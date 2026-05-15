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
// Creates plans/plan_YYYY-MM-DD_XXXXXXXX/ (date + 8-char hex seed) in cwd.
// Writes plans/.current_plan with the directory name for discovery.
// Requires Node.js 18+ (guaranteed by Claude Code).

import { mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, unlinkSync, existsSync, rmSync, copyFileSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";

const cwd = process.cwd();
const plansDir = join(cwd, "plans");
const pointerFile = join(plansDir, ".current_plan");

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
const PLAN_ID_RE = /^plan_\d{4}-\d{2}-\d{2}_[0-9a-f]{8}$/;

function readPointer() {
  try {
    const name = readFileSync(pointerFile, "utf-8").trim();
    if (!name) return null;
    if (!PLAN_ID_RE.test(name)) return null;
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

function extractField(content, pattern) {
  if (!content) return null;
  const match = content.match(pattern);
  return match ? match[1].trim() : null;
}

// System Atlas skeleton — schema must match references/file-formats.md ## plans/SYSTEM.md exactly.
// If you change the schema there, update this skeleton in lockstep.
const SYSTEM_ATLAS_SKELETON = `# System Atlas
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
`;

function ensureConsolidatedFiles() {
  const findingsPath = join(plansDir, "FINDINGS.md");
  const decisionsPath = join(plansDir, "DECISIONS.md");
  const lessonsPath = join(plansDir, "LESSONS.md");
  if (!existsSync(findingsPath)) {
    writeFileSync(findingsPath, `# Consolidated Findings
*Cross-plan findings archive. Entries merged from per-plan findings.md on close. Newest first.*
`);
  }
  if (!existsSync(decisionsPath)) {
    writeFileSync(decisionsPath, `# Consolidated Decisions
*Cross-plan decision archive. Entries merged from per-plan decisions.md on close. Newest first.*
`);
  }
  if (!existsSync(lessonsPath)) {
    writeFileSync(lessonsPath, `# Lessons Learned
*Cross-plan lessons. Updated and consolidated on close. Max 200 lines — rewrite, don't append forever.*
*Read before any PLAN state. This is institutional memory.*
`);
  }
  const systemPath = join(plansDir, "SYSTEM.md");
  if (!existsSync(systemPath)) {
    writeFileSync(systemPath, SYSTEM_ATLAS_SKELETON);
  }
  const indexPath = join(plansDir, "INDEX.md");
  if (!existsSync(indexPath)) {
    writeFileSync(indexPath, `# Plan Index
*Topic-to-directory mapping. Updated on close. Survives sliding window trim.*

| Plan | Date | Goal | Key Topics |
|------|------|------|------------|
`);
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

function stripCrossPlanNote(content) {
  // Match both old format ("...and plans/DECISIONS.md") and new format ("...plans/DECISIONS.md, and plans/LESSONS.md").
  // [^*\n] (rather than [^*]) keeps the match strictly single-line so a malformed
  // note that accidentally drops the closing asterisk cannot eat the entire
  // following file body.
  return content.replace(/\n?\*Cross-plan context: see plans\/FINDINGS\.md[^*\n]*\*\n?/g, "\n");
}

const CONSOLIDATED_COMPRESS_THRESHOLD = 500;
const MAX_CONSOLIDATED_PLANS = 4;
const COMPRESSED_SUMMARY_OPEN = "<!-- COMPRESSED-SUMMARY -->";
const COMPRESSED_SUMMARY_CLOSE = "<!-- /COMPRESSED-SUMMARY -->";

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
  // Find all ## plan_ section positions. Also catch a section that begins
  // at byte 0 (no preceding newline) — defensive against pathological
  // consolidated files lacking the boilerplate H1 header.
  const positions = [];
  if (/^## plan_/.test(content)) positions.push(0);
  const re = /\n## plan_/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    // Record the section start AT the heading (skip the leading \n), so that
    // slicing to `positions[N]` cleanly truncates before the Nth section.
    positions.push(match.index + 1);
  }
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
    let stripped = stripCrossPlanNote(stripHeader(decisionsContent));
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

  // Locate *Plan: …* preamble (required)
  for (let i = 0; i < lines.length; i++) {
    if (/^\*Plan:\s*/.test(lines[i])) { hasPreamble = true; break; }
  }

  // Locate existing compressed block (if any) — first occurrence wins
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(COMPRESSED_SUMMARY_OPEN)) {
      existingBlockStart = i;
      for (let j = i; j < lines.length; j++) {
        const m = lines[j].match(ENTRIES_AT_COMPRESS_RE);
        if (m) entriesAtCompress = Number(m[1]);
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
    if (/^## D-\d+\s*\|/.test(line)) {
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

    const headerMatch = line.match(/^## (D-\d+)\s*\|\s*([^|]+?)\s*\|\s*(\S+)\s*$/);
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
      ? { startLine: existingBlockStart, endLine: existingBlockEnd, entriesAtCompress }
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

  const block = [
    COMPRESSED_SUMMARY_OPEN,
    `<!-- entries-at-compress: ${entries.length} -->`,
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

  // Idempotency: if a compressed block exists and entry count is unchanged
  // since last compression, no-op.
  if (parsed.existingBlock && parsed.existingBlock.entriesAtCompress === parsed.entries.length) {
    return { compressed: false, beforeLines, afterLines: beforeLines, reason: "no-new-entries" };
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
const CHANGELOG_COMPRESSED_INLINE_RE = /^- \(compressed: \d+ low-decision-impact edits/;

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
function classifyChangelogLine(line) {
  if (CHANGELOG_COMPRESSED_INLINE_RE.test(line)) {
    return { kind: "inline-summary" };
  }
  if (!line.trim()) return { kind: "non-entry" };
  // Need at least 7 pipe separators for a well-formed entry (8 fields).
  const sepCount = (line.match(/\|/g) || []).length;
  if (sepCount < 7) return { kind: "non-entry" };

  const fields = line.split(" | ").map((f) => f.trim());
  if (fields.length < 8) return { kind: "non-entry" };

  const opField = fields[4];
  const radiusField = fields[5];
  const decisionRef = fields[6];

  const tierMatch = radiusField.match(/^radius:(LOW|MED|HIGH|UNKNOWN)/);
  const tier = tierMatch ? tierMatch[1] : "UNKNOWN";

  const isRevert = /^REVERT\(/.test(opField);
  const isAnchored = decisionRef !== "-" && decisionRef !== "";

  // Elidable: LOW or MED tier AND not REVERT AND decision-ref is `-`
  const elidable = (tier === "LOW" || tier === "MED") && !isRevert && !isAnchored;

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
    // Only scan a few lines beyond header before giving up.
    if (i > CHANGELOG_HEADER_LINES + 8) break;
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
 * Compress {planDir}/changelog.md if line count exceeds threshold.
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
 * Returns { compressed, beforeLines, afterLines, elidedCount, reason }.
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
  const dateMatch = planDirName.match(/plan_(\d{4}-\d{2}-\d{2})/);
  const date = dateMatch ? dateMatch[1] : "unknown";

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
  const row = `| ${planDirName} | ${date} | ${safeGoal} | ${topics} |\n`;
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

  // Warn about orphaned plan directories (pointer file exists but is corrupted/stale)
  try {
    const activeName = readPointer();
    let pointerFileExists = false;
    try { readFileSync(pointerFile, "utf-8"); pointerFileExists = true; } catch { /* no pointer file */ }
    if (!activeName && pointerFileExists) {
      const allPlans = readdirSync(plansDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.startsWith("plan_"))
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
    console.error(`ERROR: Active plan directory already exists: plans/${existing}`);
    console.error(`  To resume:      node ${process.argv[1]} resume`);
    console.error(`  To view status:  node ${process.argv[1]} status`);
    console.error(`  To close it:     node ${process.argv[1]} close`);
    console.error(`  To force new:    node ${process.argv[1]} new --force "goal"`);
    process.exit(1);
  }
  if (existing && force) {
    cmdClose({ silent: true });
  }
  // Save old pointer name for recovery if --force was used and new plan creation fails
  const previousPlan = force ? existing : null;

  const now = new Date();
  const timestamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const dateStr = now.toISOString().slice(0, 10);
  const hexStr = randomBytes(4).toString("hex");
  const planDirName = `plan_${dateStr}_${hexStr}`;
  const planDir = join(plansDir, planDirName);

  // Check if consolidated files exist for cross-plan context seeding
  const hasConsolidated = existsSync(join(plansDir, "FINDINGS.md")) || existsSync(join(plansDir, "DECISIONS.md")) || existsSync(join(plansDir, "LESSONS.md"));
  const crossPlanNote = hasConsolidated ? "\n*Cross-plan context: see plans/FINDINGS.md, plans/DECISIONS.md, and plans/LESSONS.md*\n" : "";

  try {
    mkdirSync(join(planDir, "checkpoints"), { recursive: true });
    mkdirSync(join(planDir, "findings"), { recursive: true });

    writeFileSync(
      join(planDir, "state.md"),
      `# Current State: EXPLORE
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
## Last Transition: INIT → EXPLORE (${timestamp})
## Transition History:
- INIT → EXPLORE (task started)
<!-- When logging EXPLORE → PLAN, add Exploration Confidence on the line below the transition entry, e.g.:
- EXPLORE → PLAN (gathered enough context, YYYY-MM-DDTHH:MM:SSZ)
  - confidence: scope=deep|partial|shallow, solutions=adequate|thin, risks=clear|unclear
See references/planning-rigor.md for definitions. -->
`
    );

    writeFileSync(
      join(planDir, "plan.md"),
      `# Plan v0

## Goal
${goal}

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
`
    );

    writeFileSync(
      join(planDir, "decisions.md"),
      `# Decision Log
*Plan: ${planDirName}*
*Append-only. Never edit past entries.*
${crossPlanNote}
<!-- Schema example — DO NOT REMOVE. Real entries follow this shape.
     See references/file-formats.md "Entry Schema by Type" for required fields per entry type.
     In-code anchors carry the plan-id prefix: \`# DECISION ${planDirName}/D-NNN\` (see references/decision-anchoring.md).

## D-001 | EXPLORE → PLAN | YYYY-MM-DD
**Context**: <one-paragraph background — what was discovered in EXPLORE>
**Decision**: <chosen approach in one sentence>
**Trade-off**: <X> **at the cost of** <Y>
**Reasoning**: <why this trade-off is acceptable; what alternatives were rejected>
**Anchor-Refs**: \`path/to/file.ext:LL\`, \`other/file.ext:LL-MM\`  (required when a matching \`# DECISION ${planDirName}/D-NNN\` anchor exists in source)
-->
`
    );

    writeFileSync(
      join(planDir, "findings.md"),
      `# Findings
*Summary and index of all findings. Detailed files go in findings/ directory.*
${crossPlanNote}
## Index
*To be populated during EXPLORE.*

## Key Constraints
*To be populated during EXPLORE.*

## Corrections
*Append [CORRECTED iter-N] entries here when earlier findings prove wrong. Reference the original finding file and what changed.*
`
    );

    writeFileSync(
      join(planDir, "progress.md"),
      `# Progress

## Completed
*Nothing yet.*

## In Progress
- [ ] EXPLORE: Initial context gathering

## Remaining
*To be populated from plan.md after PLAN phase.*

## Blocked
*Nothing currently.*
`
    );

    writeFileSync(
      join(planDir, "verification.md"),
      `# Verification Results
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
`
    );

    writeFileSync(
      join(planDir, "changelog.md"),
      `# Changelog
*Append-only per-edit ledger. One line per file edit. Owner: ip-executor (writes). Reader: ip-reviewer at REFLECT.*
*Format: \`UTC | iter-N/step-M | commit | path | OP(+N,-M) | radius:TIER(score) | D-NNN-or-dash | reason\`*
*See references/blast-radius.md for radius scoring. Decision-ref optional — \`-\` means no \`# DECISION\` anchor governs this edit.*
`
    );

    // Ensure consolidated files exist at plans/ root
    ensureConsolidatedFiles();

    writeFileSync(pointerFile + ".tmp", planDirName);
    renameSync(pointerFile + ".tmp", pointerFile);
  } catch (err) {
    try { rmSync(planDir, { recursive: true, force: true }); } catch (e) { console.error(`WARNING: Failed to clean up partial plan directory: ${planDir}`); }
    try { if (existsSync(pointerFile + ".tmp")) unlinkSync(pointerFile + ".tmp"); } catch (e) { console.error("WARNING: Failed to clean up temp pointer file."); }
    // If --force was used, restore the old pointer so the previous plan is not orphaned
    if (previousPlan) {
      try {
        writeFileSync(pointerFile, previousPlan);
        console.error(`WARNING: Restored pointer to previous plan: plans/${previousPlan}`);
      } catch (e) { console.error(`WARNING: Failed to restore pointer to previous plan: plans/${previousPlan}`); }
    } else {
      try { if (existsSync(pointerFile)) unlinkSync(pointerFile); } catch (e) { console.error("WARNING: Failed to clean up pointer file."); }
    }
    console.error(`ERROR: Failed to create plan directory: ${err.message}`);
    process.exit(1);
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
    const decisionCount = (decisions.match(/^## D-\d+/gm) || []).length;
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
  const planDirName = readPointer();
  if (!planDirName) {
    if (!opts.silent) {
      console.error("ERROR: No active plan to close.");
      process.exit(1);
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
    const historyMarker = "## Transition History:";
    const historyIdx = updated.indexOf(historyMarker);
    if (historyIdx >= 0) {
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
    writeFileSync(statePath, updated);
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
    .filter((d) => d.isDirectory() && d.name.startsWith("plan_"))
    .map((d) => d.name)
    .sort();

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

function printUsage() {
  console.log(`Usage: node bootstrap.mjs <command> [options]

Commands:
  new "goal"              Create a new plan directory
  new --force "goal"      Close active plan and create a new one
  resume                  Output current plan state for re-entry
  status                  One-line state summary
  close                   Close active plan (preserves directory)
  list                    Show all plan directories (active and closed)

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
  const subcommands = new Set(["new", "resume", "status", "close", "list", "help"]);

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
    // Backward compat: treat args as goal for `new`
    cmdNew(args.join(" ") || "No goal specified", false);
  } else if (cmd === "new") {
    const force = args.includes("--force");
    const goalArgs = args.slice(1).filter((a) => a !== "--force");
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
  } else if (cmd === "help") {
    printUsage();
  }
}

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
