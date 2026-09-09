#!/usr/bin/env node
// Requires Node.js 18+
//
// scar-scan — the mechanical half of `references/code-hygiene.md`.
//
// WHY THIS EXISTS. This repo's own measurement (28 planner runs, 27 deleted
// plan directories) found the asymmetry that motivates the tool: the hygiene
// categories that got MECHANIZED are measurably clean, and the ones left as
// advisory prose are the dirty ones — 64 orphaned decision anchors pointing at
// 10 dead plan-ids, and stale `uncommitted` commit fields in a closed plan's
// changelog that `plans/LESSONS.md` had already named and that recurred on the
// very next run. A rule with no owning mechanism does not hold. This script is
// the owning mechanism.
//
// WHAT IT IS NOT. It is a REPORT, not a build gate. Findings never fail a
// build; the ONLY things that exit non-zero are the two ways the scan itself
// can become untrustworthy (see EXIT CODES). Do not add it to `make validate`.
//
// THE FIVE CATEGORIES (see CATEGORIES below — that array is the single
// enumeration; EXPECTED_MIN_CATEGORIES is pinned equal to its length by a test):
//   A  orphaned decision anchors      — DELEGATED to validate-plan.mjs
//   B  stale `uncommitted` changelog commit fields, cross-checked against git
//   C  orphan plan-directory artifacts (empty findings, `-2` collisions,
//      unreferenced checkpoints)
//   D  the Forbidden Leftovers code sweep from code-hygiene.md
//   E  Complexity Budget claims in plan.md reconciled against the real diff
//
// THE PARTITION IS THE POINT. A raw count of 64 anchor errors reads as a
// permanent false regression: readers learn to ignore the section and a
// genuinely new orphan hides inside it forever. Every finding is classified
// INHERITED (predates this plan — reported with a suggested standalone command,
// never auto-remediated) or INTRODUCED (the only items an orchestrator may mint
// as `iter-N/step-M.K` completion fixes). INTRODUCED means a file named by this
// plan's own changelog.md — EXCEPT for category A, which is decided by ANCHOR
// IDENTITY alone: an anchor is this plan's only when its plan-id RESOLVES and
// EQUALS the active plan-id. File membership is proximity, not attribution.
//
// EXIT CODES (named constants below):
//   0  the scan completed, REGARDLESS of what it found
//   1  [scan-unavailable] — the upstream validator is absent, crashed, timed
//      out, or produced no parseable proof-of-run line
//   1  [scan-floor]       — fewer than EXPECTED_MIN_CATEGORIES categories REPORTED a
//      status, i.e. one was deleted from the sweep body. A category that DEGRADED at
//      runtime (no git) still reports, and still exits 0 — see decisions.md D-010.
//
// A FALSE ALL-CLEAR IS THE WORST OUTPUT THIS TOOL CAN PRODUCE. On
// [scan-unavailable] the process writes NOTHING to stdout — no findings block,
// no empty result, not even in --json — and reports on stderr. "Zero matches"
// is only ever printed when there is positive evidence the upstream actually
// ran. Do not "improve" this by emitting a partial JSON body on that path: a
// consumer that reads `{"introduced": []}` cannot tell it from a clean repo.
//
// WHAT THIS CANNOT SEE (a gate you cannot falsify is a gate you should not
// trust — the holes are named here so nobody rediscovers them as a surprise):
//   1. A category that RUNS but silently matches nothing because its own
//      pattern rotted. Neither floor catches that; only the per-category
//      fixtures in scar-scan.test.mjs do, which is weaker than a floor. This
//      is the disclosed cost of the two-floor choice (decisions.md D-005).
//   2. Category D's file discovery does not read `.gitignore`. It walks the
//      tree with a fixed SKIP_DIRS set, so a build directory outside that set
//      is swept. Chosen so D still runs with no git at all.
//   3. Category D's debug-statement and commented-out-code rules are anchored
//      at line start. A debug call chained mid-line, or after a `;`, is missed.
//      That anchoring is what keeps the rules from firing on every line of
//      prose that merely NAMES a debug function — including these comments.
//   4. `console.log` / `print()` are deliberately NOT flagged as debug logging
//      even though code-hygiene.md lists them: every gate in this repo is a CLI
//      whose entire output channel is console.log, so the rule would fire on
//      hundreds of correct lines, and a rule that fires on correct lines is a
//      rule that gets ignored.
//   5. Category B and E need git. Without it they report "unavailable" and say
//      so; A, C and D still run. A degraded category is NOT a clean category
//      and the report never lets the two look alike.
//   6. Category C's collision-suffix rule excludes names carrying a protocol-
//      assigned `-iter-N` / `-passN` segment, so a topic slug that genuinely
//      collided AND happens to end that way (`retry-iter-2.md`) is invisible to
//      it. Accepted: the alternative was reporting `review-iter-2.md` and this
//      tool's own `hygiene-iter-2.md` as residue on every run from iteration 2
//      onward — a rule that fires on correct names is a rule that gets ignored.
//   7. Two deliberate narrowings the partition pays for (decisions.md D-012).
//      (a) A category-A anchor with NO resolvable plan-id is always INHERITED,
//      so an `[anchor-badprefix]` anchor this plan itself wrote reads as
//      backlog. A NEW orphan is still caught, because it carries the active
//      plan-id. (b) The unreferenced-checkpoint rule does not fire on the
//      ACTIVE plan, so a checkpoint that stays uncited for the whole run is
//      invisible until that plan is closed and swept with --plan-dir.
//
// COST. No new full-corpus walk over `plans/`: B, C and E read ONE plan
// directory (O(1) in plan-dir count), A delegates to validate-plan.mjs whose
// own O(referenced-plans) cost is already documented, D is O(source files in
// scan scope).
//
// Zero dependencies (node: builtins only). Pure functions are exported for the
// test suite; the CLI runs only under the isEntryPoint guard, so importing this
// module is side-effect-free.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  ANY_PLAN_ID_PATTERN,
  ANY_PLAN_ID_RE,
  BLOCK_COMMENT_EXTS,
  DECISION_ID_NUM_PATTERN,
  splitChangelogFields,
} from "./shared.mjs";
import { STEP_RE } from "./schema.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const EXIT_OK = 0;
/** Both untrustworthy-scan conditions ([scan-unavailable], [scan-floor]). */
export const EXIT_UNTRUSTWORTHY = 1;

