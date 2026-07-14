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

// ---------------------------------------------------------------------------
// HTML comment regions in Markdown — the SINGLE definition of "where the comments are".
//
// DECISION plan_2026-07-14_79ee0f59/D-010 — every markdown scanner in this repo MUST
// locate comments through `htmlCommentSpans()` below. Do NOT write a fifth
// `/<!--[\s\S]*?-->/` regex at a call site. That pattern has now produced the same
// bug THREE times (v2.32.0's `.md` anchor scanner; iter-1 defect #8's state.md
// Transition-History scanners; iter-2 CRITICAL 3's `checkDecisionsSchema`), because a
// bare regex is blind to markdown code spans: a backticked `` `<!--` `` written in
// PROSE — which is exactly what an entry *documenting comment handling* contains —
// supplies a phantom opener that pairs with the next `-->` anywhere downstream and
// swallows everything between. Content inside a phantom span is INVISIBLE to
// validation, so the check FAILS OPEN (a genuinely missing `**Trade-off**:` goes
// silently unreported). Reproduced live against this plan's own decisions.md: D-008
// and D-009 vanished entirely and D-007 lost its `**Complexity Assessment**` line.
//
// The two properties below are both load-bearing; do not "simplify" either away:
//   1. LINE-COUNT PRESERVING. `stripHtmlComments` blanks, it does not delete. Every
//      caller reports line numbers from the stripped text. The deleted `:769` regex
//      used `.replace(..., "")` and every finding it emitted was off by the size of
//      the stripped comment (observed: "D-007 (line 59)"; D-007 is at line 69).
//   2. CODE-SPAN AWARE. A delimiter inside a backtick run or a fenced block is
//      literal text and can neither open nor close a comment.
// See decisions.md D-010.
// ---------------------------------------------------------------------------

/**
 * Mask every markdown literal region by overwriting its characters with spaces,
 * preserving both length and newlines so indices into the mask are valid indices
 * into `content`. Used ONLY to decide where comment delimiters may legally appear —
 * the original text is what gets sliced.
 *
 * WHAT IS MASKED (three of markdown's four literal-text constructs):
 *  1. FENCED code blocks. A line whose first non-space run is ``` or ~~~ (3+) opens;
 *     a later line whose run uses the same char and is at least as long closes. A
 *     fence with NO closer is ordinary text and masks NOTHING (see below).
 *  2. INLINE code spans. A run of N backticks is closed by the next run of exactly N
 *     backticks ON THE SAME LINE; an unclosed run masks nothing.
 *  3. INDENTED code blocks (4+ leading spaces). Conservatively detected — see below.
 *
 * WHAT IS DELIBERATELY *NOT* MASKED: raw HTML blocks. A `<div>`-wrapped example
 * containing a `<!-- DECISION … -->` is still read as a live comment. That hole is
 * why the CLAUDE.md placeholder-id policy REMAINS LOAD-BEARING — see the D-010/D-012
 * note above. Do not claim otherwise in a comment; claim it in a test.
 *
 * THE FAILURE DIRECTION IS CHOSEN, NOT ACCIDENTAL (Pre-Mortem #2, D-012).
 * Under-masking is loud: a doc example is reported as a real anchor (and, for
 * `bootstrap.mjs retire`, edited). Over-masking is SILENT and strictly worse: a REAL
 * comment's `<!--`/`-->` disappear from the mask, so bootstrap's schema-example
 * comment stops being a comment and parses as a phantom `D-001` entry, the state.md
 * template's example transition starts counting as a real one, and a genuinely stale
 * anchor never gets stamped. So every rule here is written to UNDER-mask when unsure:
 *  - an unterminated fence masks nothing (it used to mask to EOF — that bug made
 *    bootstrap's schema example visible and emitted a false `[decisions-schema]` ERROR);
 *  - an unclosed inline backtick run masks nothing;
 *  - an indented block must START at SOF or after a BLANK line (CommonMark: an indented
 *    block cannot interrupt a paragraph), and is skipped entirely when a list item
 *    governs it (indented text under a list marker is item continuation, NOT code);
 *  - a TAB-indented block is not recognized (leading spaces only) — under-masking.
 */
