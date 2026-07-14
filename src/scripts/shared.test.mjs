#!/usr/bin/env node
// Tests for shared.mjs — the single-source-of-truth helpers imported by
// bootstrap.mjs and validate-plan.mjs.
// Run: node --test src/scripts/shared.test.mjs
// Requires: Node.js 18+
//
// shared.mjs is side-effect-free (pure exports, no CLI entry guard needed),
// so the symbols are imported and exercised directly — no fixtures, no spawn.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { resolve } from "path";

const SHARED = resolve(import.meta.dirname, "shared.mjs");

import {
  extractField,
  splitChangelogFields,
  blankCompressedSummaryBlock,
  stripHtmlComments,
  htmlCommentSpans,
  unterminatedCommentOpener,
  COMPRESSED_SUMMARY_OPEN,
  COMPRESSED_SUMMARY_CLOSE,
  CHANGELOG_COMPRESSED_INLINE_RE,
  PLAN_ID_PATTERN,
  PLAN_ID_RE,
  LEGACY_PLAN_ID_PATTERN,
  LEGACY_PLAN_ID_RE,
  ANY_PLAN_ID_PATTERN,
  ANY_PLAN_ID_RE,
  PLAN_DIR_PREFIX_RE,
  PLAN_SECTION_PATTERN,
  planDateFromId,
  DECISION_ID_NUM_PATTERN,
} from "./shared.mjs";

// ---------------------------------------------------------------------------
// extractField
// ---------------------------------------------------------------------------

test("extractField: returns the trimmed first capture group", () => {
  assert.equal(extractField("Step: 5", /Step: (\d+)/), "5");
  assert.equal(extractField("Name: Foo", /Name: (.+)/), "Foo");
});

test("extractField: trims surrounding whitespace from the capture", () => {
  assert.equal(extractField("X:   spaced   ", /X:(.+)/), "spaced");
  // greedy (.+) stops at newline by default; trailing spaces trimmed
  assert.equal(extractField("Name:  Foo  \nrest", /Name:\s*(.+)/), "Foo");
});

test("extractField: returns null when the pattern does not match", () => {
  assert.equal(extractField("hello world", /Step: (\d+)/), null);
});

test("extractField: returns null for falsy content (empty/null/undefined)", () => {
  assert.equal(extractField("", /x/), null);
  assert.equal(extractField(null, /x/), null);
  assert.equal(extractField(undefined, /x/), null);
});

test("extractField: honors a multiline-flagged pattern", () => {
  const content = "preamble\nKey: val\ntrailer";
  assert.equal(extractField(content, /^Key: (.+)$/m), "val");
});

test("extractField: with no capture group returns the whole match position throws-free as null-safe", () => {
  // A pattern with no group: match[1] is undefined -> .trim() would throw, so
  // callers must always supply a group. Document the supported contract: a
  // single capture group. This asserts the supported path stays stable.
  assert.equal(extractField("v1.2.3", /v(\d+\.\d+\.\d+)/), "1.2.3");
});

// ---------------------------------------------------------------------------
// splitChangelogFields
// ---------------------------------------------------------------------------

test("splitChangelogFields: a well-formed 8-field line splits into 8 trimmed fields", () => {
  const line =
    "2026-06-27T08:37:20Z | iter-1/step-1 | 003d20a | src/scripts/blast-radius.mjs | EDIT(+1,-1) | radius:LOW(0) | - | removed dead imports";
  const f = splitChangelogFields(line);
  assert.equal(f.length, 8);
  assert.equal(f[0], "2026-06-27T08:37:20Z");
  assert.equal(f[1], "iter-1/step-1");
  assert.equal(f[2], "003d20a");
  assert.equal(f[3], "src/scripts/blast-radius.mjs");
  assert.equal(f[4], "EDIT(+1,-1)");
  assert.equal(f[5], "radius:LOW(0)");
  assert.equal(f[6], "-");
  assert.equal(f[7], "removed dead imports");
});

test("splitChangelogFields: the 8th field (reason) absorbs extra ' | ' sequences", () => {
  const line = "a | b | c | d | e | f | g | reason has | a pipe | and more";
  const f = splitChangelogFields(line);
  assert.equal(f.length, 8);
  assert.equal(f[6], "g");
  assert.equal(f[7], "reason has | a pipe | and more");
});

test("splitChangelogFields: fewer than 7 separators returns the raw split (real field count) for the caller to reject", () => {
  const f = splitChangelogFields("a | b | c");
  assert.deepEqual(f, ["a", "b", "c"]);
  assert.equal(f.length, 3); // < 8 -> malformed, caller sees true count
});

test("splitChangelogFields: trims every field", () => {
  const line = "  a  |  b  |  c  |  d  |  e  |  f  |  g  |  h  ";
  const f = splitChangelogFields(line);
  assert.deepEqual(f, ["a", "b", "c", "d", "e", "f", "g", "h"]);
});

test("splitChangelogFields: an empty line yields a single empty field (rejected by caller)", () => {
  const f = splitChangelogFields("");
  assert.deepEqual(f, [""]);
});

test("splitChangelogFields: exactly 7 separators with an empty reason still yields 8 fields", () => {
  const line = "a | b | c | d | e | f | g | ";
  const f = splitChangelogFields(line);
  assert.equal(f.length, 8);
  assert.equal(f[7], ""); // trimmed empty remainder
});

// ---------------------------------------------------------------------------
// Compression markers + recognizer regex
// ---------------------------------------------------------------------------

