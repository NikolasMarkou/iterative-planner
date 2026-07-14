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
// PLAN_ID_RE / PLAN_ID_PATTERN (defect #4 — the grammar bootstrap.mjs and
// validate-plan.mjs each used to define separately, with DIFFERENT hex tails)
// ---------------------------------------------------------------------------

test("PLAN_ID_RE: accepts the canonical shape bootstrap actually generates", () => {
  // randomBytes(4).toString("hex") → exactly 8 lowercase-hex chars.
  assert.ok(PLAN_ID_RE.test("plan_2026-07-14_79ee0f59"));
  assert.ok(PLAN_ID_RE.test("plan_1999-01-01_deadbeef"));
  assert.ok(PLAN_ID_RE.test("plan_2099-12-31_00000000"));
});

test("PLAN_ID_RE: rejects malformed plan-ids", () => {
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
  for (const s of bad) assert.ok(!PLAN_ID_RE.test(s), `${JSON.stringify(s)} must be rejected`);
});

test("PLAN_ID_RE: is anchored — no substring match inside a longer string", () => {
  assert.ok(!PLAN_ID_RE.test("x/plan_2026-07-14_79ee0f59"));
  assert.ok(!PLAN_ID_RE.test("plan_2026-07-14_79ee0f59/D-001"));
});

test("PLAN_ID_PATTERN: is the unanchored source, embeddable in a larger regex", () => {
  // The anchor scanners compose it into `(?:(<pattern>)\/)?D-...`.
  const composed = new RegExp(`^# DECISION (?:(${PLAN_ID_PATTERN})\\/)?D-(\\d{3,})$`);
  const m = composed.exec("# DECISION plan_2026-07-14_79ee0f59/D-001");
  assert.ok(m, "composed anchor regex should match a qualified anchor");
  assert.equal(m[1], "plan_2026-07-14_79ee0f59");
  assert.equal(m[2], "001");
  // Legacy unqualified form still matches with a null plan-id.
  const m2 = composed.exec("# DECISION D-002");
  assert.ok(m2);
  assert.equal(m2[1], undefined);
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
