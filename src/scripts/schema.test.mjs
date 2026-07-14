// Tests for schema.mjs — declarative element spec + validateDoc().
//
// C10 IS THE BAR: "schema.mjs rejects every field-shape violation the 6 deleted regexes rejected."
// The named failure mode of this module is a spec that is quietly MORE PERMISSIVE than the six
// hand-maintained regexes it replaces — such a spec passes every test you write for it and
// silently destroys validation the repo already had. So the bulk of this file is not "does a good
// value pass" but a case-by-case PORT of what each old regex REJECTED:
//
//   TS     /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
//   STEP   /^iter-\d+\/step-\d+$/
//   COMMIT /^([0-9a-f]{7,40}|uncommitted)$/
//   OP     /^(CREATE\(\+\d+\)|EDIT\(\+\d+,-\d+\)|DELETE\(-\d+\)|RENAME\([^→]+→[^)]+\)|REVERT\([^)]+\))$/
//   RADIUS /^(radius:(LOW|MED|HIGH)\(-?\d+\)|radius:UNKNOWN\([^)]+\))$/
//   DREF   /^(D-\d{3,}(?!\d)|-)$/
//   plus the two inline field checks: path (non-empty, no "|") and reason (non-empty).

import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, serialize } from "./xml.mjs";
import { validateDoc, validateElement, rootElement, CHANGELOG_SPEC, DREF_RE } from "./schema.mjs";
import { DECISION_ID_NUM_PATTERN } from "./shared.mjs";

// --- fixtures ---------------------------------------------------------------

const GOOD_ENTRY = {
  ts: "2026-07-14T05:49:13Z",
  step: "iter-1/step-6",
  commit: "3bdcd6c",
  path: "src/scripts/shared.mjs",
  op: "EDIT(+81,-0)",
  radius: "radius:MED(3)",
  dref: "D-005",
  reason: "hoist the id grammars into shared.mjs",
};

const el = (name, attrs = {}, children = []) => ({ type: "element", name, attrs, children });
const entry = (over = {}) => el("entry", { ...GOOD_ENTRY, ...over });
const doc = (children) => ({ type: "document", name: null, attrs: {}, children: [el("changelog", {}, children)] });
const check = (children) => validateDoc(doc(children), CHANGELOG_SPEC);
const checkEntry = (over) => check([entry(over)]);

/** Assert an entry attribute value is REJECTED, and that the finding names that attribute. */
function rejects(attr, value, label = value) {
  const issues = checkEntry({ [attr]: value });
  assert.ok(issues.length > 0, `expected "${label}" to be rejected for ${attr}, but it passed`);
  assert.ok(
    issues.some((i) => i.message.includes(`"${attr}"`)),
    `expected an issue naming attribute "${attr}", got: ${issues.map((i) => i.message).join(" ;; ")}`,
  );
  for (const i of issues) {
    assert.equal(i.severity, "WARN");
    assert.equal(i.check, "changelog-malformed");
  }
}

/** Assert an entry attribute value is ACCEPTED (the whole doc is clean). */
function accepts(attr, value, label = value) {
  const issues = checkEntry({ [attr]: value });
  assert.deepEqual(issues, [], `expected "${label}" to be accepted for ${attr}`);
}

// --- happy path -------------------------------------------------------------

test("a valid changelog doc produces zero issues", () => {
  assert.deepEqual(check([entry(), entry({ dref: "-" })]), []);
});

test("an empty changelog (root only, no entries) is valid — entry is `*`", () => {
  assert.deepEqual(check([]), []);
});

test("a full changelog with every element kind is valid", () => {
  const issues = check([
    el("compressed-summary", { "entries-at-compress": "187", "elided-groups": "3", "elided-lines": "42" }),
    entry(),
    el("compressed", { count: "14", from: "iter-1/step-3", to: "iter-1/step-7", files: "4" }),
    { type: "comment", value: " a comment is ignored " },
    el("raw", { line: "12" }, [{ type: "text", value: "a line that never parsed | cleanly" }]),
    entry({ dref: "-" }),
  ]);
  assert.deepEqual(issues, []);
});

test("issues carry the published tier and slug (WARN / changelog-malformed) — advisory contract", () => {
  const issues = checkEntry({ ts: "nope" });
  assert.equal(issues[0].severity, "WARN");
  assert.equal(issues[0].check, "changelog-malformed");
});

test("issue messages locate the offending element by index", () => {
  const issues = check([entry(), entry({ commit: "ZZZ" })]);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /<changelog>\/<entry>\[2\]/);
});

