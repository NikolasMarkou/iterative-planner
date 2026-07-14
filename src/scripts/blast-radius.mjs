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

// NOTE: spawnSync(cmd, args[], …) instead of
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

// NOTE: every diff-reading signal below used to call `git diff HEAD`, which by
// design excludes untracked files. A brand-new file therefore scored 0 on LOC
// churn, public-API touch and test delta — i.e. the CREATE case (the very case
// the changelog `OP=CREATE(+N)` field exists for, and the riskiest kind of edit)
// got the LOWEST possible radius. Reproduced pre-fix: a 500-line unstaged new
// file scored `radius:LOW(0)`; `git add` alone — zero content change — scored
// `radius:MED(3)`. Executors score a file right after writing it, before staging,
// so this was the common path, not an edge case.
//
// Fix: probe tracked-ness explicitly and, for an untracked-but-existing file,
// synthesize the CREATE diff from the file BODY (added = line count, removed = 0;
// the public-API scan runs over the body instead of over diff `+` lines; testDelta
// unions the untracked entries from `git status --porcelain`).
//
// Do NOT "fix" this by teaching the signals to `git add` the file — the scorer is
// advisory and must never mutate the index. Tracked files keep the exact
// diff-driven path they had before: their scores must not move.
function isTracked(p) {
  return tryExecArgs("git", ["ls-files", "--error-unmatch", "--", p]) !== null;
}

// Lines of the target file when it is an untracked-but-existing regular file,
// else null (tracked, deleted, or unreadable → callers use the real diff).
// Memoized: up to three signals ask for it, and each ask is a git subprocess.
let untrackedLinesCache; // undefined = not yet computed
function untrackedLines() {
  if (untrackedLinesCache !== undefined) return untrackedLinesCache;
  untrackedLinesCache = null;
  try {
    if (existsSync(filePath) && statSync(filePath).isFile() && !isTracked(repoRel)) {
      const content = readFileSync(filePath, "utf-8");
      // Trailing newline is a terminator, not a line: `seq 500 > f` is 500 lines,
      // which is exactly what `git diff --numstat` reports once the file is added.
      untrackedLinesCache = content === "" ? [] : content.replace(/\r?\n$/, "").split("\n");
    }
  } catch {
    untrackedLinesCache = null;
  }
  return untrackedLinesCache;
}

// Untracked paths per `git status --porcelain` (`?? path`), repo-root-relative —
// the same frame `git diff --name-only` reports in.
function untrackedPaths() {
  const out = tryExecArgs("git", ["status", "--porcelain", "--untracked-files=all"]);
  if (out == null) return [];
  return out
    .split("\n")
    .filter((l) => l.startsWith("?? "))
    .map((l) => l.slice(3).trim())
    // git quotes paths containing special characters (core.quotePath).
    .map((p) => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p))
    .filter((p) => p.length > 0);
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

function locScore(total) {
  if (total <= 20) return 0;
  if (total <= 80) return 1;
  if (total <= 200) return 2;
  return 3;
}

function locChurn() {
  // Untracked file → synthesize the CREATE diff from content (see NOTE above).
  const created = untrackedLines();
  if (created !== null) {
    const added = created.length;
    return { score: locScore(added), added, removed: 0 };
  }
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
  return { score: locScore(added + removed), added, removed };
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

const PUBLIC_API_RE = /^\+\s*(export\b|pub\s|public\s|def\s+[a-z]|func\s+[A-Z])/;

function publicApiTouch() {
  if (!CODE_EXTS.has(extname(repoRel))) return { score: 0, hits: 0 };
  let adds;
  const created = untrackedLines();
  if (created !== null) {
    // No diff exists for an untracked file, so scan the BODY. Every line of a new
    // file is an added line; prefixing with "+" lets the single PUBLIC_API_RE above
    // stay the one definition of "public symbol" across both paths.
    adds = created.map((l) => "+" + l);
  } else {
    const diff =
      tryExecArgs("git", ["diff", "HEAD", "--", repoRel]) ??
      tryExecArgs("git", ["diff", "--", repoRel]);
    if (!diff) return { score: 0, hits: 0 };
    adds = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
  }
  let hits = 0;
  for (const l of adds) {
    if (PUBLIC_API_RE.test(l)) hits++;
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
  // Union the diff with the untracked entries: a brand-new test file is invisible
  // to `git diff` until it is staged, which is the same blind spot as the CREATE
  // case above — a fresh test written alongside a fresh module must still count.
  const changed =
    tryExecArgs("git", ["diff", "HEAD", "--name-only"]) ??
    tryExecArgs("git", ["diff", "--name-only"]);
  const candidates = new Set([
    ...(changed ? changed.split("\n") : []),
    ...untrackedPaths(),
  ]);
  if (candidates.size === 0) return { score: 0, hit: false };
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const f of candidates) {
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
