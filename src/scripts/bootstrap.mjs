#!/usr/bin/env node
// Bootstrap and manage plan directories under plans/ in the current working directory (project root).
//
// Usage:
//   node bootstrap.mjs "goal"                  Create a new plan (backward-compatible)
//   node bootstrap.mjs new "goal"              Create a new plan
//   node bootstrap.mjs new --force "goal"      Close active plan and create a new one
//   node bootstrap.mjs resume                  Output current plan state for re-entry
//   node bootstrap.mjs status                  One-line state summary
//   node bootstrap.mjs close                   Close active plan (preserves directory)
//   node bootstrap.mjs list                    Show all plan directories (active and closed)
//
// Creates plans/plan-YYYY-MM-DDTHHMMSS-XXXXXXXX/ (UTC timestamp + 8-char hex seed) in cwd.
// Dirs created before v2.36.0 use the legacy plan_YYYY-MM-DD_XXXXXXXX shape; they are still
// read by every command, but are never minted again (shared.mjs D-005 / D-003: one write
// grammar, one read union).
// Writes plans/.current_plan with the directory name for discovery.
// Requires Node.js 18+ (guaranteed by Claude Code).

import { mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, unlinkSync, existsSync, rmSync, copyFileSync, openSync, closeSync } from "fs";
import { join, extname } from "path";
import { randomBytes, createHash } from "crypto";
import {
  extractField,
  splitChangelogFields,
  blankCompressedSummaryBlock,
  htmlCommentSpans,
  COMPRESSED_SUMMARY_OPEN,
  COMPRESSED_SUMMARY_CLOSE,
  CHANGELOG_COMPRESSED_INLINE_RE,
  PLAN_ID_RE,
  ANY_PLAN_ID_RE,
  PLAN_DIR_PREFIX_RE,
  PLAN_SECTION_PATTERN,
  planDateFromId,
  DECISION_ID_NUM_PATTERN,
} from "./shared.mjs";
// DECISION plan_2026-07-14_79ee0f59/D-002 — THE CHANGELOG IS A MARKDOWN FILE, AND AN APPEND IS ONE
// LINE. Do NOT re-encode it (XML, JSON, SQLite, …) and do NOT route writes through a document
// library. v2.33.0 did exactly that and it was REVERTED in v2.35.0: turning the one-line append
// into a parse -> splice -> re-serialize -> rename of the WHOLE file made every write a
// read-modify-write, and concurrent executors then silently dropped each other's entries from an
// append-only evidence ledger (measured: 16 parallel appends against a 3,000-entry ledger recorded
// 1, every process exiting 0). The lock added to fix that had a TOCTOU in its stale-recovery path.
// A single-line append needs none of it, and this file writes the changelog with writeFileSync.
//
// What survived that work is schema.mjs — the changelog's field SHAPES, defined exactly once and
// consumed by validate-plan.mjs. If a field shape is ever needed HERE, import it from schema.mjs;
// never re-derive a changelog field regex in this file.
// See decisions.md D-002.
// Re-exported so bootstrap.test.mjs can probe it via the bootstrap entrypoint.
export { splitChangelogFields };

const cwd = process.cwd();
const plansDir = join(cwd, "plans");
const pointerFile = join(plansDir, ".current_plan");
const lockFile = join(plansDir, ".lock");

const SKILL_VERSION_RE = /^\d+\.\d+\.\d+$/;

// DECISION plan_2026-07-14_317362c4/D-004 — resolve the skill version by PROBING TWO LAYOUTS,
// installed-first, and NEVER throw.
//
// Do NOT copy check-readme-parity.mjs's fixed `join(dirname(...), "..", "..", "VERSION")`. That
// script only ever runs in the dev tree (src/scripts/ → repo root, 2 levels up). bootstrap.mjs
// also ships INSIDE the package, where scripts live one level shallower
// (~/.claude/skills/iterative-planner/scripts/) — the same 2-level path there resolves to
// ~/.claude/skills/, i.e. some other skill's territory. So: <script>/../VERSION (installed) is
// probed BEFORE <script>/../../VERSION (dev); first hit wins.
//
// Do NOT let a filesystem error escape. A missing/unreadable VERSION must degrade to the string
// "unknown", never to an exception: an uncaught ENOENT here would crash `bootstrap.mjs new` on
// every fresh install and the whole skill would be dead on arrival. Cosmetic metadata is not
// worth a crash. Garbage content (empty, multi-line, "not-a-version") is treated the same way.
// See decisions.md D-004.
function resolveSkillVersion() {
  for (const rel of ["../VERSION", "../../VERSION"]) {
    try {
      const raw = readFileSync(new URL(rel, import.meta.url), "utf-8").trim();
      if (SKILL_VERSION_RE.test(raw)) return raw;
    } catch {
      // Unreadable at this layout — try the next probe, then fall through to "unknown".
    }
  }
  return "unknown";
}

// NOTE: concurrent-new race fix (OBS-003).
// Pre-fix: two parallel `bootstrap.mjs new` invocations both passed
// `readPointer() === null`, both created plan dirs, last writer won the
// pointer (loser orphaned). Worse, the loser's catch handler unconditionally
// unlinked the pointer file — under race the WINNER's pointer could be
// nuked, leaving 2 dirs + 0 pointer ("no active plan" with phantom dirs).
//
// Fix: O_EXCL atomic creation of `plans/.lock` with current PID. Stale-PID
// detection (lock file exists but PID is dead) is best-effort recovery.
// Catch handler only deletes the pointer if THIS process actually wrote it
// (tracked via `wePersistedPointer` boolean).

function isPidAlive(pid) {
  if (!pid || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    // Signal 0 is the canonical "does process exist" probe in POSIX. On
    // Windows we don't have it cleanly; treat as "alive" (conservative —
    // assumes the user will rerun rather than auto-clear an unfamiliar lock).
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = exists but not ours; EINVAL = invalid pid; ESRCH = not found.
    return e && e.code === "EPERM";
  }
}

// Classic Levenshtein edit distance (full DP matrix). Inputs are short
// subcommand names, so the O(m*n) cost is negligible. Used by the runCli typo
// guard to detect a single bare token that is a near-miss of a subcommand.
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

function acquireLock() {
  mkdirSync(plansDir, { recursive: true });
  // Try atomic exclusive creation.
  let fd;
  try {
    fd = openSync(lockFile, "wx");
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    // Lock exists. Read PID; if stale, reclaim.
    let priorPid = null;
    try { priorPid = parseInt(readFileSync(lockFile, "utf-8").trim(), 10); } catch {}
    if (priorPid && isPidAlive(priorPid)) {
      const e = new Error(`Another bootstrap.mjs invocation is in progress (pid ${priorPid}). Retry shortly.`);
      e.code = "ELOCKED";
      throw e;
    }
    // Stale lock — remove and retry once. The retry is also racy if many
    // processes converge on the stale lock simultaneously; the second-level
    // EEXIST surfaces ELOCKED so callers see a clean failure rather than
    // silent overwrite.
    try { unlinkSync(lockFile); } catch {}
    try {
      fd = openSync(lockFile, "wx");
    } catch (err2) {
      if (err2.code === "EEXIST") {
        const e = new Error("Lock contention reclaiming stale lock. Retry shortly.");
        e.code = "ELOCKED";
        throw e;
      }
      throw err2;
    }
  }
  try {
    writeFileSync(fd, String(process.pid));
  } finally {
    closeSync(fd);
  }
  return true;
}

