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
 * Field ORDER (0-based after split):
 *   0: timestamp  1: step  2: commit  3: path
 *   4: op         5: radius  6: decision-ref  7: reason
 *
 * What each field is ALLOWED to contain is defined once, in schema.mjs's
 * CHANGELOG_SPEC, and is deliberately not repeated here. This comment used to
 * spell out the op field as `OP(+N,-M) | NEW | REVERT(file)`; `NEW` has never
 * been an accepted op, so anyone who followed it wrote a line the validator
 * warns about on every file they create. Read the spec, not a copy of it.
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
// plan.md `## Complexity Budget` counted-cap grammar — ONE declaration.
//
// DECISION plan-2026-09-09T082122-64c4de78/D-018 — every reader of a budget cap
// line MUST import this regex; do NOT declare a second, stricter one at a call
// site. scar-scan.mjs did exactly that (it required the bold close adjacent to
// `max`), so a plan.md line the validator accepted parsed to `filesAddedMax:
// null` in the scanner, `reconcileComplexityBudget` returned nothing, and
// category E reported a clean `ran` over a plan whose own line said OVER BUDGET
// — the tool's worst output, a false all-clear, on its own plan. See D-018.
//
// Group 1 = label, 2 = used (N), 3 = cap (M) from `<label>...: N/M max`.
// Tolerances, all observed in real plan.md files: a list bullet, bold wrappers,
// a parenthetical inside the label, whitespace around the slash, and any
// trailing text after `max`. Non-global on purpose (no `lastIndex` state), so a
// single shared instance is safe to `exec` from any number of call sites.
// The "Lines added vs removed: +900/-150" line is deliberately NOT counted: it
// is a target, not a cap, and its N/M are signed deltas rather than a ratio.
// ---------------------------------------------------------------------------

export const COUNTED_BUDGET_RE = /^\s*(?:[-*+]\s*)?\**\s*(Files added|New abstractions)\b[^:\n]*:\s*\**\s*(\d+)\s*\/\s*(\d+)\s*max/i;

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
// DECISION plan_2026-07-14_79ee0f59/D-010 — every markdown scanner MUST locate comments
// through `htmlCommentSpans()` below; do NOT write another `/<!--[\s\S]*?-->/` regex at a
// call site (a bare regex is blind to a backticked `` `<!--` `` in prose, which opens a
// phantom span and silently swallows real content — reproduced 3 times). The mask must stay
// LINE-COUNT PRESERVING (blank, don't delete — callers report line numbers from it) and
// CODE-SPAN AWARE (a delimiter inside a backtick run or fenced block is literal text).
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

// DECISION plan_2026-07-14_79ee0f59/D-009 — this helper is NOT a safety mechanism and no
// caller may treat it as one: a stray `<!--` can pair with a later real `-->` (e.g.
// bootstrap's state.md trailer) and blank genuine content in between, so relying on it to
// fail SAFE was false and cost the iteration hard cap an under-count. That cap now counts
// on the RAW Transition-History block instead (validate-plan.mjs `deriveIterationFromHistory`).
// Keep the unterminated-comment branch leaving the region untouched, but do not re-add any
// claim that it protects a cap.
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
// C-family block comment regions — the `/* */` TWIN of htmlCommentSpans above.
// The single definition of "where the block comments are" for every non-markdown
// scanner in this repo.
//
// DECISION plan-2026-09-01T100120-4f591469/D-007 — `blockCommentSpans` returns BYTE
// OFFSETS into the ORIGINAL `content` (like `htmlCommentSpans`), never line indices, and
// must never be paired with output from `stripHtmlComments` (which deletes bytes, not
// line-count-preserving-only). Slice RAW content with these offsets.
//
// Do NOT go back to a bare `/\/\*([\s\S]*?)\*\//g` over raw text: it double-reports on a
// phantom opener (e.g. `"plans/*"`) and, worse, silently drops anchors below a phantom
// closer (`*/` written as prose inside a real comment) — invisible to both the validator
// and `bootstrap.mjs retire`. Under-mask when unsure: an unterminated `/*` yields no span.
//
// DECISION plan-2026-09-01T100120-4f591469/D-025 [SUPERSEDED by D-032] — a regex-literal
// lexer was tried here to stop `/[*/]/` from ending a span early. It fixed that but ate
// JSX comment openers (`{/* ... */}`) instead, the third defect from this component — the
// 3-strike rule fired and the lexer was DELETED, not patched a 4th time. Do not reintroduce
// it in any form; the `/[*/]/` over-report is the chosen, pinned behaviour.
//
// Known, deliberate, disclosed holes (all fail LOUD, never silent): `#`-line comments
// aren't scanned here (harmless in C-family; hash-family files are excluded by
// BLOCK_COMMENT_EXTS below instead). Regex literals aren't lexed, so `/* */` bytes inside
// one over-masks (double-reports) rather than losing anything. Template literals aren't
// skipped either (D-033) — same over-report trade, chosen over the silent multi-file
// masking an unbalanced backtick skip caused previously.
// ---------------------------------------------------------------------------