test("COMPRESSED_SUMMARY_OPEN / CLOSE are the expected HTML-comment markers", () => {
  assert.equal(COMPRESSED_SUMMARY_OPEN, "<!-- COMPRESSED-SUMMARY -->");
  assert.equal(COMPRESSED_SUMMARY_CLOSE, "<!-- /COMPRESSED-SUMMARY -->");
  // close marker is the open marker with a leading slash on the tag name
  assert.ok(COMPRESSED_SUMMARY_CLOSE.includes("/COMPRESSED-SUMMARY"));
});

test("CHANGELOG_COMPRESSED_INLINE_RE matches a compressed-inline summary line", () => {
  assert.ok(
    CHANGELOG_COMPRESSED_INLINE_RE.test(
      "- (compressed: 5 low-decision-impact edits folded)",
    ),
  );
  assert.ok(
    CHANGELOG_COMPRESSED_INLINE_RE.test(
      "- (compressed: 12 low-decision-impact edits; see history)",
    ),
  );
});

test("CHANGELOG_COMPRESSED_INLINE_RE does NOT match a normal changelog entry line", () => {
  assert.ok(
    !CHANGELOG_COMPRESSED_INLINE_RE.test(
      "2026-06-27T08:37:20Z | iter-1/step-1 | 003d20a | path | EDIT(+1,-1) | radius:LOW(0) | - | reason",
    ),
  );
});

test("CHANGELOG_COMPRESSED_INLINE_RE requires a digit count and a line-start anchor", () => {
  // no digit
  assert.ok(
    !CHANGELOG_COMPRESSED_INLINE_RE.test(
      "- (compressed: low-decision-impact edits)",
    ),
  );
  // not anchored at start of line (leading whitespace)
  assert.ok(
    !CHANGELOG_COMPRESSED_INLINE_RE.test(
      "  - (compressed: 5 low-decision-impact edits)",
    ),
  );
});

// ---------------------------------------------------------------------------
// blankCompressedSummaryBlock
// ---------------------------------------------------------------------------

test("blankCompressedSummaryBlock: removes a complete block's content while preserving line count", () => {
  const content = [
    "line1",
    COMPRESSED_SUMMARY_OPEN,
    "## Summary (compressed)",
    "### Decision lookup",
    "some body",
    COMPRESSED_SUMMARY_CLOSE,
    "line2",
  ].join("\n");

  const out = blankCompressedSummaryBlock(content);

  // line count is identical (so downstream line numbers stay accurate)
  assert.equal(out.split("\n").length, content.split("\n").length);
  // surrounding content is untouched
  assert.ok(out.startsWith("line1\n"));
  assert.ok(out.endsWith("\nline2"));
  // markers and body text are blanked out
  assert.ok(!out.includes(COMPRESSED_SUMMARY_OPEN));
  assert.ok(!out.includes(COMPRESSED_SUMMARY_CLOSE));
  assert.ok(!out.includes("Summary (compressed)"));
  assert.ok(!out.includes("Decision lookup"));
});

test("blankCompressedSummaryBlock: no markers present -> content returned unchanged", () => {
  const content = "just\nplain\nmarkdown\nno block";
  assert.equal(blankCompressedSummaryBlock(content), content);
});

test("blankCompressedSummaryBlock: open marker without a close marker -> unchanged (incomplete block)", () => {
  const content = `before\n${COMPRESSED_SUMMARY_OPEN}\ndangling body\nno close`;
  assert.equal(blankCompressedSummaryBlock(content), content);
});

test("blankCompressedSummaryBlock: falsy content is returned as-is", () => {
  assert.equal(blankCompressedSummaryBlock(""), "");
  assert.equal(blankCompressedSummaryBlock(null), null);
  assert.equal(blankCompressedSummaryBlock(undefined), undefined);
});

test("blankCompressedSummaryBlock: a single-line block (markers and body on one line) collapses to blanks", () => {
  const content = `pre ${COMPRESSED_SUMMARY_OPEN}body${COMPRESSED_SUMMARY_CLOSE} post`;
  const out = blankCompressedSummaryBlock(content);
  // single line in, single line out
  assert.equal(out.split("\n").length, 1);
  assert.ok(!out.includes(COMPRESSED_SUMMARY_OPEN));
  assert.ok(!out.includes(COMPRESSED_SUMMARY_CLOSE));
  assert.ok(!out.includes("body"));
  // surrounding non-block text preserved
  assert.ok(out.startsWith("pre "));
  assert.ok(out.endsWith(" post"));
});

// ---------------------------------------------------------------------------
// stripHtmlComments (defect #8 / D-003)
// ---------------------------------------------------------------------------

test("stripHtmlComments: blanks a multi-line comment interior and preserves line count exactly", () => {
  const content = [
    "- INIT → EXPLORE (task started)",
    "- EXPLORE → PLAN (real, 2026-07-14)",
    "  - confidence: scope=deep, solutions=open, risks=clear",
    "<!-- When logging EXPLORE → PLAN, add Exploration Confidence below, e.g.:",
    "- EXPLORE → PLAN (gathered enough context, YYYY-MM-DDTHH:MM:SSZ)",
    "  - confidence: scope=deep|partial|shallow",
    "See references/planning-rigor.md for definitions. -->",
  ].join("\n");
  const out = stripHtmlComments(content);
  const inLines = content.split("\n");
  const outLines = out.split("\n");
  assert.equal(outLines.length, inLines.length, "line count must be preserved");
  // Real transition lines survive byte-identically.
  assert.equal(outLines[0], inLines[0]);
  assert.equal(outLines[1], inLines[1]);
  assert.equal(outLines[2], inLines[2]);
  // Every line of the comment region is blanked to the empty string.
  assert.deepEqual(outLines.slice(3), ["", "", "", ""]);
  // The template's example transition is gone from the scanned text.
  assert.equal(out.match(/EXPLORE → PLAN/g).length, 1);
  assert.ok(!out.includes("<!--") && !out.includes("-->"));
});