function releaseLock() {
  try { unlinkSync(lockFile); } catch { /* lock may already be gone */ }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureGitignore() {
  const gitignorePath = join(cwd, ".gitignore");
  const patterns = ["plans/"];
  let content = "";
  try {
    content = readFileSync(gitignorePath, "utf-8");
  } catch {
    // No .gitignore yet — will create
  }
  const missing = patterns.filter((p) => !content.split("\n").some((line) => line.trim() === p));
  if (missing.length === 0) return;
  const suffix = (content && !content.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n";
  const updated = content + suffix;
  writeFileSync(gitignorePath + ".tmp", updated);
  renameSync(gitignorePath + ".tmp", gitignorePath);
}

// Plan directory names follow this canonical shape (set by cmdNew at creation
// time). Validating the pointer against it adds defense in depth against a
// corrupted .current_plan file containing path-traversal or arbitrary content
// — existsSync alone is fail-safe in practice but doesn't reject paths like
// `../etc/something` that happen to exist.
//
// ANY_PLAN_ID_RE (the READ union: new format | legacy format) is imported from
// shared.mjs — the single definition, shared with validate-plan.mjs. Do not re-declare
// it here (see shared.mjs D-005/D-003). The pointer is *validated* with the union, not
// the write grammar: a legacy plan dir created before v2.36.0 must stay resolvable by
// status/resume/close, or the tool cannot read the plans it wrote yesterday.

// decisions.md entry headers: `## D-NNN | PHASE | YYYY-MM-DD`. Both forms are
// built from the ONE shared digit grammar so the compressor recognizes exactly
// the entries the validator's `checkDecisionsSchema` accepts. These used to be
// hand-written `D-\d+`, which was a THIRD grammar — looser than the validator
// (it accepted `D-1`), so bootstrap would happily compress an entry the validator
// rejects as a bad header.
const DECISION_HEADER_PREFIX_RE = new RegExp(`^## D-${DECISION_ID_NUM_PATTERN}\\s*\\|`);
const DECISION_HEADER_PARSE_RE = new RegExp(
  `^## (D-${DECISION_ID_NUM_PATTERN})\\s*\\|\\s*([^|]+?)\\s*\\|\\s*(\\S+)\\s*$`
);

function readPointer() {
  try {
    const name = readFileSync(pointerFile, "utf-8").trim();
    if (!name) return null;
    if (!ANY_PLAN_ID_RE.test(name)) return null;
    if (!existsSync(join(plansDir, name))) return null;
    return name;
  } catch {
    return null;
  }
}

function readPlanFile(planDirName, filename) {
  try {
    return readFileSync(join(plansDir, planDirName, filename), "utf-8");
  } catch {
    return null;
  }
}

// extractField now lives in ./shared.mjs (imported above).

// The 12 plan-file skeletons bootstrap writes, as RAW strings with {{TOKEN}} placeholders.
// Keys are emit-template.mjs's slugs. Raw strings (not functions) on purpose: only raw strings
// are byte-diffable against a doc region, which is what lets a parity gate exist at all.
//
// The `system` skeleton's schema must match references/file-formats.md ## plans/SYSTEM.md exactly.
// If you change the schema there, update this skeleton in lockstep.
export const PLAN_TEMPLATES = {
  state: `# Current State: EXPLORE
*Skill: iterative-planner v{{VERSION}}*
## Iteration: 0
## Current Plan Step: N/A
## Pre-Step Checklist (reset before each EXECUTE step)
- [ ] Re-read state.md (this file)
- [ ] Re-read plan.md
- [ ] Re-read progress.md
- [ ] Re-read decisions.md (if fix attempt)
- [ ] Checkpoint created (if risky step or irreversible op)
## Fix Attempts (resets per plan step)
- (none yet)
## Change Manifest (current iteration)
- (no changes yet)
## Last Transition: INIT → EXPLORE ({{TIMESTAMP}})
## Transition History:
- INIT → EXPLORE (task started)
<!-- When logging EXPLORE → PLAN, add Exploration Confidence on the line below the transition entry, e.g.:
- EXPLORE → PLAN (gathered enough context, YYYY-MM-DDTHH:MM:SSZ)
  - confidence: scope=deep|partial|shallow, solutions=adequate|thin, risks=clear|unclear
See references/planning-rigor.md for definitions. -->
`,

  plan: `# Plan v0

## Goal
{{GOAL}}

## Problem Statement
*To be defined during PLAN. (1) Expected behavior, (2) invariants, (3) edge cases.*

## Context
*Pending EXPLORE phase. Findings will inform the approach.*

## Files To Modify
*To be determined after EXPLORE. List every file that will be touched.*

## Steps
*To be determined after EXPLORE. Annotate each with [RISK: low/medium/high] and [deps: N,M].*

## Assumptions
*To be populated during PLAN. Each: what you assume, which finding grounds it, which steps depend on it.*

## Failure Modes
*To be determined during PLAN. For each dependency/integration: what if slow, garbage, down?*

## Pre-Mortem & Falsification Signals
*To be determined during PLAN. Assume the plan failed — 2-3 scenarios with concrete STOP IF triggers.*

## Success Criteria
*To be defined before first EXECUTE.*

## Verification Strategy
*To be defined during PLAN. For each success criterion, define what check to run and what "pass" means.*

## Complexity Budget
- Files added: 0/3 max
- New abstractions (classes/modules/interfaces): 0/2 max
- Lines added vs removed: +0/-0 (target: net negative or neutral)
`,

  decisions: `# Decision Log
*Plan: {{PLAN_ID}}*
*Skill: iterative-planner v{{VERSION}}*
*Append-only. Never edit past entries.*
{{CROSS_PLAN_NOTE}}
<!-- Schema example — DO NOT REMOVE. Real entries follow this shape.
     See references/file-formats.md "Entry Schema by Type" for required fields per entry type.
     In-code anchors carry the plan-id prefix: \`# DECISION {{PLAN_ID}}/D-NNN\` (see references/decision-anchoring.md).

## D-001 | EXPLORE → PLAN | YYYY-MM-DD
**Context**: <one-paragraph background — what was discovered in EXPLORE>
**Decision**: <chosen approach in one sentence>
**Trade-off**: <X> **at the cost of** <Y>
**Reasoning**: <why this trade-off is acceptable; what alternatives were rejected>
**Anchor-Refs**: \`path/to/file.ext:LL\`, \`other/file.ext:LL-MM\`  (required when a matching \`# DECISION {{PLAN_ID}}/D-NNN\` anchor exists in source)
-->
`,

  findings: `# Findings
*Summary and index of all findings. Detailed files go in findings/ directory.*
{{CROSS_PLAN_NOTE}}
## Index
*To be populated during EXPLORE.*

## Key Constraints
*To be populated during EXPLORE.*

## Corrections
*Append [CORRECTED iter-N] entries here when earlier findings prove wrong. Reference the original finding file and what changed.*
`,

  progress: `# Progress

## Completed
*Nothing yet.*

## In Progress
- [ ] EXPLORE: Initial context gathering

## Remaining
*To be populated from plan.md after PLAN phase.*

## Blocked
*Nothing currently.*
`,

  verification: `# Verification Results
*Populated during PLAN (template), updated during EXECUTE (per-step), completed during REFLECT (full pass).*
*Rewritten each iteration — not append-only.*

## Criteria Verification
| # | Criterion (from plan.md) | Method | Command/Action | Result | Evidence |
|---|--------------------------|--------|----------------|--------|----------|
| 1 | *To be populated during PLAN* | - | - | PENDING | - |

## Additional Checks
*Required rows below are pre-populated every REFLECT cycle. Append optional rows (lint, type checks, behavioral diffs, smoke tests) as needed.*

| Check | Command/Action | Result | Details |
|-------|----------------|--------|---------|
| Regression | *To be populated during REFLECT (re-run previously-passing tests)* | PENDING | - |
| Scope drift | *To be populated during REFLECT (compare state.md manifest vs plan.md Files To Modify)* | PENDING | - |
| Diff review | *To be populated during REFLECT (review git diff for debug artifacts, TODOs, commented-out code)* | PENDING | - |

## Not Verified
| What | Why |
|------|-----|
| *To be populated during REFLECT* | - |

## Prediction Accuracy
*Compare plan.md predictions against actual results during REFLECT.*

| Predicted (from plan.md) | Actual | Delta |
|--------------------------|--------|-------|
| *To be populated during REFLECT* | - | - |

## Convergence Metrics
*EXTENDED — iteration 2+. First iteration: write "N/A — first iteration." See references/convergence-metrics.md.*

| Metric | Previous | Current | Delta |
|--------|----------|---------|-------|
| Pass rate | - | - | - |
| Scope (planned vs changed) | - | - | - |
| New issues found | - | - | - |
| **Convergence score** | - | - | - |

## Verdict
*To be completed during REFLECT. All 5 bullets required, in order. See references/file-formats.md.*

- Criteria passed: PENDING (N/M)
- Regressions: PENDING
- Scope drift: PENDING
- Simplification blockers: PENDING
- Recommendation: PENDING (→ CLOSE / PIVOT / EXPLORE)
`,

  changelog: `# Changelog
*Append-only per-edit ledger. One line per file edit. Owner: ip-executor (writes). Reader: ip-reviewer at REFLECT.*
*Format: \`UTC | iter-N/step-M | commit | path | OP(+N,-M) | radius:TIER(score) | D-NNN-or-dash | reason\`*
*See references/blast-radius.md for radius scoring. Decision-ref optional — \`-\` means no \`# DECISION\` anchor governs this edit.*
`,

  system: `# System Atlas
*Last refreshed: (none yet) | (no plan closed yet)*
*Domain-neutral system map. Rewritten by ip-archivist at CLOSE — max 300 lines. Read before PLAN/EXPLORE.*

## Identity
*To be populated at first CLOSE. What the system is (1-2 sentences). Domain (codebase / research / ops / strategy / other).*

## Components
*5-15 top-level building blocks. One line each: \`name\` — role.*

## Boundaries
*In scope vs out of scope. External dependencies. Boundary inputs the planner reads but does not own.*

## Invariants
*Properties that must always hold (security, data, contracts, performance budgets). Each grounded in a finding-id or decision-id reference.*

## Flows
*3-7 named end-to-end flows: trigger → path → terminus.*

## Known Patterns
*Architectural archetypes the system instantiates.*

## Codebase Specialization
*Optional — present only when domain=codebase. Omit entirely for non-code systems.*
`,

  "findings-consolidated": `# Consolidated Findings
*Cross-plan findings archive. Entries merged from per-plan findings.md on close. Newest first.*
`,

  "decisions-consolidated": `# Consolidated Decisions
*Cross-plan decision archive. Entries merged from per-plan decisions.md on close. Newest first.*
`,

  lessons: `# Lessons Learned
*Cross-plan lessons. Updated and consolidated on close. Max 200 lines — rewrite, don't append forever.*
*Read before any PLAN state. This is institutional memory.*
`,

  index: `# Plan Index
*Topic-to-directory mapping. Updated on close. Survives sliding window trim.*

| Plan | Date | Goal | Key Topics |
|------|------|------|------------|
`,
};

const TOKEN_RE = /\{\{([A-Z_]+)\}\}/g;

// Substitute {{TOKEN}} placeholders in a PLAN_TEMPLATES body.
//
// SINGLE PASS, by construction: String.prototype.replace(re, fn) scans the ORIGINAL string
// left-to-right exactly once and never re-scans what it substituted in. Do NOT "improve" this
// into a loop-until-stable or a chain of per-token .replace() calls — `goal` is unsanitized user
// text (cmdNewInner takes it straight from argv), so a goal containing the literal characters
// "{{VERSION}}" would be re-entered and rewritten on a second pass.
//
// An unknown token, or a known token with no value supplied, THROWS. Do not copy
// resolveSkillVersion's degrade-to-"unknown" contract: that is right for a cosmetic version
// string and wrong for a structural file body. The throw lands in cmdNewInner's try/catch,
// which removes the partial plan dir and restores the previous pointer — a loud failure beats
// a half-written plan.
export function renderTemplate(str, values) {
  return str.replace(TOKEN_RE, (match, token) => {
    if (!Object.prototype.hasOwnProperty.call(values, token)) {
      throw new Error(`ERROR: template placeholder ${match} has no value supplied.`);
    }
    return values[token];
  });
}

function ensureConsolidatedFiles() {
  const findingsPath = join(plansDir, "FINDINGS.md");
  const decisionsPath = join(plansDir, "DECISIONS.md");
  const lessonsPath = join(plansDir, "LESSONS.md");
  if (!existsSync(findingsPath)) {
    writeFileSync(findingsPath, renderTemplate(PLAN_TEMPLATES["findings-consolidated"], {}));
  }
  if (!existsSync(decisionsPath)) {
    writeFileSync(decisionsPath, renderTemplate(PLAN_TEMPLATES["decisions-consolidated"], {}));
  }
  if (!existsSync(lessonsPath)) {
    writeFileSync(lessonsPath, renderTemplate(PLAN_TEMPLATES.lessons, {}));
  }
  const systemPath = join(plansDir, "SYSTEM.md");
  if (!existsSync(systemPath)) {
    writeFileSync(systemPath, renderTemplate(PLAN_TEMPLATES.system, {}));
  }
  const indexPath = join(plansDir, "INDEX.md");
  if (!existsSync(indexPath)) {
    writeFileSync(indexPath, renderTemplate(PLAN_TEMPLATES.index, {}));
  }
}

function prependToConsolidated(filePath, planDirName, newSection) {
  // Insert new section after the header (H1 + boilerplate + compressed summary if present),
  // before existing plan sections. Newest plans appear first.
  let existing = "";
  try { existing = readFileSync(filePath, "utf-8"); } catch { /* file may not exist */ }

  // Dedup guard: skip if this plan was already merged
  if (existing.includes(`\n## ${planDirName}\n`)) return;

  // Skip past compressed summary block if present
  const closeMarker = existing.indexOf(COMPRESSED_SUMMARY_CLOSE);
  const searchFrom = closeMarker >= 0
    ? existing.indexOf("\n", closeMarker + COMPRESSED_SUMMARY_CLOSE.length)
    : 0;

  // Find first ## plan section after the header (and after compressed summary)
  const firstH2 = searchFrom >= 0 ? existing.indexOf("\n## ", searchFrom) : -1;
  let header, body;
  if (firstH2 >= 0) {
    header = existing.slice(0, firstH2).trimEnd();
    body = existing.slice(firstH2);
  } else {
    header = existing.trimEnd();
    body = "";
  }
  const merged = header + `\n\n## ${planDirName}\n${newSection}\n` + body;
  writeFileSync(filePath + ".tmp", merged);
  renameSync(filePath + ".tmp", filePath);
}

function stripHeader(content) {
  // Strip everything before the first ## heading (the actual user content).
  // This avoids fragile exact-match regexes on boilerplate text that the agent may edit.
  const firstH2 = content.search(/^## /m);
  return firstH2 >= 0 ? content.slice(firstH2) : "";
}

export function stripCrossPlanNote(content) {
  // NOTE: OBS-008. Pre-fix: a global
  // regex replace stripped the boilerplate note wherever it appeared. If a
  // finding's prose quoted the line (e.g. while documenting the protocol's
  // own template), that quoted line was silently elided at merge.
  // Fix: only strip when the note sits in the file's PREAMBLE — within the
  // first 10 lines AND on a line by itself. Content body that quotes the
  // boilerplate is preserved verbatim.
  const lines = content.split("\n");
  const NOTE = /^\*Cross-plan context: see plans\/FINDINGS\.md[^*\n]*\*$/;
  const PREAMBLE_LINE_CAP = 10;
  const cap = Math.min(lines.length, PREAMBLE_LINE_CAP);
  for (let i = 0; i < cap; i++) {
    if (NOTE.test(lines[i])) {
      // Also consume an immediately-adjacent blank line so we don't leave
      // a double-blank seam where the note was.
      const before = lines[i - 1];
      const after = lines[i + 1];
      const dropBlankBefore = before !== undefined && before.trim() === "";
      const dropBlankAfter = after !== undefined && after.trim() === "";
      const start = dropBlankBefore ? i - 1 : i;
      const end = dropBlankAfter ? i + 1 : i;
      lines.splice(start, end - start + 1);
      // Only strip the FIRST preamble occurrence; later quoted occurrences
      // belong to content body.
      break;
    }
  }
  return lines.join("\n");
}

const CONSOLIDATED_COMPRESS_THRESHOLD = 500;
const MAX_CONSOLIDATED_PLANS = 4;
// COMPRESSED_SUMMARY_OPEN / COMPRESSED_SUMMARY_CLOSE now live in ./shared.mjs
// (imported above) so the validator recognizes the same markers this produces.

function checkConsolidatedSize(filePath, label) {
  // After merge, warn the agent if a consolidated file exceeds the compression threshold.
  // The agent (not this script) performs the actual summarization per SKILL.md protocol.
  try {
    const content = readFileSync(filePath, "utf-8");
    const lineCount = content.split("\n").length;
    if (lineCount > CONSOLIDATED_COMPRESS_THRESHOLD) {
      const hasSummary = content.includes(COMPRESSED_SUMMARY_OPEN);
      if (hasSummary) {
        console.log(`  ACTION NEEDED: ${label} is ${lineCount} lines (>${CONSOLIDATED_COMPRESS_THRESHOLD}). Update existing compressed summary.`);
      } else {
        console.log(`  ACTION NEEDED: ${label} is ${lineCount} lines (>${CONSOLIDATED_COMPRESS_THRESHOLD}). Create compressed summary — see protocol.`);
      }
    }
  } catch { /* file may not exist */ }
}

function trimConsolidatedWindow(filePath) {
  // Keep only the MAX_CONSOLIDATED_PLANS most recent plan sections.
  // Old data is still in per-plan directories — no information lost.
  let content;
  try { content = readFileSync(filePath, "utf-8"); } catch { return; }
  // Find all `## <plan-id>` section positions, BOTH grammars (shared.mjs
  // PLAN_SECTION_PATTERN). It is line-anchored (`m`), so it also catches a section
  // that begins at byte 0 with no preceding newline — the pathological
  // consolidated file that lacks the boilerplate H1 header. Each match.index is
  // already AT the heading, so slicing to `positions[N]` cleanly truncates
  // before the Nth section.
  //
  // The pattern is a STRING; this instance is local and freshly built, so no
  // `lastIndex` can be shared with any other caller. Keep it that way.
  const sectionRe = new RegExp(PLAN_SECTION_PATTERN, "gm");
  const positions = [...content.matchAll(sectionRe)].map((m) => m.index);
  if (positions.length <= MAX_CONSOLIDATED_PLANS) return;
  // Truncate after the Nth section (keep first N, they're the newest)
  const cutoff = positions[MAX_CONSOLIDATED_PLANS];
  const trimmed = content.slice(0, cutoff).trimEnd() + "\n";
  writeFileSync(filePath + ".tmp", trimmed);
  renameSync(filePath + ".tmp", filePath);
}

function mergeToConsolidated(planDirName) {
  // Merge per-plan findings.md → plans/FINDINGS.md (newest first)
  const findingsContent = readPlanFile(planDirName, "findings.md");
  if (findingsContent) {
    let stripped = stripCrossPlanNote(stripHeader(findingsContent));
    // Demote ## → ###
    stripped = stripped.replace(/^## /gm, "### ");
    // Rewrite relative findings/ links to planDirName/findings/
    stripped = stripped.replace(/\(findings\//g, `(${planDirName}/findings/`);
    stripped = stripped.trim();
    if (stripped) {
      prependToConsolidated(join(plansDir, "FINDINGS.md"), planDirName, stripped);
    }
  }

  // Merge per-plan decisions.md → plans/DECISIONS.md (newest first)
  const decisionsContent = readPlanFile(planDirName, "decisions.md");
  if (decisionsContent) {
    let stripped = stripCrossPlanNote(stripHeader(blankCompressedSummaryBlock(decisionsContent)));
    // Demote ## → ###
    stripped = stripped.replace(/^## /gm, "### ");
    stripped = stripped.trim();
    if (stripped) {
      prependToConsolidated(join(plansDir, "DECISIONS.md"), planDirName, stripped);
    }
  }
}

// ---------------------------------------------------------------------------
// Intra-plan compression (v2.18.0+): decisions.md
// ---------------------------------------------------------------------------
//
// Mirrors the cross-plan `<!-- COMPRESSED-SUMMARY -->` pattern (see SKILL.md
// "Mandatory Re-reads" + `checkConsolidatedSize`/`prependToConsolidated`
// above). Intra-plan files have NO sliding window, so compression must run
// mid-plan, owned by the orchestrator at PLAN gate-in. This helper is the
// mechanical layer: parse raw `## D-NNN` entries, emit a lookup-table block,
// insert it between the preamble and the first entry. Raw entries below
// remain UNTOUCHED — the append-only invariant is preserved as a safety net.
//
// Re-compression: when an existing block is found, it is REPLACED — we always
// summarize raw entries (never re-summarize a prior summary). The
// `entries-at-compress: N` marker comment inside the block lets us no-op when
// no new D-NNN entries have been appended since last compression.

const DECISIONS_COMPRESS_THRESHOLD = 300;
const COMPRESSED_SUMMARY_MAX_LINES = 100;
const ENTRIES_AT_COMPRESS_RE = /<!-- entries-at-compress:\s*(\d+)\s*-->/;
// F2 — fingerprint marker: 12-hex-char sha1 prefix of sorted entry IDs joined by ",".
// Detects add+delete drift that count-only idempotency missed. Back-compat: when only
// the count marker is present (legacy compressed blocks), fall back to count comparison.
const ENTRIES_FINGERPRINT_RE = /<!-- entries-fingerprint:\s*([0-9a-f]{12})\s*-->/;

function computeEntriesFingerprint(ids) {
  // ids: array of "D-NNN" strings. Sort to canonicalize, hash, take 12 hex chars (48-bit).
  const sorted = [...ids].sort();
  return createHash("sha1").update(sorted.join(",")).digest("hex").slice(0, 12);
}

/**
 * Parse decisions.md into structured entries. Returns:
 *   { preambleEnd: number, entries: Array<{
 *       id, phase, date, headerLine, body, decisionLine,
 *       anchorRefs, isPivot, startLine, endLine
 *     }>,
 *     existingBlock: { startLine, endLine, entriesAtCompress } | null,
 *     hasPreamble: boolean
 *   }
 *
 * preambleEnd is the line index (0-based, exclusive) where the compressed
 * block should be inserted. It points at the first `## D-NNN` line OR the
 * line of an existing `<!-- COMPRESSED-SUMMARY -->` block, whichever comes
 * first — so callers replace the existing block in-place.
 */
function parseDecisionsFile(content) {
  const lines = content.split("\n");
  let preambleEnd = lines.length;
  let firstEntryLine = -1;
  let existingBlockStart = -1;
  let existingBlockEnd = -1;
  let entriesAtCompress = null;
  let hasPreamble = false;

  // Locate *Plan: …* preamble (required). Mirror validate-plan.mjs
  // parseDecisionsEntries: only the first 10 NON-BLANK lines count, so this
  // compressor and the validator agree on whether a preamble is present.
  // (plan_2026-05-30_eb9b4fee/M8 — previously this scanned the whole file, so
  // a preamble on non-blank line 11+ compressed here but ERRORed in the
  // validator.)
  let nonBlankSeen = 0;
  for (let i = 0; i < lines.length && nonBlankSeen < 10; i++) {
    const t = lines[i].trim();
    if (t === "") continue;
    nonBlankSeen += 1;
    if (/^\*Plan:\s*/.test(t)) { hasPreamble = true; break; }
  }

  // Locate existing compressed block (if any) — first occurrence wins
  let entriesFingerprint = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(COMPRESSED_SUMMARY_OPEN)) {
      existingBlockStart = i;
      for (let j = i; j < lines.length; j++) {
        const m = lines[j].match(ENTRIES_AT_COMPRESS_RE);
        if (m) entriesAtCompress = Number(m[1]);
        const fm = lines[j].match(ENTRIES_FINGERPRINT_RE);
        if (fm) entriesFingerprint = fm[1];
        if (lines[j].includes(COMPRESSED_SUMMARY_CLOSE)) {
          existingBlockEnd = j;
          break;
        }
      }
      break;
    }
  }

  // Locate first real `## D-NNN` header (NOT inside the schema HTML comment
  // block, NOT inside an existing compressed block).
  let inHtmlComment = false;
  let inCompressedBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Track HTML comment open/close. Comments are single-line OR span multiple
    // lines (`<!--` … `-->`). The decisions.md schema example is a multi-line
    // comment we must skip.
    if (!inHtmlComment && line.includes("<!--") && !line.includes("-->")) {
      // Open without close on the same line — multi-line comment begins
      // (but ignore the COMPRESSED-SUMMARY markers themselves)
      if (!line.includes(COMPRESSED_SUMMARY_OPEN)) inHtmlComment = true;
    } else if (inHtmlComment && line.includes("-->")) {
      inHtmlComment = false;
      continue;
    }
    if (line.includes(COMPRESSED_SUMMARY_OPEN)) inCompressedBlock = true;
    if (line.includes(COMPRESSED_SUMMARY_CLOSE)) { inCompressedBlock = false; continue; }
    if (inHtmlComment || inCompressedBlock) continue;
    if (DECISION_HEADER_PREFIX_RE.test(line)) {
      firstEntryLine = i;
      break;
    }
  }

  // Parse all real D-NNN entries (skip the schema example inside HTML comment).
  const entries = [];
  inHtmlComment = false;
  inCompressedBlock = false;
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prevInHtmlComment = inHtmlComment;
    if (!inHtmlComment && line.includes("<!--") && !line.includes("-->")) {
      if (!line.includes(COMPRESSED_SUMMARY_OPEN)) inHtmlComment = true;
    } else if (inHtmlComment && line.includes("-->")) {
      inHtmlComment = false;
      continue;
    }
    if (line.includes(COMPRESSED_SUMMARY_OPEN)) inCompressedBlock = true;
    if (line.includes(COMPRESSED_SUMMARY_CLOSE)) { inCompressedBlock = false; continue; }
    if (prevInHtmlComment || inHtmlComment || inCompressedBlock) continue;

    const headerMatch = line.match(DECISION_HEADER_PARSE_RE);
    if (headerMatch) {
      if (current) { current.endLine = i - 1; entries.push(current); }
      current = {
        id: headerMatch[1],
        phase: headerMatch[2].trim(),
        date: headerMatch[3].trim(),
        headerLine: line,
        body: [],
        decisionLine: "",
        anchorRefs: "",
        isPivot: /\bPIVOT\b/.test(headerMatch[2]),
        startLine: i,
        endLine: -1
      };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) { current.endLine = lines.length - 1; entries.push(current); }

  // Extract Decision + Anchor-Refs from each entry's body.
  // **Decision**: may span multiple lines until next **Field**: or blank line.
  for (const e of entries) {
    let i = 0;
    while (i < e.body.length) {
      const ln = e.body[i];
      const dm = ln.match(/^\*\*Decision\*\*:\s*(.*)$/);
      if (dm) {
        const parts = [dm[1]];
        for (let j = i + 1; j < e.body.length; j++) {
          const nxt = e.body[j];
          if (/^\*\*[A-Z][^*]*\*\*:/.test(nxt)) break;
          if (nxt.trim() === "") break;
          parts.push(nxt.trim());
        }
        e.decisionLine = parts.join(" ").trim();
      }
      const am = ln.match(/^\*\*Anchor-Refs\*\*:\s*(.*)$/);
      if (am) e.anchorRefs = am[1].trim();
      i++;
    }
  }

  preambleEnd = existingBlockStart >= 0 ? existingBlockStart
              : firstEntryLine >= 0 ? firstEntryLine
              : lines.length;

  return {
    lines,
    preambleEnd,
    firstEntryLine,
    entries,
    existingBlock: existingBlockStart >= 0
      ? { startLine: existingBlockStart, endLine: existingBlockEnd, entriesAtCompress, entriesFingerprint }
      : null,
    hasPreamble
  };
}

function buildDecisionsSummaryBlock(entries, beforeLines) {
  const lookup = entries.map((e) => {
    const decision = e.decisionLine || "(no Decision line)";
    const anchors = e.anchorRefs && !/^\(none/i.test(e.anchorRefs) ? e.anchorRefs : "none";
    return `- **${e.id}** | ${e.phase} | ${e.date} — ${decision}  (anchors: ${anchors})`;
  });

  const pivotNotes = entries
    .filter((e) => e.isPivot)
    .map((e) => `- ${e.id}: ${e.decisionLine || "(no Decision line)"}`);
  const pivotBlock = pivotNotes.length > 0
    ? pivotNotes.join("\n")
    : "*(none — no PIVOT entries yet)*";

  const anchored = entries
    .filter((e) => e.anchorRefs && !/^\(none/i.test(e.anchorRefs))
    .map((e) => `- ${e.id} → ${e.anchorRefs}`);
  const anchoredBlock = anchored.length > 0
    ? anchored.join("\n")
    : "*(none — no entries carry Anchor-Refs yet)*";

  const fingerprint = computeEntriesFingerprint(entries.map((e) => e.id));
  const block = [
    COMPRESSED_SUMMARY_OPEN,
    `<!-- entries-at-compress: ${entries.length} -->`,
    `<!-- entries-fingerprint: ${fingerprint} -->`,
    "## Summary (compressed)",
    `*Auto-compressed from ${beforeLines} lines (${entries.length} entries). Raw entries preserved below.*`,
    "",
    "### Decision lookup",
    ...lookup,
    "",
    "### Things NOT to do (from PIVOT entries)",
    pivotBlock,
    "",
    "### Anchored decisions",
    anchoredBlock,
    "",
    COMPRESSED_SUMMARY_CLOSE
  ];

  // Cap block content at 100 lines between markers (mirrors cross-plan convention).
  // Markers themselves are not counted in the 100.
  const open = block[0];
  const close = block[block.length - 1];
  let body = block.slice(1, -1);
  if (body.length > COMPRESSED_SUMMARY_MAX_LINES) {
    body = body.slice(0, COMPRESSED_SUMMARY_MAX_LINES - 1);
    body.push(`*(summary truncated to ${COMPRESSED_SUMMARY_MAX_LINES} lines — see raw entries below)*`);
  }
  return [open, ...body, close];
}

/**
 * Compress {planDir}/decisions.md if line count exceeds threshold.
 * Append-only safe: inserts/replaces a `<!-- COMPRESSED-SUMMARY -->` block
 * between the preamble and the first `## D-NNN` entry. Never edits raw entries.
 *
 * Options:
 *   threshold (default 300) — line count above which compression triggers.
 *   dryRun   (default false) — compute metrics but do not write.
 *
 * Returns { compressed, beforeLines, afterLines, reason }.
 *   reason ∈ { "missing", "empty", "under-threshold", "too-few-entries",
 *              "no-new-entries", "no-preamble", "compressed" }.
 */
export function maybeCompressDecisions(planDir, opts = {}) {
  const { threshold = DECISIONS_COMPRESS_THRESHOLD, dryRun = false } = opts;
  const filePath = join(planDir, "decisions.md");

  let content;
  try { content = readFileSync(filePath, "utf-8"); }
  catch { return { compressed: false, beforeLines: 0, afterLines: 0, reason: "missing" }; }

  if (!content.trim()) {
    return { compressed: false, beforeLines: 0, afterLines: 0, reason: "empty" };
  }

  const beforeLines = content.split("\n").length;

  if (beforeLines <= threshold) {
    return { compressed: false, beforeLines, afterLines: beforeLines, reason: "under-threshold" };
  }

  const parsed = parseDecisionsFile(content);

  if (!parsed.hasPreamble) {
    return { compressed: false, beforeLines, afterLines: beforeLines, reason: "no-preamble" };
  }

  if (parsed.entries.length < 2) {
    return { compressed: false, beforeLines, afterLines: beforeLines, reason: "too-few-entries" };
  }

  // Idempotency: prefer fingerprint over count. Count-only is fooled by add+delete (F2).
  // - Fingerprint present: no-op iff fingerprint matches current entries.
  // - Fingerprint absent (legacy block): fall back to count-only no-op.
  if (parsed.existingBlock) {
    const currentFingerprint = computeEntriesFingerprint(parsed.entries.map((e) => e.id));
    if (parsed.existingBlock.entriesFingerprint) {
      if (parsed.existingBlock.entriesFingerprint === currentFingerprint) {
        return { compressed: false, beforeLines, afterLines: beforeLines, reason: "no-new-entries" };
      }
      // fingerprint mismatch → re-compress (drift detected).
    } else if (parsed.existingBlock.entriesAtCompress === parsed.entries.length) {
      return { compressed: false, beforeLines, afterLines: beforeLines, reason: "no-new-entries" };
    }
  }

  const block = buildDecisionsSummaryBlock(parsed.entries, beforeLines);

  // Splice: replace [preambleEnd, existingBlockEnd] with block, or insert
  // block at preambleEnd if no prior block.
  let newLines;
  if (parsed.existingBlock) {
    const before = parsed.lines.slice(0, parsed.existingBlock.startLine);
    const after = parsed.lines.slice(parsed.existingBlock.endLine + 1);
    // Drop leading blank line in `after` to avoid runaway blank growth.
    while (after.length > 0 && after[0].trim() === "") after.shift();
    newLines = [...before, ...block, "", ...after];
  } else {
    const before = parsed.lines.slice(0, parsed.preambleEnd);
    const after = parsed.lines.slice(parsed.preambleEnd);
    // Ensure a blank line separates preamble from block, and block from first entry.
    while (before.length > 0 && before[before.length - 1].trim() === "") before.pop();
    newLines = [...before, "", ...block, "", ...after];
  }

  const newContent = newLines.join("\n");
  const afterLinesCount = newContent.split("\n").length;

  if (!dryRun) {
    writeFileSync(filePath + ".tmp", newContent);
    renameSync(filePath + ".tmp", filePath);
  }

  return { compressed: true, beforeLines, afterLines: afterLinesCount, reason: "compressed" };
}

// ===========================================================================
// changelog.md intra-plan compression (v2.18.0+)
//
// Append-only chronological ledger of per-file edits. Format (8 pipe-delimited
// fields):
//   UTC | iter-N/step-M | commit | path | OP(+N,-M) | radius:TIER(score) | D-NNN-or-dash | reason
//
// Strategy: preserve verbatim any line that is "load-bearing" (HIGH/UNKNOWN
// radius, REVERT op, or non-`-` decision-ref). Group consecutive elidable
// lines (LOW/MED radius, non-REVERT op, `-` decision-ref) and replace each
// group of >=5 with a single inline summary line that stays AT THE GROUP'S
// CHRONOLOGICAL POSITION (different from decisions.md which has a single
// top-of-file summary block). A small top-of-file metadata block records
// idempotency state (entries-at-compress count + elided group totals).
//
// Re-compression: the top-of-file metadata block is REPLACED on each pass;
// inline `- (compressed: ...)` summary lines from prior passes are themselves
// treated as preserve-verbatim (already-elided records survive).
//
// Tier extraction uses the scoring spec from references/blast-radius.md:
// tiers are LOW, MED, HIGH, UNKNOWN. Anything else is treated as UNKNOWN and
// preserved verbatim (safer-by-default).

const CHANGELOG_COMPRESS_THRESHOLD = 200;
const CHANGELOG_HEADER_LINES = 4;
const CHANGELOG_MIN_ELIDE_GROUP = 5;
// CHANGELOG_COMPRESSED_INLINE_RE now lives in ./shared.mjs (imported above) so
// validate-plan.mjs skips the same inline summary line this produces.

/**
 * Classify a changelog entry line into one of:
 *   { kind: "entry", elidable: bool, iterStep: string, path: string }  (parseable line)
 *   { kind: "inline-summary" }                                          (previous compression summary)
 *   { kind: "non-entry" }                                               (blank/malformed/header)
 *
 * Field indices (1-based per format docstring; 0-based in array after split):
 *   0: UTC timestamp
 *   1: iter-N/step-M
 *   2: commit hash (or "uncommitted")
 *   3: path
 *   4: OP(+N,-M) | NEW | REVERT(file)
 *   5: radius:TIER(score)
 *   6: D-NNN-or-dash
 *   7: reason
 */
// splitChangelogFields now lives in ./shared.mjs (imported + re-exported above).
// validate-plan.mjs imports the same function instead of reimplementing it.

/**
 * THE elidable rule — one definition.
 *
 * A record may be elided if and only if ALL THREE hold (references/file-formats.md
 * "Intra-plan compression", changelog section):
 *   - radius tier is LOW or MED  (HIGH and UNKNOWN are preserve-by-default — safer)
 *   - the op is not a REVERT
 *   - the decision-ref is `-` (no `# DECISION` anchor governs the edit)
 *
 * Takes the three fields by name, not positionally, so a caller cannot silently pass them in the
 * wrong order. Do NOT re-state this rule at a call site: a second copy of "which edits are safe to
 * lose" is a copy that will drift, and the failure mode is silent data loss from an append-only
 * ledger.
 */
function isElidableRecord({ op = "", radius = "", dref = "" }) {
  const tier = radius.match(/^radius:(LOW|MED|HIGH|UNKNOWN)/)?.[1] ?? "UNKNOWN";
  const isRevert = /^REVERT\(/.test(op);
  const isAnchored = dref !== "-" && dref !== "";
  return { tier, isRevert, isAnchored, elidable: (tier === "LOW" || tier === "MED") && !isRevert && !isAnchored };
}

function classifyChangelogLine(line) {
  if (CHANGELOG_COMPRESSED_INLINE_RE.test(line)) {
    return { kind: "inline-summary" };
  }
  if (!line.trim()) return { kind: "non-entry" };
  // Need at least 7 pipe separators for a well-formed entry (8 fields).
  const sepCount = (line.match(/\|/g) || []).length;
  if (sepCount < 7) return { kind: "non-entry" };

  // F3: split on the first 7 " | " separators only; everything after the 7th
  // belongs to `reason`. Without this, a legitimate reason containing " | "
  // (e.g. "fix race: a | b") expands to 9+ fields, gets classified as
  // non-entry, hides from compression and validator.
  const fields = splitChangelogFields(line);
  if (fields.length < 8) return { kind: "non-entry" };

  // Elidable/preserve rules: isElidableRecord() — the one definition.
  const { tier, isRevert, isAnchored, elidable } = isElidableRecord({
    op: fields[4],
    radius: fields[5],
    dref: fields[6],
  });

  return {
    kind: "entry",
    elidable,
    iterStep: fields[1],
    path: fields[3],
    tier,
    isRevert,
    isAnchored
  };
}

/**
 * Parse changelog.md into { lines, header, body, metadataBlock, entryCount }.
 *   header        — first CHANGELOG_HEADER_LINES lines (preserved verbatim)
 *   body          — lines after header, including any existing metadata block
 *                   and any inline summary lines (treated as preserve-verbatim
 *                   on re-compression).
 *   metadataBlock — { startLine, endLine, entriesAtCompress } | null
 *                   Line indices are absolute (0-based, full file).
 *   entryCount    — number of well-formed entry lines (kind=entry) in body,
 *                   used for idempotency check.
 */
function parseChangelogFile(content) {
  const lines = content.split("\n");
  const header = lines.slice(0, CHANGELOG_HEADER_LINES);

  // Locate existing top-of-file metadata block (lives AFTER header).
  let metadataBlock = null;
  for (let i = CHANGELOG_HEADER_LINES; i < lines.length; i++) {
    if (lines[i].includes(COMPRESSED_SUMMARY_OPEN)) {
      const startLine = i;
      let endLine = -1;
      let entriesAtCompress = null;
      for (let j = i; j < lines.length; j++) {
        const m = lines[j].match(ENTRIES_AT_COMPRESS_RE);
        if (m) entriesAtCompress = Number(m[1]);
        if (lines[j].includes(COMPRESSED_SUMMARY_CLOSE)) {
          endLine = j;
          break;
        }
      }
      if (endLine >= 0) metadataBlock = { startLine, endLine, entriesAtCompress };
      break;
    }
    // Stop at the first real body line (the true structural boundary). The
    // metadata block only ever lives in the leading comment/blank region
    // between the header and the first entry; once we hit an entry line (or a
    // `## ` heading) the block cannot be below us. Using the structural
    // boundary instead of a fixed `+8` line budget means a block pushed deeper
    // (e.g. to line 13+ by surrounding blank lines) is still detected.
    if (classifyChangelogLine(lines[i]).kind === "entry" || lines[i].startsWith("## ")) break;
  }

  // entryCount counts BOTH live entry lines AND the entry-equivalents
  // recorded in surviving inline summary lines (`- (compressed: N ...)`),
  // so the idempotency comparison `entriesAtCompress === entryCount` holds
  // across passes that have already elided most entries.
  let entryCount = 0;
  const bodyStart = CHANGELOG_HEADER_LINES;
  for (let i = bodyStart; i < lines.length; i++) {
    // Skip lines inside the metadata block (they are not entries).
    if (metadataBlock && i >= metadataBlock.startLine && i <= metadataBlock.endLine) continue;
    const cls = classifyChangelogLine(lines[i]);
    if (cls.kind === "entry") entryCount++;
    else if (cls.kind === "inline-summary") {
      const m = lines[i].match(/^- \(compressed: (\d+) low-decision-impact edits/);
      if (m) entryCount += Number(m[1]);
    }
  }

  return { lines, header, bodyStart, metadataBlock, entryCount };
}

/**
 * Compress {planDir}/changelog.md if its line count exceeds `threshold`.
 *
 * Behavior FROZEN, and pinned to exact bytes by a golden-bytes test (bootstrap.test.mjs,
 * "LEGACY FREEZE"). Every byte this produces is what the v2.32.0 compressor produced. Compression
 * rewrites an append-only evidence ledger, so a silent drift here silently rewrites history.
 *
 * Behavior: chronology-preserving inline elision. Consecutive groups of >=5
 * elidable lines (LOW/MED tier, non-REVERT, `-` decision-ref) are replaced
 * with a single inline summary `- (compressed: N low-decision-impact edits, ...)`
 * at the group's position. A top-of-file metadata block records totals for
 * idempotency.
 *
 * No-op conditions (compressed=false):
 *   - "missing"          file does not exist / unreadable
 *   - "empty"            file has no content
 *   - "under-threshold"  line count <= threshold
 *   - "no-elidable-groups"  no group of >=5 consecutive elidable lines exists
 *   - "no-new-entries"   prior metadata block records same entry count
 *
 * Options:
 *   threshold (default 200) — line count above which compression triggers.
 *   dryRun   (default false) — compute metrics but do not write.
 *
 * Returns { compressed, beforeLines, afterLines, elidedCount, reason } — the 5-key shape is a
 * CONTRACT: ip-orchestrator's PLAN gate dispatches this by dynamic import and JSON-stringifies the
 * result. Do not add, drop, or rename a key.
 *   elidedCount = number of inline summary lines INSERTED this pass
 *                 (existing prior summary lines are preserved but not counted).
 */
export function maybeCompressChangelog(planDir, opts = {}) {
  const { threshold = CHANGELOG_COMPRESS_THRESHOLD, dryRun = false } = opts;
  const filePath = join(planDir, "changelog.md");

  let content;
  try { content = readFileSync(filePath, "utf-8"); }
  catch { return { compressed: false, beforeLines: 0, afterLines: 0, elidedCount: 0, reason: "missing" }; }

  if (!content.trim()) {
    return { compressed: false, beforeLines: 0, afterLines: 0, elidedCount: 0, reason: "empty" };
  }

  // Preserve trailing-newline character semantics.
  const hadTrailingNewline = content.endsWith("\n");
  const beforeLines = content.split("\n").length;

  if (beforeLines <= threshold) {
    return { compressed: false, beforeLines, afterLines: beforeLines, elidedCount: 0, reason: "under-threshold" };
  }

  const parsed = parseChangelogFile(content);

  // Idempotency: if a metadata block exists and entry count is unchanged
  // since last compression, no-op. (Existing inline summary lines from
  // prior compression do not count as entries — see classifyChangelogLine.)
  if (parsed.metadataBlock && parsed.metadataBlock.entriesAtCompress === parsed.entryCount) {
    return { compressed: false, beforeLines, afterLines: beforeLines, elidedCount: 0, reason: "no-new-entries" };
  }

  // Walk body lines, drop the OLD metadata block (will be regenerated),
  // collect each line's classification, and identify elidable groups.
  // We rebuild the body as a list of either {keep: line} or {elide: classification}.
  const bodyLines = [];
  for (let i = parsed.bodyStart; i < parsed.lines.length; i++) {
    if (parsed.metadataBlock && i >= parsed.metadataBlock.startLine && i <= parsed.metadataBlock.endLine) continue;
    bodyLines.push(parsed.lines[i]);
  }
  // Strip leading blank lines that may have surrounded the old metadata block.
  while (bodyLines.length > 0 && bodyLines[0].trim() === "") bodyLines.shift();

  // Classify each body line. Identify contiguous runs of elidable entry lines.
  const classified = bodyLines.map((ln) => ({ line: ln, cls: classifyChangelogLine(ln) }));

  // Find runs: index ranges [start, end) of consecutive elidable entries.
  const runs = [];
  let runStart = -1;
  for (let i = 0; i <= classified.length; i++) {
    const isElidable = i < classified.length && classified[i].cls.kind === "entry" && classified[i].cls.elidable;
    if (isElidable && runStart < 0) {
      runStart = i;
    } else if (!isElidable && runStart >= 0) {
      runs.push({ start: runStart, end: i });
      runStart = -1;
    }
  }

  // Filter runs to only those meeting the minimum group size.
  const elideRuns = runs.filter((r) => (r.end - r.start) >= CHANGELOG_MIN_ELIDE_GROUP);

  if (elideRuns.length === 0) {
    return { compressed: false, beforeLines, afterLines: beforeLines, elidedCount: 0, reason: "no-elidable-groups" };
  }

  // Rebuild body, replacing each elided run with a single inline summary line.
  const newBody = [];
  let cursor = 0;
  let totalElidedLines = 0;
  for (const run of elideRuns) {
    // Emit untouched lines up to this run.
    for (; cursor < run.start; cursor++) newBody.push(classified[cursor].line);
    // Build summary for this run.
    const groupLines = classified.slice(run.start, run.end);
    const count = groupLines.length;
    totalElidedLines += count;
    const firstIter = groupLines[0].cls.iterStep;
    const lastIter = groupLines[count - 1].cls.iterStep;
    const iterRange = firstIter === lastIter ? firstIter : `${firstIter}..${lastIter}`;
    const distinctFiles = new Set(groupLines.map((g) => g.cls.path)).size;
    newBody.push(`- (compressed: ${count} low-decision-impact edits, ${iterRange}, files: ${distinctFiles})`);
    cursor = run.end;
  }
  // Tail.
  for (; cursor < classified.length; cursor++) newBody.push(classified[cursor].line);

  // Build new metadata block (sits between header and body).
  const metadataBlock = [
    COMPRESSED_SUMMARY_OPEN,
    `<!-- entries-at-compress: ${parsed.entryCount} -->`,
    `<!-- elided-groups: ${elideRuns.length}, elided-lines: ${totalElidedLines} -->`,
    COMPRESSED_SUMMARY_CLOSE
  ];

  const newLines = [...parsed.header, ...metadataBlock, ...newBody];
  let newContent = newLines.join("\n");
  // Preserve original trailing-newline semantics. split("\n").join("\n") of a
  // string ending in "\n" yields a trailing "" element joined as "\n" already,
  // so check explicitly.
  if (hadTrailingNewline && !newContent.endsWith("\n")) newContent += "\n";
  if (!hadTrailingNewline && newContent.endsWith("\n")) newContent = newContent.slice(0, -1);

  const afterLinesCount = newContent.split("\n").length;

  if (!dryRun) {
    writeFileSync(filePath + ".tmp", newContent);
    renameSync(filePath + ".tmp", filePath);
  }

  return {
    compressed: true,
    beforeLines,
    afterLines: afterLinesCount,
    elidedCount: elideRuns.length,
    reason: "compressed"
  };
}

function appendToIndex(planDirName) {
  const indexPath = join(plansDir, "INDEX.md");
  ensureConsolidatedFiles(); // creates INDEX.md if missing
  let existing = "";
  try { existing = readFileSync(indexPath, "utf-8"); } catch { /* may not exist */ }

  // Dedup guard
  if (existing.includes(`| ${planDirName} |`)) return;

  // Extract goal and date from plan files
  const plan = readPlanFile(planDirName, "plan.md");
  const goal = extractField(plan, /\n## Goal\s*\n([\s\S]+?)(?=\n## |$)/) || "No goal";
  // Strip leading blank lines before taking the first content line — guards
  // against a goal section that begins with a blank line, which would
  // otherwise produce an empty INDEX.md goal column.
  const goalFirstNonBlank = goal.split("\n").find((l) => l.trim().length > 0) || "No goal";
  const goalOneLine = goalFirstNonBlank.slice(0, 60);
  // Date column: both grammars (`plan_YYYY-MM-DD_…` and `plan-YYYY-MM-DDTHHMMSS-…`)
  // via shared.mjs. A name that is not a plan-id yields null → "unknown", as before.
  const date = planDateFromId(planDirName) || "unknown";

  // Extract key topics from findings.md ## Index section only (first 3 topic slugs).
  // Only pick links of the form `[label](target)` — bare brackets like
  // [CORRECTED], [TODO], [WIP] are not topic labels and must not pollute the
  // index column.
  const findings = readPlanFile(planDirName, "findings.md");
  let topics = "";
  if (findings) {
    const indexStart = findings.indexOf("\n## Index");
    if (indexStart >= 0) {
      const afterIndex = findings.indexOf("\n## ", indexStart + 1);
      const indexBody = afterIndex >= 0 ? findings.slice(indexStart, afterIndex) : findings.slice(indexStart);
      const linkRe = /\[([^\]]+)\]\(/g;
      const linkLabels = [];
      let lm;
      while ((lm = linkRe.exec(indexBody)) !== null) linkLabels.push(lm[1]);
      if (linkLabels.length > 0) {
        topics = linkLabels.slice(0, 3).map((t) => t.toLowerCase()).join(", ");
      }
    }
  }

  const safeGoal = goalOneLine.replace(/\|/g, "\\|");
  // F4 — escape pipes in topics column too (was missing; goal was already escaped).
  // A finding link like `[auth | session](findings/auth.md)` would otherwise inject
  // an extra `|` into the INDEX.md row and break table cell alignment.
  const safeTopics = topics.replace(/\|/g, "\\|");
  const row = `| ${planDirName} | ${date} | ${safeGoal} | ${safeTopics} |\n`;
  const updated = existing.trimEnd() + "\n" + row;
  writeFileSync(indexPath + ".tmp", updated);
  renameSync(indexPath + ".tmp", indexPath);
}

function snapshotLessons(planDirName) {
  const lessonsPath = join(plansDir, "LESSONS.md");
  const snapshotPath = join(plansDir, planDirName, "lessons_snapshot.md");
  try {
    if (existsSync(lessonsPath)) {
      copyFileSync(lessonsPath, snapshotPath);
    }
  } catch { /* snapshot is best-effort */ }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdNew(goal, force) {
  mkdirSync(plansDir, { recursive: true });

  // D-004 — acquire exclusive lock before ANY pointer/dir mutation. Releases
  // in finally below. Stale lock (dead PID) is reclaimed transparently.
  try {
    acquireLock();
  } catch (err) {
    if (err.code === "ELOCKED") {
      console.error(`ERROR: ${err.message}`);
      console.error(`  If you are certain no other bootstrap.mjs is running, delete plans/.lock manually.`);
      process.exit(1);
    }
    throw err;
  }

  // Run inner. cmdNewInner throws structured errors (code = "EACTIVE" /
  // "ECREATE" / "EBADPLANID") for paths that previously called process.exit()
  // directly — process.exit skips finally blocks, leaking the lock. We catch
  // here, release the lock, THEN exit with the appropriate code.
  let exitCode = 0;
  try {
    cmdNewInner(goal, force);
  } catch (err) {
    if (err && (err.code === "EACTIVE" || err.code === "ECREATE" || err.code === "EBADPLANID")) {
      if (err.message) console.error(err.message);
      exitCode = 1;
    } else {
      releaseLock();
      throw err;
    }
  } finally {
    releaseLock();
  }
  if (exitCode !== 0) process.exit(exitCode);
}

function cmdNewInner(goal, force) {
  // Track whether THIS invocation wrote the pointer file (D-004). The catch
  // handler at the bottom must only unlink the pointer it itself committed —
  // otherwise a partial-failure path can nuke another invocation's pointer
  // (only possible if lock acquisition is bypassed, but defensive).
  let wePersistedPointer = false;

  // Warn about orphaned plan directories (pointer file exists but is corrupted/stale)
  try {
    const activeName = readPointer();
    let pointerFileExists = false;
    try { readFileSync(pointerFile, "utf-8"); pointerFileExists = true; } catch { /* no pointer file */ }
    if (!activeName && pointerFileExists) {
      const allPlans = readdirSync(plansDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && PLAN_DIR_PREFIX_RE.test(d.name))
        .map((d) => d.name);
      if (allPlans.length > 0) {
        console.error(`WARNING: Pointer file exists but points to non-existent directory. Found ${allPlans.length} plan director${allPlans.length === 1 ? "y" : "ies"}:`);
        for (const o of allPlans) console.error(`  plans/${o}`);
        console.error(`  These may be from a previous crash. Use 'list' to inspect.`);
      }
    }
  } catch { /* plans/ may be empty or not scannable */ }

  const existing = readPointer();
  if (existing && !force) {
    // D-004 — throw structured error so cmdNew wrapper's finally releases the lock.
    const msg =
      `ERROR: Active plan directory already exists: plans/${existing}\n` +
      `  To resume:      node ${process.argv[1]} resume\n` +
      `  To view status:  node ${process.argv[1]} status\n` +
      `  To close it:     node ${process.argv[1]} close\n` +
      `  To force new:    node ${process.argv[1]} new --force "goal"`;
    const e = new Error(msg);
    e.code = "EACTIVE";
    throw e;
  }
  if (existing && force) {
    // We already hold the lock (acquired in cmdNew) — tell cmdClose not to
    // re-acquire it (would EEXIST against our own lock). D-003.
    cmdClose({ silent: true, _holdsLock: true });
  }
  // Save old pointer name for recovery if --force was used and new plan creation fails
  const previousPlan = force ? existing : null;

  const now = new Date();
  const timestamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  // DECISION plan_2026-07-14_317362c4/D-001 — the plan-dir stamp is UTC and DELIBERATELY
  // colon-free: `plan-2026-07-14T051317-317362c4`, not the ISO-8601 `…T05:13:17…`. Do NOT
  // "restore" the colons for spec purity — `:` is illegal in a Win32/NTFS filename (it
  // denotes an Alternate Data Stream), and this repo ships build.ps1 and documents Windows
  // as a first-class install path, so mkdirSync would simply fail there. `toISOString()` is
  // the UTC source (never local time: plan dirs from two machines must sort consistently),
  // sliced to seconds; stripping the colons keeps HHMMSS fixed-width, so lexical order still
  // equals chronological order — which cmdList() relies on. See decisions.md D-001.
  const stampStr = now.toISOString().slice(0, 19).replace(/:/g, ""); // YYYY-MM-DDTHHMMSS
  const hexStr = randomBytes(4).toString("hex");
  const planDirName = `plan-${stampStr}-${hexStr}`;
  // Assert the WRITE grammar before anything touches disk. A dir that fails PLAN_ID_RE is a
  // dir readPointer() rejects and validate-plan.mjs ERRORs on — better to refuse to mint it
  // than to leave an unusable plan dir (and a dangling pointer) behind.
  if (!PLAN_ID_RE.test(planDirName)) {
    const e = new Error(
      `ERROR: internal — generated plan-id "${planDirName}" does not match the plan-id grammar.\n` +
      `  Refusing to create the directory. This is a bug in bootstrap.mjs; nothing was written.`
    );
    e.code = "EBADPLANID";
    throw e;
  }
  const planDir = join(plansDir, planDirName);

  // Stamp the skill version that minted this plan into state.md + decisions.md. Resolution
  // never throws; a missing/garbage VERSION file degrades to "unknown" (D-004).
  const skillVersion = resolveSkillVersion();

  // Check if consolidated files exist for cross-plan context seeding
  const hasConsolidated = existsSync(join(plansDir, "FINDINGS.md")) || existsSync(join(plansDir, "DECISIONS.md")) || existsSync(join(plansDir, "LESSONS.md"));
  const crossPlanNote = hasConsolidated ? "\n*Cross-plan context: see plans/FINDINGS.md, plans/DECISIONS.md, and plans/LESSONS.md*\n" : "";

  try {
    mkdirSync(join(planDir, "checkpoints"), { recursive: true });
    mkdirSync(join(planDir, "findings"), { recursive: true });

    const values = {
      VERSION: skillVersion,
      PLAN_ID: planDirName,
      GOAL: goal,
      TIMESTAMP: timestamp,
      CROSS_PLAN_NOTE: crossPlanNote,
    };
    for (const slug of ["state", "plan", "decisions", "findings", "progress", "verification", "changelog"]) {
      writeFileSync(join(planDir, `${slug}.md`), renderTemplate(PLAN_TEMPLATES[slug], values));
    }

    // Ensure consolidated files exist at plans/ root
    ensureConsolidatedFiles();

    writeFileSync(pointerFile + ".tmp", planDirName);
    renameSync(pointerFile + ".tmp", pointerFile);
    wePersistedPointer = true;
  } catch (err) {
    try { rmSync(planDir, { recursive: true, force: true }); } catch (e) { console.error(`WARNING: Failed to clean up partial plan directory: ${planDir}`); }
    try { if (existsSync(pointerFile + ".tmp")) unlinkSync(pointerFile + ".tmp"); } catch (e) { console.error("WARNING: Failed to clean up temp pointer file."); }
    // If --force was used, restore the old pointer so the previous plan is not orphaned
    if (previousPlan) {
      try {
        writeFileSync(pointerFile + ".tmp", previousPlan);
        renameSync(pointerFile + ".tmp", pointerFile);
        console.error(`WARNING: Restored pointer to previous plan: plans/${previousPlan}`);
      } catch (e) { console.error(`WARNING: Failed to restore pointer to previous plan: plans/${previousPlan}`); }
    } else if (wePersistedPointer) {
      // D-004 — only unlink pointer we ourselves wrote. Pre-fix this branch
      // ran unconditionally and could nuke another invocation's pointer under
      // race conditions (now prevented by the lock, kept as defense-in-depth).
      try { if (existsSync(pointerFile)) unlinkSync(pointerFile); } catch (e) { console.error("WARNING: Failed to clean up pointer file."); }
    }
    // D-004 — throw structured error so cmdNew wrapper's finally releases the lock.
    const wrapped = new Error(`ERROR: Failed to create plan directory: ${err.message}`);
    wrapped.code = "ECREATE";
    throw wrapped;
  }

  try {
    ensureGitignore();
  } catch (err) {
    console.error(`WARNING: Plan created but .gitignore update failed: ${err.message}`);
    console.error(`  Manually add plans/ to .gitignore.`);
  }

  console.log(`Initialized plans/${planDirName}/`);
  console.log(`  Pointer: plans/.current_plan → ${planDirName}`);
  console.log(`  Goal: ${goal}`);
  console.log(`  State: EXPLORE (iteration 0)`);
  console.log(`  Cross-plan context: plans/FINDINGS.md, plans/DECISIONS.md, plans/LESSONS.md, plans/SYSTEM.md`);
  console.log(`  Next: Read code, ask questions, write findings.`);
}

function cmdResume() {
  const planDirName = readPointer();
  if (!planDirName) {
    console.error("ERROR: No active plan. Use `new` to create one.");
    process.exit(1);
  }

  const state = readPlanFile(planDirName, "state.md");
  const plan = readPlanFile(planDirName, "plan.md");
  const progress = readPlanFile(planDirName, "progress.md");
  const decisions = readPlanFile(planDirName, "decisions.md");

  const currentState = extractField(state, /^# Current State:\s*(.+)$/m) || "UNKNOWN";
  const iteration = extractField(state, /^## Iteration:\s*(.+)$/m) || "?";
  const step = extractField(state, /^## Current Plan Step:\s*(.+)$/m) || "N/A";
  const lastTransition = extractField(state, /^## Last Transition:\s*(.+)$/m) || "?";
  const goal = extractField(plan, /\n## Goal\s*\n([\s\S]+?)(?=\n## |$)/) || "No goal found";

  console.log(`Resuming plans/${planDirName}/`);
  console.log(`  State:      ${currentState}`);
  console.log(`  Iteration:  ${iteration}`);
  console.log(`  Step:       ${step}`);
  console.log(`  Goal:       ${goal.split("\n")[0]}`);
  console.log(`  Last:       ${lastTransition}`);
  console.log();

  // Print progress summary
  if (progress) {
    const completed = (progress.match(/^- \[x\].+$/gm) || []).length;
    const remaining = (progress.match(/^- \[ \].+$/gm) || []).length;
    console.log(`  Progress:   ${completed} done, ${remaining} remaining`);
  }

  // Print decision count
  if (decisions) {
    const decisionCount = (decisions.match(new RegExp(`^## D-${DECISION_ID_NUM_PATTERN}`, "gm")) || []).length;
    if (decisionCount > 0) {
      console.log(`  Decisions:  ${decisionCount} logged`);
    }
  }

  // Print checkpoint listing
  const checkpointDir = join(plansDir, planDirName, "checkpoints");
  let checkpointFiles = [];
  try {
    checkpointFiles = readdirSync(checkpointDir).filter((f) => f.endsWith(".md")).sort();
  } catch { /* checkpoints dir may not exist */ }
  if (checkpointFiles.length > 0) {
    console.log();
    console.log(`  Checkpoints (${checkpointFiles.length}):`);
    for (const cp of checkpointFiles) {
      console.log(`    ${cp} → plans/${planDirName}/checkpoints/${cp}`);
    }
  } else {
    console.log();
    console.log(`  Checkpoints: none`);
  }

  console.log();
  console.log(`  Recovery files:`);
  console.log(`    state.md     → plans/${planDirName}/state.md`);
  console.log(`    plan.md      → plans/${planDirName}/plan.md`);
  console.log(`    decisions.md → plans/${planDirName}/decisions.md`);
  console.log(`    progress.md  → plans/${planDirName}/progress.md`);
  console.log(`    findings.md  → plans/${planDirName}/findings.md`);
  console.log(`    verification.md → plans/${planDirName}/verification.md`);
  console.log();
  console.log(`  Consolidated context:`);
  console.log(`    plans/FINDINGS.md  — cross-plan findings archive`);
  console.log(`    plans/DECISIONS.md — cross-plan decision archive`);
  console.log(`    plans/LESSONS.md   — cross-plan lessons (read before PLAN)`);
  console.log(`    plans/SYSTEM.md    — system atlas (read before EXPLORE/PLAN)`);
}

function cmdStatus() {
  const planDirName = readPointer();
  if (!planDirName) {
    console.log("No active plan.");
    process.exit(0);
  }

  const state = readPlanFile(planDirName, "state.md");
  const plan = readPlanFile(planDirName, "plan.md");

  const currentState = extractField(state, /^# Current State:\s*(.+)$/m) || "UNKNOWN";
  const iteration = extractField(state, /^## Iteration:\s*(.+)$/m) || "?";
  const step = extractField(state, /^## Current Plan Step:\s*(.+)$/m) || "N/A";
  const goal = extractField(plan, /\n## Goal\s*\n([\s\S]+?)(?=\n## |$)/) || "?";

  console.log(`[${currentState}] iter=${iteration} step=${step} | ${goal.split("\n")[0].slice(0, 60)} | plans/${planDirName}`);
}

function cmdClose(opts = {}) {
  // NOTE: standalone `close` must hold the
  // same exclusive lock as `new`, or two concurrent closes race on the
  // consolidated-file merge/trim/index writes. The `new --force` path already
  // holds the lock and passes _holdsLock, so it skips re-acquisition (avoids
  // self-deadlock against its own O_EXCL lock).
  const ownLock = !opts._holdsLock;
  if (ownLock) {
    try {
      acquireLock();
    } catch (err) {
      if (err.code === "ELOCKED") {
        if (!opts.silent) {
          console.error(`ERROR: ${err.message}`);
          console.error(`  If you are certain no other bootstrap.mjs is running, delete plans/.lock manually.`);
        }
        process.exit(1);
      }
      throw err;
    }
  }
  // Lock is held before the pointer is read (cmdCloseInner) — this closes the
  // TOCTOU where two closes both read the same active plan and merge it twice.
  // process.exit inside the locked body would skip lock release (L-014), so the
  // no-plan path throws ENOCLOSE and we exit AFTER finally releases the lock.
  let exitCode = 0;
  try {
    cmdCloseInner(opts);
  } catch (err) {
    if (err && err.code === "ENOCLOSE") {
      exitCode = 1;
    } else {
      throw err; // finally releases the lock before the exception propagates
    }
  } finally {
    if (ownLock) releaseLock();
  }
  if (exitCode !== 0) process.exit(exitCode);
}

function cmdCloseInner(opts = {}) {
  const planDirName = readPointer();
  if (!planDirName) {
    if (!opts.silent) {
      console.error("ERROR: No active plan to close.");
      const e = new Error("No active plan to close.");
      e.code = "ENOCLOSE";
      throw e;
    }
    return;
  }

  // Update state.md with CLOSE transition before removing pointer
  try {
    const statePath = join(plansDir, planDirName, "state.md");
    const stateContent = readFileSync(statePath, "utf-8");
    const prevState = stateContent.match(/^# Current State:\s*(.+)$/m)?.[1] || "UNKNOWN";
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    let updated = stateContent
      .replace(/^# Current State:\s*.+$/m, "# Current State: CLOSE")
      .replace(/^## Last Transition:\s*.+$/m, `## Last Transition: ${prevState} → CLOSE (${timestamp})`);
    const transitionLine = `- ${prevState} → CLOSE (bootstrap close)\n`;
    // Insert under `## Transition History:` rather than at EOF, so the new
    // entry lands in the right section even when an agent has appended
    // additional sections after the history block.
    // Skip when the plan is already CLOSE: re-closing is a no-op, and recording
    // `CLOSE → CLOSE` would emit an invalid-transition ERROR from validate-plan.
    const historyMarker = "## Transition History:";
    const historyIdx = prevState === "CLOSE" ? -2 : updated.indexOf(historyMarker);
    if (historyIdx === -2) {
      // already CLOSE — leave history untouched (no transition occurred)
    } else if (historyIdx >= 0) {
      const afterMarker = historyIdx + historyMarker.length;
      let sectionEnd = updated.indexOf("\n## ", afterMarker);
      if (sectionEnd < 0) sectionEnd = updated.length;
      const before = updated.slice(0, sectionEnd).replace(/[ \t]+$/g, "").replace(/\n+$/, "");
      const after = updated.slice(sectionEnd);
      updated = before + "\n" + transitionLine + (after.startsWith("\n") ? "" : after.length === 0 ? "" : "\n") + after;
    } else {
      // Fallback: legacy EOF append when Transition History section is absent.
      updated += (updated.endsWith("\n") ? "" : "\n") + transitionLine;
    }
    writeFileSync(statePath + ".tmp", updated);
    renameSync(statePath + ".tmp", statePath);
  } catch (err) {
    if (!opts.silent && err.code !== "ENOENT") {
      console.error(`WARNING: state.md update failed: ${err.message}`);
    }
  }

  // Merge per-plan findings/decisions to consolidated files before removing pointer
  try {
    ensureConsolidatedFiles();
    mergeToConsolidated(planDirName);
    // Sliding window: keep only the N most recent plan sections
    trimConsolidatedWindow(join(plansDir, "FINDINGS.md"));
    trimConsolidatedWindow(join(plansDir, "DECISIONS.md"));
    // Check if consolidated files need compression (rarely triggers with sliding window)
    checkConsolidatedSize(join(plansDir, "FINDINGS.md"), "plans/FINDINGS.md");
    checkConsolidatedSize(join(plansDir, "DECISIONS.md"), "plans/DECISIONS.md");
  } catch (err) {
    if (!opts.silent) {
      console.error(`WARNING: Merge to consolidated files failed: ${err.message}`);
      console.error(`  Per-plan files remain intact at plans/${planDirName}/`);
    }
  }

  // Update topic index and snapshot lessons before removing pointer
  try { appendToIndex(planDirName); } catch { /* index update is best-effort */ }
  try { snapshotLessons(planDirName); } catch { /* snapshot is best-effort */ }

  try { unlinkSync(pointerFile); } catch { /* already removed — TOCTOU safe */ }

  if (!opts.silent) {
    console.log(`Closed plan: plans/${planDirName}`);
    console.log(`  Pointer plans/.current_plan removed.`);
    console.log(`  Plan directory preserved at plans/${planDirName}/`);
    console.log(`  Findings/decisions merged to plans/FINDINGS.md and plans/DECISIONS.md.`);
    console.log(`  Update plans/LESSONS.md with significant lessons (max 200 lines).`);
    console.log(`  Note: This is an administrative close. The protocol CLOSE state`);
    console.log(`  (summary.md, decision audit) should be completed by the agent first.`);
  } else {
    console.log(`  Closed previous plan: plans/${planDirName}`);
  }
}

function cmdList() {
  if (!existsSync(plansDir)) {
    console.log("No plans/ directory found.");
    process.exit(0);
  }

  const activeName = readPointer();
  const entries = readdirSync(plansDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && PLAN_DIR_PREFIX_RE.test(d.name))
    .map((d) => d.name)
    // Chronological, NOT lexical. A raw name sort is wrong across the read union: `-`
    // (0x2D) sorts before `_` (0x5F), so every new-format dir would group ahead of every
    // legacy dir regardless of date. Sort on the extracted date; fall back to the raw
    // name when it cannot be parsed (those land last — digits sort before letters); and
    // always tie-break on the full name, since planDateFromId resolves only to the day
    // and same-day dirs must still print in a stable order.
    .sort((a, b) => {
      const ka = planDateFromId(a) ?? a;
      const kb = planDateFromId(b) ?? b;
      if (ka !== kb) return ka < kb ? -1 : 1;
      return a < b ? -1 : a > b ? 1 : 0;
    });

  if (entries.length === 0) {
    console.log("No plan directories found.");
    process.exit(0);
  }

  console.log(`Plan directories in plans/ (${entries.length} total):`);
  for (const name of entries) {
    const marker = name === activeName ? " ← active" : "";
    const state = readPlanFile(name, "state.md");
    const plan = readPlanFile(name, "plan.md");
    const currentState = extractField(state, /^# Current State:\s*(.+)$/m) || "?";
    const goal = extractField(plan, /\n## Goal\s*\n([\s\S]+?)(?=\n## |$)/) || "?";
    const goalOneLine = goal.split("\n")[0].slice(0, 60);
    console.log(`  ${name}  [${currentState}] ${goalOneLine}${marker}`);
  }
}

// Source-file walk parameters for anchor maintenance (cmdRetire). Kept in sync
// with validate-plan.mjs ANCHOR_SOURCE_EXTS / SKIP_DIR_NAMES so `retire` stamps
// exactly the anchors the validator scans. NOTE the `.md` exception: in Markdown
// an anchor is a `DECISION … D-NNN` token anywhere inside a CLOSED HTML comment
// span, so for those extensions (see ANCHOR_HTML_EXTS below) cmdRetire scopes its
// match to `<!-- … -->` spans — the same span-scoped model the validator's HTML
// scan uses. Without that scoping, `retire` would irreversibly stamp `[STALE]`
// into documentation prose, doc examples, and unclosed comments the validator
// does not consider anchors.
const ANCHOR_SOURCE_EXTS = new Set([
  ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".rb", ".go", ".rs",
  ".c", ".h", ".cpp", ".hpp", ".java", ".kt", ".sql", ".md",
]);
// NOTE: mirrors validate-plan.mjs HTML_STYLE_EXTS, narrowed to the extensions
// this walk actually visits (ANCHOR_SOURCE_EXTS ∩ HTML_STYLE_EXTS).
const ANCHOR_HTML_EXTS = new Set([".md"]);
const ANCHOR_SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "plans",
  "target", "__pycache__", ".cache", "vendor", "out",
]);

// NOTE: `retire <plan-id>` is the auditable
// path out of the "anchor graveyard" (OBS-004 / P1): when a plan dir is removed
// or obsolete, a qualified `# DECISION <plan>/D-NNN` anchor still in source
// becomes an orphan that validate-plan reports as a blocking ERROR — which jams
// the REFLECT→CLOSE gate of the *current, unrelated* plan. retire stamps those
// anchors `[STALE]` (downgrading orphan ERROR→WARN, see validate-plan.mjs
// severityForOrphan) and drops the dir, instead of hand-editing every anchor.
function cmdRetire(planId) {
  if (!planId) {
    console.error("ERROR: usage: node bootstrap.mjs retire <plan-id>");
    process.exit(1);
  }
  // Union, not the write grammar: retire exists to stamp the anchors of OLD plans, so it
  // must be able to parse a legacy id. A new-only regex here makes retire unable to act on
  // the only plans that ever need retiring.
  if (!ANY_PLAN_ID_RE.test(planId)) {
    console.error(`ERROR: "${planId}" is not a valid plan-id (expected plan-YYYY-MM-DDTHHMMSS-XXXXXXXX, or legacy plan_YYYY-MM-DD_XXXXXXXX).`);
    process.exit(1);
  }
  if (readPointer() === planId) {
    console.error(`ERROR: ${planId} is the ACTIVE plan. Run "close" first, then "retire".`);
    process.exit(1);
  }

  // Match `DECISION <plan-id>/D-NNN` (any comment style) not already [STALE].
  // The negative lookahead makes re-running retire idempotent. ONE regex serves
  // both cases — there is no separate HTML matcher. For `.md` (ANCHOR_HTML_EXTS)
  // the walk scopes this same regex to closed `<!-- … -->` comment spans, so a
  // token in Markdown prose, in a doc example, or in an UNCLOSED comment (which
  // the validator cannot see) is left untouched — stamping exactly the validator's
  // widened HTML set. For every other extension the regex runs over the whole file.
  //
  // DECISION plan_2026-07-14_79ee0f59/D-005 — the digit grammar MUST come from
  // shared.mjs (`\d{3,}(?!\d)`), never a local `\d{3}`/`\d+` literal. Two reasons,
  // both load-bearing:
  //  1. It has to stay identical to validate-plan.mjs's anchor scanner. If retire
  //     stamps less than the validator scans, the orphan ERROR that retire exists to
  //     clear survives the retire — a permanently jammed REFLECT→CLOSE gate. The old
  //     `\d{3}` cap meant exactly that for any D-1000+ anchor.
  //  2. This regex is the ONE consumer with no terminator after the id (it must match
  //     `D-001:`, `D-001 `, and `D-001` at EOL alike), so it is the one where a greedy
  //     variable-length digit run can backtrack past the `[STALE]` idempotency
  //     lookahead and irreversibly corrupt the file. The shared pattern's trailing
  //     `(?!\d)` is what prevents that — see the note on DECISION_ID_NUM_PATTERN.
  const escaped = planId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const anchorRe = new RegExp(
    `(DECISION\\s+${escaped}\\/D-${DECISION_ID_NUM_PATTERN})(?!\\s+\\[STALE\\])`,
    "g"
  );

  let stamped = 0;
  let filesChanged = 0;
  const walk = (dir, depth = 0) => {
    if (depth > 12) return;
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) {
        if (e.name.startsWith(".") || ANCHOR_SKIP_DIRS.has(e.name)) continue;
        walk(join(dir, e.name), depth + 1);
      } else if (e.isFile() && ANCHOR_SOURCE_EXTS.has(extname(e.name))) {
        const full = join(dir, e.name);
        let txt;
        try { txt = readFileSync(full, "utf-8"); } catch { continue; }
        if (!txt.includes(planId)) continue;
        // Count the anchors we will actually write, so `stamped` agrees with the
        // file byte-for-byte (the validator/retire "sees ⇔ stamps" contract).
        let fileStamped = 0;
        let next;
        if (ANCHOR_HTML_EXTS.has(extname(e.name))) {
          // `.md`: scope anchorRe to each CLOSED `<!-- … -->` span. Prose, doc examples,
          // and unclosed comments are outside every span and are left untouched.
          //
          // DECISION plan_2026-07-14_79ee0f59/D-010 — the spans come from shared.mjs's
          // `htmlCommentSpans`, the SAME primitive validate-plan.mjs's `.md` anchor scan
          // uses. Do NOT reintroduce the local `txt.replace(/<!--[\s\S]*?-->/g, …)` that
          // stood here: it was code-span-blind (a backticked `` `<!--` `` in prose opened a
          // phantom span), and — worse — this stamper and the validator's scanner are bound
          // by the "the validator sees exactly what retire stamps" contract. Two hand-kept
          // regexes are a lockstep invariant, i.e. a defect waiting to happen; one shared
          // span enumeration makes the contract hold by construction. They move together or
          // not at all. This is a WRITE path over SOURCE files, so a divergence here is not
          // a wrong report — it is a wrong edit. See decisions.md D-010.
          // String.prototype.match/replace reset lastIndex per call, so reusing
          // anchorRe per span is safe.
          const spans = htmlCommentSpans(txt);
          let rebuilt = "";
          let cur = 0;
          for (const { start, end } of spans) {
            rebuilt += txt.slice(cur, start);
            const span = txt.slice(start, end);
            const hits = span.match(anchorRe);
            if (hits) fileStamped += hits.length;
            rebuilt += span.replace(anchorRe, "$1 [STALE]");
            cur = end;
          }
          next = rebuilt + txt.slice(cur);
        } else {
          const hits = txt.match(anchorRe);
          fileStamped = hits ? hits.length : 0;
          next = fileStamped ? txt.replace(anchorRe, "$1 [STALE]") : txt;
        }
        if (fileStamped === 0) continue;
        // Atomic write: mirror the `.tmp`+renameSync idiom used everywhere else
        // in this file (ensureGitignore ~144, maybeCompressChangelog ~986). A
        // process kill mid-write must not corrupt a SOURCE file permanently.
        writeFileSync(full + ".tmp", next);
        renameSync(full + ".tmp", full);
        stamped += fileStamped;
        filesChanged++;
      }
    }
  };
  walk(cwd);

  const planDirPath = join(plansDir, planId);
  let dirRemoved = false;
  if (existsSync(planDirPath)) {
    rmSync(planDirPath, { recursive: true, force: true });
    dirRemoved = true;
  }

  console.log(`Retired ${planId}.`);
  console.log(`  Anchors marked [STALE]: ${stamped} across ${filesChanged} file(s).`);
  console.log(`  Plan directory: ${dirRemoved ? "removed" : "not present (already deleted)"}.`);
  console.log(`  Per-plan section in plans/DECISIONS.md left intact (sliding window trims it).`);
}

// NOTE: `reset-attempts` mechanically clears
// the active plan's `## Fix Attempts` section (OBS-016 / P2). The pre-step gate
// HARD-blocks at 2 recorded attempts, and SKILL.md says the counter "resets on
// user direction | new step | PIVOT" — but nothing automated that reset, so a
// stale counter carried across a PIVOT (or a forgotten new-step wipe) jams the
// FIRST step of the next attempt. This subcommand is the auditable reset that
// replaces hand-editing state.md — the exact manual surgery the gate exists to
// avoid.
function cmdResetAttempts() {
  const planDirName = readPointer();
  if (!planDirName) {
    console.error("ERROR: No active plan. reset-attempts operates on the active plan's state.md.");
    process.exit(1);
  }
  const statePath = join(plansDir, planDirName, "state.md");
  let state;
  try { state = readFileSync(statePath, "utf-8"); } catch {
    console.error(`ERROR: cannot read ${statePath}.`);
    process.exit(1);
  }
  const hIdx = state.indexOf("## Fix Attempts");
  if (hIdx < 0) {
    console.error("ERROR: no '## Fix Attempts' section found in state.md.");
    process.exit(1);
  }
  const headingLineEnd = state.indexOf("\n", hIdx);
  const bodyStart = headingLineEnd < 0 ? state.length : headingLineEnd + 1;
  const relEnd = state.slice(bodyStart).search(/\n## [^#]/);
  let sectionEnd = relEnd < 0 ? state.length : bodyStart + relEnd;
  const tail = state.slice(sectionEnd);
  const updated = state.slice(0, bodyStart) + "- (none yet for current step)" + (tail || "\n");
  writeFileSync(statePath + ".tmp", updated);
  renameSync(statePath + ".tmp", statePath);
  console.log(`Fix Attempts reset for active plan ${planDirName}.`);
  console.log(`  state.md '## Fix Attempts' → "- (none yet for current step)"`);
  console.log(`  The pre-step leash gate will count 0 attempts on the next EXECUTE step.`);
}

function printUsage() {
  console.log(`Usage: node bootstrap.mjs <command> [options]

Commands:
  new "goal"              Create a new plan directory
  new --force "goal"      Close active plan and create a new one
  resume                  Output current plan state for re-entry
  status                  One-line state summary
  close                   Close active plan (preserves directory)
  list                    Show all plan directories (active and closed)
  retire <plan-id>        Mark a removed/obsolete plan's DECISION anchors [STALE]
                          (orphan ERROR→WARN) and drop its plan directory
  reset-attempts          Clear the active plan's Fix Attempts section (unjams a
                          stale pre-step leash counter after a PIVOT/new step)

Backward-compatible:
  node bootstrap.mjs "goal"   Same as: node bootstrap.mjs new "goal"`);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
// Only run the CLI when this file is the process entry point. Required so
// that test files (and future library consumers) can `import` the module —
// e.g. to call `maybeCompressDecisions` — without triggering the no-args
// usage path which calls `process.exit(0)` and kills the host process.
// `import.meta.url` is a `file://` URL; `process.argv[1]` is a filesystem
// path. Compare via fileURLToPath. Guard introduced in v2.18.0/step-2.

import { fileURLToPath } from "url";

function runCli() {
  const args = process.argv.slice(2);
  const subcommands = new Set(["new", "resume", "status", "close", "list", "retire", "reset-attempts", "help"]);

  if (args.length === 0) {
    printUsage();
    process.exit(0);
  }

  const cmd = args[0];

  if (!subcommands.has(cmd)) {
    if (cmd.startsWith("-")) {
      console.error(`ERROR: Unknown flag "${cmd}". Use "help" for usage.`);
      process.exit(1);
    }
    // Typo guard: a single bare token closely matching a subcommand is almost
    // certainly a mistyped subcommand, not a one-word goal. Multi-word args keep
    // the backward-compat goal behavior untouched.
    if (args.length === 1) {
      const near = [...subcommands].find((s) => editDistance(cmd, s) <= 2);
      if (near) {
        console.error(`ERROR: "${cmd}" is not a subcommand (did you mean "${near}"?).`);
        console.error(`  To use it as a plan goal, run: new "${cmd}"`);
        process.exit(1);
      }
    }
    // Backward compat: treat args as goal for `new`
    cmdNew(args.join(" ") || "No goal specified", false);
  } else if (cmd === "new") {
    // DECISION plan_2026-07-14_79ee0f59/D-004
    // `--force` is POSITIONAL: honored ONLY as the token immediately after `new`.
    // Do NOT restore the tolerant `args.includes("--force")` scan — it made goal
    // TEXT destructive. A caller that word-splits its goal (shells, CI, agents all
    // do) turned `new "add a --force flag"` into a silent force-close of the user's
    // active plan, and stripped the token from the goal on the way. A `--force`
    // token anywhere after args[1] is goal text and stays in the goal verbatim.
    // See decisions.md D-004.
    const force = args[1] === "--force";
    const goalArgs = force ? args.slice(2) : args.slice(1);
    const goal = goalArgs.join(" ") || "No goal specified";
    cmdNew(goal, force);
  } else if (cmd === "resume") {
    cmdResume();
  } else if (cmd === "status") {
    cmdStatus();
  } else if (cmd === "close") {
    cmdClose();
  } else if (cmd === "list") {
    cmdList();
  } else if (cmd === "retire") {
    cmdRetire(args[1]);
  } else if (cmd === "reset-attempts") {
    cmdResetAttempts();
  } else if (cmd === "help") {
    printUsage();
  }
}

// NOTE: isEntryPoint guard makes bootstrap.mjs importable
// as a library (for maybeCompressDecisions / maybeCompressChangelog) without triggering the
// CLI dispatch that called printUsage() + process.exit(0). Standard Node.js ESM dual-mode
// pattern: compare fileURLToPath(import.meta.url) to process.argv[1]. CLI behavior preserved.
const isEntryPoint = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  runCli();
}