/**
 * The ONE enumeration of implemented sweep categories. Everything else — the
 * floor, the per-category status table, the JSON `categories` array — derives
 * from this list, so a category cannot be dropped from the sweep while still
 * being counted.
 */
export const CATEGORIES = [
  { id: "A", key: "orphaned-anchors", title: "Orphaned decision anchors", needsGit: false },
  { id: "B", key: "stale-commit-fields", title: "Stale `uncommitted` changelog fields", needsGit: true },
  { id: "C", key: "orphan-plan-artifacts", title: "Orphan plan-directory artifacts", needsGit: false },
  { id: "D", key: "forbidden-leftovers", title: "Forbidden Leftovers code sweep", needsGit: false },
  { id: "E", key: "complexity-budget", title: "Complexity Budget reconciliation", needsGit: true },
];

// DECISION plan-2026-09-09T082122-64c4de78/D-005 — the anti-vacuity floor for a scanner
// whose FINDINGS legitimately go to zero. There is deliberately NO floor on the number of
// findings: a constant pinned at this repo's current 64 orphan anchors would be a ratchet
// pointing the wrong way, forbidding the correct end state (zero) from ever being reached.
// The two guarded failure shapes are instead (1) a category silently dropped from the sweep
// — this floor, pinned EQUAL to CATEGORIES.length by a `pin:` test, matching the exact-floor
// idiom of EXPECTED_MIN_KEYS / EXPECTED_MIN_FILES / EXPECTED_SLUGS — and (2) a dead upstream,
// guarded by the [scan-unavailable] proof-of-run requirement. Do NOT add a findings floor,
// and do NOT set this below CATEGORIES.length "for headroom": headroom here means exactly
// "that many categories may vanish and the tool still claims to have swept". Real count
// today: 5. See decisions.md D-005.
export const EXPECTED_MIN_CATEGORIES = 5;

/** Validator issue checks that report anchor residue (category A). */
export const ANCHOR_CHECKS = new Set([
  "anchor-unknown-plan",
  "anchor-orphan",
  "anchor-unqualified",
  "anchor-badprefix",
]);

/** How many INHERITED items per category the human-readable report prints. */
export const INHERITED_PRINT_LIMIT = 10;

/** Subprocess budget for the delegated validator run. Expiry => [scan-unavailable]. */
export const VALIDATOR_TIMEOUT_MS = 60_000;

/**
 * Extensions swept by category D. Built as a UNION on BLOCK_COMMENT_EXTS
 * (shared.mjs) rather than a second hand-written list, so the C-family half
 * cannot drift from the one definition the anchor scanners use. The extra
 * entries are hash-family and shell languages that have no `/* *\/` comments
 * at all and are therefore correctly absent from that set.
 */
export const CODE_EXTS = new Set([
  ...BLOCK_COMMENT_EXTS,
  ".py", ".rb", ".sh", ".bash", ".zsh", ".ps1", ".pl", ".r", ".ex", ".exs",
]);

/** Directories category D never descends into. See disclosed hole 2 in the header. */
export const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "target", "vendor", "coverage",
  ".venv", "venv", "__pycache__", ".next", ".cache", "plans",
]);

// ---------------------------------------------------------------------------
// Pure helpers — identifiers
// ---------------------------------------------------------------------------

/**
 * Derive a commit-tag prefix from a plan-id by dropping the `THHMMSS` segment:
 * `plan-2026-09-09T082122-64c4de78` -> `plan-2026-09-09-64c4de78`. A legacy
 * `plan_YYYY-MM-DD_XXXXXXXX` id derives identically (underscores normalized to
 * hyphens). Returns null for anything that is not a plan-id, so a caller can
 * degrade instead of grepping git history for a malformed string.
 *
 * Contract: (planId: string) -> string | null. Never throws.
 */
export function commitTagPrefix(planId) {
  if (!planId || !ANY_PLAN_ID_RE.test(planId)) return null;
  const m = /^plan[-_](\d{4}-\d{2}-\d{2})(?:T\d{6})?[-_]([0-9a-f]{8})$/.exec(planId);
  return m ? `plan-${m[1]}-${m[2]}` : null;
}

// ---------------------------------------------------------------------------
// Category A — orphaned decision anchors (DELEGATED)
// ---------------------------------------------------------------------------

// DECISION plan-2026-09-09T082122-64c4de78/D-003 — category A shells out to validate-plan.mjs
// and parses its report lines. It does NOT re-declare the anchor regexes and does NOT import
// that script's private internals. The anchor grammar has exactly one definition (the anchor
// scanners in validate-plan.mjs, over the id grammars in shared.mjs), mirroring the source-grep
// test that already forbids re-declaring the changelog field regexes outside schema.mjs. A
// second copy of the anchor grammar would drift, and the drift would be SILENT: this tool would
// report a clean repo while the validator reported 64 errors.
// The subprocess coupling is made safe by refusing to fail open — parseValidatorOutput() below
// requires positive PROOF the upstream really ran, and runValidator()'s caller turns its absence
// into exit 1 [scan-unavailable]. Do NOT "simplify" this by exporting the anchor functions from
// validate-plan.mjs (a wider edit to the highest-blast-radius script here for no added benefit),
// and do NOT relax the proof-of-run requirement into a "no matches means clean" default.
// See decisions.md D-003.

const ISSUE_LINE_RE = /^\s{2}(ERROR|WARN|INFO)\s*\[([a-z-]+)\]:\s(.*)$/;
const PROOF_SUMMARY_RE = /^Summary: \d+ error\(s\), \d+ warning\(s\), \d+ info\(s\)$/m;
const PROOF_PASS_RE = /^PASS: .+ — no issues found$/m;
const FILE_LINE_RE = /^(\S+):(\d+)\s/;
const ANCHOR_ID_RE = new RegExp(`(${ANY_PLAN_ID_PATTERN})/D-${DECISION_ID_NUM_PATTERN}`);

/**
 * Parse `validate-plan.mjs` stdout into anchor findings plus PROOF that the run
 * really happened.
 *
 * Contract: (stdout: string) -> { proofOfRun: boolean, anchors: Item[] }.
 * `proofOfRun` is false whenever the output carries neither the `Summary: N
 * error(s), ...` line nor the `PASS: <dir> — no issues found` line. A caller
 * MUST treat `proofOfRun === false` as [scan-unavailable] and MUST NOT treat
 * `anchors: []` as evidence of a clean repo. Never throws.
 */