test("stripHtmlComments: handles multiple comments in one document", () => {
  const content = "a<!--x-->b<!--y-->c";
  assert.equal(stripHtmlComments(content), "abc");
});

test("stripHtmlComments: leaves non-comment text byte-identical", () => {
  const content = "# Current State: EXECUTE\n## Iteration: 1\n- EXECUTE → REFLECT (1)\n";
  assert.equal(stripHtmlComments(content), content);
});

test("stripHtmlComments: an unterminated <!-- leaves the remainder UNCHANGED (fail-safe, never throws)", () => {
  // Blanking to EOF here would swallow the real EXECUTE → REFLECT record below and
  // silently disable the iteration hard cap. Over-count, never under-count.
  const content = "- EXECUTE → REFLECT (1)\n<!-- dangling opener\n- EXECUTE → REFLECT (2)\n";
  assert.equal(stripHtmlComments(content), content);
  assert.equal(content.match(/EXECUTE → REFLECT/g).length, 2);
});

test("stripHtmlComments: a complete comment before an unterminated one is still blanked", () => {
  const content = "a\n<!-- gone -->\nb\n<!-- dangling\nc";
  const out = stripHtmlComments(content);
  assert.equal(out.split("\n").length, content.split("\n").length);
  assert.equal(out, "a\n\nb\n<!-- dangling\nc");
});

test("stripHtmlComments: comments do not nest — the first --> closes the comment", () => {
  // `<!--` inside a comment body is ordinary text (HTML has no nesting); the trailing
  // `tail` is therefore OUTSIDE the comment and must survive.
  const content = "pre <!-- outer <!-- inner --> tail";
  assert.equal(stripHtmlComments(content), "pre  tail");
});

test("stripHtmlComments: falsy content is returned as-is", () => {
  assert.equal(stripHtmlComments(""), "");
  assert.equal(stripHtmlComments(null), null);
  assert.equal(stripHtmlComments(undefined), undefined);
});

// ---------------------------------------------------------------------------
// Code-span awareness (iter-2 CRITICAL 3 / D-010).
//
// A comment delimiter written INSIDE a markdown code span or fenced block is
// PROSE — it can neither open nor close a comment. Without this, an artifact that
// merely *writes about* comment handling supplies a phantom opener that pairs with
// the next `-->` anywhere downstream and swallows every line between, making that
// content invisible to validation (fail-open). This is the reproduced CRITICAL 3.
// ---------------------------------------------------------------------------

test("stripHtmlComments: a backticked <!-- is PROSE and opens nothing (the CRITICAL 3 shape)", () => {
  // The exact shape from this repo's own decisions.md: an entry discussing a
  // backticked opener, a later entry containing a backticked closer. The old regex
  // spanned between them and DELETED the lines in the middle.
  const content = [
    "**Decision**: the scrubber must ignore a backticked `<!--` token.",
    "**Complexity Assessment**: no new files.",
    "**Reasoning**: the closer `-->` is prose too.",
  ].join("\n");
  assert.equal(stripHtmlComments(content), content, "no span exists, so nothing may be blanked");
});

test("stripHtmlComments: a real comment ADJACENT to a code span is still blanked", () => {
  // Over-masking guard (Pre-Mortem #2): masking code spans must not make real
  // comments invisible — if it did, bootstrap's schema example would parse as a
  // phantom D-001 entry.
  const content = "text `<!--` more\n<!-- a real comment -->\ntail `-->` end";
  const out = stripHtmlComments(content);
  assert.equal(out, "text `<!--` more\n\ntail `-->` end");
  assert.equal(out.split("\n").length, content.split("\n").length);
});

test("stripHtmlComments: backtick runs of length 1, 2 and 3 all mask their delimiters", () => {
  // A run of N backticks is closed by a run of exactly N (CommonMark), which is how
  // one writes a literal backtick inside a code span.
  for (const n of [1, 2, 3]) {
    const tick = "`".repeat(n);
    const content = `pre ${tick}<!--${tick} post`;
    assert.equal(stripHtmlComments(content), content, `run length ${n} must mask`);
  }
});

test("stripHtmlComments: an UNBALANCED backtick masks nothing (a stray tick must not blind the scanner)", () => {
  // Deliberately conservative: an unclosed run is ordinary text. If it masked to
  // end-of-line, one stray backtick could hide a real comment opener.
  const content = "a stray ` tick\n<!-- real -->\ntail";
  assert.equal(stripHtmlComments(content), "a stray ` tick\n\ntail");
});

test("stripHtmlComments: a delimiter inside a fenced code block is prose (``` and ~~~)", () => {
  for (const f of ["```", "~~~"]) {
    const content = `intro\n${f}\n<!-- this is a code sample, not a comment -->\n${f}\noutro`;
    assert.equal(stripHtmlComments(content), content, `fence ${f} must mask its body`);
  }
});