// DECISION plan-2026-09-01T100120-4f591469/D-032 — the block-comment scan is gated by
// this ALLOWLIST only. Do NOT restore the old complement gate or rewrite as a denylist:
// running the C-style block scan on hash/SQL-family extensions (13 of them have no `/* */`
// at all) let two shell globs open a phantom span across a real anchor and desync the
// validator from `retire`. An allowlist fails safe for an unclassified extension (no scan,
// loud partition-test failure) where a denylist would give it phantom spans everywhere.
// Disclosed hole: `.tf`/`.sql` do have real `/* */` comments and are deliberately absent —
// anchors inside them go unscanned. Both consumers (`findAnchorsInFile`, `cmdRetire`)
// import this one set.
export const BLOCK_COMMENT_EXTS = new Set([
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".go", ".rs",
  ".c", ".h", ".cpp", ".hpp", ".cc", ".java", ".kt", ".swift", ".scala", ".cs", ".php",
]);

// DECISION plan-2026-09-01T100120-4f591469/D-033 — the BACKTICK is deliberately ABSENT
// from this set; do not add it back. Skipping template literals previously let an odd
// backtick count inside a regex literal run to the next backtick anywhere in the file and
// silently swallow real comment spans — the one failure direction this scanner must not
// take. The accepted cost is a visible over-report instead (a `/* */` inside a template
// literal now opens a phantom span).
const BLOCK_STRING_DELIMS = new Set(['"', "'"]);

// Skip a quoted string starting at `i`. Returns the offset one past its closing quote,
// or -1 when the quote never closes — in which case the caller must treat the quote as
// ORDINARY TEXT (under-masking, the loud direction). Neither delimiter may span a
// newline, which BOUNDS a mis-read to one line. Backslash escapes the next character.
function skipStringLiteral(content, i) {
  const quote = content[i];
  let j = i + 1;
  while (j < content.length) {
    const c = content[j];
    if (c === "\\") { j += 2; continue; }
    if (c === quote) return j + 1;
    if (c === "\n") return -1;
    j += 1;
  }
  return -1;
}

// From `from`, scan CODE context (strings and `//` line comments skipped) for a STRAY
// block-comment closer — one with no opener, which is a syntax error in every C-family
// language and is therefore evidence that an EARLIER closer was prose inside a comment
// rather than its terminator. Returns that offset, or -1 if a `/*` or EOF comes first.
function nextStrayBlockCloser(content, from) {
  let i = from;
  while (i < content.length) {
    const c = content[i];
    if (c === "\\") { i += 2; continue; } // escaped: `\*/` inside a regex literal is not a closer
    if (c === "/" && content[i + 1] === "*") return -1;
    if (c === "*" && content[i + 1] === "/") return i;
    if (c === "/" && content[i + 1] === "/") {
      const nl = content.indexOf("\n", i + 2);
      if (nl < 0) return -1;
      i = nl + 1;
      continue;
    }
    if (BLOCK_STRING_DELIMS.has(c)) {
      const e = skipStringLiteral(content, i);
      if (e > 0) { i = e; continue; }
    }
    i += 1;
  }
  return -1;
}

