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
  unterminatedCommentOpener,
  ANY_PLAN_ID_PATTERN,
  ANY_PLAN_ID_RE,
  PLAN_SECTION_PATTERN,
  DECISION_ID_NUM_PATTERN,
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

function extractSection(content, heading) {
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
  return body.trim() || null;
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

// DECISION plan_2026-07-14_79ee0f59/D-003 — state.md's Transition History MUST be
// read comment-blind. bootstrap.mjs's own state.md template ends with an HTML-comment
// guidance block that embeds a literal example transition (`- EXPLORE → PLAN (...)`),
// so a raw scan of the block ingests template prose as if it were a real transition
// record: it made [exploration-confidence] WARN on EVERY fresh plan, and it would let
// a future template example inject a phantom (possibly ILLEGAL) transition into the
// legality check and the iteration hard-cap counter.
// NOTE: this is the SAME comment-region-blindness class the repo already fixed once in
// v2.32.0 for the .md DECISION-anchor scanner (see HTML_STYLE_EXTS below, ~:904). The
// state.md scanners never learned that lesson; this helper is the single place they do.
// Do NOT re-introduce a raw `state.slice(indexOf("## Transition History:"))` scan —
// route every Transition-History reader through this function.
// CORRECTED at iter-2/step-5 (D-009): this note used to add "and do NOT improve
// stripHtmlComments to blank an unterminated `<!--` to EOF, because that would disable the
// iteration hard cap". That framing was wrong — it located a SAFETY property in a
// general-purpose text helper. The stripper's behaviour never protected the cap (a stray
// opener pairs with bootstrap's template trailer, so it is never unterminated in the first
// place). The cap protects itself, by reading RAW: see deriveIterationFromHistory below.
// DECISION plan_2026-07-14_79ee0f59/D-010 — the heading is located with a LINE-ANCHORED
// match (`/^## Transition History:/m`), never a bare `stripped.indexOf("## Transition
// History:")`. Do not "simplify" it back to indexOf. A substring search also matches the
// heading's own NAME written mid-line in prose — and state.md's Change Manifest quotes it
// verbatim (iteration 1 recorded: "All raw `state.indexOf(\"## Transition History:\")`
// scans replaced..."). The block then began at the Change Manifest instead of the real
// heading 45 lines later, so ~40 lines of prose were scanned as transition records. This
// was INVISIBLE until CRITICAL 3 was fixed, because the code-span-blind comment scrub was
// blanking the very lines it corrupted — two bugs cancelling out. Measured on this repo's
// own state.md: the block started at line 17, the transition-legality check saw 14
// transition-shaped prose lines, and the iteration hard-cap counter derived **0** from 3
// real `EXECUTE → REFLECT` records. A heading is a LINE, so match it as one.
// DECISION plan_2026-07-14_79ee0f59/D-009 — the `raw` option exists for exactly ONE
// caller: deriveIterationFromHistory (the iteration hard cap). Do NOT pass `{ raw: true }`
// from an advisory scanner "for consistency" — they MUST keep reading the stripped block,
// where bootstrap's template example transition is invisible and a false WARN would be
// recoverable anyway. See the fail-closed note on deriveIterationFromHistory below.
// The heading is located in whichever text the caller reads, NOT always in the stripped
// text: a stray `<!--` ABOVE the heading blanks the heading itself, so a stripped-only
// lookup returns null and the cap derives 0 from ANY number of real records. Measured on
// the reviewer's fixture (stray opener + 4 real records + the template trailer): the
// stripped lookup derives **0**, not the 2 the review reported. Locating in raw text is
// what makes the cap structurally incapable of under-counting.
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

  const lines = historyBlock.split("\n").filter((l) => l.startsWith("- "));

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

  // Count indexed findings (lines starting with "- " or "N. " under ## Index).
  // findingItems already captures both bullet links ("- [Foo](path)") and plain
  // bullets ("- Foo") — links are a subset, so summing them with findingLinks
  // would double-count. Use bullets + numbered to support mixed-style indexes.
  const indexSection = extractSection(findings, "Index");
  if (indexSection) {
    const findingItems = indexSection.split("\n").filter((l) => l.match(/^- .+/));
    const numberedItems = indexSection.split("\n").filter((l) => l.match(/^\d+\.\s+.+/));
    const count = findingItems.length + numberedItems.length;

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
    const stateIter = extractField(state, /^## Iteration:\s*(.+)$/m);
    if (verification && stateIter && parseInt(stateIter) >= 2) {
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
// line are intentionally NOT counted. Conservative: only fires during
// EXECUTE/REFLECT — outside those states the section is stale from a previous
// step. WARN at 3, ERROR at 4+. Resets on step / PIVOT / user direction
// (tracked by the agent rewriting the section).
function checkLeashCount(planDir, issues) {
  const state = readFile(join(planDir, "state.md"));
  if (!state) return;

  const currentState = extractField(state, /^# Current State:\s*(.+)$/m) || "";
  if (!["EXECUTE", "REFLECT"].includes(currentState.toUpperCase())) return;

  const section = extractSection(state, "Fix Attempts");
  if (!section) return; // No section — legacy state.md or pre-template plan. Silent.
  // Alternation: documented `- Step N, attempt M` first, comma-optional/space-only variants
  // (`- Step 1 attempt 1`, `- Step 1  attempts 2`), and legacy bare `- Attempt M` / `- Attempts M`.
  // Plural `attempts?` tolerated; previously a non-canonical write silently bypassed the leash (F1).
  const attempts = section.split("\n").filter((l) => /^-\s+(Step\s+\d+[,\s]+attempts?\s+\d+|Attempts?\s+\d+)/i.test(l));
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
  const norm = block.replace(/[–—‐]/g, "-");
  const re = /EXECUTE\s*(?:→|->)\s*REFLECT/g;
  let count = 0;
  while (re.exec(norm) !== null) count++;
  return count;
}

// DECISION plan_2026-07-14_79ee0f59/D-009 — this counter drives the iteration hard cap
// (a SAFETY mechanism), and it therefore counts on the **RAW** history block. Do NOT
// "unify" it with the advisory scanners by dropping the raw read.
//
// This CORRECTS a false invariant that shipped here under D-003. That note claimed the
// cap could only ever OVER-count, because `stripHtmlComments` leaves an unterminated
// `<!--` untouched. The claim was FALSE in the shipped template's own shape:
// bootstrap.mjs ends EVERY state.md with a guidance comment that supplies a trailing
// `-->` (bootstrap.mjs:1383-1386), so a stray opener is never unterminated — it pairs
// with that trailer and blanks everything between. Reproduced: a stray `<!-- note:` line
// above the heading + 4 real `EXECUTE → REFLECT` records → the cap derived **0**. The
// safety cap silently disappeared. It failed OPEN.
//
// The fail-safe cannot live in the stripper. Under HTML rules that document genuinely IS
// one long comment, and no purely-local rule distinguishes "a `-->` belonging to another
// comment": a blank line does not, a heading does not, and marker-balance counting does
// not (left-to-right pairing finds the stray opener perfectly "balanced" against the
// template's closer). So the invariant is RELOCATED to the consumer that needs it — this
// one. Counting `max(raw, stripped)` (raw is the whole region a comment could hide) makes
// under-counting STRUCTURALLY IMPOSSIBLE for any comment shape, and the cap can then only
// OVER-count: the loud, recoverable, agent-visible direction.
//
// Advisory scanners (checkExplorationConfidence, transition legality, the PC advisory)
// deliberately keep reading the STRIPPED block: a false WARN there is recoverable, a false
// ERROR would not be. The price of raw counting is re-acquiring the template-example
// exposure D-003 removed — safe today ONLY because the template's sole example transition
// is `EXPLORE → PLAN`, never `EXECUTE → REFLECT` (assumption B4, re-verified against
// bootstrap.mjs:1383-1386 at iter-2/step-5). If a template example ever adds an
// `EXECUTE → REFLECT` line, this over-counts by one on EVERY fresh plan — and
// [state-comment-anomaly] fires to say why. See decisions.md D-009.
// Exported for testability ONLY (the CLI cannot observe a derived count below 5 — the cap
// prints nothing under its WARN threshold — and the review's fixture measures exactly 4).
// The module's CLI dispatch is already guarded by `isEntryPoint`, so importing is safe.
export function deriveIterationFromHistory(state) {
  return Math.max(
    countExecuteReflect(transitionHistoryBlock(state, { raw: true })),
    countExecuteReflect(transitionHistoryBlock(state)),
  );
}

// DECISION plan_2026-07-14_79ee0f59/D-009 — the DIAGNOSTIC half of the fail-closed cap.
// Raw counting (above) makes the cap incapable of under-counting, but it buys that with the
// possibility of an OVER-count whenever a comment region embeds a transition-shaped line.
// An unexplained over-count would be its own kind of silent failure ("why does the validator
// think I am on iteration 8?"), so this check exists to always EXPLAIN one.
//
// WARN ONLY. Do NOT promote this to an ERROR and do NOT add it to the --pre-step gate's
// HARD-fail slugs. A stray comment marker in state.md is an authoring accident, not a
// protocol violation: the cap already handles the safety consequence, and an ERROR here
// would BLOCK a plan over a typo in a file the agent is actively editing. It also must stay
// silent on a fresh `bootstrap.mjs new` plan dir and on this repo's own plan dir — a WARN
// that fires on every plan is noise, and noise is how a real signal gets ignored.
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

  const iterStr = extractField(state, /^## Iteration:\s*(.+)$/m);
  if (!iterStr) return;

  const iter = parseInt(iterStr);
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
// Group 1 = label, 2 = used (N), 3 = cap (M) from `<label>...: N/M max`.
const COUNTED_BUDGET_RE = /^\s*(?:[-*+]\s*)?\**\s*(Files added|New abstractions)\b[^:\n]*:\s*\**\s*(\d+)\s*\/\s*(\d+)\s*max/i;
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
  // Tolerances baked into COUNTED_BUDGET_RE, all observed in real plan.md files:
  //   - list bullet (`- `), bold wrappers (`**Files added: 8/3 max**`)
  //   - a parenthetical inside the label ("New abstractions (classes/modules/interfaces):")
  //   - whitespace around the slash
  // The "Lines added vs removed: +900/-150" line is deliberately NOT counted:
  // it is a *target*, not a cap, and its N/M are signed deltas, not a ratio.
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
  // the comment scrub is CODE-SPAN AWARE. Do NOT restore the regex that stood here:
  //   blankCompressedSummaryBlock(content).replace(/<!--[\s\S]*?-->/g, "")
  // It was wrong twice over. (1) It DELETED lines, so every line number this function
  // reports was offset by the size of any stripped comment — it reported "D-007 (line 59)"
  // for an entry at line 69 on this repo's own decisions.md. (2) It was blind to code
  // spans, so a backticked `` `<!--` `` in an entry that merely *writes about* comments
  // opened a phantom span that ran to the next `-->` in a LATER entry — silently
  // deleting real entries. On this repo's own decisions.md it made D-008 and D-009
  // vanish and emitted two FALSE ERRORs (a bogus "sequence broken … got D-010" and a
  // bogus "missing **Complexity Assessment**"). The dangerous half is the inverse: a
  // decision genuinely missing `**Trade-off**:` inside a swallowed span was reported by
  // NOTHING. The check failed OPEN. See decisions.md D-010 and shared.mjs
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

// 3.1e — Verdict 5 required bullets, in order.
function checkVerificationVerdict(planDir, issues) {
  const path = join(planDir, "verification.md");
  const content = readFile(path);
  if (!content) return;
  const verdict = extractSection(content, "Verdict");
  if (!verdict) return; // section presence is not enforced here; other checks own it.

  const requiredKeywords = [
    /criteria pass(?:ed|\s+count)/i,
    /regressions/i,
    /scope drift/i,
    /simplification blockers/i,
    /recommend(?:ed|ation)/i,
  ];
  const labels = [
    "Criteria passed",
    "Regressions",
    "Scope drift",
    "Simplification blockers",
    "Recommended transition",
  ];

  // Find positions of each keyword in the Verdict section.
  let lastPos = -1;
  let orderBroken = false;
  const missing = [];
  for (let i = 0; i < requiredKeywords.length; i++) {
    const re = requiredKeywords[i];
    const m = re.exec(verdict);
    if (!m) {
      missing.push(labels[i]);
      continue;
    }
    if (m.index < lastPos) orderBroken = true;
    lastPos = m.index;
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

const ANCHOR_SOURCE_EXTS = new Set([
  ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".rb", ".go", ".rs",
  ".c", ".h", ".cpp", ".hpp", ".java", ".kt", ".sql", ".md",
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
const HTML_STYLE_EXTS = new Set([".md", ".markdown", ".mdx", ".html", ".htm"]);

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

  // Block comment scan (multi-line) — applies to /* */ in C-family + CSS.
  // Loop over EVERY anchor in the block; previously only the first was found.
  // NOTE: this scan has no comment-marker prefix on its inner regex, so it must
  // NOT run on HTML-style files. Block-comment delimiters occur as ordinary prose
  // there — CHANGELOG.md:331 quotes an inline block comment holding two bare
  // `D-NNN` tokens — and both would be reported as anchors. Gate on the extension;
  // do not exclude by path (that hides real anchors in a whole directory).
  if (!HTML_STYLE_EXTS.has(ext)) {
    const blockRe = /\/\*([\s\S]*?)\*\//g;
    let bm;
    while ((bm = blockRe.exec(text)) !== null) {
      const body = bm[1];
      const bodyOffset = bm.index + 2; // skip past "/*"
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
  // DECISION plan_2026-07-14_79ee0f59/D-010 — the comment spans come from shared.mjs's
  // `htmlCommentSpans`, NOT from a local `/<!--([\s\S]*?)-->/g`. Do not inline one back:
  // that regex is code-span-blind, so a backticked `` `<!--` `` in prose opens a phantom
  // span and the scanner then sees anchors inside doc examples (or misses a real one
  // whose span boundary moved). That hole was previously only PAPERED OVER by policy —
  // CLAUDE.md tells doc authors to use placeholder ids — which is a policy patch over a
  // code bug. It is now closed in code. bootstrap.mjs retire's stamper consumes the SAME
  // primitive, which is what makes the "the validator sees exactly what retire stamps"
  // contract true by construction. Change one, change both. See decisions.md D-010.
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

// DECISION plan_2026-07-14_317362c4/D-005 — anchors whose plan-id prefix is not a legal
// plan-id are found by a SECOND, loose-prefix pass, and reported as WARN. Do NOT "fix"
// this by widening the read union (shared.mjs) to also accept the commit-tag shape
// `plan-YYYY-MM-DD-HASH`: that would make a mis-derived prefix *resolve*, and the anchor
// would then be silently attributed to a plan directory that does not exist. The union is
// the grammar of things that ARE plan-ids; this pass is the net under it. And do NOT
// promote this to ERROR: the anchor still documents a real decision, the id still
// resolves by eye, and a cosmetic prefix typo must not hard-block a REFLECT→CLOSE gate.
// Bare anchors (no prefix at all) are NOT reported here — `anchor-unqualified` already
// owns them; double-reporting the same line under two checks trains people to ignore both.
// See decisions.md D-005.
function findBadPrefixAnchorsInFile(file, projectRoot) {
  return findAnchorsInFile(file, projectRoot, LOOSE_ANCHOR_PREFIX_PATTERN)
    .filter((a) => a.qualified && !ANY_PLAN_ID_RE.test(a.planName));
}

// Collect known decision IDs grouped by plan. Returns Map<planName, Set<id>>.
// The active plan is keyed by `activePlanName`. Cross-plan archive is parsed
// section-aware: each `## <plan-id>` heading begins a section; `### D-NNN`
// entries within belong to that plan.
function collectKnownDecisionIdsByPlan(planDir, activePlanName) {
  const map = new Map();

  function add(planName, id) {
    if (!planName) return;
    if (!map.has(planName)) map.set(planName, new Set());
    map.get(planName).add(id);
  }

  // Active plan's per-plan decisions.md.
  const planDecisions = readFile(join(planDir, "decisions.md"));
  if (planDecisions) {
    const { entries } = parseDecisionsEntries(planDecisions);
    for (const e of entries) add(activePlanName, e.id);
  }

  // Walk every per-plan decisions.md (covers archived plans whose sections
  // have been trimmed from plans/DECISIONS.md).
  try {
    const entries = readdirSync(plansDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (!ANY_PLAN_ID_RE.test(ent.name)) continue;
      if (ent.name === activePlanName) continue; // already loaded above
      const txt = readFile(join(plansDir, ent.name, "decisions.md"));
      if (!txt) continue;
      const { entries: pe } = parseDecisionsEntries(txt);
      for (const e of pe) add(ent.name, e.id);
    }
  } catch { /* plans/ may not be scannable */ }

  // Consolidated plans/DECISIONS.md, section-aware: track current `## <plan-id>`
  // wrapper, attribute every nested `### D-NNN` (or `## D-NNN` if not nested)
  // to that plan. Matches v2.13.0 sliding-window content shape.
  const consolidated = readFile(join(plansDir, "DECISIONS.md"));
  if (consolidated) {
    const lines = consolidated.split("\n");
    let currentPlan = null;
    const planSectionRe = new RegExp(`^##\\s+(${ANY_PLAN_ID_PATTERN})\\s*$`);
    const dashEntryRe = new RegExp(`^#{2,3}\\s+D-(${DECISION_ID_NUM_PATTERN})\\b`);
    for (const line of lines) {
      const ps = planSectionRe.exec(line);
      if (ps) { currentPlan = ps[1]; continue; }
      const de = dashEntryRe.exec(line);
      if (de && currentPlan) add(currentPlan, parseInt(de[1], 10));
    }
  }

  return map;
}

function checkReverseAnchors(planDir, planDirName, issues, projectRoot) {
  const knownByPlan = collectKnownDecisionIdsByPlan(planDir, planDirName);
  let files;
  try {
    files = walkSourceFiles(projectRoot);
  } catch {
    return;
  }

  for (const file of files) {
    for (const b of findBadPrefixAnchorsInFile(file, projectRoot)) {
      const rel = relative(projectRoot, b.file);
      const idStr = `D-${String(b.id).padStart(3, "0")}`;
      issues.push({
        severity: "WARN",
        check: "anchor-badprefix",
        message: `${rel}:${b.line} anchor prefix "${b.planName}" is not a plan-id, so ${idStr} is invisible to the anchor audit — it matches no anchor regex at all, and is not even reported as an orphan. A plan-id is the full plan-DIRECTORY name (\`plan-YYYY-MM-DDTHHMMSS-XXXXXXXX\`, or legacy \`plan_YYYY-MM-DD_XXXXXXXX\`). If it looks like a commit tag: the tag DROPS the \`THHMMSS\` segment, anchors keep it. See references/decision-anchoring.md`,
      });
    }
    const anchors = findAnchorsInFile(file, projectRoot);
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
            message: `${rel}:${a.line} orphan anchor ${fullId}${staleSuffix} (plan exists but no ${idStr} entry in its decisions.md)`,
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
            message: `${rel}:${a.line} orphan anchor ${idStr}${staleSuffix} (no matching entry in active plan's decisions.md)`,
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
  const required = [
    { name: "Summary", re: /^##\s+Summary\b/m },
    { name: "Key Findings", re: /^##\s+Key Findings\b/m },
    { name: "Constraints", re: /^##\s+Constraints\b/m },
    { name: "Code Patterns", re: /^##\s+Code Patterns\b/m },
    { name: "Risks", re: /^##\s+Risks\b/m },
  ];
  for (const f of files) {
    const text = readFile(join(dir, f));
    if (!text) continue;
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
  const lines = historyBlock.split("\n");

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
// Line format: UTC | iter-N/step-M | commit | path | OP(+N,-M) | radius:TIER(score) | D-NNN-or-dash | reason
//
// DECISION plan_2026-07-14_79ee0f59/D-001 — the SIX hand-maintained field regexes that used to live
// right here (TS / STEP / COMMIT / OP / RADIUS / DREF) are GONE. They now exist exactly once, as
// typed fields in schema.mjs's CHANGELOG_SPEC: each line is split by splitChangelogFields(), turned
// into a synthetic <entry> node by entryFromFields(), and checked by validateElement().
//
// What NOT to do:
//   - Do NOT reintroduce a changelog field regex here. Two copies of a field shape kept in lockstep
//     by hand is the exact defect the schema exists to remove; that is why validateElement() and
//     entryFromFields() are exported at all. (The XML encoding that once wrapped this file was
//     reverted in v2.35.0 — the SCHEMA is what survived, and it is the whole point.)
//   - Do NOT promote [changelog-malformed] to ERROR. The changelog is ADVISORY (file-formats.md:
//     "Changelog issues are advisory only. Never blocks CLOSE."). A bug in our own line parser must
//     never be able to block a CLOSE.
// See decisions.md D-001.
function checkChangelogFormat(planDir, issues) {
  const file = join(planDir, "changelog.md");
  const content = readFile(file);
  if (!content) return; // Optional file — older plans (and fresh dirs) may lack it.

  const lines = content.split("\n");
  let lineNo = 0;
  for (const raw of lines) {
    lineNo++;
    const line = raw.trim();
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
// DECISION plan-2026-07-16T085306-8bd12f33/D-001 — join integrity is a SEPARATE
// flat check, string-set membership only, called ONLY from validate().
// What NOT to do:
//   - Do NOT re-validate the dref SHAPE here (no `D-\d{3,}` regex, no new field
//     constants): the shape is already guaranteed by CHANGELOG_SPEC's DREF_RE in
//     checkChangelogFormat's loop, and the source-grep test in
//     validate-plan.test.mjs pins this file as regex-free for the six changelog
//     fields. This check compares the already-validated string against
//     parseDecisionsEntries()'s idStr set — nothing more.
//   - Do NOT wire this into runPreStepGate (state.md-only, <50ms, exit-2 contract)
//     and do NOT promote to ERROR (the changelog is advisory; a stale dref must
//     never block a CLOSE).
//   - Do NOT add a second decisions.md parser: parseDecisionsEntries is the one
//     parser (it is already comment/compression-blind — a dref whose decision was
//     compressed away legitimately WARNs; accepted trade-off).
// See decisions.md D-001 (plan-2026-07-16T085306-8bd12f33).
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
// v2.17.0 — Presentation Contract advisory
// ---------------------------------------------------------------------------
// Best-effort signal: when state.md records a user-facing transition
// (PLAN→EXECUTE, REFLECT→CLOSE, PIVOT→PLAN), check whether a Presentation
// Contract was named anywhere in state.md / decisions.md / progress.md.
// This cannot inspect chat content — only metadata signals. WARN, never ERROR.
//
// Contracts: PC-EXPLORE, PC-PLAN, PC-EXECUTE-STEP, PC-EXECUTE-LEASH,
//            PC-REFLECT, PC-PIVOT (defined in references/file-formats.md).
//
// Rule: for each gated transition observed in Transition History, the same
// state.md (or decisions.md / progress.md) should contain at least one
// reference to the contract that governs the transition. Absence is a WARN.
function checkPresentationContractLog(planDir, issues) {
  const state = readFile(join(planDir, "state.md"));
  if (!state) return;
  const decisions = readFile(join(planDir, "decisions.md")) || "";
  const progress = readFile(join(planDir, "progress.md")) || "";
  const corpus = state + "\n" + decisions + "\n" + progress;
  // D-003: the DETECTION side must be comment-blind — a transition named inside a
  // template/guidance comment (or in commented-out prose) is not a recorded transition
  // and must not summon a WARN about a contract that was never due. The SEARCH side
  // (`corpus`) stays raw on purpose: it only ever SUPPRESSES a WARN, so stripping it
  // could only make this advisory noisier, never more correct.
  const stateRecorded = stripHtmlComments(state);

  // Gated transitions and their expected contract names. Multiple contracts
  // possible per transition — match any.
  const gates = [
    { from: "PLAN", to: "EXECUTE", contracts: ["PC-PLAN"] },
    { from: "REFLECT", to: "CLOSE", contracts: ["PC-REFLECT"] },
    { from: "PIVOT", to: "PLAN", contracts: ["PC-PIVOT"] },
  ];

  for (const g of gates) {
    // Detect transition occurrence — match either "FROM → TO" or "FROM -> TO" forms,
    // anywhere in state.md (Transition History line or Last Transition).
    const re = new RegExp(`${g.from}\\s*(?:→|->)\\s*${g.to}`);
    if (!re.test(stateRecorded)) continue;
    // Check whether any of the expected contract names appears in corpus.
    const found = g.contracts.some((c) => corpus.includes(c));
    if (!found) {
      issues.push({
        severity: "WARN",
        check: "presentation-contract-unlogged",
        message: `${g.from}→${g.to} transition recorded in state.md but no ${g.contracts.join("/")} reference found in state.md/decisions.md/progress.md (best-effort signal — verify the contract was emitted to the user).`,
      });
    }
  }
}

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
  checkCompressionMarkers(issues);

  // Step 3 additions (2.13.0): schema and anchor enforcement.
  checkDecisionsSchema(planDir, issues);
  checkVerificationVerdict(planDir, issues);
  checkFindingsIndexLinks(planDir, issues);
  checkReverseAnchors(planDir, planId, issues, cwd);
  checkVerificationEvidence(planDir, issues);
  checkFindingsTopicSections(planDir, issues);
  checkExplorationConfidence(planDir, issues);
  // v2.14.0 — plan-qualified anchors, plan-id preamble, gated Anchor-Refs.
  checkPlanIdPreamble(planDir, planId, issues);
  checkAnchorRefsRequired(planDir, planId, issues, cwd);
  checkAnchorRefsValidity(planDir, planId, issues, cwd);
  // v2.15.0 — per-edit changelog (informational; never blocks CLOSE).
  checkChangelogFormat(planDir, issues);
  // v2.51.0 — changelog dref join integrity (WARN-only; never blocks CLOSE).
  checkChangelogDrefIntegrity(planDir, issues);
  // v2.17.0 — Presentation Contract advisory (best-effort, WARN-only).
  checkPresentationContractLog(planDir, issues);

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
  // Same relaxed regex as checkLeashCount (F1): comma optional, attempts? plural ok.
  const attemptRe = /^-\s+(Step\s+\d+[,\s]+attempts?\s+\d+|Attempts?\s+\d+)/i;
  const attempts = section ? section.split("\n").filter((l) => attemptRe.test(l)).length : 0;
  if (attempts >= 2) {
    console.log(`GATE:FAIL [leash-cap] attempts=${attempts} cap=2`);
    process.exit(2);
  }

  const iterStr = extractField(state, /^## Iteration:\s*(.+)$/m);
  const iter = iterStr ? parseInt(iterStr, 10) : 0;
  if (Number.isFinite(iter) && iter >= 6) {
    console.log(`GATE:FAIL [iteration-cap] iteration=${iter} hard-cap=6`);
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
  - plans/LESSONS.md line count (ERROR [lessons-cap] on >200 lines, INFO [lessons-absent] when missing)
  - Compression-summary marker integrity in FINDINGS.md/DECISIONS.md (ERROR [compress-markers] on unbalanced/nested/duplicate)
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
  - Presentation Contract advisory (WARN [presentation-contract-unlogged] when
    a gated transition PLAN→EXECUTE / REFLECT→CLOSE / PIVOT→PLAN is recorded
    in state.md without any PC-PLAN / PC-REFLECT / PC-PIVOT reference in
    state.md / decisions.md / progress.md — best-effort signal)

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