// --- field 1: ts (former TS regex) ------------------------------------------

test("ts: valid ISO-8601 UTC second-precision timestamp passes", () => {
  accepts("ts", "2026-07-14T05:49:13Z");
  accepts("ts", "1999-12-31T23:59:59Z");
});

test("ts: every shape the TS regex rejected is still rejected", () => {
  rejects("ts", "2026-07-14 05:49:13Z", "space instead of T");
  rejects("ts", "2026-07-14T05:49:13", "missing Z");
  rejects("ts", "2026-07-14T05:49Z", "no seconds");
  rejects("ts", "2026-07-14T05:49:13.123Z", "millisecond precision");
  rejects("ts", "2026-07-14T05:49:13+02:00", "offset instead of Z");
  rejects("ts", "26-07-14T05:49:13Z", "2-digit year");
  rejects("ts", "2026-7-14T05:49:13Z", "unpadded month");
  rejects("ts", "2026-07-14", "date only");
  rejects("ts", "not-a-date");
  rejects("ts", "", "empty");
  rejects("ts", " 2026-07-14T05:49:13Z", "leading space");
  rejects("ts", "2026-07-14T05:49:13Z ", "trailing space");
});

test("ts: iso-datetime is STRICTLY STRONGER than the old regex — calendar-impossible dates fail", () => {
  // The old TS regex was shape-only: it accepted 2026-13-45T99:99:99Z. This is a deliberate
  // tightening, never a loosening. Documented so a future reader does not "restore parity".
  rejects("ts", "2026-13-01T00:00:00Z", "month 13");
  rejects("ts", "2026-02-30T00:00:00Z", "Feb 30");
  rejects("ts", "2026-07-14T25:00:00Z", "hour 25");
});

// --- field 2: step (former STEP regex) --------------------------------------

test("step: valid iter-N/step-M passes, including multi-digit", () => {
  accepts("step", "iter-1/step-1");
  accepts("step", "iter-12/step-345");
});

test("step: every shape the STEP regex rejected is still rejected", () => {
  rejects("step", "iter1/step2", "missing hyphens");
  rejects("step", "iter-1/step-", "missing step number");
  rejects("step", "iter-/step-1", "missing iter number");
  rejects("step", "step-1", "no iter part");
  rejects("step", "iter-1", "no step part");
  rejects("step", "iter-a/step-1", "non-numeric iter");
  rejects("step", "iter-1/step-b", "non-numeric step");
  rejects("step", "iter-1/step-1x", "trailing junk");
  rejects("step", "xiter-1/step-1", "leading junk");
  rejects("step", "iter-1\\step-1", "backslash separator");
  rejects("step", "", "empty");
});

// --- field 3: commit (former COMMIT regex) ----------------------------------

test("commit: 7..40 lowercase hex, or the literal `uncommitted`", () => {
  accepts("commit", "3bdcd6c");
  accepts("commit", "a".repeat(40));
  accepts("commit", "uncommitted");
});

test("commit: every shape the COMMIT regex rejected is still rejected", () => {
  rejects("commit", "3bdcd6", "6 chars — too short");
  rejects("commit", "a".repeat(41), "41 chars — too long");
  rejects("commit", "3BDCD6C", "uppercase hex");
  rejects("commit", "zzzzzzz", "non-hex letters");
  rejects("commit", "3bdcd6c ", "trailing space");
  rejects("commit", "UNCOMMITTED", "wrong case literal");
  rejects("commit", "uncommitted!", "literal with junk");
  rejects("commit", "", "empty");
});

// --- field 4: path (former inline `!path || path.includes("|")` check) ------

test("path: a normal repo-relative path passes", () => {
  accepts("path", "src/scripts/schema.mjs");
  accepts("path", "plans/plan_2026-07-14_79ee0f59/decisions.md");
});

test("path: every shape the inline path check rejected is still rejected", () => {
  rejects("path", "", "empty");
  rejects("path", "   ", "whitespace only");
  rejects("path", "src/a|b.mjs", "contains a pipe");
});

test("path: a newline is rejected — stricter than the old check, never weaker", () => {
  rejects("path", "src/a\nb.mjs", "contains a newline");
});

// --- field 5: op (former OP regex) ------------------------------------------

test("op: all five legal op forms pass", () => {
  accepts("op", "CREATE(+298)");
  accepts("op", "EDIT(+45,-12)");
  accepts("op", "DELETE(-30)");
  accepts("op", "RENAME(src/old.mjs→src/new.mjs)");
  accepts("op", "REVERT(src/foo.js)");
});