function maskLiteralRegions(content) {
  const lines = content.split("\n");
  const literal = new Array(lines.length).fill(false); // whole-line literal regions

  const isBlank = (l) => l.trim() === "";
  const leadSpaces = (l) => {
    let n = 0;
    while (n < l.length && l[n] === " ") n += 1;
    return n;
  };
  const fenceMark = (line) => {
    const indent = line.length - line.trimStart().length;
    const m = /^(`{3,}|~{3,})/.exec(line.slice(indent));
    return m ? { char: m[1][0], len: m[1].length } : null;
  };

  // Pass 1 — fenced blocks. The closer is located BEFORE committing to the fence, so
  // an opener that is never closed stays ordinary text instead of swallowing the file.
  for (let i = 0; i < lines.length; i += 1) {
    const open = fenceMark(lines[i]);
    if (!open) continue;
    let close = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const m = fenceMark(lines[j]);
      if (m && m.char === open.char && m.len >= open.len) {
        close = j;
        break;
      }
    }
    if (close < 0) continue; // unterminated fence → masks NOTHING
    for (let j = i; j <= close; j += 1) literal[j] = true;
    i = close;
  }

  // Pass 2 — indented code blocks, conservatively.
  const LIST_MARKER = /^ {0,3}([-*+]|\d{1,9}[.)])(\s|$)/;
  // Walk back from a candidate block start: blanks are transparent (a list may contain
  // them); an open list marker means this indented run is item CONTINUATION, not code;
  // any other indented line is ambiguous, so keep looking back rather than deciding; a
  // flush-left non-list line closes any list and settles it as real code.
  const governedByList = (i) => {
    for (let k = i - 1; k >= 0; k -= 1) {
      const l = lines[k];
      if (isBlank(l)) continue;
      if (LIST_MARKER.test(l)) return true;
      if (leadSpaces(l) >= 1) continue;
      return false;
    }
    return false;
  };

  for (let i = 0; i < lines.length; i += 1) {
    if (literal[i] || isBlank(lines[i]) || leadSpaces(lines[i]) < 4) continue;
    if (i > 0 && !isBlank(lines[i - 1])) continue; // cannot interrupt a paragraph
    if (governedByList(i)) continue;
    // The block runs through indented + blank lines; trailing blanks are NOT part of it.
    let end = i;
    for (let j = i; j < lines.length && !literal[j]; j += 1) {
      if (isBlank(lines[j])) continue;
      if (leadSpaces(lines[j]) < 4) break;
      end = j;
    }
    for (let k = i; k <= end; k += 1) literal[k] = true;
    i = end;
  }

  return lines
    .map((line, i) => (literal[i] ? " ".repeat(line.length) : maskInlineCodeSpans(line)))
    .join("\n");
}

/** Mask inline backtick code spans in one line. Length-preserving. */
function maskInlineCodeSpans(line) {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      out += line[i];
      i += 1;
      continue;
    }
    let openEnd = i;
    while (openEnd < line.length && line[openEnd] === "`") openEnd += 1;
    const runLen = openEnd - i;
    // Seek a closing run of EXACTLY runLen backticks (CommonMark's rule).
    let k = openEnd;
    let closeStart = -1;
    while (k < line.length) {
      if (line[k] !== "`") {
        k += 1;
        continue;
      }
      let runEnd = k;
      while (runEnd < line.length && line[runEnd] === "`") runEnd += 1;
      if (runEnd - k === runLen) {
        closeStart = k;
        break;
      }
      k = runEnd;
    }
    if (closeStart < 0) {
      out += line.slice(i, openEnd); // unclosed run → literal text, mask nothing
      i = openEnd;
      continue;
    }
    const closeEnd = closeStart + runLen;
    out += " ".repeat(closeEnd - i);
    i = closeEnd;
  }
  return out;
}

/**
 * Enumerate every COMPLETE HTML comment region in `content` as `{ start, end }`
 * offsets (`start` at `<`, `end` one past the final `>`, so `content.slice(start, end)`
 * is the whole comment including its markers). This is the one definition of where
 * the comments are; `stripHtmlComments`, `validate-plan.mjs`'s `.md` anchor scanner
 * and `bootstrap.mjs retire`'s anchor stamper all consume it, which is what keeps the
 * validator/retire "sees ⇔ stamps" contract true by construction rather than by two
 * regexes being kept in lockstep by hand.
 *
 * Semantics (deliberate):
 *  - Comment delimiters inside a code span or fenced block are PROSE: they can
 *    neither open nor close a region (D-010).
 *  - HTML comments do NOT nest: the first `-->` closes, so a `<!--` inside a comment
 *    body is ordinary text.
 *  - An UNTERMINATED `<!--` yields NO span — the region is left alone rather than
 *    swallowed to EOF (see the fail-safe note on `stripHtmlComments`). Never throws.
 */
export function htmlCommentSpans(content) {
  if (!content) return [];
  const mask = maskLiteralRegions(content);
  const spans = [];
  let cursor = 0;
  for (;;) {
    const openIdx = mask.indexOf("<!--", cursor);
    if (openIdx < 0) break;
    const closeIdx = mask.indexOf("-->", openIdx + 4);
    if (closeIdx < 0) break; // unterminated → no span (fail safe)
    const end = closeIdx + 3;
    spans.push({ start: openIdx, end });
    cursor = end;
  }
  return spans;
}

// DECISION plan_2026-07-14_79ee0f59/D-009 — CORRECTS a FALSE invariant this anchor used
// to assert under D-003. The old note claimed the unterminated-comment branch below made
// validate-plan.mjs's iteration hard cap fail SAFE: leave a dangling `<!--` untouched, the
// story went, and a stray opener can only ever make the cap OVER-count. That was FALSE in
// the shipped template's own shape. bootstrap.mjs ends EVERY state.md with a guidance
// comment supplying a trailing `-->` (bootstrap.mjs:1383-1386), so a stray opener is never
// unterminated: it PAIRS with that trailer and this helper dutifully blanks every real
// transition record in between. Measured: a stray `<!-- note:` line + 4 real
// `EXECUTE → REFLECT` records → the cap derived 0. The cap failed OPEN, silently.
//
// The fail-safe could not be repaired here, and MUST NOT be re-attempted here. Under HTML
// rules that document genuinely IS one long comment; no purely-local rule distinguishes "a
// `-->` belonging to a different comment" (a blank line does not — the decisions.md
// template comment contains one; a heading does not; marker-balance counting does not —
// left-to-right pairing finds the stray opener perfectly "balanced" against the trailer).
// So the invariant was RELOCATED to the consumer that needs it: the cap now counts on the
// RAW Transition-History block (validate-plan.mjs, `deriveIterationFromHistory`), which is
// structurally incapable of under-counting for any comment shape.
//
// What that means for THIS function: it is a general-purpose, HTML-correct text helper and
// nothing more. It is NOT a safety mechanism, and no caller may treat it as one. Keep the
// unterminated branch (leaving the region untouched is still the least-surprising reading,
// and blanking-to-EOF would wreck the advisory scanners), but do not restore any claim that
// it protects a cap. An invariant asserted in a comment is not an invariant until a test
// constructs the case it forbids — that test now exists. See decisions.md D-009.
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
 * Semantics (deliberate): those of `htmlCommentSpans` above — first `-->` wins,
 * comments do not nest, an unterminated `<!--` is left UNCHANGED rather than
 * blanked-to-EOF (fails SAFE: over-counting iterations is recoverable, under-counting
 * is not), a delimiter inside a code span is prose, and non-comment text is returned
 * byte-identical.
 */
export function stripHtmlComments(content) {
  if (!content) return content;
  const spans = htmlCommentSpans(content);
  if (spans.length === 0) return content;
  let out = "";
  let cursor = 0;
  for (const { start, end } of spans) {
    out += content.slice(cursor, start);
    out += content.slice(start, end).replace(/[^\n]/g, "");
    cursor = end;
  }
  return out + content.slice(cursor);
}

/**
 * Locate an UNBALANCED HTML comment opener: a `<!--` that no `-->` ever closes, using
 * EXACTLY the same left-to-right pairing (and the same code-span masking) that
 * `htmlCommentSpans` uses. Returns its 0-based offset, or -1 when the markers balance.
 *
 * Deliberately built ON TOP of `htmlCommentSpans` rather than re-running the pairing loop:
 * the two must agree by construction. `htmlCommentSpans` consumes the document up to the
 * last `-->` it could pair, so any opener remaining after that is, by definition, the one
 * with no closer.
 *
 * This is the diagnostic half of D-009. It cannot make the iteration cap safe — the cap
 * protects itself by counting raw (see validate-plan.mjs `deriveIterationFromHistory`) —
 * because marker-balance counting is exactly what a stray opener DEFEATS: pairing finds it
 * perfectly "balanced" against bootstrap's template trailer. What it CAN do is EXPLAIN an
 * over-count, and surface a stray opener even when nothing was swallowed. Consumer:
 * validate-plan.mjs's `[state-comment-anomaly]` WARN (advisory — never an ERROR).
 */
export function unterminatedCommentOpener(content) {
  if (!content) return -1;
  const spans = htmlCommentSpans(content);
  const after = spans.length > 0 ? spans[spans.length - 1].end : 0;
  return maskLiteralRegions(content).indexOf("<!--", after);
}

// ---------------------------------------------------------------------------
// Identifier grammars: plan-id and decision-id.
//
// DECISION plan_2026-07-14_79ee0f59/D-005 — these are the ONLY definitions of the
// two id grammars in the codebase. Do NOT re-declare `PLAN_ID_RE` (or an inline
// `plan_\d{4}-...` / `D-\d{3}` pattern) in bootstrap.mjs or validate-plan.mjs:
// they diverged exactly that way once (bootstrap enforced 8 hex, the validator
// accepted any hex tail "for forward compatibility"), which is a one-sided
// migration hazard — the producer and the checker disagreeing about what a legal
// id even is. Do NOT re-loosen the hex tail to `+` for "forward compatibility":
// there is no other producer, and a permissive checker cannot catch a corrupt
// pointer or a hand-typo'd anchor. If the id shape ever really changes, change it
// HERE and both consumers move together. See decisions.md D-005.
// ---------------------------------------------------------------------------

/**
 * Plan-id grammar: `plan_YYYY-MM-DD_XXXXXXXX`, where the tail is exactly 8
 * lowercase-hex chars — precisely what bootstrap.mjs's `randomBytes(4).toString("hex")`
 * emits. Exported as a *string* pattern because the anchor scanners embed it inside
 * larger `new RegExp(...)` compositions; `PLAN_ID_RE` is the anchored form.
 */
export const PLAN_ID_PATTERN = "plan_\\d{4}-\\d{2}-\\d{2}_[0-9a-f]{8}";
export const PLAN_ID_RE = new RegExp(`^${PLAN_ID_PATTERN}$`);

/**
 * Decision-id digit grammar: 3-digit zero-padding is the MINIMUM, not the maximum.
 * `D-001` stays canonical; `D-1` / `D-99` stay invalid (padding is still enforced);
 * `D-1000` and beyond now parse and are stamped by `bootstrap.mjs retire`. Embedded
 * in every decision-id regex (decisions.md headers, the 4 anchor comment styles, the
 * consolidated DECISIONS.md scan, the changelog decision-ref field, retire's stamper).
 *
 * DECISION plan_2026-07-14_79ee0f59/D-005 — the trailing `(?!\d)` is LOAD-BEARING.
 * Do NOT "simplify" this to a bare `\d{3,}`. Once the id length is variable, a greedy
 * digit run can BACKTRACK to a shorter prefix to make the rest of an enclosing regex
 * match. The live casualty is `bootstrap.mjs retire`, whose stamper has no terminator
 * after the id (it must match `D-001:`, `D-001 `, and `D-001` at EOL alike): on an
 * already-stamped `D-1000 [STALE]` it matched just `D-100` — the next char is `0`, not
 * ` [STALE]`, so its idempotency lookahead passed — and re-stamped the file into the
 * corrupt `D-100 [STALE]0 [STALE]`. That is an irreversible source mutation. Pinning the
 * digit run to be MAXIMAL here makes every consumer boundary-safe by construction,
 * instead of each one having to re-derive that its own trailing `\|` / ` ` / `\b` / `$`
 * happens to forbid a digit. Zero-width, so capture groups still yield just the digits.
 * See decisions.md D-005.
 */
export const DECISION_ID_NUM_PATTERN = "\\d{3,}(?!\\d)";