// Enumerate every COMPLETE block-comment region in `content` as `{ start, end }` BYTE
// offsets (both markers included), skipping openers that occur inside a string literal or
// a `//` line comment, and recovering from a prose closer inside a comment body.
//
// Semantics (deliberate):
//  - Block comments do NOT nest; the terminator is the first closer that the stray-closer
//    recovery below does not show to be prose.
//  - An UNTERMINATED `/*` yields NO span — the region is left alone rather than swallowed
//    to EOF, matching `htmlCommentSpans`. Never throws.
//  - `validate-plan.mjs`'s `findAnchorsInFile` and `bootstrap.mjs retire`'s stamper BOTH
//    consume this, which is what keeps the "the validator sees exactly what retire stamps"
//    contract true by construction instead of by two regexes kept in lockstep by hand.
export function blockCommentSpans(content) {
  if (!content) return [];
  const spans = [];
  let i = 0;
  while (i < content.length) {
    const c = content[i];
    if (c === "\\") { i += 2; continue; } // escaped: a `\/\*` in a regex literal opens nothing
    if (c === "/" && content[i + 1] === "*") {
      const start = i;
      let close = content.indexOf("*/", i + 2);
      if (close < 0) { i += 2; continue; } // unterminated → no span (fail safe)
      for (;;) {
        const stray = nextStrayBlockCloser(content, close + 2);
        if (stray < 0) break;
        close = stray;
      }
      spans.push({ start, end: close + 2 });
      i = close + 2;
      continue;
    }
    if (c === "/" && content[i + 1] === "/") {
      const nl = content.indexOf("\n", i + 2);
      if (nl < 0) break;
      i = nl + 1;
      continue;
    }
    if (BLOCK_STRING_DELIMS.has(c)) {
      const e = skipStringLiteral(content, i);
      if (e > 0) { i = e; continue; }
    }
    i += 1;
  }
  return spans;
}

// ---------------------------------------------------------------------------
// Identifier grammars: plan-id and decision-id.
//
// DECISION plan_2026-07-14_79ee0f59/D-005 — the ONLY definitions of the two id grammars
// in the codebase; do not re-declare a `PLAN_ID_RE` elsewhere (they diverged once when
// duplicated) or loosen the hex tail "for forward compatibility" (a permissive checker
// can't catch a typo'd anchor). Change it HERE only, both consumers move together.
//
// `PLAN_ID_PATTERN` (new format) is for GENERATION only; `ANY_PLAN_ID_PATTERN` (new |
// legacy union) is for every read/validate path — do not delete the legacy half once
// new-format dirs exist, or old committed anchors silently stop matching anything. Do
// NOT make `ANY_PLAN_ID_PATTERN` capturing: it's interpolated into anchor regexes whose
// `pushMatch` reads fixed group indices by position.
// ---------------------------------------------------------------------------

/**
 * Plan-id WRITE grammar: `plan-YYYY-MM-DDTHHMMSS-XXXXXXXX` (UTC, colon-free — colons
 * are illegal on Win32/NTFS, see D-001), where the tail is exactly 8 lowercase-hex
 * chars — precisely what bootstrap.mjs's `randomBytes(4).toString("hex")` emits.
 * Exported as a *string* pattern because scanners embed it inside larger
 * `new RegExp(...)` compositions; `PLAN_ID_RE` is the anchored form.
 *
 * This is what bootstrap GENERATES. To *recognize* an id, use ANY_PLAN_ID_PATTERN.
 */
export const PLAN_ID_PATTERN = "plan-\\d{4}-\\d{2}-\\d{2}T\\d{6}-[0-9a-f]{8}";
export const PLAN_ID_RE = new RegExp(`^${PLAN_ID_PATTERN}$`);