test("stripHtmlComments: a fenced block cannot swallow a REAL comment that follows it", () => {
  const content = "```js\nconst re = /<!--/;\n```\n<!-- real -->\nend";
  const out = stripHtmlComments(content);
  assert.equal(out, "```js\nconst re = /<!--/;\n```\n\nend");
  assert.equal(out.split("\n").length, content.split("\n").length);
});

test("stripHtmlComments: an info-string fence closes on a bare fence of >= the opening length", () => {
  const content = "````text\n<!-- inside -->\n````\n<!-- outside -->\n";
  const out = stripHtmlComments(content);
  assert.match(out, /<!-- inside -->/, "fenced body is literal and must survive");
  assert.doesNotMatch(out, /outside/, "the comment after the fence is real and must be blanked");
});

test("stripHtmlComments: line count is preserved for every fixture (line numbers stay true)", () => {
  const fixtures = [
    "a\n<!-- x -->\nb",
    "a\n<!--\nmulti\nline\n-->\nb",
    "`<!--`\nreal\n`-->`",
    "```\n<!-- fenced -->\n```",
    "<!-- unterminated\nrest",
    "no comments at all",
  ];
  for (const f of fixtures) {
    assert.equal(
      stripHtmlComments(f).split("\n").length,
      f.split("\n").length,
      `line count must survive: ${JSON.stringify(f)}`
    );
  }
});

// ---------------------------------------------------------------------------
// htmlCommentSpans — the single definition of "where the comments are" (D-010).
// ---------------------------------------------------------------------------

test("htmlCommentSpans: returns offsets that slice the comment back out of the ORIGINAL text", () => {
  const content = "pre <!-- one --> mid <!-- two --> post";
  const spans = htmlCommentSpans(content);
  assert.equal(spans.length, 2);
  assert.equal(content.slice(spans[0].start, spans[0].end), "<!-- one -->");
  assert.equal(content.slice(spans[1].start, spans[1].end), "<!-- two -->");
});

test("htmlCommentSpans: a phantom (backticked) opener yields NO span", () => {
  assert.deepEqual(htmlCommentSpans("an entry about `<!--` and later `-->`"), []);
});

test("htmlCommentSpans: an unterminated opener yields NO span (fail-safe, never throws)", () => {
  assert.deepEqual(htmlCommentSpans("<!-- dangling\nmore text"), []);
});

test("htmlCommentSpans: falsy content yields an empty list", () => {
  assert.deepEqual(htmlCommentSpans(""), []);
  assert.deepEqual(htmlCommentSpans(null), []);
});

test("htmlCommentSpans: stripHtmlComments blanks exactly the spans it reports (one definition)", () => {
  // The anchor scanner (validate-plan.mjs) and the anchor stamper (bootstrap.mjs
  // retire) are bound by a "sees ⇔ stamps" contract. Both consume THIS function, so
  // the contract holds by construction rather than by two regexes kept in lockstep.
  const content = "a\n<!-- one -->\n`<!--`\n<!-- two -->\nz";
  const spans = htmlCommentSpans(content);
  const stripped = stripHtmlComments(content);
  assert.equal(spans.length, 2, "the phantom backticked opener must not produce a third span");
  // Blanking keeps LINE count, not byte offsets (non-newline chars are removed — the
  // same idiom as blankCompressedSummaryBlock), so compare content, not offsets.
  for (const { start, end } of spans) {
    const body = content.slice(start, end).replace(/\n/g, "");
    assert.ok(body.length > 0);
    assert.ok(!stripped.includes(body), `span ${JSON.stringify(body)} must be gone from the output`);
  }
  assert.equal(stripped, "a\n\n`<!--`\n\nz");
  assert.equal(stripped.split("\n").length, content.split("\n").length);
});

// ---------------------------------------------------------------------------
// Plan-id grammars (defect #4 — the grammar bootstrap.mjs and validate-plan.mjs each
// used to define separately, with DIFFERENT hex tails).
//
// v2.36.0 (D-003): the ONE grammar became one WRITE grammar + one READ union.
//   PLAN_ID_*        → new format `plan-YYYY-MM-DDTHHMMSS-XXXXXXXX` (what bootstrap MINTS)
//   LEGACY_PLAN_ID_* → old format `plan_YYYY-MM-DD_XXXXXXXX` (never minted again)
//   ANY_PLAN_ID_*    → the union every reader/scanner/validator uses
// ---------------------------------------------------------------------------

const NEW_ID = "plan-2026-07-14T051317-317362c4";
const LEGACY_ID = "plan_2026-07-14_79ee0f59";

test("PLAN_ID_RE: accepts the canonical NEW shape bootstrap actually generates", () => {
  // UTC `YYYY-MM-DDTHHMMSS` (colon-free — D-001) + randomBytes(4).toString("hex").
  assert.ok(PLAN_ID_RE.test(NEW_ID));
  assert.ok(PLAN_ID_RE.test("plan-1999-01-01T000000-deadbeef"));
  assert.ok(PLAN_ID_RE.test("plan-2099-12-31T235959-00000000"));
});

