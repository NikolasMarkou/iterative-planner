#!/usr/bin/env node
// Blast-radius scorer for the iterative-planner skill.
//
// Computes a coarse, deterministic radius signal for a single file edit.
// Output is meant for the per-edit `changelog.md` ledger — informative,
// never gating.
//
// Usage:
//   node blast-radius.mjs <file>              Score a file (default: current iteration HEAD)
//   node blast-radius.mjs <file> --verbose    Include per-signal breakdown
//   node blast-radius.mjs <file> --json       Emit JSON instead of single line
//
// Exit code: 0 always (informational tool — never block executor).
// Output line 1 (always): radius:TIER(score) or radius:UNKNOWN(reason)
//
// Requires Node.js 18+. No external dependencies.

import { existsSync, readFileSync, statSync, readdirSync } from "fs";
import { spawnSync } from "child_process";
import { join, extname, basename, relative, resolve } from "path";

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const json = args.includes("--json");
const fileArg = args.find((a) => !a.startsWith("--"));

if (!fileArg) {
  process.stdout.write("radius:UNKNOWN(no-file-arg)\n");
  process.exit(0);
}

const cwd = process.cwd();
const filePath = resolve(cwd, fileArg);
const repoRel = relative(cwd, filePath);

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// DECISION plan_2026-05-15_9ae230f7/D-003 [STALE] — spawnSync(cmd, args[], …) instead of
// execSync(cmd-string). Pre-fix: every callsite interpolated `repoRel` (and
// `pat`) into a double-quoted shell command string, allowing `$()` / backtick
// expansion when the filename contained those. Live probe (FN-004) created
// /tmp/FN_PWNED from a filename `bad$(touch /tmp/FN_PWNED).js`. Post-fix:
// argv elements never touch the shell. shell:false is the spawnSync default.
function tryExecArgs(cmd, args, opts = {}) {
  try {
    const r = spawnSync(cmd, args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
      ...opts,
    });
    if (r.error || r.status !== 0) return null;
    return (r.stdout ?? "").trim();
  } catch {
    return null;
  }
}

function isGitRepo() {
  return tryExecArgs("git", ["rev-parse", "--is-inside-work-tree"]) === "true";
}

function isBinary(p) {
  try {
    const buf = readFileSync(p, { encoding: null });
    const sample = buf.slice(0, 8000);
    for (const b of sample) if (b === 0) return true;
    return false;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Signal 1 — LOC churn (added + removed) from git diff --numstat
// Range 0..3, threshold per references/blast-radius.md.
// -----------------------------------------------------------------------------

function locChurn() {
  // Try staged + unstaged together against HEAD; fall back to working-tree only.
  const numstat =
    tryExecArgs("git", ["diff", "HEAD", "--numstat", "--", repoRel]) ??
    tryExecArgs("git", ["diff", "--numstat", "--", repoRel]);
  if (numstat == null) return { score: 0, added: 0, removed: 0 };
  const line = numstat.split("\n").find((l) => l.trim().length > 0);
  if (!line) return { score: 0, added: 0, removed: 0 };
  const [a, r] = line.split(/\s+/);
  const added = a === "-" ? 0 : parseInt(a, 10) || 0;
  const removed = r === "-" ? 0 : parseInt(r, 10) || 0;
  const total = added + removed;
  let score = 0;
  if (total <= 20) score = 0;
  else if (total <= 80) score = 1;
  else if (total <= 200) score = 2;
  else score = 3;
  return { score, added, removed };
}

// -----------------------------------------------------------------------------
// Signal 2 — Reverse-dep count
// grep across repo for imports/requires referencing this file's basename.
// Range 0..3 by tier. Pattern is heuristic and language-agnostic.
// -----------------------------------------------------------------------------

function reverseDeps() {
  const ext = extname(repoRel);
  const base = basename(repoRel, ext);
  if (!base) return { score: 0, count: 0 };
  // Build a heuristic pattern matching common import idioms.
  // Pattern goes into git grep / grep as an argv element — never shell-interpreted.
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pat = `(from ['\"][^'\"]*${escaped}['\"]|require\\(['\"][^'\"]*${escaped}['\"]\\)|import [^;]*${escaped}|use [a-zA-Z0-9_:]*${escaped}|include [\"<][^\">]*${escaped})`;
  // Use git grep when in repo (faster, respects .gitignore); fall back to grep -r.
  let out =
    tryExecArgs("git", ["grep", "-E", "-l", "--untracked", "--no-color", pat,
                        "--", `:(top,exclude)${repoRel}`, ":(top,exclude)plans/"]) ??
    tryExecArgs("grep", ["-E", "-r", "-l", `--include=*.${ext.slice(1) || "*"}`, pat, "."]);
  if (out == null) return { score: 0, count: 0 };
  const lines = out.split("\n").filter((l) => l.trim().length > 0 && l !== repoRel);
  const count = lines.length;
  let score = 0;
  if (count === 0) score = 0;
  else if (count <= 5) score = 1;
  else if (count <= 20) score = 2;
  else score = 3;
  return { score, count };
}

// -----------------------------------------------------------------------------
// Signal 3 — Shared-path flag
// Path matches (^|/)(lib|core|shared|common|utils|types)/ — case-insensitive.
// Score: 0 or 2.
// -----------------------------------------------------------------------------

function sharedPath() {
  const norm = repoRel.replace(/\\/g, "/").toLowerCase();
  const match = /(^|\/)(lib|core|shared|common|utils|types)\//.test(norm);
  return { score: match ? 2 : 0, match };
}

// -----------------------------------------------------------------------------
// Signal 4 — Public-API touch
// diff added line matches `^\+\s*(export\b|pub\s|public\s|def\s+[a-z])`
// (extension-aware: skip for non-code extensions).
// Score: 0 or 2.
// -----------------------------------------------------------------------------

const CODE_EXTS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift", ".scala", ".cs",
  ".c", ".h", ".cpp", ".hpp", ".cc", ".php",
]);