export function parseValidatorOutput(stdout) {
  const text = stdout || "";
  const proofOfRun = PROOF_SUMMARY_RE.test(text) || PROOF_PASS_RE.test(text);
  const anchors = [];
  for (const raw of text.split("\n")) {
    const m = ISSUE_LINE_RE.exec(raw);
    if (!m) continue;
    const [, severity, check, message] = m;
    if (!ANCHOR_CHECKS.has(check)) continue;
    const loc = FILE_LINE_RE.exec(message);
    const idMatch = ANCHOR_ID_RE.exec(message);
    anchors.push({
      category: "A",
      kind: check,
      severity,
      file: loc ? loc[1] : null,
      line: loc ? Number(loc[2]) : null,
      // null for a legacy bare `D-NNN` anchor, which names no plan at all.
      planId: idMatch ? idMatch[1] : null,
      stale: message.includes("[STALE]"),
      // The validator prefixes every anchor message with `<file>:<line> `, which
      // the report already prints from the parsed fields. Strip it so a finding
      // line does not name its own location twice.
      evidence: loc ? message.slice(loc[0].length) : message,
      remediation: null, // filled by remediationForAnchor once provenance is known
    });
  }
  return { proofOfRun, anchors };
}

/** Suggested standalone command for an inherited anchor finding. */
function remediationForAnchor(item) {
  if (item.kind === "anchor-unknown-plan" && item.planId) {
    return `node <skill-path>/scripts/bootstrap.mjs retire ${item.planId}`;
  }
  if (item.kind === "anchor-unqualified") {
    return "add the plan-id prefix to the anchor, or remove it if its code no longer survives";
  }
  return "remove the anchor, or add the missing decisions.md entry it points at";
}

/**
 * Run the delegated validator.
 *
 * Contract: ({ scriptPath, planDirName, cwd }) -> { ok, stdout, reason }.
 * `ok:false` carries a human-readable `reason` and MUST become
 * [scan-unavailable] at the call site. Never throws.
 */
export function runValidator({ scriptPath, planDirName, cwd }) {
  if (!existsSync(scriptPath)) {
    return { ok: false, stdout: "", reason: `validate-plan.mjs not found at ${scriptPath}` };
  }
  let r;
  try {
    r = spawnSync(process.execPath, [scriptPath, planDirName], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: VALIDATOR_TIMEOUT_MS,
    });
  } catch (err) {
    return { ok: false, stdout: "", reason: `validate-plan.mjs spawn threw (${err.code ?? err.message})` };
  }
  if (r.error) {
    const why = r.error.code === "ETIMEDOUT" ? `timed out after ${VALIDATOR_TIMEOUT_MS}ms` : r.error.code ?? r.error.message;
    return { ok: false, stdout: "", reason: `validate-plan.mjs ${why}` };
  }
  if (r.signal) {
    return { ok: false, stdout: "", reason: `validate-plan.mjs killed by ${r.signal} (timeout ${VALIDATOR_TIMEOUT_MS}ms)` };
  }
  // status 0 = clean, 1 = errors found. BOTH are real runs. Anything else
  // (2 = leash gate, >2 = crash) means the validator did not do this job.
  if (r.status !== 0 && r.status !== 1) {
    return { ok: false, stdout: r.stdout ?? "", reason: `validate-plan.mjs exited ${r.status} (expected 0 or 1)` };
  }
  return { ok: true, stdout: r.stdout ?? "", reason: null };
}

// ---------------------------------------------------------------------------
// Category B — stale `uncommitted` changelog commit fields
// ---------------------------------------------------------------------------

/**
 * Changelog entry lines whose commit field is still the literal `uncommitted`.
 *
 * Contract: (changelogText: string) -> [{ lineNo, step, path, reason }].
 * Field split and the step grammar are REUSED (splitChangelogFields from
 * shared.mjs, STEP_RE from schema.mjs) rather than re-parsed here: the field
 * shapes have exactly one definition and this is not it. A line is only an
 * entry when it splits into 8 fields AND its step field satisfies the grammar,
 * which is what keeps the word "uncommitted" appearing in a REASON field — as
 * it does in two real correction lines in this repo — from being counted as a
 * stale commit field. Never throws.
 */