test("PLAN_ID_RE: rejects malformed NEW plan-ids", () => {
  const bad = [
    "plan-2026-07-14T051317-317362c",   // 7 hex — too short
    "plan-2026-07-14T051317-317362c44", // 9 hex — too long
    "plan-2026-07-14T051317-ZZZZZZZZ",  // not hex
    "plan-2026-07-14T051317-317362C4",  // uppercase hex
    "plan-2026-7-14T051317-317362c4",   // unpadded date
    "plan-2026-07-14T05131-317362c4",   // 5-digit time
    "plan-2026-07-14T0513177-317362c4", // 7-digit time
    "plan-2026-07-14T05:13:17-317362c4", // colons (illegal on Win32 — D-001)
    "plan-2026-07-14-317362c4",         // the COMMIT tag, not a dir name (no T HHMMSS)
    "plan-2026-07-14T051317",           // no tail
    "notaplan-2026-07-14T051317-317362c4", // wrong prefix
    "../etc/passwd",                    // path traversal (the .current_plan guard)
    "",
  ];
  for (const s of bad) assert.ok(!PLAN_ID_RE.test(s), `${JSON.stringify(s)} must be rejected`);
});

test("PLAN_ID_RE: the WRITE grammar rejects the legacy format", () => {
  // Generation is new-only: a legacy id must never satisfy the mint-time assertion.
  assert.ok(!PLAN_ID_RE.test(LEGACY_ID));
  assert.ok(!PLAN_ID_RE.test("plan_2026-07-14_deadbeef"));
});

test("LEGACY_PLAN_ID_RE: accepts every pre-v2.36.0 plan-id", () => {
  assert.ok(LEGACY_PLAN_ID_RE.test(LEGACY_ID));
  assert.ok(LEGACY_PLAN_ID_RE.test("plan_1999-01-01_deadbeef"));
  assert.ok(LEGACY_PLAN_ID_RE.test("plan_2099-12-31_00000000"));
});

test("LEGACY_PLAN_ID_RE: rejects malformed legacy plan-ids (unchanged old grammar)", () => {
  const bad = [
    "plan_2026-07-14_79ee0f5",      // 7 hex — too short
    "plan_2026-07-14_79ee0f599",    // 9 hex — too long
    "plan_2026-07-14_ZZZZZZZZ",     // not hex
    "plan_2026-07-14_79EE0F59",     // uppercase hex
    "plan_2026-7-14_79ee0f59",      // unpadded date
    "plan_2026-07-14",              // no tail
    "notaplan_2026-07-14_79ee0f59", // wrong prefix
    "../etc/passwd",                // path traversal (the .current_plan guard)
    "",
  ];
  for (const s of bad) {
    assert.ok(!LEGACY_PLAN_ID_RE.test(s), `${JSON.stringify(s)} must be rejected`);
  }
});

test("LEGACY_PLAN_ID_RE: rejects the new format", () => {
  assert.ok(!LEGACY_PLAN_ID_RE.test(NEW_ID));
});

test("ANY_PLAN_ID_RE: the READ union accepts BOTH grammars", () => {
  // This is what keeps yesterday's plan dirs (and their committed DECISION anchors)
  // readable after the v2.36.0 cutover. See D-003.
  assert.ok(ANY_PLAN_ID_RE.test(NEW_ID));
  assert.ok(ANY_PLAN_ID_RE.test(LEGACY_ID));
});

test("ANY_PLAN_ID_RE: is anchored — no substring match inside a longer string", () => {
  assert.ok(!ANY_PLAN_ID_RE.test(`x/${LEGACY_ID}`));
  assert.ok(!ANY_PLAN_ID_RE.test(`${LEGACY_ID}/D-001`));
  assert.ok(!ANY_PLAN_ID_RE.test(`x/${NEW_ID}`));
  assert.ok(!ANY_PLAN_ID_RE.test(`${NEW_ID}/D-001`));
});

test("ANY_PLAN_ID_RE: rejects path traversal (the .current_plan guard — I-4)", () => {
  const traversal = [
    "../etc/passwd",
    "..",
    ".",
    "plan-../x",
    "plan_../x",
    "../plan_2026-07-14_79ee0f59",
    "plans/../../etc/passwd",
    `${NEW_ID}/../..`,
    "/etc/passwd",
    "",
  ];
  for (const s of traversal) {
    assert.ok(!ANY_PLAN_ID_RE.test(s), `${JSON.stringify(s)} must be rejected`);
    assert.ok(!PLAN_ID_RE.test(s), `${JSON.stringify(s)} must be rejected by PLAN_ID_RE`);
    assert.ok(!LEGACY_PLAN_ID_RE.test(s), `${JSON.stringify(s)} must be rejected by LEGACY`);
  }
});

test("ANY_PLAN_ID_PATTERN: is NON-CAPTURING — group indices of the host regex are stable", () => {
  // LOAD-BEARING (D-003). The 4 anchor regexes in validate-plan.mjs interpolate this
  // pattern and then read m[1]=planName, m[2]=id, m[3]=stale BY INDEX (`pushMatch`).
  // A capture group inside the union shifts all three and silently mis-parses every
  // anchor in the repo. Assert on real group indices, not on the pattern's text.
  const host = new RegExp(`(x)${ANY_PLAN_ID_PATTERN}(y)`);
  const m = host.exec(`x${NEW_ID}y`);
  assert.ok(m, "host regex should match");
  assert.equal(m[1], "x");
  assert.equal(m[2], "y", "the union must not consume a capture-group index");
  assert.equal(m.length, 3, "exactly 2 capture groups — the union adds none");

  const m2 = host.exec(`x${LEGACY_ID}y`);
  assert.ok(m2);
  assert.equal(m2[2], "y");
  assert.equal(m2.length, 3);
});