function publicApiTouch() {
  if (!CODE_EXTS.has(extname(repoRel))) return { score: 0, hits: 0 };
  const diff =
    tryExecArgs("git", ["diff", "HEAD", "--", repoRel]) ??
    tryExecArgs("git", ["diff", "--", repoRel]);
  if (!diff) return { score: 0, hits: 0 };
  const adds = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
  let hits = 0;
  for (const l of adds) {
    if (/^\+\s*(export\b|pub\s|public\s|def\s+[a-z]|func\s+[A-Z])/.test(l)) hits++;
  }
  return { score: hits > 0 ? 2 : 0, hits };
}

// -----------------------------------------------------------------------------
// Signal 5 — Test coverage delta
// Tests in this iteration that added/modified for this file → -1.
// Heuristic: any file in the same diff under a path matching /test|spec/ that
// references this file's basename.
// -----------------------------------------------------------------------------

function testDelta() {
  const ext = extname(repoRel);
  const base = basename(repoRel, ext);
  if (!base) return { score: 0, hit: false };
  const changed =
    tryExecArgs("git", ["diff", "HEAD", "--name-only"]) ??
    tryExecArgs("git", ["diff", "--name-only"]);
  if (!changed) return { score: 0, hit: false };
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const f of changed.split("\n")) {
    if (!f) continue;
    if (f === repoRel) continue;
    if (!/(^|\/)(tests?|specs?|__tests__)\//i.test(f) && !/\.(test|spec)\./.test(f)) continue;
    const content = (() => {
      try { return readFileSync(join(cwd, f), "utf-8"); } catch { return ""; }
    })();
    if (new RegExp(escaped).test(content)) return { score: -1, hit: true };
  }
  return { score: 0, hit: false };
}

// -----------------------------------------------------------------------------
// Signal 6 — Iteration history
// File appeared in a prior iteration's manifest (state.md change manifest) of
// the active plan. Heuristic: grep prior plans/.current_plan/state.md for path.
// Score: 0 or 1.
// -----------------------------------------------------------------------------

function iterationHistory() {
  try {
    const ptr = readFileSync(join(cwd, "plans", ".current_plan"), "utf-8").trim();
    if (!ptr) return { score: 0, prior: false };
    const planDir = join(cwd, "plans", ptr);
    // Look in checkpoints/ for prior iteration markers and decisions.md mentions.
    const candidates = [];
    const stPath = join(planDir, "state.md");
    if (existsSync(stPath)) candidates.push(stPath);
    const cpDir = join(planDir, "checkpoints");
    if (existsSync(cpDir)) {
      for (const f of readdirSync(cpDir)) {
        if (f.endsWith(".md")) candidates.push(join(cpDir, f));
      }
    }
    for (const p of candidates) {
      try {
        const c = readFileSync(p, "utf-8");
        // Match repoRel as a backtick-fenced or whitespace-bounded path.
        const re = new RegExp(`(\`|\\s)${repoRel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\`|\\s|$)`);
        if (re.test(c)) return { score: 1, prior: true };
      } catch {}
    }
  } catch {}
  return { score: 0, prior: false };
}

// -----------------------------------------------------------------------------
// Compose
// -----------------------------------------------------------------------------

function emitUnknown(reason) {
  if (json) {
    process.stdout.write(JSON.stringify({ tier: "UNKNOWN", reason, file: repoRel }) + "\n");
  } else {
    process.stdout.write(`radius:UNKNOWN(${reason})\n`);
  }
  process.exit(0);
}

if (!isGitRepo()) emitUnknown("no-git");
if (!existsSync(filePath)) {
  // File may have been deleted as part of edit; still try to score from diff.
  // If git diff returns nothing, give up.
  const d = tryExecArgs("git", ["diff", "HEAD", "--numstat", "--", repoRel]);
  if (!d) emitUnknown("not-tracked");
}
if (existsSync(filePath) && statSync(filePath).isDirectory()) emitUnknown("is-directory");
if (existsSync(filePath) && isBinary(filePath)) emitUnknown("unreadable");

const loc = locChurn();
const deps = reverseDeps();
const shared = sharedPath();
const api = publicApiTouch();
const tests = testDelta();
const hist = iterationHistory();

const score = loc.score + deps.score + shared.score + api.score + tests.score + hist.score;
const tier = score <= 2 ? "LOW" : score <= 5 ? "MED" : "HIGH";

if (json) {
  process.stdout.write(JSON.stringify({
    tier, score, file: repoRel,
    signals: {
      loc: { score: loc.score, added: loc.added, removed: loc.removed },
      deps: { score: deps.score, count: deps.count },
      shared: { score: shared.score, match: shared.match },
      api: { score: api.score, hits: api.hits },
      tests: { score: tests.score, hit: tests.hit },
      hist: { score: hist.score, prior: hist.prior },
    },
  }) + "\n");
  process.exit(0);
}

let line = `radius:${tier}(${score})`;
if (verbose) {
  line += ` loc=${loc.score}(+${loc.added},-${loc.removed}) deps=${deps.score}(${deps.count}) shared=${shared.score} api=${api.score}(${api.hits}) tests=${tests.score} hist=${hist.score}`;
}
process.stdout.write(line + "\n");