test("op: every shape the OP regex rejected is still rejected", () => {
  rejects("op", "EDIT(+1)", "EDIT without removed count");
  rejects("op", "EDIT(+1,-2)trailing", "trailing junk after a valid op");
  rejects("op", "CREATE(-1)", "CREATE with a negative count");
  rejects("op", "CREATE(+)", "CREATE with no number");
  rejects("op", "DELETE(+30)", "DELETE with a positive count");
  rejects("op", "MOVE(+1,-1)", "unknown op verb");
  rejects("op", "edit(+1,-2)", "lowercase verb");
  rejects("op", "RENAME(src/old.mjs->src/new.mjs)", "ASCII arrow instead of →");
  rejects("op", "REVERT()", "REVERT with an empty file");
  rejects("op", "EDIT", "verb with no LOC");
  rejects("op", "", "empty");
});

// --- field 6: radius (former RADIUS regex) ----------------------------------

test("radius: all four tiers pass, including a negative score and UNKNOWN(reason)", () => {
  accepts("radius", "radius:LOW(0)");
  accepts("radius", "radius:MED(3)");
  accepts("radius", "radius:HIGH(6)");
  accepts("radius", "radius:LOW(-1)");
  accepts("radius", "radius:UNKNOWN(script-missing)");
  accepts("radius", "radius:UNKNOWN(no-git)");
  // Parity, not taste: the old regex's UNKNOWN reason is `[^)]+`, so a digit is a legal reason.
  // Tightening it here would be a behavior change smuggled in under a refactor. It stays legal.
  accepts("radius", "radius:UNKNOWN(2)");
});

test("radius: every shape the RADIUS regex rejected is still rejected", () => {
  rejects("radius", "LOW(2)", "missing radius: prefix");
  rejects("radius", "radius:HUGE(2)", "unknown tier");
  rejects("radius", "radius:low(2)", "lowercase tier");
  rejects("radius", "radius:LOW(x)", "non-numeric score");
  rejects("radius", "radius:LOW()", "empty score");
  rejects("radius", "radius:LOW", "no score at all");
  rejects("radius", "radius:UNKNOWN()", "UNKNOWN with an empty reason");
  rejects("radius", "", "empty");
});

test("radius: the anchoring bug the grouped alternation fixed stays fixed", () => {
  // Without the outer group, ^ anchors only the first alternative and $ only the last, so these
  // two passed. They are the regression cases for that fix; they must never pass again.
  rejects("radius", "radius:LOW(2)trailing", "trailing junk after a scored tier");
  rejects("radius", "leadingradius:UNKNOWN(x)", "leading junk before UNKNOWN");
});

// --- field 7: dref (former DREF regex, built from DECISION_ID_NUM_PATTERN) --

test("dref: a padded decision id, a 4+ digit id, or a bare `-` passes", () => {
  accepts("dref", "D-001");
  accepts("dref", "D-005");
  accepts("dref", "D-1000");
  accepts("dref", "D-123456");
  accepts("dref", "-");
});

test("dref: every shape the DREF regex rejected is still rejected", () => {
  rejects("dref", "D-1", "under-padded (1 digit)");
  rejects("dref", "D-12", "under-padded (2 digits)");
  rejects("dref", "d-001", "lowercase D");
  rejects("dref", "D001", "missing hyphen");
  rejects("dref", "D-001x", "trailing junk");
  rejects("dref", "D-", "no digits");
  rejects("dref", "--", "double dash");
  rejects("dref", "none", "prose instead of a ref");
  rejects("dref", "", "empty");
});

test("dref is BUILT FROM the shared D-005 grammar — not a re-derived digit run", () => {
  // Re-deriving the digit run without D-005's trailing boundary is what corrupted source in
  // bootstrap retire. Assert the composition, not just the behavior: a copy-pasted pattern that
  // happens to behave the same today would pass a behavioral test and rot tomorrow.
  assert.equal(DECISION_ID_NUM_PATTERN, "\\d{3,}(?!\\d)");
  assert.ok(DREF_RE.source.includes(DECISION_ID_NUM_PATTERN), "DREF_RE must embed DECISION_ID_NUM_PATTERN verbatim");
  assert.ok(DREF_RE.test("D-1000"), "the boundary must not truncate D-1000 to D-100");
  assert.ok(!DREF_RE.test("D-100x"));
});

// --- field 8: reason (former inline non-empty check) + free-text -------------

test("reason: a normal one-clause reason passes", () => {
  accepts("reason", "wire executor changelog protocol");
});