/**
 * Plan-id LEGACY grammar: `plan_YYYY-MM-DD_XXXXXXXX` — every plan dir created before
 * v2.36.0, and every `# DECISION <plan-id>/D-NNN` anchor committed under one. Never
 * generated again; permanently readable.
 */
export const LEGACY_PLAN_ID_PATTERN = "plan_\\d{4}-\\d{2}-\\d{2}_[0-9a-f]{8}";
export const LEGACY_PLAN_ID_RE = new RegExp(`^${LEGACY_PLAN_ID_PATTERN}$`);

/**
 * Plan-id READ union — the grammar every validating/scanning path uses.
 * NON-CAPTURING by construction: it is interpolated into regexes whose consumers read
 * capture groups by index. Adding a capture group here is a silent, repo-wide corruption
 * (see the D-005 block above and the group-index test in shared.test.mjs).
 */
export const ANY_PLAN_ID_PATTERN = `(?:${PLAN_ID_PATTERN}|${LEGACY_PLAN_ID_PATTERN})`;
export const ANY_PLAN_ID_RE = new RegExp(`^${ANY_PLAN_ID_PATTERN}$`);

/**
 * Cheap prefix filter for plan directory names (both grammars). Use to skip obvious
 * non-plan dirs before the full `ANY_PLAN_ID_RE` test — never as a validator on its own
 * (it accepts `plan-../x`, which is exactly the traversal `ANY_PLAN_ID_RE` rejects).
 */
export const PLAN_DIR_PREFIX_RE = /^plan[-_]/;

/**
 * `## <plan-id>` section header in a consolidated file (plans/FINDINGS.md,
 * plans/DECISIONS.md, …), both grammars. Line-anchored, so it also matches a section at
 * byte 0 — build it with the `m` flag, and with `g` when enumerating every position.
 *
 * Exported as a STRING, not a RegExp, and deliberately so: a shared module-level `g`
 * regex is stateful (`lastIndex`), and `matchAll` does NOT rescue it — it clones the
 * regex *including* `lastIndex`. Two stray `.test()` calls anywhere would then make
 * `matchAll` return `[]`, and the consolidated sliding-window trim would silently stop
 * trimming forever. A string cannot carry state: every call site does
 * `new RegExp(PLAN_SECTION_PATTERN, "gm")` and owns its own instance.
 */
export const PLAN_SECTION_PATTERN = "^## plan[-_]";

/**
 * Extract `YYYY-MM-DD` from a plan-id of either grammar. Returns null when the input is
 * not a plan-id (callers substitute their own placeholder — e.g. bootstrap's INDEX.md
 * date column falls back to "unknown").
 */
export function planDateFromId(id) {
  if (!id) return null;
  const m = /^plan[-_](\d{4}-\d{2}-\d{2})[T_]/.exec(id);
  return m ? m[1] : null;
}

/**
 * Decision-id digit grammar: 3-digit zero-padding is the MINIMUM, not the maximum.
 * `D-001` stays canonical; `D-1` / `D-99` stay invalid (padding is still enforced);
 * `D-1000` and beyond now parse and are stamped by `bootstrap.mjs retire`. Embedded
 * in every decision-id regex (decisions.md headers, the 4 anchor comment styles, the
 * consolidated DECISIONS.md scan, the changelog decision-ref field, retire's stamper).
 *
 * DECISION plan_2026-07-14_79ee0f59/D-005 — the trailing `(?!\d)` is LOAD-BEARING; do not
 * simplify to a bare `\d{3,}`. Without it a greedy digit run can backtrack to a shorter
 * prefix (observed: `bootstrap.mjs retire` re-stamped an already-stamped `D-1000 [STALE]`
 * into the corrupt `D-100 [STALE]0 [STALE]`, an irreversible source mutation). Zero-width,
 * so capture groups still yield just the digits.
 * See decisions.md D-005.
 */
export const DECISION_ID_NUM_PATTERN = "\\d{3,}(?!\\d)";