test("the three patterns are string sources, and the union is built from the other two", () => {
  // No re-typing: ANY is literally `(?:NEW|LEGACY)` (D-003 / D-005 — one definition each).
  assert.equal(typeof PLAN_ID_PATTERN, "string");
  assert.equal(typeof LEGACY_PLAN_ID_PATTERN, "string");
  assert.equal(ANY_PLAN_ID_PATTERN, `(?:${PLAN_ID_PATTERN}|${LEGACY_PLAN_ID_PATTERN})`);
});

test("ANY_PLAN_ID_PATTERN: is the unanchored source, embeddable in a larger regex", () => {
  // The anchor scanners compose it into `(?:(<pattern>)\/)?D-...` — one explicit capture
  // group wrapping the union, so m[1] is the plan-id and m[2] the decision number.
  const composed = new RegExp(`^# DECISION (?:(${ANY_PLAN_ID_PATTERN})\\/)?D-(\\d{3,})$`);

  // Legacy qualified anchor — the 18 committed ones in this repo. MUST still match.
  // Spelled out as a LITERAL (not `${LEGACY_ID}`) on purpose: this line is the byte-exact
  // shape of a real committed anchor, so it is also what the repo-wide anchor-count
  // tripwire greps for.
  const m = composed.exec("# DECISION plan_2026-07-14_79ee0f59/D-001");
  assert.ok(m, "composed anchor regex should match a legacy-qualified anchor");
  assert.equal(m[1], LEGACY_ID);
  assert.equal(m[2], "001");

  // New-format qualified anchor.
  const mNew = composed.exec(`# DECISION ${NEW_ID}/D-042`);
  assert.ok(mNew, "composed anchor regex should match a new-format-qualified anchor");
  assert.equal(mNew[1], NEW_ID);
  assert.equal(mNew[2], "042");

  // Pre-v2.14.0 unqualified form still matches with a null plan-id.
  const m2 = composed.exec("# DECISION D-002");
  assert.ok(m2);
  assert.equal(m2[1], undefined);
});

test("PLAN_DIR_PREFIX_RE: cheap prefix filter matches both grammars", () => {
  assert.ok(PLAN_DIR_PREFIX_RE.test(NEW_ID));
  assert.ok(PLAN_DIR_PREFIX_RE.test(LEGACY_ID));
  assert.ok(!PLAN_DIR_PREFIX_RE.test("plans"));
  assert.ok(!PLAN_DIR_PREFIX_RE.test("notaplan_2026-07-14_79ee0f59"));
  assert.ok(!PLAN_DIR_PREFIX_RE.test(".current_plan"));
});

test("PLAN_SECTION_PATTERN: finds `## <plan-id>` section headers of both grammars", () => {
  const re = () => new RegExp(PLAN_SECTION_PATTERN, "gm");
  const content = `# Findings\n\n## ${LEGACY_ID}\nold\n\n## ${NEW_ID}\nnew\n`;
  assert.equal([...content.matchAll(re())].length, 2);
  assert.equal(content.search(re()), content.indexOf(`## ${LEGACY_ID}`));
  // A section at offset 0 (no leading newline) is still found — `m` flag, not `\n##`.
  assert.equal(`## ${NEW_ID}\nx`.search(re()), 0);
  // Non-section headings are not plan sections.
  assert.equal("## Index\n## Notes\n".search(re()), -1);
});

// The hazard this export exists to prevent: a module-level `/gm` regex is stateful, and
// `matchAll` does NOT rescue it — it clones the regex *with* `lastIndex`. Under the old
// `PLAN_SECTION_RE` export, two `.test()` calls before a `matchAll` returned `[]`, and
// `trimConsolidatedWindow` then silently stopped trimming forever. A string pattern
// cannot carry state, so the failure is structurally unreachable rather than
// prose-guarded. This test would have FAILED against the old export.
test("PLAN_SECTION_PATTERN: is a string — no shared lastIndex to poison", () => {
  assert.equal(typeof PLAN_SECTION_PATTERN, "string");
  assert.ok(!("lastIndex" in Object(PLAN_SECTION_PATTERN)), "a string has no lastIndex");

  const content = `# Findings\n\n## ${LEGACY_ID}\nold\n\n## ${NEW_ID}\nnew\n`;
  // Hostile idiom: exhaust a `g` instance built from the pattern, THEN scan. Under a
  // shared instance this poisoned every later consumer; here it cannot escape the caller.
  const hostile = new RegExp(PLAN_SECTION_PATTERN, "gm");
  assert.ok(hostile.test(content));
  assert.ok(hostile.test(content));
  assert.ok(hostile.lastIndex > 0, "the local instance IS stateful — that is the point");
  assert.equal([...content.matchAll(new RegExp(PLAN_SECTION_PATTERN, "gm"))].length, 2);
  assert.equal(content.search(new RegExp(PLAN_SECTION_PATTERN, "gm")), content.indexOf(`## ${LEGACY_ID}`));
});

test("PLAN_SECTION_RE: the stateful shared instance is gone (not re-exported)", async () => {
  const mod = await import("./shared.mjs");
  assert.equal(mod.PLAN_SECTION_RE, undefined, "a shared `g` regex must not be re-introduced");
  const src = readFileSync(SHARED, "utf-8");
  assert.ok(!/export const PLAN_SECTION_RE\b/.test(src), "no shared PLAN_SECTION_RE export");
});