test("reason: empty / whitespace-only is rejected, as the inline check did", () => {
  rejects("reason", "", "empty");
  rejects("reason", "   ", "whitespace only");
  rejects("reason", "\n", "newline only");
});

test("reason is free-text: pipes are accepted (the legacy escaping concession)", () => {
  accepts("reason", "fix race: a | b | c");
  accepts("reason", "a | b", "pipes");
});

test("reason is free-text: newlines and unicode arrows are accepted", () => {
  accepts("reason", "first line\nsecond line");
  accepts("reason", "rename src/old.mjs → src/new.mjs");
  accepts("reason", "suite 302 → 372, 0 failures\ttab too");
});

test("reason free-text survives a real serialize → parse round trip", () => {
  // xml.mjs escapes a newline in an attribute to &#10; precisely so a conformant reader cannot
  // normalize it to a space and silently corrupt the reason. Prove the pair holds end to end.
  const nasty = "fix race: a | b\nthen c → d\twith\ttabs & <angles> \"quotes\" 'apos'";
  const xml = serialize(doc([entry({ reason: nasty })]));
  const reparsed = parse(xml);
  assert.deepEqual(validateDoc(reparsed, CHANGELOG_SPEC), []);
  assert.equal(rootElement(reparsed).children[0].attrs.reason, nasty);
});

// --- structural: required / unknown / cardinality ---------------------------

test("missing required attribute is reported, one issue per missing field", () => {
  const bare = el("entry", { ts: GOOD_ENTRY.ts });
  const issues = validateDoc(doc([bare]), CHANGELOG_SPEC);
  for (const name of ["step", "commit", "path", "op", "radius", "dref", "reason"]) {
    assert.ok(
      issues.some((i) => i.message.includes(`missing required attribute "${name}"`)),
      `expected a missing-attribute issue for "${name}"`,
    );
  }
  assert.equal(issues.length, 7);
});

test("unknown attribute is reported", () => {
  const issues = checkEntry({ author: "claude" });
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /unknown attribute "author"/);
});

test("unknown element is reported", () => {
  const issues = check([el("note", {}, [])]);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /unexpected child element <note>/);
});

test("wrong root element is reported, and nothing else is claimed", () => {
  const d = { type: "document", name: null, attrs: {}, children: [el("decisions", {}, [])] };
  const issues = validateDoc(d, CHANGELOG_SPEC);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /root element is <decisions>, expected <changelog>/);
});

test("wrong child cardinality is reported: <compressed-summary> is `?`", () => {
  const summary = () => el("compressed-summary", { "entries-at-compress": "1", "elided-groups": "1", "elided-lines": "1" });
  assert.deepEqual(check([summary()]), [], "one summary is legal");
  const issues = check([summary(), summary()]);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /<compressed-summary> may appear at most once \(found 2\)/);
});

test("text content in an element that forbids it is reported", () => {
  const issues = check([el("entry", GOOD_ENTRY, [{ type: "text", value: "stray prose" }])]);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /text content is not allowed in <entry>/);
});

test("<raw> carries text on purpose — an unparseable line is preserved, never dropped", () => {
  const issues = check([el("raw", {}, [{ type: "text", value: "garbage || not | an | entry" }])]);
  assert.deepEqual(issues, []);
});

test("<raw> still rejects an unknown attribute and a bad line number", () => {
  assert.match(check([el("raw", { lien: "3" })])[0].message, /unknown attribute "lien"/);
  assert.match(check([el("raw", { line: "zero" })])[0].message, /attribute "line" must be an integer/);
});

test("<compressed> element: int and range fields are typed", () => {
  const ok = el("compressed", { count: "14", from: "iter-1/step-3", to: "iter-1/step-7", files: "4" });
  assert.deepEqual(check([ok]), []);
  const bad = el("compressed", { count: "many", from: "step-3", to: "iter-1/step-7", files: "0" });
  const issues = check([bad]);
  assert.equal(issues.length, 3);
  assert.match(issues.map((i) => i.message).join("\n"), /attribute "count" must be an integer/);
  assert.match(issues.map((i) => i.message).join("\n"), /attribute "from" must match/);
  assert.match(issues.map((i) => i.message).join("\n"), /attribute "files" must be >= 1/);
});

test("whitespace between elements is not text content", () => {
  const d = parse('<changelog>\n  <entry ts="2026-07-14T05:49:13Z" step="iter-1/step-1" commit="uncommitted" path="a.mjs" op="CREATE(+1)" radius="radius:LOW(0)" dref="-" reason="x"/>\n</changelog>\n');
  assert.deepEqual(validateDoc(d, CHANGELOG_SPEC), []);
});

