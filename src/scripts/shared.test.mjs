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
  COMPRESSED_SUMMARY_OPEN,
  COMPRESSED_SUMMARY_CLOSE,
  CHANGELOG_COMPRESSED_INLINE_RE,
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