test("planDateFromId: extracts YYYY-MM-DD from both grammars", () => {
  assert.equal(planDateFromId(NEW_ID), "2026-07-14");
  assert.equal(planDateFromId(LEGACY_ID), "2026-07-14");
  assert.equal(planDateFromId("plan-1999-01-01T000000-deadbeef"), "1999-01-01");
  assert.equal(planDateFromId("plan_2099-12-31_00000000"), "2099-12-31");
});

test("planDateFromId: returns null for non-plan-ids (caller supplies the fallback)", () => {
  assert.equal(planDateFromId("not-a-plan"), null);
  assert.equal(planDateFromId("plan-2026-07-14"), null); // no separator after the date
  assert.equal(planDateFromId(""), null);
  assert.equal(planDateFromId(null), null);
  assert.equal(planDateFromId(undefined), null);
});

// ---------------------------------------------------------------------------
// DECISION_ID_NUM_PATTERN (defect #6 — ids were hard-capped at exactly 3 digits,
// so D-1000+ neither parsed nor got stamped [STALE] by `retire`)
// ---------------------------------------------------------------------------

test("DECISION_ID_NUM_PATTERN: 3-digit padding is the MINIMUM, not the maximum", () => {
  const re = new RegExp(`^D-${DECISION_ID_NUM_PATTERN}$`);
  // Canonical + past the old 3-digit cap.
  for (const ok of ["D-001", "D-099", "D-999", "D-1000", "D-12345"]) {
    assert.ok(re.test(ok), `${ok} must be a valid decision id`);
  }
  // Padding minimum preserved: under-padded ids stay INVALID, so `D-1` and
  // `D-001` can never become two names for the same decision.
  for (const bad of ["D-1", "D-99", "D-", "D-abc", "D001"]) {
    assert.ok(!re.test(bad), `${bad} must NOT be a valid decision id`);
  }
});

// ---------------------------------------------------------------------------
// unterminatedCommentOpener — the [state-comment-anomaly] balance probe (D-009).
// ---------------------------------------------------------------------------

test("unterminatedCommentOpener: finds an opener with no closer, and agrees with htmlCommentSpans", () => {
  assert.equal(unterminatedCommentOpener(""), -1);
  assert.equal(unterminatedCommentOpener(null), -1);
  assert.equal(unterminatedCommentOpener("no comments here at all"), -1);
  assert.equal(unterminatedCommentOpener("<!-- balanced -->"), -1);
  assert.equal(unterminatedCommentOpener("<!-- one --> text <!-- two -->"), -1);

  // The unterminated cases: the offset points AT the `<`.
  assert.equal(unterminatedCommentOpener("<!-- stray"), 0);
  const s = "line\n<!-- stray, never closed\nmore";
  assert.equal(unterminatedCommentOpener(s), s.indexOf("<!--"));
  // A closed comment followed by a stray one — the probe must see PAST the closed region.
  const t = "<!-- closed -->\ntext\n<!-- stray";
  assert.equal(unterminatedCommentOpener(t), t.lastIndexOf("<!--"));

  // Code spans are PROSE: a backticked delimiter can neither open nor close (D-010).
  assert.equal(unterminatedCommentOpener("a backticked `<!--` is not an opener"), -1);
  assert.equal(unterminatedCommentOpener("```\n<!-- inside a fence\n```"), -1);

  // HTML comments do not nest: the first `-->` closes, so this BALANCES.
  assert.equal(unterminatedCommentOpener("<!-- outer <!-- inner -->"), -1);
});

test("unterminatedCommentOpener: a stray opener PAIRED with bootstrap's template trailer BALANCES (why D-009 does not build the cap on this probe)", () => {
  // This is the review's exact shape. The markers balance perfectly — left-to-right pairing
  // matches the stray opener with the template's closer — so the probe is SILENT here, and a
  // balance check could never have been the iteration cap's fail-safe. The cap protects itself
  // by counting the RAW block; this probe is a diagnostic, and the [state-comment-anomaly]
  // check pairs it with a raw-vs-stripped count comparison precisely to cover this shape.
  const state = [
    "## Transition History:",
    "<!-- note: stray opener, an authoring accident",
    "- EXECUTE → REFLECT (1)",
    "- EXECUTE → REFLECT (2)",
    "<!-- When logging EXPLORE → PLAN, add Exploration Confidence, e.g.:",
    "- EXPLORE → PLAN (gathered enough context)",
    "See references/planning-rigor.md for definitions. -->",
  ].join("\n");
  assert.equal(unterminatedCommentOpener(state), -1, "the markers balance — this is the trap D-009 documents");
  // And the proof that the region really was swallowed: both records vanish from the strip.
  assert.ok(!/EXECUTE → REFLECT \(1\)/.test(stripHtmlComments(state)));
  assert.ok(!/EXECUTE → REFLECT \(2\)/.test(stripHtmlComments(state)));
});

// ---------------------------------------------------------------------------
// maskLiteralRegions (iter-3 CRITICAL B, D-012) — indented code blocks + the
// unterminated fence. Exercised through `htmlCommentSpans` / `stripHtmlComments`,
// which is the only way any consumer sees the mask.
//
// The failure direction is asymmetric and the tests are written to pin BOTH sides:
//   under-mask → a doc example is reported as a live anchor, and `bootstrap.mjs
//                retire` EDITS the documentation file (loud, but a wrong write).
//   over-mask  → a REAL comment's markers vanish, so bootstrap's schema example
//                parses as a phantom `D-001` and a stale anchor never gets stamped
//                (SILENT, and strictly worse — Pre-Mortem #2).
// ---------------------------------------------------------------------------