test("XML comments inside the changelog are ignored, not validated", () => {
  assert.deepEqual(check([{ type: "comment", value: " append-only ledger " }, entry()]), []);
});

// --- the load-bearing invariant: report, never throw -------------------------

test("validateDoc REPORTS invalid content — it never throws", () => {
  const nasties = [
    doc([entry({ ts: null })]),
    doc([entry({ radius: undefined })]),
    { type: "document", name: null, attrs: {}, children: [] },
    { type: "document" },
    null,
    undefined,
    "a string",
    42,
    { type: "element", name: "changelog" },
  ];
  for (const d of nasties) {
    let issues;
    assert.doesNotThrow(() => {
      issues = validateDoc(d, CHANGELOG_SPEC);
    }, `validateDoc threw on ${JSON.stringify(d)}`);
    assert.ok(Array.isArray(issues));
    for (const i of issues) {
      assert.ok(typeof i.severity === "string" && typeof i.check === "string" && typeof i.message === "string");
    }
  }
});

test("a document with no root element is reported, not thrown", () => {
  const issues = validateDoc({ type: "document", name: null, attrs: {}, children: [{ type: "comment", value: "x" }] }, CHANGELOG_SPEC);
  assert.deepEqual(issues, [{ severity: "WARN", check: "changelog-malformed", message: "document has no root element" }]);
});

test("a cyclic DOM is reported, not a stack overflow crash", () => {
  const bad = el("changelog", {}, []);
  bad.children.push(bad);
  assert.doesNotThrow(() => validateDoc({ type: "document", name: null, attrs: {}, children: [bad] }, CHANGELOG_SPEC));
});

test("every issue has exactly the validator's standard issue shape", () => {
  const issues = check([entry({ ts: "x", op: "y", dref: "z" })]);
  assert.equal(issues.length, 3);
  for (const i of issues) assert.deepEqual(Object.keys(i).sort(), ["check", "message", "severity"]);
});

// --- validateElement + rootElement (the exported seams for steps 10/11) -----

test("validateElement validates a synthetic <entry> — the legacy markdown path's seam", () => {
  // Step 11 builds this node from splitChangelogFields() so the legacy .md changelog and the .xml
  // changelog validate through the SAME field types. One shape, two encodings.
  assert.deepEqual(validateElement(entry(), CHANGELOG_SPEC, "changelog.md:12"), []);
  const issues = validateElement(entry({ commit: "nope" }), CHANGELOG_SPEC, "changelog.md:12");
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /^changelog\.md:12: attribute "commit" must match/);
});

test("validateElement on a non-element reports rather than throwing", () => {
  assert.deepEqual(validateElement(null, CHANGELOG_SPEC), [
    { severity: "WARN", check: "changelog-malformed", message: "expected an element node" },
  ]);
});

test("rootElement finds the root past a declaration and comments", () => {
  const d = parse('<?xml version="1.0"?><!-- hi --><changelog/>');
  assert.equal(rootElement(d).name, "changelog");
});

test("rootElement is identity on an element and null on junk", () => {
  const e = el("changelog");
  assert.equal(rootElement(e), e);
  assert.equal(rootElement({ name: "changelog", attrs: {}, children: [] }).name, "changelog");
  assert.equal(rootElement(null), null);
  assert.equal(rootElement({ type: "document", name: null, attrs: {}, children: [] }), null);
});

// --- the spec is the single source of truth ---------------------------------

test("the changelog spec declares exactly the 8 fields, no more", () => {
  const attrs = Object.keys(CHANGELOG_SPEC.elements.entry.attrs).sort();
  assert.deepEqual(attrs, ["commit", "dref", "op", "path", "radius", "reason", "step", "ts"]);
  for (const a of Object.values(CHANGELOG_SPEC.elements.entry.attrs)) assert.equal(a.required, true);
});

test("the spec carries the artifact's published advisory tier and slug", () => {
  assert.equal(CHANGELOG_SPEC.severity, "WARN");
  assert.equal(CHANGELOG_SPEC.check, "changelog-malformed");
  assert.equal(CHANGELOG_SPEC.root, "changelog");
});

test("importing schema.mjs has no CLI side effects", async () => {
  const mod = await import("./schema.mjs");
  assert.equal(typeof mod.validateDoc, "function");
  assert.equal(typeof mod.validateElement, "function");
  assert.equal(typeof mod.rootElement, "function");
});
