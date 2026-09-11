#!/usr/bin/env node
// Validate protocol compliance of an iterative-planner plan directory.
//
// Usage:
//   node validate-plan.mjs                   Validate active plan
//   node validate-plan.mjs <plan-dir-name>   Validate specific plan directory
//
// Checks: state transitions, mandatory plan sections, cross-file consistency.
// Read-only — reports issues but changes nothing.
// Requires Node.js 18+.

import { readFileSync, existsSync, readdirSync } from "fs";
import { join, extname, relative, basename } from "path";
import { fileURLToPath } from "url";
import {
  extractField,
  splitChangelogFields,
  CHANGELOG_COMPRESSED_INLINE_RE,
  blankCompressedSummaryBlock,
  stripHtmlComments,
  htmlCommentSpans,
  blockCommentSpans,
  BLOCK_COMMENT_EXTS,
  unterminatedCommentOpener,
  ANY_PLAN_ID_PATTERN,
  ANY_PLAN_ID_RE,
  PLAN_SECTION_PATTERN,
  DECISION_ID_NUM_PATTERN,
  COUNTED_BUDGET_RE,
} from "./shared.mjs";
// Changelog field shapes are schema-driven (see checkChangelogFormat / D-001).
import { CHANGELOG_SPEC, entryFromFields, validateElement } from "./schema.mjs";

const cwd = process.cwd();
const plansDir = join(cwd, "plans");
const pointerFile = join(plansDir, ".current_plan");

// ---------------------------------------------------------------------------
// v2.14.0 — Plan-qualified DECISION anchors
// ---------------------------------------------------------------------------
// In-code anchors of the form `# DECISION plan_YYYY-MM-DD_XXXXXXXX/D-NNN`
// carry the originating plan's directory name as a prefix. This makes anchors
// globally unambiguous and resolvable even after plans/DECISIONS.md sliding-
// window trim drops the originating plan section.
//
// Pre-v2.14.0 bare `D-NNN` anchors are accepted (WARN [anchor-unqualified]) as
// a migration nudge. New plans (state.md INIT timestamp ≥ ANCHOR_REFS_REQUIRED_SINCE)
// are held to the strict requirement: matching Anchor-Refs in decisions.md +
// preamble line in decisions.md/summary.md.

// Cutover for strict enforcement. Plans whose state.md INIT timestamp is on or
// after this instant are subject to ERROR (rather than WARN) for missing
// Anchor-Refs and missing plan-id preamble.
//
// Set to 09:00:00Z on v2.14.0 release day, after the v2.13.0 closing plan
// (plan_2026-05-07_9560e49b INIT at 08:07Z) and before the v2.14.0 plan
// (plan_2026-05-07_7556fb98 INIT at 09:17Z). Pre-cutover closed plans remain
// WARN-only on missing schema fields they couldn't have known about.
const ANCHOR_REFS_REQUIRED_SINCE = "2026-05-07T09:00:00Z";

// Plan-id and decision-id (`D-NNN`) grammars are imported from shared.mjs — the single
// definition, shared with bootstrap.mjs (the PRODUCER of both). This file used to keep
// its own copy of PLAN_ID_PATTERN with a permissive `[0-9a-f]+` tail "for forward
// compatibility" while bootstrap enforced exactly 8 hex, so the two disagreed about what
// a legal plan-id even is. Do not re-declare either grammar here.
//
// The validator is a pure READER: it never mints an id, so it uses ANY_PLAN_ID_PATTERN /
// ANY_PLAN_ID_RE — the union of the v2.36.0 format (`plan-YYYY-MM-DDTHHMMSS-XXXXXXXX`)
// and the legacy one (`plan_YYYY-MM-DD_XXXXXXXX`). Do NOT narrow these to PLAN_ID_*
// (the write grammar): legacy plan dirs and the anchors qualified by legacy ids would
// stop matching *silently* — not as orphan ERRORs, but as no match at all.
// See shared.mjs / decisions.md D-005 + D-003.