export function findStaleCommitFields(changelogText) {
  const out = [];
  const lines = (changelogText || "").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.includes(" | ")) continue;
    const fields = splitChangelogFields(line);
    if (fields.length !== 8) continue;
    if (!STEP_RE.test(fields[1])) continue;
    if (fields[2] !== "uncommitted") continue;
    out.push({ lineNo: i + 1, step: fields[1], path: fields[3], reason: fields[7] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Category C — orphan plan-directory artifacts
// ---------------------------------------------------------------------------

/**
 * The mandatory nuclear-fallback checkpoint. Every plan is REQUIRED to create it
 * before its first edit whether or not anything ever cites it, so an
 * "unreferenced" cp-000 is protocol compliance, not residue.
 */
const MANDATORY_CHECKPOINT_RE = /^cp-0+-iter1$/;

/** A findings file with less than this many non-blank lines is an empty shell. */
const MIN_FINDINGS_LINES = 3;

/**
 * A PROTOCOL-ASSIGNED iteration/pass suffix, which is not a collision suffix.
 * `ip-reviewer.md` names its artifacts `review-iter-N[-passM].md` and `ip-boyscout.md`
 * names its own `hygiene-iter-N.md`, so the bare `-[2-9].md` test below reported the
 * protocol's own iteration-2 output — including this tool's — as orphan residue.
 */
const PROTOCOL_ITER_SUFFIX_RE = /-(?:iter-|pass-?)\d+\.md$/;

/**
 * Classify plan-directory residue from an already-read listing.
 *
 * Contract: ({ findings, checkpoints, referenceText, planIsActive }) -> Item[], where
 *   findings   = [{ name, content }] from the plan's findings/ dir
 *   checkpoints= [{ name }] .md files from the plan's checkpoints/ dir
 *   referenceText = the concatenated text of the plan's other files, searched
 *                   for checkpoint mentions
 *   planIsActive = true when the swept plan is the one plans/.current_plan
 *                  points at, which suppresses the unreferenced-checkpoint rule
 *                  only (findings rules are unaffected)
 * Kept pure (takes a listing, not a path) so the test suite can drive every
 * branch without a fixture tree. Never throws.
 */
export function classifyPlanArtifacts({ findings = [], checkpoints = [], referenceText = "", planIsActive = false }) {
  const items = [];
  for (const f of findings) {
    const body = (f.content || "").split("\n").filter((l) => l.trim() !== "");
    if (body.length < MIN_FINDINGS_LINES) {
      items.push({
        category: "C",
        kind: "empty-findings-file",
        file: `findings/${f.name}`,
        line: null,
        evidence: `findings artifact has ${body.length} non-blank line(s), below ${MIN_FINDINGS_LINES}`,
        remediation: "populate the artifact or delete it — an empty findings file reads as evidence that was never gathered",
      });
    }
    // The shape this catches is an EXPLORER TOPIC SLUG that collided and took a `-2`
    // suffix under ip-explorer.md's collision rule (`auth-system-2.md`). Names carrying
    // a protocol-assigned `-iter-N` / `-passN` segment are excluded first (disclosed
    // hole 6): they are assigned by the protocol, not minted by a slug collision.
    if (!PROTOCOL_ITER_SUFFIX_RE.test(f.name) && /-[2-9]\.md$/.test(f.name)) {
      items.push({
        category: "C",
        kind: "collision-suffix",
        file: `findings/${f.name}`,
        line: null,
        evidence: `name carries a numeric collision suffix (${f.name})`,
        remediation: "merge into the un-suffixed artifact and delete the duplicate, or rename it to a real topic",
      });
    }
  }
  // The ACTIVE plan's checkpoints are IN FLIGHT: one created minutes ago by the run now
  // in progress is the protocol working, not residue, and the plan file that will cite it
  // may not be written yet. Narrowed, not deleted (decisions.md D-012) — a dangling
  // checkpoint in a CLOSED plan is still real residue and is still reported.
  for (const c of planIsActive ? [] : checkpoints) {
    const stem = c.name.replace(/\.md$/, "");
    if (MANDATORY_CHECKPOINT_RE.test(stem)) continue;
    if (referenceText.includes(stem)) continue;
    items.push({
      category: "C",
      kind: "unreferenced-checkpoint",
      file: `checkpoints/${c.name}`,
      line: null,
      evidence: `no other plan file mentions ${stem}`,
      remediation: "cite the checkpoint from state.md/progress.md where it was taken, or delete it if the risky change it guarded is long since committed",
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Category D — the Forbidden Leftovers code sweep
// ---------------------------------------------------------------------------

/**
 * The categories of `references/code-hygiene.md` "Forbidden Leftovers" this
 * sweep mechanizes. That document stays the CANONICAL definition of the list;
 * this array is the set of items a machine can decide, not a replacement for it.
 */
export const LEFTOVER_KINDS = [
  "marker-comment",
  "debug-statement",
  "commented-out-code",
  "dead-import",
  "orphaned-test-file",
];

// Line-start anchored on purpose (disclosed hole 3): a marker is a leftover when
// it OPENS a comment, not when a sentence merely mentions the word.
const MARKER_RE = /^\s*(?:\/\/+|#+|\*|\/\*+|--)\s*(TODO|FIXME|XXX|HACK)\b/;
// A debug statement is a STATEMENT, so it starts a line. `console.log` and
// `print()` are excluded — see disclosed hole 4.
const DEBUG_RE = /^\s*(?:debugger\b|console\.(?:debug|trace)\s*\(|breakpoint\s*\(\s*\)|pdb\.set_trace\s*\()/;
// A comment whose body opens like code AND closes like a statement.
const COMMENTED_CODE_RE =
  /^\s*(?:\/\/|#)\s*(?:const|let|var|function|return|import|export|if|for|while|switch|class|def|elif|await|async)\b.*[;{}]\s*$/;
// A pattern STRING, not a shared /g RegExp: a module-level global regex carries
// lastIndex across calls, so two call sites silently interfere. Each use builds
// its own instance (the same discipline as PLAN_SECTION_PATTERN in shared.mjs).
const IMPORT_STMT_PATTERN = "^import\\s+([\\s\\S]*?)\\s+from\\s+[\"\'][^\"\']+[\"\'];?";
const TEST_FILE_RE = /^(.*)\.(?:test|spec)\.((?:m|c)?[jt]sx?)$/;
const JS_EXTS = new Set([".mjs", ".cjs", ".js", ".jsx", ".ts", ".tsx"]);

/** Local binding names introduced by one `import ... from "..."` clause. */
function importedNames(clause) {
  const names = [];
  const named = /\{([^}]*)\}/.exec(clause);
  if (named) {
    for (const part of named[1].split(",")) {
      const t = part.trim();
      if (!t) continue;
      const as = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(t);
      names.push(as ? as[1] : t.replace(/^type\s+/, ""));
    }
  }
  const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
  if (ns) names.push(ns[1]);
  const head = clause.replace(/\{[^}]*\}/g, "").replace(/\*\s+as\s+[A-Za-z_$][\w$]*/g, "");
  const def = /^\s*([A-Za-z_$][\w$]*)\s*,?\s*$/.exec(head);
  if (def) names.push(def[1]);
  return names.filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
}

/**
 * Sweep one source file for the mechanizable Forbidden Leftovers.
 *
 * Contract: (relPath: string, text: string) -> Item[]. Pure: takes the text, so
 * the test suite drives every kind without touching the filesystem. The
 * `orphaned-test-file` kind is decided by the CALLER (it needs a sibling-file
 * existence check), not here. Never throws.
 */
export function scanForbiddenLeftovers(relPath, text) {
  const items = [];
  const push = (kind, lineNo, evidence, remediation) =>
    items.push({ category: "D", kind, file: relPath, line: lineNo, evidence, remediation });

  const lines = (text || "").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const marker = MARKER_RE.exec(line);
    if (marker) {
      push("marker-comment", i + 1, line.trim().slice(0, 160),
        `resolve the ${marker[1]} or delete it — a marker comment is an unfinished revert, not a backlog`);
    }
    if (DEBUG_RE.test(line)) {
      push("debug-statement", i + 1, line.trim().slice(0, 160),
        "remove the debug statement added during a failed attempt");
    }
    if (COMMENTED_CODE_RE.test(line)) {
      push("commented-out-code", i + 1, line.trim().slice(0, 160),
        "delete the commented-out code — git history is the archive");
    }
  }

  if (JS_EXTS.has(extname(relPath))) {
    const body = (text || "").replace(
      new RegExp(IMPORT_STMT_PATTERN, "gm"),
      (stmt) => stmt.replace(/[^\n]/g, " "),
    );
    const importRe = new RegExp(IMPORT_STMT_PATTERN, "gm");
    let m;
    while ((m = importRe.exec(text || "")) !== null) {
      const lineNo = (text.slice(0, m.index).match(/\n/g) || []).length + 1;
      for (const name of importedNames(m[1])) {
        if (!new RegExp(`\\b${name}\\b`).test(body)) {
          push("dead-import", lineNo, `imported \`${name}\` is never referenced in this file`,
            `remove \`${name}\` from the import — an import for a removed module is an incomplete revert`);
        }
      }
    }
  }
  return items;
}

/**
 * Decide the `orphaned-test-file` kind for a discovered file set.
 *
 * Contract: (relPaths: string[], exists: (rel) => boolean) -> Item[]. A
 * `<stem>.test.<ext>` / `<stem>.spec.<ext>` whose sibling `<stem>.<ext>` does
 * not exist is a test for code that was reverted. Only the JS-family
 * sibling-file convention is decided; python's `test_x.py` names no unambiguous
 * subject and is deliberately left alone. Never throws.
 */
export function findOrphanedTestFiles(relPaths, exists) {
  const items = [];
  for (const rel of relPaths) {
    const m = TEST_FILE_RE.exec(rel);
    if (!m) continue;
    const subject = `${m[1]}.${m[2]}`;
    if (exists(subject)) continue;
    items.push({
      category: "D",
      kind: "orphaned-test-file",
      file: rel,
      line: null,
      evidence: `no subject file ${subject}`,
      remediation: "delete the test, or restore the module it was written against",
    });
  }
  return items;
}

/**
 * Collect code files under `root`, skipping SKIP_DIRS. Deliberately git-free so
 * category D still runs in a non-repo (see disclosed hole 2).
 * Contract: (root: string) -> string[] of repo-relative paths. Never throws;
 * an unreadable directory contributes nothing rather than aborting the sweep.
 */
export function collectCodeFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".github") continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(abs);
      } else if (e.isFile() && CODE_EXTS.has(extname(e.name))) {
        out.push(relative(root, abs));
      }
    }
  };
  walk(root);
  return out.sort();
}

// ---------------------------------------------------------------------------
// Category E — Complexity Budget reconciliation
// ---------------------------------------------------------------------------

/**
 * Parse the numeric claims out of plan.md's `## Complexity Budget` section.
 *
 * Contract: (planText: string) -> { filesAdded, filesAddedMax, abstractions,
 * abstractionsMax } with null for anything absent or unparseable. A plan that
 * states its budget in prose only yields all-null, and the caller reports the
 * category as ran-with-nothing-to-reconcile rather than inventing a cap.
 * Never throws.
 */
export function parseComplexityBudget(planText) {
  // Sliced line-wise, not by regex: a "section runs to the next `## ` or EOF"
  // pattern needs an end-of-INPUT anchor, and JS has none that co-exists with
  // the `m` flag ( `$` becomes end-of-LINE and the section collapses to nothing).
  const lines = (planText || "").split("\n");
  const start = lines.findIndex((l) => /^##\s+Complexity Budget\s*$/.test(l));
  let end = lines.length;
  for (let i = start + 1; start >= 0 && i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  const body = start < 0 ? "" : lines.slice(start + 1, end).join("\n");
  const num = (re) => {
    const m = re.exec(body);
    return m ? { got: Number(m[1]), max: Number(m[2]) } : null;
  };
  const files = num(/\*\*Files added:\s*(\d+)\s*\/\s*(\d+)\s*max\*\*/i);
  const abs = num(/\*\*New abstractions:\s*(\d+)\s*\/\s*(\d+)\s*max\*\*/i);
  return {
    filesAdded: files ? files.got : null,
    filesAddedMax: files ? files.max : null,
    abstractions: abs ? abs.got : null,
    abstractionsMax: abs ? abs.max : null,
  };
}

/**
 * Reconcile a parsed budget against the measured file-add count.
 *
 * Contract: (budget, measuredFilesAdded: number | null) -> Item[]. Returns a
 * finding ONLY when a stated cap is measurably exceeded; a measurement that
 * merely differs from the plan's own running tally is not a defect. Never throws.
 */
export function reconcileComplexityBudget(budget, measuredFilesAdded) {
  if (measuredFilesAdded === null || budget.filesAddedMax === null) return [];
  if (measuredFilesAdded <= budget.filesAddedMax) return [];
  return [{
    category: "E",
    kind: "complexity-budget-exceeded",
    file: "plan.md",
    line: null,
    evidence: `plan.md caps files added at ${budget.filesAddedMax}; the diff since this plan's first commit adds ${measuredFilesAdded}`,
    remediation: "fold the extra file into an existing one, or record the cap change in decisions.md — an over-budget diff is a STOP signal, not a rounding error",
  }];
}

// ---------------------------------------------------------------------------
// The partition
// ---------------------------------------------------------------------------

/** Repo-relative paths named by this plan's changelog entry lines. */
export function changelogPaths(changelogText) {
  const paths = new Set();
  for (const line of (changelogText || "").split("\n")) {
    if (!line.includes(" | ")) continue;
    const fields = splitChangelogFields(line);
    if (fields.length !== 8 || !STEP_RE.test(fields[1])) continue;
    paths.add(fields[3]);
  }
  return paths;
}

/**
 * Classify one finding as INHERITED or INTRODUCED.
 *
 * Contract: (item, { paths: Set<string>, planId: string, planDirRel: string })
 *   -> { provenance: "inherited" | "introduced", why: string }.
 *
 * The rule, and why anchors get their own test:
 *  - ANCHOR items (category A) are decided by PLAN-ID ALONE, never by whether
 *    the file appears in the changelog. Half the files this repo's plans edit
 *    already carry inherited anchors from dead plans; a file-membership test
 *    would flip those to INTRODUCED the moment a plan touched the file for an
 *    unrelated reason, which is exactly the permanent-false-regression failure
 *    the partition exists to prevent. An anchor whose plan-id does not RESOLVE
 *    at all (an `[anchor-badprefix]` item) can never equal the active plan-id,
 *    so it is INHERITED too — it does NOT fall back to the file test.
 *  - Everything INSIDE the plan directory (categories B, C, E) is this plan's by
 *    construction — the changelog logs source edits and never lists its own dir.
 *  - Everything else (category D) is INTRODUCED iff its file appears in the
 *    plan's changelog.
 * Never throws.
 */
export function classifyProvenance(item, { paths, planId, planDirRel }) {
  // DECISION plan-2026-09-09T082122-64c4de78/D-012 — category A is attributed by ANCHOR
  // IDENTITY, never by file membership. Do NOT restore a `&& item.planId` guard here: it
  // let an anchor with NO resolvable plan-id fall through to the changelog test below, and
  // three pre-existing `[anchor-badprefix]` anchors were reported INTRODUCED for the sole
  // reason that this plan had edited their file for an unrelated purpose. File membership
  // is not attribution; it is proximity. The permanent-false-regression failure that turns
  // every inherited finding in a touched file into a fresh regression is the exact outcome
  // this partition exists to prevent — see decisions.md D-012.
  if (item.category === "A") {
    if (!item.planId) {
      return { provenance: "inherited", why: "anchor names no resolvable plan-id, so it cannot be this plan's" };
    }
    return item.planId === planId
      ? { provenance: "introduced", why: `anchor names the active plan-id ${planId}` }
      : { provenance: "inherited", why: `anchor names ${item.planId}, not the active plan` };
  }
  const file = item.file || "";
  if (planDirRel && file.startsWith(planDirRel)) {
    return { provenance: "introduced", why: "artifact lives in this plan's own directory" };
  }
  if (paths.has(file)) {
    return { provenance: "introduced", why: "file appears in this plan's changelog.md" };
  }
  return { provenance: "inherited", why: "file is not named by this plan's changelog.md" };
}

// ---------------------------------------------------------------------------
// Git (categories B and E)
// ---------------------------------------------------------------------------

/**
 * Run git with argv (never a shell string — a plan-id or path must never reach
 * a shell). Contract: (args, cwd) -> string | null; null on any failure,
 * including "not a git repo". Never throws.
 */
function git(args, cwd) {
  try {
    const r = spawnSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
    if (r.error || r.status !== 0) return null;
    return (r.stdout ?? "").trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

const readOr = (p, fallback = "") => {
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return fallback;
  }
};

const listDir = (p) => {
  try {
    return readdirSync(p).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
};

/**
 * Resolve the plan directory to sweep.
 * Contract: ({ root, planDirArg }) -> { planDirAbs, planDirRel, planId } |
 * { planDirAbs: null, reason }. A missing pointer is NOT fatal: categories A
 * and D still run against the repo.
 */
export function resolvePlanDir({ root, planDirArg }) {
  const plansDir = join(root, "plans");
  let name = planDirArg;
  if (!name) {
    const pointed = readOr(join(plansDir, ".current_plan"), "").trim();
    if (!pointed) return { planDirAbs: null, reason: "no plans/.current_plan pointer" };
    name = pointed;
  }
  name = basename(name.trim());
  if (!ANY_PLAN_ID_RE.test(name)) {
    return { planDirAbs: null, reason: `"${name}" is not a valid plan-id` };
  }
  const abs = join(plansDir, name);
  if (!existsSync(abs)) return { planDirAbs: null, reason: `plan directory ${name} does not exist` };
  return { planDirAbs: abs, planDirRel: `plans/${name}`, planId: name };
}

/**
 * Run the full sweep.
 *
 * Contract: ({ root, planDirArg, validatorPath }) -> report object, or
 * `{ unavailable: <reason> }` when category A could not be trusted. The
 * unavailable shape carries NO findings key at all — a caller cannot
 * accidentally read it as a clean result. Never throws.
 *
 * Report shape:
 *   { tool, planId, planDir, gitAvailable, categories: [{id,key,title,status,
 *     note,findings}], categoriesRan, counts: {inherited,introduced,byCategory},
 *     inherited: Item[], introduced: Item[] }
 * Item: { category, kind, file, line, evidence, remediation, provenance, why }
 */
export function runScan({ root, planDirArg = null, validatorPath }) {
  const plan = resolvePlanDir({ root, planDirArg });
  const gitAvailable = git(["rev-parse", "--is-inside-work-tree"], root) === "true";
  const categories = [];
  const findings = [];
  const status = (id, s, note, n) => {
    const meta = CATEGORIES.find((c) => c.id === id);
    categories.push({ id, key: meta.key, title: meta.title, status: s, note, findings: n });
  };

  // --- A: orphaned decision anchors (delegated) ---------------------------
  if (!plan.planDirAbs) {
    // The validator is plan-scoped; with no plan there is nothing to delegate to
    // and no anchor corpus to resolve against. That is a DEGRADED category, not
    // a clean one, and it is not [scan-unavailable] — the upstream is fine.
    status("A", "degraded", `no plan directory (${plan.reason}); anchors cannot be resolved`, 0);
  } else {
    const v = runValidator({ scriptPath: validatorPath, planDirName: plan.planId, cwd: root });
    if (!v.ok) return { unavailable: v.reason };
    const parsed = parseValidatorOutput(v.stdout);
    if (!parsed.proofOfRun) {
      return {
        unavailable:
          "validate-plan.mjs produced no proof-of-run line (expected `Summary: N error(s), ...` or `PASS: ... — no issues found`); its report format may have drifted",
      };
    }
    for (const a of parsed.anchors) a.remediation = remediationForAnchor(a);
    findings.push(...parsed.anchors);
    status("A", "ran", `delegated to validate-plan.mjs (${parsed.anchors.length} anchor issue(s))`, parsed.anchors.length);
  }

  const changelogText = plan.planDirAbs ? readOr(join(plan.planDirAbs, "changelog.md")) : "";
  const tagPrefix = plan.planId ? commitTagPrefix(plan.planId) : null;

  // --- B: stale `uncommitted` changelog commit fields ---------------------
  if (!plan.planDirAbs) {
    status("B", "degraded", `no plan directory (${plan.reason})`, 0);
  } else if (!gitAvailable) {
    status("B", "unavailable", "git unavailable — a stale field cannot be distinguished from work that truly is uncommitted", 0);
  } else {
    const stale = findStaleCommitFields(changelogText);
    let n = 0;
    for (const s of stale) {
      const hash = tagPrefix
        ? git(["log", "--fixed-strings", `--grep=[${tagPrefix}/${s.step}]`, "--format=%h", "-1"], root)
        : null;
      findings.push({
        category: "B",
        kind: "stale-commit-field",
        file: `${plan.planDirRel}/changelog.md`,
        line: s.lineNo,
        evidence: hash
          ? `line ${s.lineNo} (${s.step}, ${s.path}) still reads \`uncommitted\`, but ${hash} carries that step's tag`
          : `line ${s.lineNo} (${s.step}, ${s.path}) reads \`uncommitted\` and no commit carries that step's tag — ambiguous, not resolved`,
        remediation: hash
          ? `rewrite the commit field to ${hash}`
          : "confirm whether the step ever landed; do not assert a hash that git cannot corroborate",
      });
      n += 1;
    }
    status("B", "ran", `${stale.length} entry line(s) still read \`uncommitted\``, n);
  }

  // --- C: orphan plan-directory artifacts ---------------------------------
  if (!plan.planDirAbs) {
    status("C", "degraded", `no plan directory (${plan.reason})`, 0);
  } else {
    const fdir = join(plan.planDirAbs, "findings");
    const cdir = join(plan.planDirAbs, "checkpoints");
    const findingFiles = listDir(fdir).map((name) => ({ name, content: readOr(join(fdir, name)) }));
    const checkpointFiles = listDir(cdir).map((name) => ({ name }));
    const referenceText = ["state.md", "progress.md", "plan.md", "decisions.md", "changelog.md", "findings.md"]
      .map((f) => readOr(join(plan.planDirAbs, f)))
      .join("\n");
    const pointed = basename(readOr(join(root, "plans", ".current_plan"), "").trim());
    const items = classifyPlanArtifacts({
      findings: findingFiles,
      checkpoints: checkpointFiles,
      referenceText,
      planIsActive: pointed !== "" && pointed === plan.planId,
    }).map((i) => ({ ...i, file: `${plan.planDirRel}/${i.file}` }));
    findings.push(...items);
    status("C", "ran", `${findingFiles.length} findings artifact(s), ${checkpointFiles.length} checkpoint(s) inspected`, items.length);
  }

  // --- D: Forbidden Leftovers code sweep ----------------------------------
  const codeFiles = collectCodeFiles(root);
  const fileSet = new Set(codeFiles);
  const leftovers = [];
  for (const rel of codeFiles) {
    leftovers.push(...scanForbiddenLeftovers(rel, readOr(join(root, rel))));
  }
  leftovers.push(...findOrphanedTestFiles(codeFiles, (p) => fileSet.has(p)));
  findings.push(...leftovers);
  status("D", "ran", `${codeFiles.length} source file(s) swept for ${LEFTOVER_KINDS.length} leftover kind(s)`, leftovers.length);

  // --- E: Complexity Budget reconciliation --------------------------------
  if (!plan.planDirAbs) {
    status("E", "degraded", `no plan directory (${plan.reason})`, 0);
  } else if (!gitAvailable) {
    status("E", "unavailable", "git unavailable — the real diff cannot be measured", 0);
  } else {
    const budget = parseComplexityBudget(readOr(join(plan.planDirAbs, "plan.md")));
    const tagged = tagPrefix
      ? git(["log", "--fixed-strings", `--grep=[${tagPrefix}/`, "--format=%H"], root)
      : null;
    const hashes = tagged ? tagged.split("\n").filter(Boolean) : [];
    let measured = null;
    let note;
    if (hashes.length === 0) {
      note = "no commit yet carries this plan's tag — nothing to reconcile";
    } else {
      const base = git(["rev-parse", `${hashes[hashes.length - 1]}^`], root);
      const nameStatus = base ? git(["diff", "--name-status", base, "HEAD"], root) : null;
      if (nameStatus === null) {
        note = "could not resolve this plan's base commit — diff not measured";
      } else {
        const added = nameStatus.split("\n").filter((l) => l.startsWith("A\t"));
        const untracked = (git(["status", "--porcelain"], root) || "")
          .split("\n")
          .filter((l) => l.startsWith("?? ") && !l.startsWith("?? plans/"));
        measured = added.length + untracked.length;
        note = `budget caps files added at ${budget.filesAddedMax ?? "n/a"}; measured ${measured} (${added.length} committed + ${untracked.length} untracked)`;
      }
    }
    const items = reconcileComplexityBudget(budget, measured);
    findings.push(...items);
    status("E", "ran", note, items.length);
  }

  // --- partition ----------------------------------------------------------
  const paths = changelogPaths(changelogText);
  const inherited = [];
  const introduced = [];
  const byCategory = {};
  for (const item of findings) {
    const { provenance, why } = classifyProvenance(item, {
      paths,
      planId: plan.planId,
      planDirRel: plan.planDirRel,
    });
    const classified = { ...item, provenance, why };
    (provenance === "introduced" ? introduced : inherited).push(classified);
    byCategory[item.category] = (byCategory[item.category] || 0) + 1;
  }

  return {
    tool: "scar-scan",
    planId: plan.planId ?? null,
    planDir: plan.planDirRel ?? null,
    gitAvailable,
    categories,
    // Two different numbers, and conflating them was defect (2) of decisions.md D-010.
    // REPORTED = how many categories produced a status row at all (the floor's subject).
    // RAN = how many actually completed; a category that degraded is NOT counted here,
    // because --self-check and the banner must never let a degraded one look clean.
    categoriesReported: categories.length,
    categoriesRan: categories.filter((c) => c.status === "ran").length,
    counts: { inherited: inherited.length, introduced: introduced.length, byCategory },
    inherited,
    introduced,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const describe = (i) =>
  `[${i.category}/${i.kind}] ${i.file ?? "(no file)"}${i.line ? `:${i.line}` : ""} — ${i.evidence}`;

/**
 * Human-readable report.
 * Contract: (report) -> string[] of lines. The INTRODUCED list is NEVER
 * truncated (it is the actionable half). The INHERITED list is capped per
 * category at INHERITED_PRINT_LIMIT with an explicit "and N more" line, so a
 * 64-item backlog does not bury the part a reader must act on; `--json` always
 * carries every item.
 */
export function formatReport(report) {
  const out = [];
  out.push(`scar-scan: ${report.planId ?? "(no active plan)"}${report.planDir ? ` (${report.planDir})` : ""}`);
  out.push("");
  out.push("Categories:");
  for (const c of report.categories) {
    out.push(`  ${c.id}  ${c.key.padEnd(22)} ${c.status.padEnd(12)} ${String(c.findings).padStart(3)} finding(s)  — ${c.note}`);
  }
  const degraded = report.categories.filter((c) => c.status !== "ran");
  out.push("");
  out.push(degraded.length === 0
    ? "All categories ran. No category degraded."
    : `DEGRADED: ${degraded.map((c) => c.id).join(", ")} — a degraded category is NOT a clean category.`);

  out.push("");
  out.push(`## Introduced (${report.introduced.length})`);
  if (report.introduced.length === 0) {
    out.push("  (none — nothing this plan's changelog touched carries new residue)");
  } else {
    for (const i of report.introduced) {
      out.push(`  ${describe(i)}`);
      out.push(`      why: ${i.why}`);
      out.push(`      fix: ${i.remediation}`);
    }
  }

  out.push("");
  out.push(`## Inherited (${report.inherited.length})`);
  if (report.inherited.length === 0) {
    out.push("  (none)");
  } else {
    for (const c of CATEGORIES) {
      const items = report.inherited.filter((i) => i.category === c.id);
      if (items.length === 0) continue;
      out.push(`  ${c.id} — ${c.title}: ${items.length} item(s), NOT this plan's regression`);
      for (const i of items.slice(0, INHERITED_PRINT_LIMIT)) out.push(`    ${describe(i)}`);
      if (items.length > INHERITED_PRINT_LIMIT) {
        out.push(`    ... and ${items.length - INHERITED_PRINT_LIMIT} more (use --json for the full list)`);
      }
      const commands = [...new Set(items.map((i) => i.remediation).filter(Boolean))];
      for (const cmd of commands.slice(0, 5)) out.push(`    suggested: ${cmd}`);
      if (commands.length > 5) out.push(`    ... and ${commands.length - 5} more suggested commands (--json)`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isEntryPoint = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    console.log(`scar-scan — partitioned hygiene sweep (report, not a gate)

Usage: node scar-scan.mjs [--plan-dir <dir>] [--json] [--self-check]

  --plan-dir <dir>  sweep this plan directory instead of plans/.current_plan
  --json            emit the full machine-readable report (nothing truncated)
  --self-check      run the sweep and report how many of the ${EXPECTED_MIN_CATEGORIES} categories
                    actually ran, naming every degraded one

Exit codes:
  0  the scan completed, regardless of what it found
  1  [scan-unavailable] upstream validator absent/crashed/unparseable, or
     [scan-floor] fewer than EXPECTED_MIN_CATEGORIES categories ran

On [scan-unavailable] NOTHING is written to stdout — not even in --json. A
false all-clear is the worst output this tool can produce.`);
    process.exit(EXIT_OK);
  }

  // root override: opt-in env var read HERE only (inside isEntryPoint), so tests can
  // spawn real CLI failure branches against fixture roots without touching module scope.
  const root = process.env.IP_SCAR_SCAN_ROOT ?? process.cwd();
  const validatorPath =
    process.env.IP_SCAR_SCAN_VALIDATOR ??
    join(dirname(fileURLToPath(import.meta.url)), "validate-plan.mjs");
  const planDirIdx = args.indexOf("--plan-dir");
  const planDirArg = planDirIdx !== -1 ? args[planDirIdx + 1] ?? null : null;
  const asJson = args.includes("--json");
  const selfCheck = args.includes("--self-check");

  const report = runScan({ root, planDirArg, validatorPath });

  if (report.unavailable) {
    // Stdout stays EMPTY on this path. See the header: a consumer must never be
    // able to read an untrustworthy scan as a clean one.
    console.error(`scar-scan: FAIL [scan-unavailable] — ${report.unavailable}`);
    console.error("scar-scan: no findings reported; this is NOT an all-clear.");
    process.exit(EXIT_UNTRUSTWORTHY);
  }

  // DECISION plan-2026-09-09T082122-64c4de78/D-010 — the floor guards categoriesREPORTED,
  // never categoriesRan. Two failure shapes look alike in a count and are opposites: a
  // category DELETED from the sweep body (vacuity — CATEGORIES still lists it, the pin test
  // still passes, and the report quietly covers less than it claims) versus a category that
  // DEGRADED at runtime because git is absent (legitimate — B and E say `unavailable`, and
  // the header promises A/C/D still run and the process still exits 0). Testing `ran` here
  // would turn every non-git run into a hard failure and destroy the honest partial report
  // this tool exists to produce. Degradation is reported loudly instead — by the banner, by
  // --self-check, and by each row's own status. See decisions.md D-010.
  if (report.categoriesReported < EXPECTED_MIN_CATEGORIES) {
    console.error(
      `scar-scan: FAIL [scan-floor] — only ${report.categoriesReported} categor(ies) reported a status, below EXPECTED_MIN_CATEGORIES = ${EXPECTED_MIN_CATEGORIES}`,
    );
    console.error("scar-scan: no findings reported; this is NOT an all-clear.");
    process.exit(EXIT_UNTRUSTWORTHY);
  }

  if (selfCheck) {
    const degradedCats = report.categories.filter((c) => c.status !== "ran");
    console.log(`scar-scan --self-check: ${report.categoriesRan}/${report.categoriesReported} categories ran`);
    console.log(
      degradedCats.length === 0
        ? "  no category degraded."
        : `  ${degradedCats.length} DEGRADED: ${degradedCats.map((c) => `${c.id} (${c.status})`).join(", ")} — a degraded category is NOT a clean category.`,
    );
    for (const c of report.categories) {
      console.log(`  ${c.id}  ${c.key.padEnd(22)} ${c.status.padEnd(12)} — ${c.note}`);
    }
    const pinned = CATEGORIES.length === EXPECTED_MIN_CATEGORIES;
    console.log(
      pinned
        ? `  floor pinned: EXPECTED_MIN_CATEGORIES == CATEGORIES.length == ${CATEGORIES.length}`
        : `  FLOOR DRIFT: EXPECTED_MIN_CATEGORIES = ${EXPECTED_MIN_CATEGORIES} but CATEGORIES.length = ${CATEGORIES.length}`,
    );
    if (!pinned) process.exit(EXIT_UNTRUSTWORTHY);
    process.exit(EXIT_OK);
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(EXIT_OK);
  }

  for (const line of formatReport(report)) console.log(line);
  process.exit(EXIT_OK);
}
