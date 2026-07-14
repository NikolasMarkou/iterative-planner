// Shared helpers for the iterative-planner scripts.
//
// Single source of truth for small pure functions that bootstrap.mjs and
// validate-plan.mjs both need. Before this module each script kept its own
// copy (extractField was byte-identical in both; the changelog field-split was
// exported by bootstrap.mjs but reimplemented inline in validate-plan.mjs with
// a "kept in lockstep" comment). Centralizing here removes that drift surface.
//
// Distribution note: this file lives flat in src/scripts/ (NOT a lib/ subdir)
// so the `src/scripts/*.mjs` copy glob in Makefile and build.ps1 ships it
// automatically with no build change. Importers use a relative "./shared.mjs".
// Requires Node.js 18+ (ESM).

/**
 * Extract the first capture group of `pattern` from `content`, trimmed.
 * Returns null when content is falsy or the pattern does not match.
 */
export function extractField(content, pattern) {
  if (!content) return null;
  const match = content.match(pattern);
  return match ? match[1].trim() : null;
}

/**
 * F3 — pipe-tolerant changelog field split.
 * Splits a changelog line on the FIRST 7 occurrences of " | "; the 8th field
 * (reason) absorbs any remaining " | " sequences. Without this, a legitimate
 * reason containing " | " (e.g. "fix race: a | b") expands to 9+ fields and is
 * wrongly classified as malformed/non-entry, hiding the line from compression
 * and the validator. Fields are returned trimmed. When the line has fewer than
 * 7 separators it cannot be a well-formed entry; we return `line.split(SEP)`
 * (trimmed) so the caller sees the real field count and rejects it.
 *
 * Field indices (0-based after split):
 *   0: UTC timestamp        4: OP(+N,-M) | NEW | REVERT(file)
 *   1: iter-N/step-M        5: radius:TIER(score)
 *   2: commit | uncommitted 6: D-NNN | -
 *   3: path                 7: reason
 */
export function splitChangelogFields(line) {
  const SEP = " | ";
  const fields = [];
  let cursor = 0;
  for (let i = 0; i < 7; i++) {
    const idx = line.indexOf(SEP, cursor);
    if (idx < 0) return line.split(SEP).map((f) => f.trim()); // <8 fields; let caller reject
    fields.push(line.slice(cursor, idx).trim());
    cursor = idx + SEP.length;
  }
  fields.push(line.slice(cursor).trim()); // remainder = reason
  return fields;
}

// ---------------------------------------------------------------------------
// Intra-plan compression markers + recognizers.
//
// Single source of truth shared by the PRODUCER (bootstrap.mjs maybeCompress*)
// and the VALIDATOR (validate-plan.mjs). Before centralizing these, the
// validator did not know about the artifacts bootstrap wrote, so a correctly
// compressed decisions.md / changelog.md tripped its own validator
// (decisions-schema ERROR on "## Summary (compressed)"; changelog-malformed
// WARN on the inline "- (compressed: ...)" line). Keep both consumers importing
// from here so that drift cannot recur.
// ---------------------------------------------------------------------------

export const COMPRESSED_SUMMARY_OPEN = "<!-- COMPRESSED-SUMMARY -->";
export const COMPRESSED_SUMMARY_CLOSE = "<!-- /COMPRESSED-SUMMARY -->";

// Inline per-changelog compression summary line written by maybeCompressChangelog.
export const CHANGELOG_COMPRESSED_INLINE_RE = /^- \(compressed: \d+ low-decision-impact edits/;

/**
 * Blank out the COMPRESSED-SUMMARY block (markers + body) in a decisions.md
 * string, preserving line count so downstream line numbers stay accurate. The
 * block body is plain markdown ("## Summary (compressed)", "### Decision lookup",
 * ...) that must NOT be parsed as decision entries. Only non-newline characters
 * are removed, so every line index is unchanged. Returns the content unchanged
 * when no complete block is present.
 */
export function blankCompressedSummaryBlock(content) {
  if (!content) return content;
  const openIdx = content.indexOf(COMPRESSED_SUMMARY_OPEN);
  if (openIdx < 0) return content;
  const closeIdx = content.indexOf(COMPRESSED_SUMMARY_CLOSE, openIdx);
  if (closeIdx < 0) return content;
  const end = closeIdx + COMPRESSED_SUMMARY_CLOSE.length;
  const block = content.slice(openIdx, end);
  const blanked = block.replace(/[^\n]/g, "");
  return content.slice(0, openIdx) + blanked + content.slice(end);
}

// DECISION plan_2026-07-14_79ee0f59/D-003 — the unterminated-comment branch below is
// deliberate and load-bearing. Do NOT "fix" it to blank from a dangling `<!--` to EOF,
// and do NOT make it throw: validate-plan.mjs's iteration hard-cap counter reads
// state.md through this helper, so blanking-to-EOF on a stray opener would erase real
// `EXECUTE → REFLECT` records and silently disable a safety cap. Leaving the region
// untouched can only OVER-count iterations (a loud, recoverable false positive).
/**
 * Blank out every complete HTML comment region (`<!-- ... -->`, markers included)
 * in `content`, preserving line count so downstream line numbers stay accurate —
 * the same non-newline-blanking idiom as blankCompressedSummaryBlock above.
 *
 * Why this exists: bootstrap.mjs's state.md template ends with a guidance block
 * inside an HTML comment, and that block contains a literal EXAMPLE transition
 * (`- EXPLORE → PLAN (...)`). Any scanner that reads the Transition History block
 * raw ingests that example as if it were a real transition record. Callers must
 * strip first, scan second.
 *
 * Semantics (deliberate):
 *  - HTML comments do NOT nest: the first `-->` closes the comment, so a
 *    `<!--` appearing inside a comment body is ordinary text and is blanked.
 *  - An UNTERMINATED `<!--` (no closing `-->`) is left UNCHANGED rather than
 *    blanked-to-EOF. This fails SAFE: consumers of this helper include the
 *    iteration hard-cap counter, and blanking to EOF on a stray/typo'd opener
 *    would silently swallow real transition records and disable a safety cap.
 *    Over-counting is recoverable; under-counting is not. Never throws.
 *  - Non-comment text is returned byte-identical.
 */
export function stripHtmlComments(content) {
  if (!content) return content;
  let out = "";
  let cursor = 0;
  for (;;) {
    const openIdx = content.indexOf("<!--", cursor);
    if (openIdx < 0) break;
    const closeIdx = content.indexOf("-->", openIdx + 4);
    if (closeIdx < 0) break; // unterminated → leave the remainder untouched (fail safe)
    const end = closeIdx + 3;
    out += content.slice(cursor, openIdx);
    out += content.slice(openIdx, end).replace(/[^\n]/g, "");
    cursor = end;
  }
  return cursor === 0 ? content : out + content.slice(cursor);
}