// Read the INIT timestamp from state.md. Looks for any line matching
// `INIT (→|->) EXPLORE (TS)` where TS parses as an ISO date — checks the
// "Last Transition" line first, then falls back to scanning Transition
// History (the INIT entry persists there after the plan moves on).
// Returns Date | null. Malformed/missing → null (treat as pre-cutover, lenient).
function parseInitTimestamp(planDir) {
  const state = readFile(join(planDir, "state.md"));
  if (!state) return null;
  const re = /INIT\s*(?:→|->)\s*EXPLORE\s*\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(state)) !== null) {
    const raw = m[1].trim();
    const d = new Date(raw);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

// Returns true if INIT timestamp is on or after the v2.14.0 cutover.
// Null/malformed → false (pre-cutover, lenient WARN-not-ERROR).
function isPostCutover(planDir) {
  const ts = parseInitTimestamp(planDir);
  if (ts === null) return false;
  return ts.getTime() >= new Date(ANCHOR_REFS_REQUIRED_SINCE).getTime();
}

// ---------------------------------------------------------------------------
// Valid state transitions (from SKILL.md)
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS = new Set([
  "INIT→EXPLORE",
  "EXPLORE→PLAN",
  "PLAN→EXPLORE",
  "PLAN→PLAN",
  "PLAN→EXECUTE",
  "EXECUTE→REFLECT",
  "REFLECT→CLOSE",
  "REFLECT→PIVOT",
  "REFLECT→EXPLORE",
  "REFLECT→EXECUTE",
  "PIVOT→PLAN",
  // Bootstrap-generated transitions
  "EXPLORE→CLOSE",   // bootstrap close from EXPLORE
  "PLAN→CLOSE",      // bootstrap close from PLAN
  "EXECUTE→CLOSE",   // bootstrap close from EXECUTE
  "PIVOT→CLOSE",   // bootstrap close from PIVOT
  "UNKNOWN→CLOSE",   // bootstrap close fallback
  "CLOSE→CLOSE",   // idempotent re-close (legacy state.md; new closes skip the write)
]);

// Mandatory sections in plan.md (header text → considered populated if non-placeholder)
const PLAN_SECTIONS = [
  "Goal",
  "Problem Statement",
  "Context",
  "Files To Modify",
  "Steps",
  "Assumptions",
  "Failure Modes",
  "Pre-Mortem & Falsification Signals",
  "Success Criteria",
  "Verification Strategy",
  "Complexity Budget",
];

const PLACEHOLDER_PATTERNS = [
  /^\*to be (defined|determined|populated)/im,
  /^\*pending/im,
  /^\*nothing yet/im,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readFile(path) {
  try {
    // Normalize CRLF on read so downstream regexes and trimmed-token
    // comparisons (e.g. currentState.toUpperCase() === "EXECUTE") match on
    // Windows-saved files as well as POSIX. Single point of fix.
    return readFileSync(path, "utf-8").replace(/\r\n/g, "\n");
  } catch {
    return null;
  }
}

// extractField now lives in ./shared.mjs (imported above).

function isPlaceholder(text) {
  if (!text || !text.trim()) return true;
  return PLACEHOLDER_PATTERNS.some((p) => p.test(text.trim()));
}

// `trim: false` keeps the body's leading whitespace. Only the Verdict check
// needs it, and it needs it badly: trimming strips the indentation of the
// FIRST line only, so a Verdict indented uniformly by 2 spaces reports its
// first bullet at indent 0 and the other four at indent 2. Any indent-aware
// reader of a section must opt out of the trim. Emptiness semantics are
// identical either way — a section that is only whitespace is still null.
function extractSection(content, heading, { trim = true } = {}) {
  // NOTE: allow optional trailing
  // parenthetical (e.g. "## Fix Attempts (resets per plan step)" as written
  // by bootstrap.mjs). Without this, every callsite using a bootstrap-written
  // parenthetical heading silently returned null.
  if (!content) return null;
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingRe = new RegExp(`^## ${escaped}(?:\\s+\\(.*\\))?[ \\t]*$`, "m");
  const headingMatch = headingRe.exec(content);
  if (!headingMatch) return null;
  const start = headingMatch.index + headingMatch[0].length;
  const nextHeading = content.indexOf("\n## ", start);
  const body = nextHeading >= 0 ? content.slice(start, nextHeading) : content.slice(start);
  if (!body.trim()) return null;
  return trim ? body.trim() : body;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

// F5 — canonical phase normalization shared by checkStateTransitions and
// checkDecisionsSchema. Maps `Re-Plan` / `RE_PLAN` / `REPLAN` (any case) to
// `PIVOT`. Before this helper, the two checks used different normalization:
// transition history normalized REPLAN→PIVOT, but checkDecisionsSchema used
// raw `phase.includes("PIVOT")` substring which (a) missed REPLAN-as-phase
// and (b) false-positive-matched any phase containing the substring (e.g.
// `PIVOT-RECOVERY`).
function normalizePhase(s) {
  if (!s) return "";
  return s.replace(/[–—‐]/g, "-").replace(/RE[_-]?PLAN/gi, "PIVOT").toUpperCase();
}

// Returns true iff the normalized phase represents a real PIVOT transition.
// Accepts bare `PIVOT`, arrow-form ending in `→ PIVOT`/`-> PIVOT` (REFLECT → PIVOT),
// AND arrow-form STARTING with `PIVOT → ...` (PIVOT → PLAN). Rejects substring
// false-positives like `PIVOT-RECOVERY` / `PIVOT-PLAN` (bare hyphen = qualifier,
// not transition).
//
// NOTE: pattern-discipline per LESSONS L-012:
// when a check operates on phase semantics, accept BOTH sides of the arrow.
// The prior implementation only matched PIVOT as DESTINATION, missing
// PIVOT-as-SOURCE (`PIVOT → PLAN`) which the state machine produces.
function isPivotPhase(s) {
  const n = normalizePhase(s);
  if (n === "PIVOT") return true;
  if (/(?:→|->)\s*PIVOT$/.test(n)) return true;       // X → PIVOT
  if (/^PIVOT\s*(?:→|->)/.test(n)) return true;       // PIVOT → X
  return false;
}

// DECISION plan-2026-09-11T141919-e5db2894/D-003 — shared prefix pattern identifying ANY
// "- HYGIENE SKIP (iter N): <reason>" line, regardless of N or what its free-text reason
// contains. checkHygieneSweepGate's own skip-line regex (below, ~line 1989) narrows this to
// one specific iteration for its existence check; THIS generic form exists so
// stripHygieneSkipLines() (immediately below) can recognize "this is a HYGIENE SKIP line" and
// exclude it WHOLESALE from any reader of Transition History — prefix-only matching previously
// let a reason containing an arrow (e.g. "-> ") or the literal pair "EXECUTE → REFLECT" reach
// through into arrow/pair parsing (reviewer CRITICAL #1/#2, plan-2026-09-11T141919-e5db2894).
// Do not restrict what a skip-line reason may say — the fix is exclusion of the whole line,
// not a content ban on operator-authored prose.
const HYGIENE_SKIP_LINE_RE = /^-\s+HYGIENE SKIP \(iter \d+\):/;

// DECISION plan-2026-09-11T141919-e5db2894/D-003 — structural fix for reviewer pass-2
// CONCERN #1: the original fix (EXECUTE step-1.1) patched checkStateTransitions and
// countExecuteReflect individually and left a comment CLAIMING that reader list was
// exhaustive; it was not — checkExplorationConfidence and countRePlans also scan Transition
// History text with arrow-sensitive regexes and were equally vulnerable to a HYGIENE SKIP
// reason containing an arrow pair (e.g. "...the EXPLORE -> PLAN rewrite..." spuriously
// tripping [exploration-confidence]; "...REFLECT -> PIVOT then PIVOT -> PLAN..." spuriously
// inflating [convergence]). Route EVERY reader of a Transition-History block through this ONE
// helper before any arrow/pair scan, so "a HYGIENE SKIP line never leaks into a reader" is
// structural (one call site to get right), not a hand-maintained list of patched functions to
// keep in sync. Do not re-add a per-function `.filter(... && !HYGIENE_SKIP_LINE_RE.test(l))`
// inline — call this instead.
function stripHygieneSkipLines(text) {
  if (text === null || text === undefined) return text;
  return text
    .split("\n")
    .filter((l) => !HYGIENE_SKIP_LINE_RE.test(l))
    .join("\n");
}

// DECISION plan_2026-07-14_79ee0f59/D-003 — state.md's Transition History is read
// comment-blind: bootstrap's own template embeds an example transition inside an HTML
// comment, and a raw scan ingests it as a real record. Route every reader through this
// function; do not re-introduce a raw indexOf/slice scan.
// DECISION plan_2026-07-14_79ee0f59/D-010 — the heading is matched LINE-ANCHORED
// (`/^## Transition History:/m`), never `indexOf`: a bare substring search also matches
// the heading's own name quoted in prose elsewhere in the file.
// DECISION plan_2026-07-14_79ee0f59/D-009 — the `raw` option exists for exactly ONE
// caller, deriveIterationFromHistory (the iteration hard cap), which must read RAW text
// so a stray `<!--` above the heading can't blank it and silently under-count. Every
// other (advisory) caller keeps reading the stripped block.
function transitionHistoryBlock(state, { raw = false } = {}) {
  if (!state) return null;
  const text = raw ? state : stripHtmlComments(state);
  const m = /^## Transition History:/m.exec(text);
  if (!m) return null;
  return text.slice(m.index);
}

function checkStateTransitions(planDir, issues) {
  const state = readFile(join(planDir, "state.md"));
  if (!state) {
    issues.push({ severity: "ERROR", check: "state", message: "state.md not found or unreadable" });
    return;
  }

  const currentState = extractField(state, /^# Current State:\s*(.+)$/m);
  if (!currentState) {
    issues.push({ severity: "ERROR", check: "state", message: "Cannot parse current state from state.md" });
  }

  // Parse transition history (comment-blind — see transitionHistoryBlock / D-003).
  const historyBlock = transitionHistoryBlock(state);
  if (historyBlock === null) {
    issues.push({ severity: "WARN", check: "state", message: "No transition history found in state.md" });
    return;
  }

  // HYGIENE SKIP lines are excluded WHOLESALE, not just guarded at the prefix — see
  // stripHygieneSkipLines (reviewer CRITICAL #1).
  const lines = stripHygieneSkipLines(historyBlock).split("\n").filter((l) => l.startsWith("- "));

  for (const line of lines) {
    // Format: "- STATE1 → STATE2 (reason)" — arrow can be → or ->
    const match = line.match(/^- (.+?)\s+(?:→|->)\s+([A-Za-z_]+)/);
    if (!match) continue;

    // F5 — use shared normalizePhase helper (same transform used by checkDecisionsSchema)
    const normFrom = normalizePhase(match[1]);
    const normTo = normalizePhase(match[2]);
    const key = `${normFrom}→${normTo}`;

    if (!VALID_TRANSITIONS.has(key)) {
      issues.push({ severity: "ERROR", check: "transition", message: `Invalid transition: ${key} (from: "${line.trim()}")` });
    }
  }
}

function checkPlanSections(planDir, issues) {
  const plan = readFile(join(planDir, "plan.md"));
  if (!plan) {
    issues.push({ severity: "ERROR", check: "plan", message: "plan.md not found or unreadable" });
    return;
  }

  const state = readFile(join(planDir, "state.md"));
  const currentState = extractField(state, /^# Current State:\s*(.+)$/m) || "";

  // Only check for non-placeholder content if past EXPLORE (plan should be filled during PLAN)
  const requireContent = ["EXECUTE", "REFLECT", "PIVOT", "CLOSE"].includes(currentState.toUpperCase());

  for (const section of PLAN_SECTIONS) {
    const content = extractSection(plan, section);
    if (content === null) {
      issues.push({ severity: "ERROR", check: "plan-section", message: `Missing section: ## ${section}` });
    } else if (requireContent && isPlaceholder(content)) {
      issues.push({ severity: "WARN", check: "plan-section", message: `Section "## ${section}" still has placeholder content` });
    }
  }
}

function checkFindings(planDir, issues) {
  const findings = readFile(join(planDir, "findings.md"));
  if (!findings) {
    issues.push({ severity: "WARN", check: "findings", message: "findings.md not found or unreadable" });
    return;
  }

  const state = readFile(join(planDir, "state.md"));
  const currentState = extractField(state, /^# Current State:\s*(.+)$/m) || "";

  // Count indexed findings under ## Index, in all three shapes the findings.md
  // template permits. The template's Index body is just `*To be populated during
  // EXPLORE.*` — no protocol file has ever instructed a bullets-only Index — so a
  // table Index is conformant output and must not raise a WARN (B-class rule: every
  // WARN corresponds to a rule some protocol file actually states).
  //   bullets:   "- [Foo](path) — headline"  (links are a subset of bullets; counting
  //              both would double-count, so only bullets are counted)
  //   numbered:  "1. Foo"
  //   table:     one row per finding, counted only AFTER a |---|---| separator row,
  //              which excludes the header row and the separator itself.
  const indexSection = extractSection(findings, "Index");
  if (indexSection) {
    const lines = indexSection.split("\n");
    const findingItems = lines.filter((l) => l.match(/^- .+/));
    const numberedItems = lines.filter((l) => l.match(/^\d+\.\s+.+/));
    let seenSeparator = false;
    let tableRows = 0;
    for (const raw of lines) {
      const l = raw.trim();
      if (!l.startsWith("|")) { seenSeparator = false; continue; }
      if (/^\|[\s:|-]+\|?$/.test(l)) { seenSeparator = true; continue; }
      if (seenSeparator) tableRows++;
    }
    const count = findingItems.length + numberedItems.length + tableRows;

    if (count < 3 && !["EXPLORE", "CLOSE"].includes(currentState.toUpperCase())) {
      issues.push({ severity: "WARN", check: "findings", message: `Only ${count} indexed findings (minimum 3 required before PLAN)` });
    }
  }
}

function checkCrossFileConsistency(planDir, issues) {
  const state = readFile(join(planDir, "state.md"));
  const plan = readFile(join(planDir, "plan.md"));
  const progress = readFile(join(planDir, "progress.md"));

  if (!state || !plan || !progress) return;

  const currentState = extractField(state, /^# Current State:\s*(.+)$/m) || "";

  // Check iteration consistency
  const stateIter = extractField(state, /^## Iteration:\s*(.+)$/m);
  if (stateIter) {
    const planVersion = extractField(plan, /^# Plan v(\d+)/m);
    if (planVersion && stateIter !== "0" && parseInt(stateIter) !== parseInt(planVersion)) {
      issues.push({ severity: "WARN", check: "consistency", message: `state.md iteration (${stateIter}) != plan.md version (v${planVersion})` });
    }
  }

  // Check that verification.md exists and has content if in REFLECT or later
  if (["REFLECT", "CLOSE"].includes(currentState.toUpperCase())) {
    const verification = readFile(join(planDir, "verification.md"));
    if (!verification) {
      issues.push({ severity: "ERROR", check: "consistency", message: "verification.md missing during REFLECT/CLOSE" });
    }
  }

  // Check convergence metrics in verification.md for iteration 2+ REFLECT
  if (["REFLECT", "CLOSE"].includes(currentState.toUpperCase())) {
    const verification = readFile(join(planDir, "verification.md"));
    // DECISION plan-2026-09-01T100120-4f591469/D-034 — asks "has this plan been re-planned?",
    // via re-plan count (countRePlans below), not `EXECUTE → REFLECT` count — the latter
    // wrongly counts a same-iteration completion-fix loop as a new iteration. Do not swap in
    // deriveIterationFromHistory here.
    const stateIterRaw = extractField(state, /^## Iteration:\s*(.+)$/m);
    const declaredIter = stateIterRaw ? parseInt(stateIterRaw, 10) : 0;
    const derivedIter = deriveConvergenceIteration(state);
    const effectiveIter = Math.max(Number.isFinite(declaredIter) ? declaredIter : 0, derivedIter);
    if (verification && effectiveIter >= 2) {
      if (!verification.includes("## Convergence Metrics") || !verification.includes("Convergence score")) {
        issues.push({ severity: "WARN", check: "convergence", message: "verification.md missing Convergence Metrics section for iteration 2+ (EXTENDED check — see references/convergence-metrics.md)" });
      } else {
        // Check if convergence metrics are still placeholder values (all dashes)
        const convergenceSection = extractSection(verification, "Convergence Metrics");
        if (convergenceSection) {
          const scoreRow = convergenceSection.split("\n").find((l) => l.includes("Convergence score"));
          if (scoreRow && /\|\s*-\s*\|\s*-\s*\|\s*-\s*\|/.test(scoreRow)) {
            issues.push({ severity: "WARN", check: "convergence", message: "verification.md Convergence Metrics still has placeholder values for iteration 2+ (EXTENDED check — see references/convergence-metrics.md)" });
          }
        }
      }
    }
  }

  // Check that summary.md exists at CLOSE
  if (currentState.toUpperCase() === "CLOSE") {
    if (!existsSync(join(planDir, "summary.md"))) {
      issues.push({ severity: "WARN", check: "consistency", message: "summary.md missing during CLOSE" });
    }
  }

  // Check that decisions.md exists
  if (!existsSync(join(planDir, "decisions.md"))) {
    issues.push({ severity: "ERROR", check: "consistency", message: "decisions.md not found" });
  }
}

function checkChangeManifest(planDir, issues) {
  const state = readFile(join(planDir, "state.md"));
  if (!state) return;

  const currentState = extractField(state, /^# Current State:\s*(.+)$/m) || "";
  if (!["EXECUTE", "REFLECT"].includes(currentState.toUpperCase())) return;

  if (!state.includes("## Change Manifest")) {
    issues.push({ severity: "WARN", check: "manifest", message: "state.md missing Change Manifest section during EXECUTE/REFLECT" });
  }
}

// Autonomy Leash enforcement (SKILL.md §"Autonomy Leash" L344-354): max 2 fix
// attempts per step. Counts lines under ## Fix Attempts that match either:
//   - documented format: `- Step N, attempt M: …` (see references/file-formats.md
//     state.md section, lines 39-44)
//   - legacy format:     `- Attempt M: …`        (pre-v2.18.0 plans; kept for
//     backward compatibility so closed plans continue to validate identically)
// Placeholder lines like `- (none yet)` and the `- Step N: LEASH HIT.` summary
// line are intentionally NOT counted (a colon after the step number is not `[,\s]`). Conservative: only fires during
// EXECUTE/REFLECT — outside those states the section is stale from a previous
// step. WARN at 3, ERROR at 4+. Resets on step / PIVOT / user direction
// (tracked by the agent rewriting the section).
// DECISION plan-2026-09-01T100120-4f591469/D-026: ONE shared constant for the fix-attempt
// line shape (checkLeashCount + runPreStepGate) — two copies previously matched `Step \d+`
// only, so `- Step 9.1, attempt 1:` (completion-fix numbering) bypassed the leash entirely.
// Step-number fragment is deliberately looser than schema.mjs's STEP_RE: a safety cap must
// over-count an unforeseen shape like `Step 9.1.2`, never silently skip it.
const FIX_ATTEMPT_RE = /^-\s+(Step\s+\d+(?:\.\d+)*[,\s]+attempts?\s+\d+|Attempts?\s+\d+)/i;

function checkLeashCount(planDir, issues) {
  const state = readFile(join(planDir, "state.md"));
  if (!state) return;

  const currentState = extractField(state, /^# Current State:\s*(.+)$/m) || "";
  if (!["EXECUTE", "REFLECT"].includes(currentState.toUpperCase())) return;

  const section = extractSection(state, "Fix Attempts");
  if (!section) return; // No section — legacy state.md or pre-template plan. Silent.
  // Alternation: documented `- Step N, attempt M` first, comma-optional/space-only variants
  // (`- Step 1 attempt 1`, `- Step 1  attempts 2`), sub-step numbering (`- Step 9.1, attempt 1`),
  // and legacy bare `- Attempt M` / `- Attempts M`.
  const attempts = section.split("\n").filter((l) => FIX_ATTEMPT_RE.test(l));
  // Two enforcement tiers (see SKILL.md §Autonomy Leash "Enforcement tiers"):
  // the real-time --pre-step gate HARD-blocks the 3rd spawn (cap = 2 attempts).
  // This full-run check is a RETROSPECTIVE audit, so 2 recorded attempts is
  // legal (you are allowed 2); 3 means a 3rd attempt slipped past the gate
  // (WARN); 4+ means the gate was bypassed entirely (ERROR).
  if (attempts.length >= 4) {
    issues.push({
      severity: "ERROR",
      check: "leash",
      message: `${attempts.length} fix attempts recorded in state.md — the Autonomy Leash allows 2 per step and the --pre-step gate blocks the 3rd spawn in real time. ${attempts.length} recorded means the gate was bypassed: STOP COMPLETELY, revert, present to user. See SKILL.md §Autonomy Leash.`,
    });
  } else if (attempts.length === 3) {
    issues.push({
      severity: "WARN",
      check: "leash",
      message: `3 fix attempts recorded — the Autonomy Leash allows 2 per step (the --pre-step gate blocks the 3rd spawn). A 3rd recorded attempt means the leash was passed: revert, present, PIVOT. See SKILL.md §Autonomy Leash.`,
    });
  }
}

// NOTE: derive iteration from Transition
// History (OBS-005). Pre-fix: `## Iteration: N` is agent-written, so an agent
// (or sloppy fork) that forgets to bump it bypasses the 5/6 caps indefinitely.
// Cross-check: each EXECUTE → REFLECT arrow in Transition History closes one
// iteration. Final value = max(declared, derived) — both signals govern.
//
/** Count `EXECUTE → REFLECT` arrows in a Transition-History block (null → 0). */
function countExecuteReflect(block) {
  if (block === null) return 0;
  // Use normalizePhase semantics (en/em dash → hyphen). Count distinct
  // EXECUTE → REFLECT transitions.
  // Exclude HYGIENE SKIP lines wholesale BEFORE the pair scan — their free-text reason is
  // unconstrained and may itself contain the literal pair "EXECUTE → REFLECT", which would
  // otherwise self-inflate the derived iteration count (reviewer CRITICAL #2,
  // plan-2026-09-11T141919-e5db2894). See stripHygieneSkipLines.
  const filtered = stripHygieneSkipLines(block).replace(/[–—‐]/g, "-");
  const re = /EXECUTE\s*(?:→|->)\s*REFLECT/g;
  let count = 0;
  while (re.exec(filtered) !== null) count++;
  return count;
}

// DECISION plan-2026-09-01T100120-4f591469/D-034 — the ADVISORY iteration derivation,
// deliberately separate from the hard cap's countExecuteReflect: this asks "has the plan
// been re-planned?", not "how much work happened?". Do not unify them — feeding this count
// to the hard cap would let an endless non-replanning loop escape it (an under-count in a
// safety mechanism); feeding countExecuteReflect here wrongly flags a same-iteration
// completion-fix loop as a new iteration.
// Counts arrivals at PLAN that begin a new iteration: only `REFLECT → PIVOT → PLAN` and
// `REFLECT → EXPLORE → PLAN` (SKILL.md § Autonomy Leash "Known reset gap"). Every other
// arrival at PLAN (`EXPLORE → PLAN`, `PLAN → PLAN`, `PLAN → EXPLORE → PLAN`) is routine
// same-iteration work per the Transitions table and must not count.
/** Count re-plans: arrivals at PLAN that follow a departure from REFLECT (null → 0). */
function countRePlans(block) {
  if (block === null) return 0;
  // Exclude HYGIENE SKIP lines wholesale BEFORE the pair scan — a skip-line reason
  // containing e.g. "REFLECT -> PIVOT then PIVOT -> PLAN" would otherwise self-inflate the
  // re-plan count and drive deriveConvergenceIteration past its real value (reviewer pass-2
  // CONCERN #1, plan-2026-09-11T141919-e5db2894). See stripHygieneSkipLines.
  const norm = stripHygieneSkipLines(block).replace(/[–—‐]/g, "-");
  const re = /\b([A-Z]+)\s*(?:→|->)\s*([A-Z]+)\b/g;
  let leftReflect = false;
  let count = 0;
  let m;
  while ((m = re.exec(norm)) !== null) {
    const [, from, to] = m;
    if (to === "PLAN") {
      if (leftReflect) { count++; leftReflect = false; }
    } else if (from === "REFLECT") {
      // REFLECT → EXECUTE is the completion-fix loop and does NOT begin an iteration; it
      // also never reaches PLAN, so arming on it is harmless. REFLECT → CLOSE ends the
      // plan. The two that matter are REFLECT → PIVOT and REFLECT → EXPLORE.
      leftReflect = to === "PIVOT" || to === "EXPLORE";
    }
  }
  return count;
}

// Exported for testability ONLY (same precedent as deriveIterationFromHistory below: the
// CLI cannot observe this number directly, it only observes whether the WARN fires).
// The module's CLI dispatch is guarded by `isEntryPoint`, so importing is safe.
export function deriveConvergenceIteration(state) {
  return 1 + countRePlans(transitionHistoryBlock(state));
}

// DECISION plan_2026-07-14_79ee0f59/D-009 — this counter drives the iteration hard cap
// (a SAFETY mechanism), so it reads `max(raw, stripped)`, never stripped-only: a stray
// `<!--` above the heading pairs with bootstrap's own trailing `-->` and can blank real
// records, making the cap derive 0 and fail OPEN. Raw counting makes under-counting
// structurally impossible; the cap can then only over-count, which is the safe direction.
// Advisory scanners deliberately keep reading stripped-only — a false WARN is recoverable,
// a false ERROR would not be.
// Exported for testability ONLY (the CLI cannot observe a derived count below 5 — the cap
// prints nothing under its WARN threshold — and the review's fixture measures exactly 4).
// The module's CLI dispatch is already guarded by `isEntryPoint`, so importing is safe.
export function deriveIterationFromHistory(state) {
  return Math.max(
    countExecuteReflect(transitionHistoryBlock(state, { raw: true })),
    countExecuteReflect(transitionHistoryBlock(state)),
  );
}

// DECISION plan_2026-07-14_79ee0f59/D-009 — the DIAGNOSTIC half of the fail-closed cap:
// explains an over-count from a stray unterminated `<!--`. WARN only, never promoted to
// ERROR or to the --pre-step HARD-fail slugs — a stray marker is an authoring accident,
// not a protocol violation, and the cap already handles the safety consequence.
function checkStateCommentAnomaly(planDir, issues) {
  const state = readFile(join(planDir, "state.md"));
  if (!state) return; // absence is already reported by checkStateTransitions

  const strayIdx = unterminatedCommentOpener(state);
  if (strayIdx >= 0) {
    const line = state.slice(0, strayIdx).split("\n").length;
    issues.push({
      severity: "WARN",
      check: "state-comment-anomaly",
      message: `state.md line ${line}: an HTML comment opener \`<!--\` has no matching \`-->\`. Everything after it reads as comment body to the advisory scanners. The iteration cap is unaffected (it counts the raw block — D-009), but close or delete the marker.`,
    });
  }

  // The other half: a transition-shaped line living INSIDE a comment region. This is what a
  // stray opener does when it pairs with bootstrap's trailing template comment — it swallows
  // real records — and it is also what a genuine comment holding an example transition does.
  // Either way the raw and stripped readings disagree, and the cap took the raw one.
  const raw = countExecuteReflect(transitionHistoryBlock(state, { raw: true }));
  const stripped = countExecuteReflect(transitionHistoryBlock(state));
  if (raw !== stripped) {
    issues.push({
      severity: "WARN",
      check: "state-comment-anomaly",
      message: `state.md Transition History: ${raw} \`EXECUTE → REFLECT\` record(s) in the raw text but ${stripped} after HTML comments are stripped — ${raw - stripped} transition-shaped line(s) sit INSIDE a comment region. The iteration cap counts the raw ${raw} on purpose (it must never under-count — D-009), so this is why it may read higher than you expect.`,
    });
  }
}

function checkIterationLimits(planDir, issues) {
  const state = readFile(join(planDir, "state.md"));
  if (!state) return;

  const iterStr = extractField(state, /^## Iteration:\s*(.+)$/m);
  const declared = iterStr ? parseInt(iterStr) : 0;
  const derived = deriveIterationFromHistory(state);
  // max() so neither side can silence the other.
  const iter = Math.max(Number.isFinite(declared) ? declared : 0, derived);
  if (!Number.isFinite(iter) || iter <= 0) return;

  // When derived > declared, mention the source so the agent knows to fix
  // the discrepancy (and the validator's reasoning isn't opaque).
  const source = derived > declared
    ? ` (declared=${declared}, derived=${derived} from EXECUTE → REFLECT transition count)`
    : "";

  if (iter >= 6) {
    issues.push({ severity: "ERROR", check: "iteration", message: `Iteration ${iter}${source} exceeds hard limit (6+): must decompose into smaller tasks` });
  } else if (iter === 5) {
    issues.push({ severity: "WARN", check: "iteration", message: `Iteration 5${source}: mandatory decomposition analysis required (2-3 sub-goals)` });
  }
}

function checkProgressStructure(planDir, issues) {
  const progress = readFile(join(planDir, "progress.md"));
  if (!progress) {
    issues.push({ severity: "WARN", check: "progress", message: "progress.md not found or unreadable" });
    return;
  }

  const requiredSections = ["Completed", "In Progress", "Remaining"];
  for (const section of requiredSections) {
    if (!progress.includes(`## ${section}`)) {
      issues.push({ severity: "WARN", check: "progress", message: `progress.md missing section: ## ${section}` });
    }
  }
}

function checkCheckpoints(planDir, issues) {
  const state = readFile(join(planDir, "state.md"));
  if (!state) return;

  // Mirrors checkIterationLimits (line ~564) and runPreStepGate (line ~2080):
  // max(declared, derived) so an agent that forgets to bump the declared field
  // cannot silently bypass this WARN by understating its iteration.
  const iterStr = extractField(state, /^## Iteration:\s*(.+)$/m);
  const declared = iterStr ? parseInt(iterStr, 10) : 0;
  const derived = deriveIterationFromHistory(state);
  const iter = Math.max(Number.isFinite(declared) ? declared : 0, derived);
  if (iter < 2) return;

  const cpDir = join(planDir, "checkpoints");
  if (!existsSync(cpDir)) {
    issues.push({ severity: "WARN", check: "checkpoints", message: `No checkpoints/ directory found at iteration ${iter} (expected checkpoint before risky changes)` });
    return;
  }

  try {
    const cpFiles = readdirSync(cpDir).filter((f) => f.endsWith(".md"));
    if (cpFiles.length === 0) {
      issues.push({ severity: "WARN", check: "checkpoints", message: `checkpoints/ directory is empty at iteration ${iter}` });
    }
  } catch { /* best-effort */ }
}

// Counted budget lines: only the two capped counters ("Files added",
// "New abstractions"). Everything else in the section is prose or a target.
// COUNTED_BUDGET_RE now lives in ./shared.mjs (imported above) — scar-scan.mjs
// reads the same line and used to declare its own stricter copy (D-018).
// The escape hatch. Anywhere on the same line, bold/backticks/parens tolerated.
const JUSTIFIED_RE = /\(\s*justified\s*:/i;

function checkComplexityBudget(planDir, issues) {
  const plan = readFile(join(planDir, "plan.md"));
  if (!plan) return;

  const state = readFile(join(planDir, "state.md"));
  const currentState = extractField(state, /^# Current State:\s*(.+)$/m) || "";
  if (!["EXECUTE", "REFLECT", "PIVOT", "CLOSE"].includes(currentState.toUpperCase())) return;

  const budgetSection = extractSection(plan, "Complexity Budget");
  if (!budgetSection) return;

  if (isPlaceholder(budgetSection)) {
    issues.push({ severity: "WARN", check: "complexity", message: "Complexity Budget section still has placeholder content during EXECUTE+" });
    // Placeholder text carries no numbers — nothing left to count.
    return;
  }

  // NOTE: (v2.33.0, audit defect #5) Numeric budget enforcement.
  // Before this, the check only tested for placeholder prose, so the protocol's
  // documented cap ("Files added: N/M max") was never actually compared: a plan
  // could declare `Files added: 9/3 max` and validate clean.
  //
  // The tolerances (list bullet, bold wrappers, parenthetical label, trailing
  // text) and the deliberate exclusion of the "Lines added vs removed" target
  // line are documented at COUNTED_BUDGET_RE's declaration in shared.mjs.
  //
  // WARN-only, by design. This is an authoring-quality signal, not a
  // correctness gate. DO NOT promote it to ERROR and DO NOT wire it into the
  // --pre-step gate (that path reads state.md only and reserves exit 2 for the
  // four HARD-fail slugs). An over-budget plan that states WHY it is over
  // budget is compliant — `(justified: …)` on the line suppresses the WARN.
  for (const rawLine of budgetSection.split("\n")) {
    const m = COUNTED_BUDGET_RE.exec(rawLine);
    if (!m) continue;
    const [, label, usedStr, capStr] = m;
    const used = Number(usedStr);
    const cap = Number(capStr);
    if (!(used > cap)) continue;
    if (JUSTIFIED_RE.test(rawLine)) continue;
    issues.push({
      severity: "WARN",
      check: "budget-exceeded",
      message: `Complexity Budget exceeded: ${label} ${used}/${cap} max (${used} > ${cap}) with no "(justified: ...)" rationale on the line`,
    });
  }
}

function checkConsolidatedFiles(issues) {
  const files = ["FINDINGS.md", "DECISIONS.md", "LESSONS.md"];
  for (const f of files) {
    if (!existsSync(join(plansDir, f))) {
      issues.push({ severity: "INFO", check: "consolidated", message: `plans/${f} not found (created on first plan)` });
    }
  }

  // Check INDEX.md
  if (!existsSync(join(plansDir, "INDEX.md"))) {
    issues.push({ severity: "INFO", check: "consolidated", message: "plans/INDEX.md not found (created on first new)" });
  }
}

// v2.60.0 — [index-orphan]: a closed plan with NO surviving copy anywhere.
//
// The per-plan directory is EPHEMERAL by design (references/decision-anchoring.md), and the
// plans glob is gitignored in every consuming project, so a MISSING DIRECTORY IS NORMAL and
// is deliberately NOT reported here. The defect this check exists for is narrower and real:
// a plan named by plans/INDEX.md whose directory is gone AND whose `## <plan-id>` section is
// no longer in plans/FINDINGS.md or plans/DECISIONS.md. Nothing survives that plan — its
// findings, decisions and reasoning are unrecoverable, and until now every health command in
// this repo reported exit 0 over exactly that state.
//
// WARN, never ERROR. On any corpus with history this fires immediately for every plan already
// lost before the check shipped; ERROR would block CLOSE on a pre-existing backlog the current
// author cannot fix. Same policy as [lessons-eviction] — a signal of this class must never
// block CLOSE.
//
// COST: O(rows in plans/INDEX.md) existsSync calls + at most 2 file reads total (FINDINGS.md,
// DECISIONS.md, read once outside the loop). NO directory enumeration. The O(all-plan-dirs)
// walk prohibited by plan-2026-07-16T164852-47577439/D-001 is NOT reintroduced, and this is
// not a derived index — INDEX.md is written at CLOSE by its owner and read as-is.
function checkIndexResolution(issues) {
  const index = readFile(join(plansDir, "INDEX.md"));
  if (index === null) return; // absence already reported by checkConsolidatedFiles as INFO

  // Same INDEX row idiom as checkLessonsEviction: first cell of a pipe row, trimmed, must be
  // a plan-id in either grammar. Header and separator rows fail the anchored test and are
  // skipped for free.
  const planIds = [];
  for (const line of index.split("\n")) {
    const m = /^\|([^|]+)\|/.exec(line);
    if (!m) continue;
    const cell = m[1].trim();
    if (ANY_PLAN_ID_RE.test(cell)) planIds.push(cell);
  }
  if (planIds.length === 0) return;

  // Read the consolidated tier once, only if at least one directory is actually missing.
  const missing = planIds.filter((id) => !existsSync(join(plansDir, id)));
  if (missing.length === 0) return;

  const consolidated = [
    readFile(join(plansDir, "FINDINGS.md")) || "",
    readFile(join(plansDir, "DECISIONS.md")) || "",
  ].join("\n");

  for (const id of missing) {
    // Capturing-section idiom, built from the shared non-capturing grammar (see
    // collectKnownDecisionIdsByPlan). Escape nothing: plan-ids are [a-z0-9_-] plus digits
    // and 'T' by grammar, so the id is regex-safe by construction.
    const sectionRe = new RegExp(`^##[ \\t]+${id}[ \\t]*$`, "m");
    if (sectionRe.test(consolidated)) continue;
    issues.push({
      severity: "WARN",
      check: "index-orphan",
      message: `plans/INDEX.md names ${id} but plans/${id}/ is gone AND no "## ${id}" section survives in plans/FINDINGS.md or plans/DECISIONS.md — that plan's findings and decisions have no surviving copy. Anchors in source may still reference it via plans/ANCHORS.md.`,
    });
  }
}

// v2.16.0 — System atlas cap enforcement.
// plans/SYSTEM.md is the cross-plan system atlas (domain-neutral; rewritten
// at CLOSE by ip-archivist; see references/file-formats.md ## plans/SYSTEM.md).
// Hard cap is 300 lines. ERROR on cap violation prevents silent truncation by
// writers — the cap forces curation (demote-by-staleness), not truncation.
// File-absent on legacy plans (created before v2.16.0) is INFO, not ERROR.
const SYSTEM_ATLAS_LINE_CAP = 300;

function checkSystemAtlasCap(issues) {
  const path = join(plansDir, "SYSTEM.md");
  if (!existsSync(path)) {
    issues.push({ severity: "INFO", check: "atlas-absent", message: "plans/SYSTEM.md not found (created on first `bootstrap.mjs new` from v2.16.0; legacy plans may lack it)" });
    return;
  }
  let content;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return; // unreadable — silent. existence was already checked.
  }
  // Trailing newline produces an empty trailing element — drop it for accurate count.
  const lines = content.split("\n");
  const lineCount = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  if (lineCount > SYSTEM_ATLAS_LINE_CAP) {
    issues.push({
      severity: "ERROR",
      check: "atlas-cap",
      message: `plans/SYSTEM.md is ${lineCount} lines (>${SYSTEM_ATLAS_LINE_CAP} cap). Curate at next CLOSE — demote-by-staleness, do NOT truncate by recency. See references/file-formats.md ## plans/SYSTEM.md.`,
    });
  }
}

// Hard cap on plans/LESSONS.md (200 lines, per SKILL.md § Lessons Learned).
// Mirrors the SYSTEM.md cap: the file is rewritten at CLOSE, so a cap violation
// is a curation failure that must be corrected (consolidate / drop stale entries)
// rather than silently truncated.
const LESSONS_LINE_CAP = 200;

// Validate compression-summary marker integrity in consolidated files
// (plans/FINDINGS.md, plans/DECISIONS.md). Rules from SKILL.md §Consolidated
// File Management — Compression: markers come in matched pairs, never nested,
// at most one pair per file, and must sit between H1 and the first
// `## <plan-id>` section. We enforce pairing + non-nesting strictly, and the "at most one
// pair" rule because the compression protocol REPLACES the block on each
// regeneration (Step 3, SKILL.md L167); two pairs imply a regeneration bug.
function checkCompressionMarkers(issues) {
  const OPEN = "<!-- COMPRESSED-SUMMARY -->";
  const CLOSE = "<!-- /COMPRESSED-SUMMARY -->";
  for (const fname of ["FINDINGS.md", "DECISIONS.md"]) {
    const path = join(plansDir, fname);
    if (!existsSync(path)) continue;
    let content;
    try { content = readFileSync(path, "utf-8"); } catch { continue; }
    // NOTE: OBS-010 line-anchored markers.
    // Pre-fix: `content.indexOf(OPEN)` substring-matched prose mentions of
    // the marker (e.g. a finding's plain-English description of the
    // compression machinery wrapped in backticks). Result: false-positive
    // ERROR `[compress-markers] unbalanced (1 open, 0 close)` for any plan
    // documenting its own compression spec. Fix: only count occurrences
    // where the trimmed line equals the marker exactly. Position arrays use
    // BYTE OFFSETS of the line in the file (needed for the alternation
    // check below).
    const lines = content.split("\n");
    const opens = [];
    const closes = [];
    let offset = 0;
    for (const ln of lines) {
      const trimmed = ln.trim();
      if (trimmed === OPEN) opens.push(offset);
      else if (trimmed === CLOSE) closes.push(offset);
      offset += ln.length + 1; // +1 for the "\n"
    }
    if (opens.length === 0 && closes.length === 0) continue;
    if (opens.length !== closes.length) {
      issues.push({
        severity: "ERROR",
        check: "compress-markers",
        message: `plans/${fname}: unbalanced compression markers (${opens.length} open, ${closes.length} close). Markers must come in matched pairs. See SKILL.md §Consolidated File Management.`,
      });
      continue;
    }
    // Pair them positionally and verify strict alternation (no nesting).
    let nested = false;
    let outOfOrder = false;
    for (let k = 0; k < opens.length; k++) {
      if (opens[k] >= closes[k]) { outOfOrder = true; break; }
      if (k > 0 && opens[k] < closes[k - 1]) { nested = true; break; }
    }
    if (outOfOrder) {
      issues.push({ severity: "ERROR", check: "compress-markers", message: `plans/${fname}: compression marker found out of order (close before open). See SKILL.md §Consolidated File Management.` });
      continue;
    }
    if (nested) {
      issues.push({ severity: "ERROR", check: "compress-markers", message: `plans/${fname}: nested compression markers detected. The compression protocol REPLACES the block, never nests.` });
      continue;
    }
    if (opens.length > 1) {
      issues.push({
        severity: "ERROR",
        check: "compress-markers",
        message: `plans/${fname}: ${opens.length} compression-summary blocks found (expected ≤1). Compression replaces the existing block — multiple blocks indicate a regeneration bug. See SKILL.md L167.`,
      });
      continue;
    }
    // One pair: verify it sits before the first `## <plan-id>` section (BOTH
    // grammars — shared.mjs PLAN_SECTION_PATTERN, a string; this instance is local,
    // so it shares no `lastIndex` with anyone).
    const firstPlanSection = content.search(new RegExp(PLAN_SECTION_PATTERN, "gm"));
    if (firstPlanSection !== -1 && opens[0] > firstPlanSection) {
      issues.push({
        severity: "WARN",
        check: "compress-markers",
        message: `plans/${fname}: compression block appears AFTER the first \`## <plan-id>\` section. Per SKILL.md §Compression Format, the block belongs between the H1 header and the first plan section.`,
      });
    }
  }
}

function checkLessonsCap(issues) {
  const path = join(plansDir, "LESSONS.md");
  if (!existsSync(path)) {
    // Created by bootstrap on first `new`. Absent file = legacy plan; informational only.
    issues.push({ severity: "INFO", check: "lessons-absent", message: "plans/LESSONS.md not found (created on first `bootstrap.mjs new`; legacy plans may lack it)" });
    return;
  }
  let content;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return; // unreadable — silent.
  }
  const lines = content.split("\n");
  const lineCount = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  if (lineCount > LESSONS_LINE_CAP) {
    issues.push({
      severity: "ERROR",
      check: "lessons-cap",
      message: `plans/LESSONS.md is ${lineCount} lines (>${LESSONS_LINE_CAP} cap). Rewrite at next CLOSE — consolidate related lessons, drop low-value entries, tighten wording. See SKILL.md § Lessons Learned.`,
    });
  }
}

// v2.53.0 (F1) — lessons-eviction gate. The archivist REWRITES plans/LESSONS.md
// at every CLOSE with a policy of "never drop an [I:5] entry — tighten or merge
// wording instead" (ip-archivist.md Step 4), but nothing mechanical held that
// invariant: the cap checks above count lines only. This rule compares the
// [I:5]-tagged line COUNT in the current LESSONS.md against the previous
// close's point-in-time copy (plans/<prev>/lessons_snapshot.md, resolved via
// plans/INDEX.md's last data row — INDEX is append-only, one row per close,
// so the last plan-id row IS the most recent close).
//
// DECISION plan-2026-07-16T164852-47577439/D-001 — severity is WARN/INFO only, triggered by
// the COUNT invariant alone; no fuzzy content matching. An equal-count content swap is a
// recorded limitation left to human judgment. Never promote to ERROR — [I:5] curation must
// not block CLOSE.
function checkLessonsEviction(issues) {
  const lessons = readFile(join(plansDir, "LESSONS.md"));
  if (lessons === null) return; // absent/unreadable — checkLessonsCap already reports absence

  // Resolve the previous close: LAST plans/INDEX.md data row whose first cell
  // is a plan-id (either shape). Header/separator rows fail the anchored
  // ANY_PLAN_ID_RE and are skipped; malformed rows degrade to "no baseline".
  const index = readFile(join(plansDir, "INDEX.md"));
  let prevPlanId = null;
  if (index) {
    for (const line of index.split("\n")) {
      const m = /^\|([^|]+)\|/.exec(line);
      if (!m) continue;
      const cell = m[1].trim();
      if (ANY_PLAN_ID_RE.test(cell)) prevPlanId = cell;
    }
  }
  if (!prevPlanId) {
    issues.push({
      severity: "INFO",
      check: "lessons-eviction",
      message: "no previous close on record in plans/INDEX.md — eviction baseline unavailable",
    });
    return;
  }

  const snapshot = readFile(join(plansDir, prevPlanId, "lessons_snapshot.md"));
  if (snapshot === null) {
    issues.push({
      severity: "INFO",
      check: "lessons-eviction",
      message: `previous plan ${prevPlanId} has no lessons_snapshot.md (predates snapshot mechanism) — eviction baseline unavailable`,
    });
    return;
  }

  const i5Lines = (txt) => txt.split("\n").filter((ln) => ln.includes("[I:5]"));
  const prev = i5Lines(snapshot);
  const curr = i5Lines(lessons);
  if (curr.length >= prev.length) return; // equal (even reworded) or grown — silent

  // Diff-style decision-support summary: snapshot [I:5] lines absent verbatim
  // from the current file, and current [I:5] lines absent from the snapshot.
  // Verbatim set membership only — rewording shows up as a -/+ pair for a
  // human to judge, never as a similarity score.
  const truncate = (s) => (s.length > 120 ? `${s.slice(0, 117)}...` : s);
  const currSet = new Set(curr);
  const prevSet = new Set(prev);
  const diff = [
    ...prev.filter((ln) => !currSet.has(ln)).map((ln) => `- ${truncate(ln)}`),
    ...curr.filter((ln) => !prevSet.has(ln)).map((ln) => `+ ${truncate(ln)}`),
  ];
  const shown = diff.slice(0, 10);
  if (diff.length > shown.length) shown.push(`… (${diff.length - shown.length} more changed line(s))`);
  issues.push({
    severity: "WARN",
    check: "lessons-eviction",
    message:
      `plans/LESSONS.md has ${curr.length} [I:5] line(s); the previous close's snapshot (${prevPlanId}/lessons_snapshot.md) had ${prev.length}. ` +
      `Apparent changes:\n    ${shown.join("\n    ")}\n    ` +
      `Merges/tightening of [I:5] entries are legitimate curation — this is a human judgment call, decision-support only, never a CLOSE blocker.`,
  });
}

// ---------------------------------------------------------------------------
// Decisions.md schema checks (Step 3.1 + 3.2 — added in 2.13.0)
// ---------------------------------------------------------------------------

// Parse decisions.md into entries. Each entry: { id: number, idStr: "D-NNN",
// header: full header line, phase: PHASE token (uppercased for matching),
// date: YYYY-MM-DD string, body: text between this header and next.
// Skips headings inside HTML comment blocks (the schema example block).
//
// Returns { entries, badHeaders, preamblePlanId, preambleLine }:
//   preamblePlanId — value of the *Plan: <plan-id>* preamble line if present, else null
//   preambleLine — 1-based line number of the preamble (for diagnostics), or null
function parseDecisionsEntries(content) {
  if (!content) return { entries: [], badHeaders: [], preamblePlanId: null, preambleLine: null };

  // Extract preamble before stripping comments (preamble lives outside comments).
  // Look in the first 10 non-blank lines for `*Plan: <plan-id>*`.
  let preamblePlanId = null;
  let preambleLine = null;
  {
    const rawLines = content.split("\n");
    const preambleRe = new RegExp(`^\\*Plan:\\s*(${ANY_PLAN_ID_PATTERN})\\*\\s*$`);
    let nonBlankSeen = 0;
    for (let i = 0; i < rawLines.length && nonBlankSeen < 10; i++) {
      const t = rawLines[i].trim();
      if (t === "") continue;
      nonBlankSeen += 1;
      const pm = preambleRe.exec(t);
      if (pm) {
        preamblePlanId = pm[1];
        preambleLine = i + 1;
        break;
      }
    }
  }

  // Blank the intra-plan COMPRESSED-SUMMARY block first (markers + body) so its
  // markdown headings ("## Summary (compressed)", "### Decision lookup", ...) —
  // written by bootstrap.mjs maybeCompressDecisions — are not parsed as decision
  // entries. Then blank the remaining HTML comment regions so the example schema
  // in bootstrap.mjs (wrapped in <!-- ... -->) does not register as a real D-001.
  //
  // DECISION plan_2026-07-14_79ee0f59/D-010 — both scrubs are LINE-COUNT PRESERVING and
  // code-span aware. Do not restore a raw `.replace(/<!--[\s\S]*?-->/g, "")`: it shifted
  // reported line numbers and, worse, let a backticked `<!--` in real prose open a phantom
  // span that silently swallowed later entries (failed OPEN). Use shared.mjs's
  // `htmlCommentSpans` — the single definition of where the comments are.
  const stripped = stripHtmlComments(blankCompressedSummaryBlock(content));
  const lines = stripped.split("\n");
  const entries = [];
  const badHeaders = [];
  // Decision ids are `D-NNN` with 3-digit padding as the MINIMUM, not a cap:
  // `D-1000` must parse (shared.mjs DECISION_ID_NUM_PATTERN). `D-1` stays a bad header.
  const headerRe = new RegExp(`^## D-(${DECISION_ID_NUM_PATTERN}) \\| (.+) \\| (\\d{4}-\\d{2}-\\d{2})$`);
  // Any "## " heading that is not the top-level "# Decision Log" header.
  const anyH2Re = /^## (.+)$/;

  let current = null;
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h2 = anyH2Re.exec(line);
    if (h2) {
      // Close previous
      if (current) {
        current.body = lines.slice(bodyStart, i).join("\n");
        entries.push(current);
        current = null;
      }
      const m = headerRe.exec(line);
      if (m) {
        current = {
          id: parseInt(m[1], 10),
          idStr: `D-${m[1]}`,
          header: line,
          phase: m[2].trim().toUpperCase(),
          date: m[3],
          lineNum: i + 1,
          body: "",
        };
        bodyStart = i + 1;
      } else {
        // Non-conforming heading. Record it.
        badHeaders.push({ line, lineNum: i + 1 });
      }
    }
  }
  if (current) {
    current.body = lines.slice(bodyStart).join("\n");
    entries.push(current);
  }
  return { entries, badHeaders, preamblePlanId, preambleLine };
}

function checkDecisionsSchema(planDir, issues) {
  const path = join(planDir, "decisions.md");
  const content = readFile(path);
  if (!content) return;

  const { entries, badHeaders } = parseDecisionsEntries(content);

  // 3.1a — header format on every ## heading.
  for (const bh of badHeaders) {
    issues.push({
      severity: "ERROR",
      check: "decisions-schema",
      message: `decisions.md:${bh.lineNum} non-conforming entry header: "${bh.line}" (expected "## D-NNN | PHASE | YYYY-MM-DD")`,
    });
  }

  // 3.1b — sequential numbering [1, 2, 3, ...] starting from 1.
  if (entries.length > 0) {
    const ids = entries.map((e) => e.id);
    for (let i = 0; i < ids.length; i++) {
      const expected = i + 1;
      if (ids[i] !== expected) {
        issues.push({
          severity: "ERROR",
          check: "decisions-schema",
          message: `decisions.md D-NNN sequence broken at position ${i + 1}: expected D-${String(expected).padStart(3, "0")}, got D-${String(ids[i]).padStart(3, "0")}`,
        });
        break;
      }
    }
  }

  // 3.1c — Trade-off line presence in every entry, and "at the cost of" phrase.
  // 3.1d — Complexity Assessment block in PIVOT entries.
  const tradeoffRe = /^\*\*Trade-off\*\*:/m;
  const atTheCostOfRe = /at the cost of/i;
  for (const e of entries) {
    if (!tradeoffRe.test(e.body)) {
      issues.push({
        severity: "ERROR",
        check: "decisions-schema",
        message: `decisions.md ${e.idStr} (line ${e.lineNum}) missing **Trade-off**: line`,
      });
    } else if (!atTheCostOfRe.test(e.body)) {
      issues.push({
        severity: "WARN",
        check: "decisions-schema",
        message: `decisions.md ${e.idStr} (line ${e.lineNum}) **Trade-off**: line missing "at the cost of" phrase`,
      });
    }
    // F5 — strict PIVOT detection via shared helper. Previously raw
    // `phase.includes("PIVOT")` false-positive-matched `PIVOT-RECOVERY` and
    // false-negative-missed `REPLAN` (which transition-history normalization
    // already maps to PIVOT). Both checks now share normalizePhase/isPivotPhase.
    if (isPivotPhase(e.phase)) {
      if (!/\*\*Complexity Assessment\*\*/.test(e.body)) {
        issues.push({
          severity: "ERROR",
          check: "decisions-schema",
          message: `decisions.md ${e.idStr} (line ${e.lineNum}) is a PIVOT entry but missing **Complexity Assessment** block`,
        });
      }
    }
  }
}

// 3.1e — Verdict 5 required bullets, in order, and actually filled in.
function checkVerificationVerdict(planDir, issues) {
  const path = join(planDir, "verification.md");
  const content = readFile(path);
  if (!content) return;
  // Untrimmed: the indent of the first bullet is load-bearing here (see the
  // field-list discriminator below).
  const verdict = extractSection(content, "Verdict", { trim: false });
  if (!verdict) return; // section presence is not enforced here; other checks own it.

  // Every scan below runs against a bullet's parsed LABEL — never against the
  // whole section and never against free bullet text. Three distinct false
  // positives all reduce to that one rule (D-009):
  //   1. Narrative above the bullets ("no regressions were introduced, and
  //      scope drift was avoided") matched "regressions" before "criteria
  //      passed" and tripped the order check. Do NOT scan `verdict` directly.
  //   2. A keyword in a bullet's VALUE ("- Criteria passed: 5/5 as recommended
  //      by the reviewer") did the same. Do NOT scan raw bullet text either.
  //   3. The PENDING scan iterated EVERY bullet-shaped line, so a nested
  //      sub-bullet ("  - follow-up: PENDING a separate plan") produced a
  //      CLOSE-blocking ERROR on a fully-filled Verdict. It must intersect with
  //      the 5 required labels.
  // Bullet markers cover `-`, `*`, `+` and the ordered forms `1.` / `1)`.
  // Narrowing this to `-`/`*` regressed previously-clean numbered-list Verdicts
  // to a hard `missing required bullet(s)` ERROR — do NOT re-narrow it.
  const BULLET_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
  const verdictLines = verdict.split("\n");

  // A fenced code block inside the Verdict holds an EXAMPLE, not Verdict
  // fields. Scanning it treated `- Criteria passed: PENDING` inside a fence as
  // a real bullet and produced a CLOSE-blocking ERROR on a fully-filled
  // Verdict (D-012). Both ``` and ~~~ fences are recognized; a fence of the
  // other character inside an open fence is content, not a delimiter.
  //
  // UNTERMINATED fence: deliberately marks NOTHING. Swallowing the rest of the
  // section would empty `bullets` and trade this false positive for a
  // `missing required bullet(s)` false positive plus a silently-skipped
  // PENDING scan — strictly worse. An unclosed fence is a malformed document,
  // and the safe reading of a malformed document is the pre-fence one.
  const FENCE_RE = /^\s*(`{3,}|~{3,})/;
  const fenced = new Array(verdictLines.length).fill(false);
  let openAt = -1;
  let openChar = "";
  for (let i = 0; i < verdictLines.length; i++) {
    const f = FENCE_RE.exec(verdictLines[i]);
    if (!f) continue;
    if (openAt === -1) { openAt = i; openChar = f[1][0]; continue; }
    if (f[1][0] !== openChar) continue;
    for (let j = openAt; j <= i; j++) fenced[j] = true;
    openAt = -1;
  }

  const bullets = [];
  for (let i = 0; i < verdictLines.length; i++) {
    if (fenced[i]) continue;
    const b = BULLET_RE.exec(verdictLines[i]);
    if (!b) continue;
    const body = b[2];
    const sep = /^(.+?):\s*(.*)$/.exec(body);
    // A colon-less bullet keeps its whole text as the label, so presence/order
    // stay exactly as permissive as they were before label scoping. Only the
    // PENDING scan needs a value, and a colon-less bullet has none.
    bullets.push(sep
      ? { label: sep[1].trim(), value: sep[2].trim() }
      : { label: body.trim(), value: null });
  }

  const labels = [
    "Criteria passed",
    "Regressions",
    "Scope drift",
    "Simplification blockers",
    "Recommended transition",
  ];

  // The Verdict FIELD LIST — derived once, then used by presence, order and
  // PENDING alike. A bullet is a field when its LABEL, normalized, IS one of the
  // five required labels (or a separator-joined compound of them). Everything
  // else in the section — lead-ins, commentary, deferred-work notes — is not.
  //
  // DECISION plan-2026-08-04T092155-0063b038/D-011 — SUPERSEDED by D-013, kept as the
  // thing NOT to do: a "keyword bullet at minimum indent" rule made indentation
  // load-bearing and shipped six CLOSE-blocking false positives on correctly-indented
  // Verdicts. Do not restore it and do not reach for indent again.
  //
  // DECISION plan-2026-08-04T092155-0063b038/D-013 — the discriminator is LABEL
  // TIGHTNESS, never position: a bullet is a field only when its label essentially IS
  // the required label. Both absolute and relative indent rules have shipped a
  // CLOSE-blocking false positive (see D-011); unanchored keyword substrings are the
  // original defect ("Recommendation-related follow-up" matched "Recommendation").
  const FIELD_LABEL_PATTERNS = [
    /^criteria\s+pass(?:ed|es|ing)?(?:\s+count)?$/,
    /^regressions?$/,
    /^scope\s+drift$/,
    /^simplification\s+blockers?$/,
    /^recommend(?:ation|ations|ed)?(?:\s+(?:transition|state))?$/,
  ];
  // Trivial decoration a real label may carry: markdown emphasis or code ticks, a
  // trailing parenthetical ("Criteria passed (C-1..C-13)"), trailing punctuation,
  // and case/whitespace variation. None of it changes WHICH label is being written.
  const normalizeLabel = (label) => label
    .replace(/[*_`~]/g, "")
    .trim()
    .replace(/\s*\([^)]*\)$/, "")
    .replace(/[.:!?]+$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  // A compound label ("Regressions and scope drift", "Scope drift / regressions")
  // is a field for BOTH of its keywords, but is still ONE bullet — the order walk
  // below therefore lets one bullet satisfy consecutive keywords instead of
  // demanding a distinct bullet per keyword. Every part must itself be tight; one
  // free-text part ("Regressions and next steps") makes the whole bullet commentary.
  const SEPARATOR_RE = new RegExp("\\s+and\\s+|\\s*[/&+,;]\\s*");
  const labelKeywords = (label) => {
    const norm = normalizeLabel(label);
    if (!norm) return [];
    const keys = [];
    for (const part of norm.split(SEPARATOR_RE)) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const idx = FIELD_LABEL_PATTERNS.findIndex((re) => re.test(trimmed));
      if (idx === -1) return [];
      if (!keys.includes(idx)) keys.push(idx);
    }
    return keys;
  };

  const fields = [];
  for (const b of bullets) {
    const keys = labelKeywords(b.label);
    if (keys.length > 0) fields.push({ ...b, keys });
  }

  // Presence and order over the derived field list. `at >= lastIdx` (not `>`) is
  // what makes a compound label count ONCE: it may satisfy two consecutive
  // required keywords without a second bullet, and cannot satisfy a keyword whose
  // predecessor was matched later in the document.
  let lastIdx = 0;
  let orderBroken = false;
  const missing = [];
  for (let i = 0; i < labels.length; i++) {
    if (!fields.some((f) => f.keys.includes(i))) {
      missing.push(labels[i]);
      continue;
    }
    let at = -1;
    for (let j = lastIdx; j < fields.length; j++) {
      if (fields[j].keys.includes(i)) { at = j; break; }
    }
    if (at === -1) { orderBroken = true; continue; }
    lastIdx = at;
  }

  if (missing.length > 0) {
    issues.push({
      severity: "ERROR",
      check: "verdict",
      message: `verification.md Verdict missing required bullet(s): ${missing.join(", ")}`,
    });
  }
  if (orderBroken) {
    issues.push({
      severity: "ERROR",
      check: "verdict",
      message: "verification.md Verdict bullets present but not in required order (Criteria passed, Regressions, Scope drift, Simplification blockers, Recommended transition)",
    });
  }

  // Unfilled bullets: bootstrap writes every Verdict value as `PENDING`, and
  // the keyword scan above is satisfied by the LABELS alone, so a skeleton
  // Verdict used to validate clean all the way through CLOSE. State-gated the
  // same way checkCrossFileConsistency reads `# Current State:` — PENDING is
  // CORRECT before REFLECT (bootstrap just wrote it), so this must stay silent
  // in every other state or it fires on every freshly-bootstrapped plan.
  const state = readFile(join(planDir, "state.md"));
  const currentState = (extractField(state, /^# Current State:\s*(.+)$/m) || "").trim().toUpperCase();
  if (currentState !== "REFLECT" && currentState !== "CLOSE") return;

  // Only the 5 required bullets can be "unfilled" — a sub-bullet recording
  // deferred work is not a Verdict field, even when its label CONTAINS one of the
  // required labels. `fields` is the single derived list above; do not re-run any
  // keyword test over `bullets` here.
  //
  // Reported per REQUIRED FIELD, not per bullet: a Verdict may legitimately carry
  // two bullets whose labels are both tight for the same field (a filled one plus
  // a nested `- Regressions: PENDING soak testing` note), and the field is unfilled
  // only when EVERY bullet that could fill it is still PENDING.
  const pending = [];
  for (let i = 0; i < labels.length; i++) {
    const candidates = fields.filter((f) => f.keys.includes(i) && f.value !== null);
    if (candidates.length === 0) continue;
    if (!candidates.every((f) => /^PENDING\b/i.test(f.value))) continue;
    if (!pending.includes(candidates[0].label)) pending.push(candidates[0].label);
  }
  if (pending.length > 0) {
    issues.push({
      severity: currentState === "CLOSE" ? "ERROR" : "WARN",
      check: "verdict",
      message: `verification.md Verdict bullet(s) still unfilled (PENDING) at ${currentState}: ${pending.join(", ")}`,
    });
  }
}

// 3.1f — findings.md Index links resolve to existing files in findings/.
function checkFindingsIndexLinks(planDir, issues) {
  const path = join(planDir, "findings.md");
  const content = readFile(path);
  if (!content) return;
  const indexSection = extractSection(content, "Index");
  if (!indexSection) return;

  const linkRe = /\[[^\]]+\]\(([^)]+)\)/g;
  let m;
  while ((m = linkRe.exec(indexSection)) !== null) {
    const href = m[1].trim();
    if (/^https?:\/\//.test(href)) continue;
    if (href.startsWith("#")) continue;
    // Resolve relative to plan dir.
    const target = join(planDir, href);
    if (!existsSync(target)) {
      issues.push({
        severity: "ERROR",
        check: "findings-index",
        message: `findings.md Index link does not resolve: ${href}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Reverse anchor check (Step 3.1g — added in 2.13.0)
// ---------------------------------------------------------------------------

export const ANCHOR_SOURCE_EXTS = new Set([
  ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".rb", ".go", ".rs",
  ".c", ".h", ".cpp", ".hpp", ".java", ".kt", ".sql", ".md",
  // 16 additions (v2.57.6): the union of findAnchorsInFile's hash-style and
  // slash-style per-family lists — restores real anchor-audit coverage for
  // extensions that scanner already knows how to parse but this collection-side
  // allowlist never grew to include. Must stay byte-identical to bootstrap.mjs's
  // own ANCHOR_SOURCE_EXTS copy (see that file's "Kept in sync" comment).
  ".sh", ".bash", ".zsh", ".yml", ".yaml", ".toml", ".r", ".pl", ".pm", ".tf",
  ".jsx", ".cc", ".swift", ".scala", ".cs", ".php",
]);

// NOTE: extensions whose ONLY anchor form is the HTML comment `<!-- DECISION … -->`.
// In these files the hash/slash/SQL/block scans are suppressed: Markdown prose and
// fenced code blocks routinely contain `#`, `//`, `--` and C-style block-comment
// delimiters as ordinary text (CHANGELOG.md:331 quotes an inline block comment
// holding two bare `D-NNN` tokens, while describing this very scanner). Requiring
// the `DECISION` token immediately after a `<!--` opener makes every doc example
// inert by construction rather than by exclusion list.
// Do NOT write a literal block-comment delimiter pair in this file's comments: the
// block scan below has no marker prefix and would read it as a real anchor block.
export const HTML_STYLE_EXTS = new Set([".md", ".markdown", ".mdx", ".html", ".htm"]);

const SKIP_DIR_NAMES = new Set([
  "node_modules", ".git", "dist", "build", "plans",
  "target", "__pycache__", ".cache", "vendor", "out",
]);

function walkSourceFiles(root, files = [], depth = 0) {
  if (depth > 12) return files;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const ent of entries) {
    if (ent.name.startsWith(".") && ent.name !== ".") {
      // skip dotdirs/dotfiles by default (covers .git, .cache, etc.)
      if (ent.isDirectory()) continue;
    }
    const full = join(root, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIR_NAMES.has(ent.name)) continue;
      walkSourceFiles(full, files, depth + 1);
    } else if (ent.isFile()) {
      const ext = extname(ent.name);
      if (ANCHOR_SOURCE_EXTS.has(ext)) {
        files.push(full);
      }
    }
  }
  return files;
}

// Loose plan-id prefix: ANY run of non-space, non-slash characters sitting where a
// plan-id belongs. Used ONLY by the bad-prefix scan below — never to resolve an anchor.
// It is not a plan-id grammar (D-005's "one grammar" rule is untouched); it is the
// complement used to see the anchors the real grammar cannot see.
const LOOSE_ANCHOR_PREFIX_PATTERN = "[^\\s\\/]+";

// The anchor regex family, built ONCE from a single body template so the strict form
// (prefix = the shared read union) and the loose form (prefix = anything) cannot drift
// apart. Capture groups: 1=planName(opt), 2=id, 3=stale(opt).
// The strict prefix is the READ UNION from shared.mjs, which is NON-CAPTURING
// `(?:new|legacy)` — that is load-bearing, not stylistic: `pushMatch` reads
// m[1]/m[2]/m[3] by index, so a capture group inside the union shifts all three and
// mis-parses every anchor in the repo. The decision-id digit run is `\d{3,}(?!\d)` —
// 3-digit padding is a MINIMUM, so D-1000+ is scannable; the trailing boundary keeps the
// run maximal. These four MUST stay grammar-identical to bootstrap.mjs retire's stamper,
// or retire cannot clear an orphan this scanner reports.
function buildAnchorRegexes(prefixPattern) {
  const body = `(?:(${prefixPattern})\\/)?D-(${DECISION_ID_NUM_PATTERN})(\\s+\\[STALE\\])?`;
  return {
    hashRe: new RegExp(`(?:^|\\s)#\\s+DECISION\\s+${body}(?::|\\s|$)`),
    slashRe: new RegExp(`(?:^|\\s)\\/\\/\\s+DECISION\\s+${body}(?::|\\s|$)`),
    sqlRe: new RegExp(`(?:^|\\s)--\\s+DECISION\\s+${body}(?::|\\s|$)`),
    blockInnerRe: new RegExp(`DECISION\\s+${body}`),
  };
}

// Collect all anchor occurrences in a single source file. Returns array of
// { file, line, planName, id, qualified, stale }:
//   planName — string plan-id prefix if anchor is qualified, else null
//   id       — D-NNN integer (just the three-digit number)
//   qualified — true iff planName is non-null
//   stale    — true iff anchor carries the [STALE] marker
//
// `prefixPattern` defaults to the shared read union (the real grammar). The bad-prefix
// scan re-runs this same walk with LOOSE_ANCHOR_PREFIX_PATTERN — same extension gating,
// same comment spans, same doc-example immunity — so the two scans cannot disagree about
// what counts as a comment.
function findAnchorsInFile(file, projectRoot, prefixPattern = ANY_PLAN_ID_PATTERN) {
  let text;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  const ext = extname(file);
  const out = [];

  const { hashRe, slashRe, sqlRe, blockInnerRe } = buildAnchorRegexes(prefixPattern);

  function pushMatch(m, lineNum) {
    out.push({
      file,
      line: lineNum,
      planName: m[1] || null,
      id: parseInt(m[2], 10),
      qualified: !!m[1],
      stale: !!m[3],
    });
  }

  // Per-line scan for hash, slash, double-dash markers.
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    // Hash style.
    if ([".py", ".rb", ".sh", ".bash", ".zsh", ".yml", ".yaml", ".toml", ".r", ".pl", ".pm", ".tf"].includes(ext)) {
      m = hashRe.exec(line);
      if (m) pushMatch(m, i + 1);
    }
    // Slash style.
    if ([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".go", ".rs", ".c", ".h", ".cpp", ".hpp", ".cc", ".java", ".swift", ".kt", ".scala", ".cs", ".php"].includes(ext)) {
      m = slashRe.exec(line);
      if (m) pushMatch(m, i + 1);
    }
    // SQL double-dash.
    if (ext === ".sql") {
      m = sqlRe.exec(line);
      if (m) pushMatch(m, i + 1);
    }
  }

  // Block comment scan (multi-line) — runs ONLY on `BLOCK_COMMENT_EXTS`, the shared.mjs
  // allowlist of extensions whose grammar actually has `/* */` (D-032).
  // Loop over EVERY anchor in the block; previously only the first was found.
  // NOTE: this scan has no comment-marker prefix on its inner regex, so it must NOT run
  // on files where those delimiters are ordinary text. In HTML-style files that is prose
  // — CHANGELOG.md:331 quotes an inline block comment holding two bare `D-NNN` tokens —
  // and in hash-family files it is shell globs (`build/*` … `src/*/lib`), which used to
  // open a phantom span across a real anchor and report it twice. An ALLOWLIST states
  // where the grammar applies instead of guessing where it does not; gate on the
  // extension, never by path (that hides real anchors in a whole directory).
  //
  // DECISION plan-2026-09-01T100120-4f591469/D-007 — spans come from shared.mjs's
  // `blockCommentSpans`, never a local raw-text regex (code-string-blind, and shipped both
  // double-reporting and silent anchor loss). Byte offsets into `text`, never paired with
  // stripped text. `bootstrap.mjs retire` consumes the same primitive — change one, change both.
  if (BLOCK_COMMENT_EXTS.has(ext)) {
    for (const { start, end } of blockCommentSpans(text)) {
      const body = text.slice(start + 2, end - 2); // strip "/*" and its closer
      const bodyOffset = start + 2;
      const innerRe = new RegExp(blockInnerRe.source, "g");
      let dm;
      while ((dm = innerRe.exec(body)) !== null) {
        // Compute the line number of this specific match within the file.
        const lineNum = text.slice(0, bodyOffset + dm.index).split("\n").length;
        pushMatch(dm, lineNum);
      }
    }
  }

  // HTML comment scan (multi-line) — the ONLY anchor form recognized in Markdown
  // and HTML. Two-stage, mirroring the block-comment loop above so the two paths
  // behave identically: the outer regex finds each well-formed (CLOSED) comment
  // span; the inner marker-less loop — reusing blockInnerRe.source verbatim, NOT a
  // second pattern — finds EVERY `DECISION … D-NNN` token in the comment body, not
  // only the first. `DECISION` need NOT be adjacent to the `<!--` opener. An
  // UNCLOSED `<!-- DECISION …` (no `-->`) is a comment span to neither this scan
  // nor `retire`, so it is an anchor to NEITHER tool — the bootstrap.mjs "retire
  // stamps exactly what the validator scans" contract holds on malformed input.
  // A `#`- or `//`-style example inside a fenced code block is prose, not an anchor.
  //
  // DECISION plan_2026-07-14_79ee0f59/D-010 — comment spans come from shared.mjs's
  // `htmlCommentSpans`, never a local raw regex (code-span-blind: a backticked `<!--` in
  // prose opened a phantom span). `bootstrap.mjs retire` consumes the same primitive, which
  // is what makes "the validator sees exactly what retire stamps" true by construction.
  if (HTML_STYLE_EXTS.has(ext)) {
    for (const { start, end } of htmlCommentSpans(text)) {
      const body = text.slice(start + 4, end - 3); // strip "<!--" and "-->"
      const bodyOffset = start + 4; // (the block loop uses +2 for "/*")
      const innerRe = new RegExp(blockInnerRe.source, "g");
      let dm;
      while ((dm = innerRe.exec(body)) !== null) {
        // Compute the line number of this specific match within the file.
        const lineNum = text.slice(0, bodyOffset + dm.index).split("\n").length;
        pushMatch(dm, lineNum);
      }
    }
  }

  return out;
}

// DECISION plan_2026-07-14_317362c4/D-005 — anchors with an illegal plan-id prefix are
// found by a second, loose pass and reported as WARN, never ERROR (a cosmetic typo must
// not block CLOSE). Do not widen the plan-id grammar to make a mis-derived prefix resolve
// — that would silently attribute the anchor to a plan directory that doesn't exist.
function findBadPrefixAnchorsInFile(file, projectRoot) {
  return findAnchorsInFile(file, projectRoot, LOOSE_ANCHOR_PREFIX_PATTERN)
    .filter((a) => a.qualified && !ANY_PLAN_ID_RE.test(a.planName));
}

// Collect known decision IDs grouped by plan. Returns Map<planName, Set<id>>.
// The active plan is keyed by `activePlanName`. Cross-plan archive is parsed
// section-aware: each `## <plan-id>` heading begins a section; `### D-NNN`
// entries within belong to that plan.
//
// DECISION plan-2026-07-16T164852-47577439/D-001 — per-plan decisions.md reads are scoped
// to `referencedPlanIds` (plan-ids actually named by anchors in source), never a readdirSync
// walk of every plans/ directory (O(all-plan-dirs), unbounded). Also never a generated index
// derived from the per-plan files — that's a staleness surface. Read set: {active ∪
// referenced plans} + consolidated plans/DECISIONS.md + committed plans/ANCHORS.md.
// `baseDir` exists solely so tests can point at a fixture tree — the module-level
// `plansDir` binds to cwd at import time. Exported for the decoy-dirs unit test.
// See plan-2026-07-16T164852-47577439/decisions.md D-001.
export function collectKnownDecisionIdsByPlan(planDir, activePlanName, referencedPlanIds, baseDir = plansDir) {
  const map = new Map();
  // Sidecar: which SOURCE (tier) supplied ids for each plan. Attached to the returned Map
  // as an own property so the return SHAPE stays `Map<planName, Set<id>>` for every
  // existing consumer. Its only reader is the `anchor-orphan` message builder, which used
  // to assert "plan exists but no D-NNN entry in its decisions.md" without ever having
  // read a plan directory or a decisions.md — sending maintainers to a file that does not
  // exist when the anchor had in fact resolved through plans/ANCHORS.md alone. Recording
  // the tier at `add()` time costs zero extra IO; re-deriving it at message time would be
  // a new lookup.
  const tiers = new Map();

  function add(planName, id, tier) {
    if (!planName) return;
    if (!map.has(planName)) map.set(planName, new Set());
    map.get(planName).add(id);
    if (!tiers.has(planName)) tiers.set(planName, new Set());
    tiers.get(planName).add(tier);
  }

  // Active plan's per-plan decisions.md.
  const planDecisions = readFile(join(planDir, "decisions.md"));
  if (planDecisions) {
    const { entries } = parseDecisionsEntries(planDecisions);
    for (const e of entries) add(activePlanName, e.id, `plans/${activePlanName}/decisions.md`);
  }

  // Per-plan decisions.md for each plan-id actually referenced by a strict
  // qualified anchor (covers archived plans whose sections have been trimmed
  // from plans/DECISIONS.md).
  for (const id of referencedPlanIds) {
    if (!ANY_PLAN_ID_RE.test(id)) continue;
    if (id === activePlanName) continue; // already loaded above
    const txt = readFile(join(baseDir, id, "decisions.md"));
    if (!txt) continue;
    const { entries: pe } = parseDecisionsEntries(txt);
    for (const e of pe) add(id, e.id, `plans/${id}/decisions.md`);
  }

  // Consolidated plans/DECISIONS.md, section-aware: track current `## <plan-id>`
  // wrapper, attribute every nested `### D-NNN` (or `## D-NNN` if not nested)
  // to that plan. Matches v2.13.0 sliding-window content shape.
  const consolidated = readFile(join(baseDir, "DECISIONS.md"));
  if (consolidated) {
    const lines = consolidated.split("\n");
    let currentPlan = null;
    const planSectionRe = new RegExp(`^##\\s+(${ANY_PLAN_ID_PATTERN})\\s*$`);
    const dashEntryRe = new RegExp(`^#{2,3}\\s+D-(${DECISION_ID_NUM_PATTERN})\\b`);
    for (const line of lines) {
      const ps = planSectionRe.exec(line);
      if (ps) { currentPlan = ps[1]; continue; }
      const de = dashEntryRe.exec(line);
      if (de && currentPlan) add(currentPlan, parseInt(de[1], 10), "plans/DECISIONS.md");
    }
  }

  // Committed manifest plans/ANCHORS.md — the durable tier. One line per anchored
  // decision: `<plan-id>/D-NNN | YYYY-MM-DD | one-line rationale`. Read EXACTLY
  // ONCE per full validation: O(1) file reads and O(manifest lines) parse,
  // independent of how many plan directories exist. Never runs on the --pre-step
  // path, which bypasses the full validator entirely.
  //
  // DECISION plan-2026-08-04T092155-0063b038/D-010 — never generate these lines by scanning
  // `# DECISION` anchors out of source (an anchor would become its own proof of validity,
  // silently retiring typo detection). Written only from the closing plan's own decisions.md.
  // Line regex stays anchored at line start with the pipe delimiter immediate — never widen
  // toward free text, or ordinary prose could register a decision.
  const manifest = readFile(join(baseDir, "ANCHORS.md"));
  if (manifest) {
    const manifestLineRe = new RegExp(
      `^(${ANY_PLAN_ID_PATTERN})\\/D-(${DECISION_ID_NUM_PATTERN})[ \\t]*\\|`,
    );
    for (const line of manifest.split("\n")) {
      const mm = manifestLineRe.exec(line);
      if (mm) add(mm[1], parseInt(mm[2], 10), "plans/ANCHORS.md");
    }
  }

  map.tiersByPlan = tiers;
  return map;
}

// DECISION plan-2026-09-01T100120-4f591469/D-008 — an orphan message names ONLY the
// sources actually read (via the Map's `tiersByPlan` sidecar), not a fixed list — the old
// text pointed at a decisions.md that was never opened when resolution came from
// plans/ANCHORS.md alone.
function tierList(knownByPlan, planName) {
  const set = knownByPlan.tiersByPlan?.get(planName);
  if (!set || set.size === 0) return "no decision source";
  return [...set].join(" + ");
}

function tierPlural(knownByPlan, planName) {
  const set = knownByPlan.tiersByPlan?.get(planName);
  return set && set.size > 1 ? "any of them" : "it";
}

function checkReverseAnchors(planDir, planDirName, issues, projectRoot) {
  let files;
  try {
    files = walkSourceFiles(projectRoot);
  } catch {
    return;
  }

  // Pass 1: scan every source file once (same two reads per file as before),
  // collecting the per-file anchor results and the set of plan-ids that strict
  // qualified anchors reference. Stale anchors are included (they must keep
  // resolving); bad-prefix anchors are excluded by construction (their prefix
  // is not a plan-id, so they never feed a knownByPlan lookup).
  const scanned = [];
  const referenced = new Set();
  for (const file of files) {
    const badprefix = findBadPrefixAnchorsInFile(file, projectRoot);
    const anchors = findAnchorsInFile(file, projectRoot);
    scanned.push({ badprefix, anchors });
    for (const a of anchors) {
      if (a.qualified) referenced.add(a.planName);
    }
  }

  const knownByPlan = collectKnownDecisionIdsByPlan(planDir, planDirName, referenced);

  // Pass 2: report, in the same per-file order as the single-pass version.
  for (const { badprefix, anchors } of scanned) {
    for (const b of badprefix) {
      const rel = relative(projectRoot, b.file);
      const idStr = `D-${String(b.id).padStart(3, "0")}`;
      issues.push({
        severity: "WARN",
        check: "anchor-badprefix",
        message: `${rel}:${b.line} anchor prefix "${b.planName}" is not a plan-id, so ${idStr} is invisible to the anchor audit — it matches no anchor regex at all, and is not even reported as an orphan. A plan-id is the full plan-DIRECTORY name (\`plan-YYYY-MM-DDTHHMMSS-XXXXXXXX\`, or legacy \`plan_YYYY-MM-DD_XXXXXXXX\`). If it looks like a commit tag: the tag DROPS the \`THHMMSS\` segment, anchors keep it. See references/decision-anchoring.md`,
      });
    }
    for (const a of anchors) {
      const rel = relative(projectRoot, a.file);
      const idStr = `D-${String(a.id).padStart(3, "0")}`;
      const staleSuffix = a.stale ? " [STALE]" : "";
      const severityForOrphan = a.stale ? "WARN" : "ERROR";

      if (a.qualified) {
        // Qualified anchor: must resolve in the named plan's set.
        const set = knownByPlan.get(a.planName);
        const fullId = `${a.planName}/${idStr}`;
        if (!set) {
          issues.push({
            severity: severityForOrphan,
            check: "anchor-unknown-plan",
            message: `${rel}:${a.line} anchor references unknown plan ${a.planName} (${fullId}${staleSuffix}); no per-plan decisions.md and no matching section in plans/DECISIONS.md`,
          });
        } else if (!set.has(a.id)) {
          issues.push({
            severity: severityForOrphan,
            check: "anchor-orphan",
            message: `${rel}:${a.line} orphan anchor ${fullId}${staleSuffix} (${a.planName} resolves via ${tierList(knownByPlan, a.planName)}, but no ${idStr} entry was found in ${tierPlural(knownByPlan, a.planName)})`,
          });
        }
      } else {
        // Bare anchor (legacy form). Always WARN to nudge migration; then
        // attempt resolution against active plan only (existing behavior).
        issues.push({
          severity: "WARN",
          check: "anchor-unqualified",
          message: `${rel}:${a.line} bare anchor ${idStr}${staleSuffix} lacks plan-id prefix (expected \`${planDirName || "<plan-id>"}/${idStr}\`); see references/decision-anchoring.md`,
        });
        const activeSet = planDirName ? knownByPlan.get(planDirName) : null;
        if (!activeSet || !activeSet.has(a.id)) {
          issues.push({
            severity: severityForOrphan,
            check: "anchor-orphan",
            message: `${rel}:${a.line} orphan anchor ${idStr}${staleSuffix} (no ${idStr} entry for the active plan in ${planDirName ? tierList(knownByPlan, planDirName) : "any decision source"})`,
          });
        }
      }
    }
  }
}

// v2.14.0 — plan-id preamble in decisions.md and summary.md.
// `*Plan: <plan-id>*` MUST appear within the first 10 non-blank lines.
// Strict (ERROR) for plans whose INIT timestamp ≥ ANCHOR_REFS_REQUIRED_SINCE;
// lenient (WARN) for legacy plans.
function checkPlanIdPreamble(planDir, planDirName, issues) {
  const strict = isPostCutover(planDir);
  const sev = strict ? "ERROR" : "WARN";

  function checkOne(filename) {
    const path = join(planDir, filename);
    const content = readFile(path);
    if (!content) return; // file may not exist (summary.md only at CLOSE)

    const { preamblePlanId } = parseDecisionsEntries(content);
    if (!preamblePlanId) {
      issues.push({
        severity: sev,
        check: "preamble-missing",
        message: `plan-id preamble line "*Plan: ${planDirName}*" not found in ${filename} (must appear within first 10 non-blank lines)`,
      });
      return;
    }
    if (planDirName && preamblePlanId !== planDirName) {
      issues.push({
        severity: "ERROR",
        check: "preamble-mismatch",
        message: `${filename} preamble plan-id "${preamblePlanId}" does not match plan directory name "${planDirName}"`,
      });
    }
  }

  checkOne("decisions.md");
  checkOne("summary.md");
}

// ---------------------------------------------------------------------------
// WARN-level checks (Step 3.2)
// ---------------------------------------------------------------------------

// 3.2a — Evidence column weak content.
function checkVerificationEvidence(planDir, issues) {
  const content = readFile(join(planDir, "verification.md"));
  if (!content) return;
  const section = extractSection(content, "Criteria Verification");
  if (!section) return;

  const lines = section.split("\n");
  const weakRe = /^(looks good|seems to work|lgtm|ok|fine|good)$/i;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith("|")) continue;
    // Skip header + separator rows.
    if (/^\|\s*-+\s*\|/.test(line)) continue;
    if (/^\|\s*#\s*\|/.test(line)) continue;
    // Split on | and trim.
    const cells = line.split("|").map((c) => c.trim());
    // Drop leading/trailing empty cells from outer pipes.
    if (cells.length > 0 && cells[0] === "") cells.shift();
    if (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
    if (cells.length < 6) continue; // schema: # | Criterion | Method | Cmd | Result | Evidence
    // DECISION plan-2026-09-01T100120-4f591469/D-011 — discriminate on the CRITERION cell
    // (reusing PLACEHOLDER_PATTERNS), never the Evidence cell: an empty/PENDING Evidence
    // cell beside a REAL criterion is exactly what this check exists to WARN on at REFLECT.
    const criterion = cells[1] || "";
    if (PLACEHOLDER_PATTERNS.some((p) => p.test(criterion))) continue;
    const evidence = cells[5];
    if (!evidence || evidence === "-") {
      issues.push({
        severity: "WARN",
        check: "evidence",
        message: `verification.md Criteria row "${cells[1] || "?"}" has empty Evidence cell`,
      });
      continue;
    }
    if (weakRe.test(evidence)) {
      issues.push({
        severity: "WARN",
        check: "evidence",
        message: `verification.md Criteria row "${cells[1] || "?"}" has weak Evidence: "${evidence}"`,
      });
      continue;
    }
    // Single-word check (no whitespace and not the placeholder "-").
    if (!/\s/.test(evidence) && evidence.length > 0 && evidence !== "-" && !/^\d+\/\d+/.test(evidence)) {
      issues.push({
        severity: "WARN",
        check: "evidence",
        message: `verification.md Criteria row "${cells[1] || "?"}" Evidence is single-word: "${evidence}"`,
      });
    }
  }
}

// 3.2b — findings/{topic}.md missing required sections.
function checkFindingsTopicSections(planDir, issues) {
  const dir = join(planDir, "findings");
  if (!existsSync(dir)) return;
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return;
  }
  // "Risks" any-prefix match (e.g. "Risks", "Risks & Unknowns", "Risks-Unknowns").
  const explorerRequired = [
    { name: "Summary", re: /^##\s+Summary\b/m },
    { name: "Key Findings", re: /^##\s+Key Findings\b/m },
    { name: "Constraints", re: /^##\s+Constraints\b/m },
    { name: "Code Patterns", re: /^##\s+Code Patterns\b/m },
    { name: "Risks", re: /^##\s+Risks\b/m },
  ];
  // DECISION plan-2026-09-01T100120-4f591469/D-010 — `findings/` holds THREE artifact schemas:
  // explorer topic files (Summary/Key Findings/Constraints/Code Patterns/Risks), reviewer
  // output (`review-iter-N[-passM].md`, Concerns/Blind Spots/Verdict per ip-reviewer.md), and
  // hygiene-sweep output (`hygiene-iter-N[-passM].md`, Inherited/Introduced/Verdict per
  // ip-boyscout.md). The filename discriminator SWITCHES the required list, never exempts — a
  // reviewer or hygiene file missing `## Verdict` must still WARN, since REFLECT routing
  // consumes that section.
  const reviewerRequired = [
    { name: "Concerns", re: /^##\s+Concerns\b/m },
    { name: "Blind Spots", re: /^##\s+Blind Spots\b/m },
    { name: "Verdict", re: /^##\s+Verdict\b/m },
  ];
  // DECISION plan-2026-09-09T082122-64c4de78/D-002 — the hygiene report gets its OWN required
  // list rather than being reshaped to fit the explorer schema. Do NOT "simplify" this by
  // dropping the branch and having ip-boyscout emit Summary/Key Findings/Code Patterns: that
  // is free in code and wrong in substance, because it leaves the routing-critical `## Verdict`
  // ungated while mandating a decorative `## Code Patterns` heading. See decisions.md D-002.
  const hygieneRequired = [
    { name: "Inherited", re: /^##\s+Inherited\b/m },
    { name: "Introduced", re: /^##\s+Introduced\b/m },
    { name: "Verdict", re: /^##\s+Verdict\b/m },
  ];
  const REVIEW_FILE_RE = /^review-iter-\d+(?:-pass\d+)?\.md$/;
  const HYGIENE_FILE_RE = /^hygiene-iter-\d+(?:-pass\d+)?\.md$/;
  for (const f of files) {
    const text = readFile(join(dir, f));
    if (!text) continue;
    let required = explorerRequired;
    if (REVIEW_FILE_RE.test(f)) required = reviewerRequired;
    else if (HYGIENE_FILE_RE.test(f)) required = hygieneRequired;
    const missing = required.filter((r) => !r.re.test(text)).map((r) => r.name);
    if (missing.length > 0) {
      issues.push({
        severity: "WARN",
        check: "findings-topic",
        message: `findings/${f} missing required section(s): ${missing.join(", ")}`,
      });
    }
  }
}

// checkHygieneSweepGate — fires only during REFLECT/CLOSE. Requires EITHER a
// hygiene-sweep report for the current iteration (findings/hygiene-iter-N(-passM)?.md
// with a ## Verdict heading — content-blind, presence is the whole signal, per
// scar-scan.mjs's "report, never gate" contract) OR an explicit arrow-free
// "- HYGIENE SKIP (iter N): <reason>" bullet inside state.md's Transition History.
// Severity mirrors checkVerdictBullets: WARN at REFLECT (advisory), ERROR at CLOSE
// (blocking, same pattern [atlas-cap] already established).
function checkHygieneSweepGate(planDir, issues) {
  const state = readFile(join(planDir, "state.md"));
  if (!state) return; // checkStateTransitions already reports unreadable state.md

  const currentState = (extractField(state, /^# Current State:\s*(.+)$/m) || "").trim().toUpperCase();
  if (currentState !== "REFLECT" && currentState !== "CLOSE") return;

  // DECISION plan-2026-09-11T141919-e5db2894/D-010: DECLARED iteration ALONE, NOT
  // max(declared, derived) — deliberately different from runPreStepGate's iteration-cap
  // check and checkIterationLimits. There, over-counting is the SAFE direction (forces an
  // earlier hard stop). Here it is the UNSAFE direction: a same-iteration completion-fix
  // round trip (REFLECT → EXECUTE → REFLECT) does not bump the declared field but IS counted
  // by deriveIterationFromHistory, so max() would silently drive iter past the orchestrator's
  // and ip-boyscout's real iteration and turn a correct, current-iteration hygiene report or
  // skip line into a false CLOSE-blocking ERROR the archivist cannot clear (reviewer CRITICAL
  // #3). The orchestrator and ip-boyscout both read/write the DECLARED field, never a derived
  // one, so matching against it is what "for the current iteration" actually means here.
  //
  // DECISION plan-2026-09-11T141919-e5db2894/D-010 (reviewer pass-2 CONCERN #2 follow-up):
  // when the declared field is missing/unparseable, fall back to countRePlans (via
  // deriveConvergenceIteration) rather than returning silently forever — pass-1's original
  // max(declared, derived) fallback was rejected above because it counts a same-iteration
  // completion-fix round trip as a new iteration (the CRITICAL #3 false positive this whole
  // decision exists to avoid); countRePlans is immune to that — it counts only genuine
  // re-PLAN arrivals (REFLECT → PIVOT → PLAN / REFLECT → EXPLORE → PLAN), never a
  // REFLECT → EXECUTE → REFLECT completion-fix loop — so falling back to it ONLY when the
  // declared field cannot be trusted at all does not reopen CRITICAL #3. A STALE-but-parseable
  // declared field (never bumped after a genuine replan) is a separate, pre-existing protocol
  // invariant violation — the declared field is supposed to be authoritative and other checks
  // (the --pre-step iteration cap) already trust it too — and is deliberately NOT
  // second-guessed here; doing so would mean this one check overriding a field every other
  // check trusts, which is a bigger design change out of scope for this fix.
  const iterStr = extractField(state, /^## Iteration:\s*(.+)$/m);
  const declared = iterStr ? parseInt(iterStr, 10) : NaN;
  const iter = Number.isFinite(declared) ? declared : deriveConvergenceIteration(state);
  if (iter < 1) return; // still unparseable/derivable to nothing — fail silent, not throw

  // (a) findings/hygiene-iter-N(-passM)?.md with a ## Verdict heading.
  const HYGIENE_ITER_FILE_RE = new RegExp(`^hygiene-iter-${iter}(?:-pass\\d+)?\\.md$`);
  const findingsDir = join(planDir, "findings");
  let hasReport = false;
  if (existsSync(findingsDir)) {
    let files = [];
    try {
      files = readdirSync(findingsDir).filter((f) => f.endsWith(".md"));
    } catch {
      files = [];
    }
    for (const f of files) {
      if (!HYGIENE_ITER_FILE_RE.test(f)) continue;
      const text = readFile(join(findingsDir, f));
      if (text && /^##\s+Verdict\b/m.test(text)) {
        hasReport = true;
        break;
      }
    }
  }
  if (hasReport) return;

  // DECISION plan-2026-09-11T141919-e5db2894/D-001: (b) arrow-free
  // "- HYGIENE SKIP (iter N): <reason>" bullet in Transition History.
  // Do NOT write this as an arrow-based line (e.g. "REFLECT -> REFLECT" or
  // "REFLECT → REFLECT") — checkStateTransitions' FROM → TO regex (line ~267)
  // would then misparse it as a spurious state transition, requiring a new
  // REFLECT→REFLECT entry in VALID_TRANSITIONS: a larger, riskier change this
  // plan deliberately avoids. The arrow-free bullet is invisible to that
  // regex by construction. See decisions.md D-001/D-003.
  // DECISION plan-2026-09-11T141919-e5db2894/D-003: "arrow-free" held only for the line's
  // FIXED PREFIX, not its free-text reason — a reason itself containing "->"/"→" still
  // reached checkStateTransitions/countExecuteReflect until HYGIENE_SKIP_LINE_RE (above)
  // started excluding the WHOLE line from both readers, closing that gap (reviewer CRITICAL
  // #1/#2). This regex below still only builds the ITERATION-SPECIFIC existence match; it
  // does not itself need to change to fix that gap.
  const historyBlock = transitionHistoryBlock(state);
  const skipRe = new RegExp(`^-\\s+HYGIENE SKIP \\(iter ${iter}\\):\\s+\\S.*$`, "m");
  const hasSkip = historyBlock ? skipRe.test(historyBlock) : false;
  if (hasSkip) return;

  // Reviewer pass-2 NOTE #8: a skip line naming a DIFFERENT iteration (or otherwise
  // malformed — e.g. missing iteration number, empty reason) reads, in the message below, as
  // "you wrote nothing", which is misleading when a line is in fact present. Detect any
  // HYGIENE_SKIP_LINE_RE match (regardless of which iteration it names) and say so — this is
  // a message-string improvement only; the gate still fails closed exactly as before.
  const anySkipMatch = historyBlock ? historyBlock.split("\n").find((l) => HYGIENE_SKIP_LINE_RE.test(l)) : null;
  const otherIterMatch = anySkipMatch ? /HYGIENE SKIP \(iter (\d+)\)/.exec(anySkipMatch) : null;
  const otherIterNote = otherIterMatch && otherIterMatch[1] !== String(iter)
    ? ` (a HYGIENE SKIP line naming iteration ${otherIterMatch[1]} is present, but does not match iteration ${iter})`
    : "";

  issues.push({
    severity: currentState === "CLOSE" ? "ERROR" : "WARN",
    check: "hygiene-gate",
    message: `No hygiene-sweep record for iteration ${iter} at ${currentState}: missing findings/hygiene-iter-${iter}(-passM).md with a ## Verdict heading, and no "- HYGIENE SKIP (iter ${iter}): <reason>" line in state.md's Transition History${otherIterNote}`,
  });
}

// 3.2c — state.md transition missing Exploration Confidence on EXPLORE → PLAN.
//
// Two corrections (D-003, defect #8):
//  1. Comment-blind — via transitionHistoryBlock(). The pre-fix raw scan matched the
//     literal `EXPLORE → PLAN` on the OPENING line of bootstrap's guidance comment and
//     then read the EXAMPLE transition beneath it as the "next non-empty line", which
//     of course carries no `confidence:` — so this WARN fired on every fresh plan,
//     including plans with a perfectly correct confidence sub-line.
//  2. Most-recent-only — a plan that has cycled EXPLORE → PLAN three times used to emit
//     three WARNs. Only the LATEST transition's confidence sub-line is actionable.
// The check still fires when the sub-line is genuinely absent: corrected, not deleted.
function checkExplorationConfidence(planDir, issues) {
  const state = readFile(join(planDir, "state.md"));
  const historyBlock = transitionHistoryBlock(state);
  if (historyBlock === null) return;
  // Exclude HYGIENE SKIP lines wholesale BEFORE the arrow scan — a skip-line reason
  // containing e.g. "the EXPLORE -> PLAN rewrite" would otherwise be read as (and take
  // priority over, since only the LAST match counts) a real EXPLORE → PLAN transition,
  // producing a spurious WARN and masking the genuine confidence sub-line check (reviewer
  // pass-2 CONCERN #1, plan-2026-09-11T141919-e5db2894). See stripHygieneSkipLines.
  const lines = stripHygieneSkipLines(historyBlock).split("\n");

  // Index of the LAST real `EXPLORE → PLAN` transition line, or -1.
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/EXPLORE\s+(?:→|->)\s+PLAN/.test(lines[i])) last = i;
  }
  if (last < 0) return;

  // Look at the next non-empty line; should contain "confidence:".
  let j = last + 1;
  while (j < lines.length && lines[j].trim() === "") j++;
  const next = lines[j] || "";
  if (!/confidence:/i.test(next)) {
    issues.push({
      severity: "WARN",
      check: "exploration-confidence",
      message: "state.md Transition History EXPLORE → PLAN line missing Exploration Confidence sub-line (expected 'confidence:' on next line)",
    });
  }
}

// 3.2d / v2.14.0 — decisions.md entries missing Anchor-Refs when corresponding
// code has a matching anchor for THIS PLAN. Strict (ERROR) post-cutover,
// lenient (WARN) for pre-v2.14.0 plans.
function checkAnchorRefsRequired(planDir, planDirName, issues, projectRoot) {
  const content = readFile(join(planDir, "decisions.md"));
  if (!content) return;
  const { entries } = parseDecisionsEntries(content);
  if (entries.length === 0) return;

  // Build set of D-NNN ids that have anchors in source ATTRIBUTABLE to this
  // plan. Qualified anchors must match planDirName; bare anchors fall through
  // to the active plan as the implicit owner (legacy compat).
  const anchoredIds = new Set();
  let files;
  try {
    files = walkSourceFiles(projectRoot);
  } catch {
    return;
  }
  for (const f of files) {
    const anchors = findAnchorsInFile(f, projectRoot);
    for (const a of anchors) {
      if (a.qualified) {
        if (a.planName === planDirName) anchoredIds.add(a.id);
      } else {
        // Bare anchor: implicitly belongs to active plan.
        if (planDirName) anchoredIds.add(a.id);
      }
    }
  }

  const strict = isPostCutover(planDir);
  const sev = strict ? "ERROR" : "WARN";
  const checkName = strict ? "anchor-refs-missing" : "anchor-refs";

  const anchorRefsRe = /\*\*Anchor-Refs\*\*:/m;
  for (const e of entries) {
    if (!anchoredIds.has(e.id)) continue;
    if (!anchorRefsRe.test(e.body)) {
      issues.push({
        severity: sev,
        check: checkName,
        message: `decisions.md ${e.idStr} has matching code anchor but no **Anchor-Refs**: line`,
      });
    }
  }
}

// v2.14.0 — verify each `**Anchor-Refs**: \`path:line\`...` reference resolves:
// the file exists at projectRoot AND contains some DECISION anchor with this
// entry's id (qualified for this plan, or bare). WARN-only — line numbers
// drift, so we don't enforce exact line match.
function checkAnchorRefsValidity(planDir, planDirName, issues, projectRoot) {
  const content = readFile(join(planDir, "decisions.md"));
  if (!content) return;
  const { entries } = parseDecisionsEntries(content);
  if (entries.length === 0) return;

  const refLineRe = /^\*\*Anchor-Refs\*\*:\s*(.+)$/m;
  const refItemRe = /`([^`]+)`/g;

  for (const e of entries) {
    const ml = refLineRe.exec(e.body);
    if (!ml) continue;
    const refsLine = ml[1];
    const refs = [];
    let im;
    while ((im = refItemRe.exec(refsLine)) !== null) refs.push(im[1].trim());

    for (const ref of refs) {
      const colonIdx = ref.lastIndexOf(":");
      if (colonIdx < 1) continue; // malformed; skip silently
      const filePart = ref.slice(0, colonIdx);
      const target = join(projectRoot, filePart);
      if (!existsSync(target)) {
        issues.push({
          severity: "WARN",
          check: "anchor-refs-stale",
          message: `decisions.md ${e.idStr} **Anchor-Refs** points to missing file: ${ref}`,
        });
        continue;
      }
      // Verify some matching anchor exists for this id in the file.
      const anchors = findAnchorsInFile(target, projectRoot);
      const found = anchors.some((a) => {
        if (a.id !== e.id) return false;
        if (a.qualified && a.planName !== planDirName) return false;
        return true;
      });
      if (!found) {
        issues.push({
          severity: "WARN",
          check: "anchor-refs-stale",
          message: `decisions.md ${e.idStr} **Anchor-Refs** ${ref} but no matching DECISION anchor found in the file`,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// v2.15.0 — per-edit changelog (informational checks, WARN-only)
// v2.33.0 — schema-driven field shapes.
//
// File: {plan-dir}/changelog.md — markdown, pipe-delimited, one line per edit, appended atomically.
// Field ORDER: UTC | iter-N/step-M | commit | path | op | radius | D-NNN-or-dash | reason
// What each field may CONTAIN is defined once, in schema.mjs's CHANGELOG_SPEC, and is
// deliberately not copied here — this comment used to spell the op field `OP(+N,-M)`, a
// shape the spec rejects and which cannot express CREATE(+N), DELETE(-N) or RENAME(old→new).
//
// DECISION plan_2026-07-14_79ee0f59/D-001 — the six changelog field regexes live exactly
// once, as typed fields in schema.mjs's CHANGELOG_SPEC (split by splitChangelogFields,
// checked by validateElement). Do not reintroduce a field regex here — two hand-kept copies
// is the defect the schema removes. [changelog-malformed] stays WARN, never ERROR: the
// changelog is advisory and a bug in our own parser must never block CLOSE.
function checkChangelogFormat(planDir, issues) {
  const file = join(planDir, "changelog.md");
  const content = readFile(file);
  if (!content) return; // Optional file — older plans (and fresh dirs) may lack it.

  const lines = content.split("\n");
  let lineNo = 0;
  for (const raw of lines) {
    lineNo++;
    const line = raw.trim();
    // These skip conditions are mirrored in checkChangelogDrefIntegrity —
    // change both together (2-place lockstep, no shared predicate yet).
    if (!line) continue;
    if (line.startsWith("#")) continue;        // header
    if (line.startsWith("*")) continue;        // italic header note
    if (line.startsWith("<!--")) continue;     // comment
    if (CHANGELOG_COMPRESSED_INLINE_RE.test(line)) continue; // inline compression summary (bootstrap.mjs maybeCompressChangelog)
    // F3 — Data line: split on the FIRST 7 " | " separators; the 8th field
    // (reason) absorbs any trailing " | " inside it. Pre-fix, a legitimate
    // reason like "fix race: a | b" produced 9 fields → WARN [changelog-malformed]
    // + classifyChangelogLine returned non-entry, hiding the line from compression.
    // Single source of truth: ./shared.mjs splitChangelogFields (same function
    // bootstrap.mjs uses) — no longer reimplemented inline here.
    const fields = splitChangelogFields(line);
    if (fields.length !== 8) {
      // The ONE rule that is about the ENCODING (pipe framing), not about a field shape — so it
      // stays here rather than in the spec. Everything below this line is schema-driven.
      issues.push({
        severity: "WARN",
        check: "changelog-malformed",
        message: `changelog.md:${lineNo}: expected 8 pipe-separated fields, got ${fields.length}`,
      });
      continue;
    }
    // One synthetic <entry> node built from the line's 8 fields, checked against the ONE spec.
    // Same severity (WARN), same check slug (changelog-malformed) — the spec carries both.
    const entry = entryFromFields(fields, false);
    for (const issue of validateElement(entry, CHANGELOG_SPEC, `changelog.md:${lineNo}`)) {
      issues.push(issue);
    }
  }
}

// ---------------------------------------------------------------------------
// v2.51.0 — changelog dref join integrity (WARN-only)
// ---------------------------------------------------------------------------
// DECISION plan-2026-07-16T085306-8bd12f33/D-001 — join integrity is a separate flat
// check (string-set membership against parseDecisionsEntries' idStr set), called only from
// validate(). It does not re-validate dref shape (that's CHANGELOG_SPEC's job — a
// shape-invalid dref may draw both WARNs, by design) and stays out of --pre-step and out
// of ERROR: the changelog is advisory and must never block a CLOSE.
function checkChangelogDrefIntegrity(planDir, issues) {
  const content = readFile(join(planDir, "changelog.md"));
  if (!content) return; // Optional file — same convention as checkChangelogFormat.
  const decisionsContent = readFile(join(planDir, "decisions.md"));
  if (!decisionsContent) return; // No decisions.md → nothing to join against.

  const known = new Set(parseDecisionsEntries(decisionsContent).entries.map((e) => e.idStr));

  const lines = content.split("\n");
  let lineNo = 0;
  for (const raw of lines) {
    lineNo++;
    const line = raw.trim();
    // Same skip conditions as checkChangelogFormat — header, italic note,
    // comment, and inline-compressed lines are not data lines.
    if (!line) continue;
    if (line.startsWith("#")) continue;
    if (line.startsWith("*")) continue;
    if (line.startsWith("<!--")) continue;
    if (CHANGELOG_COMPRESSED_INLINE_RE.test(line)) continue;
    const fields = splitChangelogFields(line);
    if (fields.length !== 8) continue; // Malformed lines are checkChangelogFormat's business.
    const dref = fields[6];
    if (dref !== "-" && !known.has(dref)) {
      issues.push({
        severity: "WARN",
        check: "changelog-dref-orphan",
        message: `changelog.md:${lineNo} dref ${dref} has no matching entry in decisions.md (no ## ${dref} heading found)`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// DECISION plan-2026-09-01T100120-4f591469/D-009 — deliberately NO Presentation Contract
// check here. `checkPresentationContractLog` (v2.17.0) WARNed unless PC-PLAN/PC-REFLECT/
// PC-PIVOT appeared in a plan file, but a Presentation Contract is chat-only by definition
// and no protocol file instructs writing one to disk — so a correctly-run plan WARNed. Do
// not restore it or write a new one.
//
// The tempting "fix" — adding that instruction to the orchestrator and the REFLECT
// module — was rejected: an agent that logs the contract name proves only that it
// logged the name, so the signal would be self-fulfilling ceremony on every plan.
// Deleting an unenforceable check is this repo's own precedent ([byte-claim],
// v2.39.0, deleted rather than extended). See decisions.md D-009.
// ---------------------------------------------------------------------------

function validate(planDirName) {
  const planDir = (planDirName.includes("/") || planDirName.startsWith(".")) ? planDirName : join(plansDir, planDirName);
  // Identity comparisons use the bare plan-id, NOT the filesystem path: a CLI arg
  // like `plans/plan_XXX` must still match a `*Plan: plan_XXX*` preamble and bare
  // `plan_XXX/D-NNN` anchors. Keep planDir (filesystem path) raw; basename only the
  // identity var, never the path (preserves absolute/nonexistent-path behavior; plan inv #4).
  const planId = basename(planDirName);

  if (!existsSync(planDir)) {
    console.error(`ERROR: Plan directory not found: ${planDir}`);
    process.exit(1);
  }

  const issues = [];

  checkStateTransitions(planDir, issues);
  checkPlanSections(planDir, issues);
  checkFindings(planDir, issues);
  checkCrossFileConsistency(planDir, issues);
  checkChangeManifest(planDir, issues);
  checkLeashCount(planDir, issues);
  checkIterationLimits(planDir, issues);
  checkStateCommentAnomaly(planDir, issues); // v2.34.0 — D-009 diagnostic (WARN-only)
  checkProgressStructure(planDir, issues);
  checkCheckpoints(planDir, issues);
  checkComplexityBudget(planDir, issues);
  checkConsolidatedFiles(issues);
  checkSystemAtlasCap(issues);
  checkLessonsCap(issues);
  checkLessonsEviction(issues); // v2.53.0 (F1) — WARN/INFO only; full-validator path, never --pre-step
  checkCompressionMarkers(issues);
  checkIndexResolution(issues); // v2.60.0 — WARN-only; never blocks CLOSE; full-validator path, never --pre-step

  // Step 3 additions (2.13.0): schema and anchor enforcement.
  checkDecisionsSchema(planDir, issues);
  checkVerificationVerdict(planDir, issues);
  checkFindingsIndexLinks(planDir, issues);
  checkReverseAnchors(planDir, planId, issues, cwd);
  checkVerificationEvidence(planDir, issues);
  checkFindingsTopicSections(planDir, issues);
  checkHygieneSweepGate(planDir, issues);
  checkExplorationConfidence(planDir, issues);
  // v2.14.0 — plan-qualified anchors, plan-id preamble, gated Anchor-Refs.
  checkPlanIdPreamble(planDir, planId, issues);
  checkAnchorRefsRequired(planDir, planId, issues, cwd);
  checkAnchorRefsValidity(planDir, planId, issues, cwd);
  // v2.15.0 — per-edit changelog (informational; never blocks CLOSE).
  checkChangelogFormat(planDir, issues);
  // v2.51.0 — changelog dref join integrity (WARN-only; never blocks CLOSE).
  checkChangelogDrefIntegrity(planDir, issues);

  // Report
  const errors = issues.filter((i) => i.severity === "ERROR");
  const warns = issues.filter((i) => i.severity === "WARN");
  const infos = issues.filter((i) => i.severity === "INFO");

  if (issues.length === 0) {
    console.log(`PASS: ${planDir} — no issues found`);
    process.exit(0);
  }

  console.log(`Validation: ${planDir}`);
  for (const issue of errors) {
    console.log(`  ERROR [${issue.check}]: ${issue.message}`);
  }
  for (const issue of warns) {
    console.log(`  WARN  [${issue.check}]: ${issue.message}`);
  }
  for (const issue of infos) {
    console.log(`  INFO  [${issue.check}]: ${issue.message}`);
  }

  console.log(`\nSummary: ${errors.length} error(s), ${warns.length} warning(s), ${infos.length} info(s)`);
  process.exit(errors.length > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Pre-step gate (--pre-step mode)
// ---------------------------------------------------------------------------

// NOTE: Pre-step Autonomy Leash gate.
// Lightweight HARD gate the orchestrator MUST run before every ip-executor
// spawn (between "identify next step" and "Spawn ip-executor"). Exits 2 on
// any HARD FAIL — exit code 2 is reserved EXCLUSIVELY for this mode, so
// orchestrator shell scripts can distinguish a leash trip from legacy
// validator errors (exit 1) without grepping stdout.
//
// DO NOT:
//   - widen the check set to walk source files (anchor scan, findings index,
//     extractField on plan.md, checkpoint validation): the gate must run in
//     <50ms per executor spawn. Only state.md is opened.
//   - emit WARN/exit 1 from this path: every check is binary PASS/FAIL.
//     Exit 1 is reserved for future expansion.
//   - re-use exit code 1 for HARD FAIL: that conflates leash trips with
//     malformed-plan errors from the full validator. Exit 2 is reserved for leash trips.
//   - print more than one line: stdout = single "GATE:*" token line.
function runPreStepGate(planDir) {
  const statePath = join(planDir, "state.md");
  const state = readFile(statePath);
  if (!state) {
    console.log("GATE:FAIL [no-plan]");
    process.exit(2);
  }

  const currentState = (extractField(state, /^# Current State:\s*(.+)$/m) || "").trim();
  if (currentState.toUpperCase() !== "EXECUTE") {
    console.log(`GATE:FAIL [wrong-state] expected=EXECUTE actual=${currentState || "<missing>"}`);
    process.exit(2);
  }

  const section = extractSection(state, "Fix Attempts");
  // Same shape as checkLeashCount, because it is literally the same constant (FIX_ATTEMPT_RE).
  const attempts = section ? section.split("\n").filter((l) => FIX_ATTEMPT_RE.test(l)).length : 0;
  if (attempts >= 2) {
    console.log(`GATE:FAIL [leash-cap] attempts=${attempts} cap=2`);
    process.exit(2);
  }

  // Mirrors checkIterationLimits (line ~564): max(declared, derived) so an agent that
  // forgets to bump the declared field cannot silently bypass the hard cap. Reuses the
  // already-exported deriveIterationFromHistory on the in-memory `state` string already
  // read above — no new file I/O, stays inside the <50ms/state.md-only budget.
  const iterStr = extractField(state, /^## Iteration:\s*(.+)$/m);
  const declared = iterStr ? parseInt(iterStr, 10) : 0;
  const derived = deriveIterationFromHistory(state);
  const iter = Math.max(Number.isFinite(declared) ? declared : 0, derived);
  if (Number.isFinite(iter) && iter >= 6) {
    const source = derived > declared
      ? ` (declared=${declared}, derived=${derived} from EXECUTE → REFLECT transition count)`
      : "";
    console.log(`GATE:FAIL [iteration-cap] iteration=${iter}${source} hard-cap=6`);
    process.exit(2);
  }

  console.log("GATE:PASS");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// CLI Dispatch
// ---------------------------------------------------------------------------

// NOTE: CLI dispatch guarded behind isEntryPoint so the
// module is import-safe (a test helper or future tooling can `import` validate-plan.mjs without
// the arg-parsing + process.exit firing at module load). Standard Node.js ESM dual-mode pattern,
// mirrors bootstrap.mjs:1831-1841. Do NOT move the process.exit calls or validate() back to
// module scope — that re-breaks import-safety.
const isEntryPoint = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: node validate-plan.mjs [plan-dir-name]
       node validate-plan.mjs --pre-step [plan-dir-name]

Validates protocol compliance of an iterative-planner plan directory.
If no plan directory is specified, validates the active plan.

--pre-step mode:
  Lightweight HARD gate intended to be invoked by the orchestrator before
  each ip-executor spawn (between "identify next step" and "Spawn ip-executor").
  Opens only state.md (no anchor walk, no findings scan) for sub-50ms latency.
  Checks (short-circuit on first FAIL, in order):
    1. plan dir + state.md readable      → GATE:FAIL [no-plan]
    2. Current State = EXECUTE           → GATE:FAIL [wrong-state]
    3. Fix Attempts >= 2                 → GATE:FAIL [leash-cap]
    4. Iteration >= 6                    → GATE:FAIL [iteration-cap]
  Output: single line on stdout — GATE:PASS or GATE:FAIL [slug] [...details].

Checks:
  - State transition validity
  - Mandatory plan.md sections
  - Findings count (≥3 before PLAN)
  - Cross-file consistency (state/plan/progress/verification)
  - Change manifest presence during EXECUTE/REFLECT
  - Autonomy Leash fix-attempt count (WARN [leash] at 3, ERROR at 4+ during EXECUTE/REFLECT)
  - Iteration limits (5 = decomposition, 6+ = hard stop)
  - Progress.md structure (Completed/In Progress/Remaining)
  - Checkpoint existence for iteration 2+
  - Complexity Budget population during EXECUTE+
  - Consolidated files existence
  - plans/SYSTEM.md line count (ERROR [atlas-cap] on >300 lines, INFO [atlas-absent] when missing)
  - Hygiene-sweep record at REFLECT/CLOSE (WARN [hygiene-gate] at REFLECT, ERROR [hygiene-gate] at CLOSE, when neither findings/hygiene-iter-N(-passM).md's ## Verdict nor a "- HYGIENE SKIP (iter N): <reason>" line is found)
  - plans/LESSONS.md line count (ERROR [lessons-cap] on >200 lines, INFO [lessons-absent] when missing)
  - Compression-summary marker integrity in FINDINGS.md/DECISIONS.md (ERROR [compress-markers] on unbalanced/nested/duplicate)
  - INDEX.md rows with no surviving copy (WARN [index-orphan] when both plans/<id>/ and the consolidated section are gone)
  - decisions.md entry header format (## D-NNN | PHASE | YYYY-MM-DD)
  - decisions.md D-NNN sequential numbering (no gaps, starts at D-001)
  - decisions.md **Trade-off**: line in every entry
  - decisions.md **Complexity Assessment** block in PIVOT entries
  - verification.md Verdict 5 required bullets (in order)
  - findings.md Index links resolve to existing files
  - Reverse anchor scan (orphan # DECISION <plan-id>/D-NNN in source)
  - Bare D-NNN anchor → WARN [anchor-unqualified] (v2.14.0 migration nudge)
  - Qualified anchor with unknown plan → ERROR [anchor-unknown-plan]
  - Evidence column quality (WARN on weak/empty/single-word)
  - findings/{topic}.md required sections (WARN)
  - state.md Exploration Confidence on EXPLORE → PLAN (WARN)
  - decisions.md / summary.md plan-id preamble (ERROR post-v2.14.0, WARN otherwise)
  - decisions.md Anchor-Refs required when matching anchor exists in source
    (ERROR post-v2.14.0, WARN otherwise; gated by state.md INIT timestamp)
  - decisions.md Anchor-Refs validity (WARN if file missing or anchor not found)

Exit codes:
  0 = pass (no errors, warnings are OK; or GATE:PASS in --pre-step mode)
  1 = fail (errors found in full validator)
  2 = GATE:FAIL — reserved EXCLUSIVELY for --pre-step HARD FAIL
      (leash-cap, wrong-state, iteration-cap, no-plan). Orchestrators MUST
      halt the EXECUTE spawn pipeline on exit 2.`);
    process.exit(0);
  }

  // --pre-step branch — bypass the full validator entirely.
  if (args.includes("--pre-step")) {
    // Resolve plan dir: positional non-flag arg wins; else .current_plan pointer.
    const positional = args.find((a) => !a.startsWith("--") && a !== "-h");
    let preStepDir;
    if (positional) {
      // Accept absolute path, relative path, or bare plan-dir name (resolved under plans/).
      if (positional.includes("/") || positional.startsWith(".")) {
        preStepDir = positional;
      } else {
        preStepDir = join(plansDir, positional);
      }
    } else {
      try {
        const pointed = readFileSync(pointerFile, "utf-8").trim();
        preStepDir = join(plansDir, pointed);
      } catch {
        console.log("GATE:FAIL [no-plan]");
        process.exit(2);
      }
    }
    runPreStepGate(preStepDir);
  }

  let planDirName;
  if (args.length > 0) {
    planDirName = args[0];
  } else {
    try {
      planDirName = readFileSync(pointerFile, "utf-8").trim();
    } catch {
      console.error("ERROR: No active plan and no plan directory specified.");
      console.error("  Usage: node validate-plan.mjs <plan-dir-name>");
      process.exit(1);
    }
  }

  validate(planDirName);
}