test("maskLiteralRegions: a 4-space INDENTED code block is literal — a DECISION example in one is NOT a comment", () => {
  // The iter-3 CRITICAL B red run, in miniature. Pre-fix this yielded a span, so the
  // validator emitted a false [anchor-unknown-plan] and retire wrote [STALE] into the doc.
  const doc = "# Doc\n\nExample:\n\n    <!-- DECISION plan_2026-01-01_deadbeef/D-001 example -->\n\nEnd.\n";
  assert.deepEqual(htmlCommentSpans(doc), [], "an indented-code example must yield NO comment span");
  assert.equal(stripHtmlComments(doc), doc, "and the text must come back byte-identical");
});

test("maskLiteralRegions: an indented block starting at SOF is literal", () => {
  assert.deepEqual(htmlCommentSpans("    <!-- DECISION x/D-001 -->\n\ntext\n"), []);
});

test("maskLiteralRegions: an indented block runs through interior blank lines but stops at the first flush-left line", () => {
  const doc = "para\n\n    <!-- one -->\n\n    <!-- two -->\n\n<!-- REAL -->\n";
  const spans = htmlCommentSpans(doc);
  assert.equal(spans.length, 1, "only the flush-left comment is real");
  assert.equal(doc.slice(spans[0].start, spans[0].end), "<!-- REAL -->");
});

test("maskLiteralRegions: OVER-MASK GUARD — an indented run cannot interrupt a paragraph (no preceding blank line)", () => {
  // CommonMark: an indented code block cannot interrupt a paragraph. This is the rule
  // that keeps bootstrap's decisions.md schema-example comment a COMMENT: its 5-space
  // continuation lines follow the non-blank `<!-- Schema example …` opener line.
  const doc = "<!-- Schema example\n     See references/file-formats.md\n     more prose\n-->\n";
  const spans = htmlCommentSpans(doc);
  assert.equal(spans.length, 1, "the schema-example comment must still be ONE comment span");
  assert.equal(doc.slice(spans[0].start, spans[0].end), doc.trimEnd());
});

test("maskLiteralRegions: OVER-MASK GUARD — indented text under a LIST marker is item continuation, not code", () => {
  // A checklist item (CLAUDE.md's own shape) whose continuation is indented 4+.
  const doc = "- [ ] a checklist item\n\n    <!-- REAL comment under a list -->\n";
  const spans = htmlCommentSpans(doc);
  assert.equal(spans.length, 1, "a list continuation must NOT be masked — the comment stays visible");
  assert.equal(doc.slice(spans[0].start, spans[0].end), "<!-- REAL comment under a list -->");
  // Ordered lists too, and the list survives blank lines.
  assert.equal(htmlCommentSpans("1. step one\n\n    <!-- c -->\n").length, 1);
  // …but a flush-left paragraph CLOSES the list, and the block after it is real code.
  assert.deepEqual(htmlCommentSpans("- item\n\nA plain paragraph.\n\n    <!-- c -->\n"), []);
});

test("maskLiteralRegions: OVER-MASK GUARD — a TAB-indented block is not recognized (under-mask, deliberately)", () => {
  assert.equal(htmlCommentSpans("para\n\n\t<!-- c -->\n").length, 1);
});

test("maskLiteralRegions: an UNTERMINATED fence masks NOTHING (it does not swallow to EOF)", () => {
  // Review WARNING 3 / Pre-Mortem #2: pre-fix, the opener masked every remaining line,
  // so bootstrap's template comment stopped being a comment and the validator emitted a
  // FALSE [decisions-schema] ERROR on the schema example it had just un-hidden.
  const doc = "```\n<!-- REAL comment below an unclosed fence -->\ntext\n";
  const spans = htmlCommentSpans(doc);
  assert.equal(spans.length, 1, "an unclosed fence is ordinary text; the comment below it is REAL");
  assert.equal(doc.slice(spans[0].start, spans[0].end), "<!-- REAL comment below an unclosed fence -->");
});

test("maskLiteralRegions: a CLOSED fence still masks (the unterminated fix did not disable fences)", () => {
  assert.deepEqual(htmlCommentSpans("```\n<!-- example -->\n```\n"), []);
  assert.deepEqual(htmlCommentSpans("~~~\n<!-- example -->\n~~~\n"), []);
  // A longer closer closes; a shorter one does not.
  assert.deepEqual(htmlCommentSpans("```\n<!-- e -->\n`````\n"), []);
  // A fence closed only by a DIFFERENT char is unterminated → masks nothing.
  assert.equal(htmlCommentSpans("```\n<!-- REAL -->\n~~~\n").length, 1);
});

test("maskLiteralRegions: stripHtmlComments stays EXACTLY line-count preserving across the new constructs", () => {
  const docs = [
    "para\n\n    <!-- indented -->\n\nafter\n",
    "```\n<!-- unclosed fence -->\nmore\n",
    "- item\n\n    <!-- list continuation -->\n",
    "    <!-- sof indented -->\n",
    "<!-- real -->\n\n    indented code\n\n<!-- real2 -->\n",
    "\r\npara\r\n\r\n    <!-- crlf indented -->\r\n",
  ];
  for (const d of docs) {
    assert.equal(
      stripHtmlComments(d).split("\n").length,
      d.split("\n").length,
      `line count must be preserved for:\n${JSON.stringify(d)}`,
    );
  }
});
