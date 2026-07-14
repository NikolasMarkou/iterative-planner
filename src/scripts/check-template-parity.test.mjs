// Tests for check-template-parity.mjs — the bootstrap<->doc template byte-parity gate.
// Run: node --test src/scripts/check-template-parity.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseSkeletons,
  firstDiffLine,
  locateTemplateKey,
  header,
  checkParity,
  report,
  DOC_REL,
  SRC_REL,
  EXPECTED_SLUGS,
} from "./check-template-parity.mjs";
import { PLAN_TEMPLATES } from "./bootstrap.mjs";
import { resolveTemplate, servedRegionEnd } from "./emit-template.mjs";

// --- fixtures ---------------------------------------------------------------

// A minimal doc in the real shape: worked-example prose, a REAL <!-- TEMPLATE:<slug> --> marker, the
// TEMPLATE:END boundary, then the SKELETON regions, then the SKELETON END terminator. The worked-half
// slug marker is load-bearing: the shared boundary `servedRegionEnd` anchors to the LAST valid slug's
// terminator (D-008), so a fixture WITHOUT one would fail-close to whole-doc and trip rule (h) on its
// own skeleton regions. `state` is a real slug in VALID_TEMPLATES; the fixture's own template keys
// (alpha/beta) are deliberately NOT — the anchor slug and the compared slugs are independent.
const doc = (...regions) =>
  ["# Formats", "", "<!-- TEMPLATE:state -->", "<!-- TEMPLATE:END -->", "", ...regions, "<!-- SKELETON:END -->", ""].join("\n");

const region = (slug, ...bodyLines) =>
  [`<!-- SKELETON:${slug} -->`, "```markdown", ...bodyLines, "```", ""].join("\n");

// Two templates, two matching regions. Bodies carry the trailing "\n" every template has.
const TEMPLATES = { alpha: "# Alpha\n- one\n", beta: "# Beta\n" };
const DOC_OK = doc(region("alpha", "# Alpha", "- one"), region("beta", "# Beta"));

// The fixtures carry 2 templates, so they declare their own coverage floor. The REAL floor
// (EXPECTED_SLUGS = 12) is exercised by the vacuous-pass test and the LIVE test at the bottom.
const FIXTURE_FLOOR = 2;

const rules = (issues) => issues.map((i) => i.rule);
const msgs = (issues) => issues.map((i) => i.message).join(" | ");

// --- primitives -------------------------------------------------------------

test("parseSkeletons lifts each region body as bytes, with a 1-based doc line for the body", () => {
  const { regions, endLine } = parseSkeletons(DOC_OK);
  assert.deepEqual([...regions.keys()], ["alpha", "beta"]);
  assert.equal(regions.get("alpha").body, "# Alpha\n- one\n");
  assert.equal(regions.get("beta").body, "# Beta\n");
  // "# Formats"=1, ""=2, TEMPLATE:state=3, TEMPLATE:END=4, ""=5, marker=6, fence=7, first body line=8.
  assert.equal(regions.get("alpha").bodyLine, 8);
  assert.equal(regions.get("alpha").markerLine, 6);
  assert.ok(endLine > regions.get("beta").markerLine);
});

test("parseSkeletons appends the trailing newline the region contract promises", () => {
  const { regions } = parseSkeletons(doc(region("alpha", "x")));
  assert.equal(regions.get("alpha").body, "x\n");
});

test("parseSkeletons does not mistake the END terminator for a slug", () => {
  const { regions } = parseSkeletons(DOC_OK);
  assert.equal(regions.has("END"), false);
});

test("firstDiffLine returns -1 for byte-equal bodies and the 0-based index otherwise", () => {
  assert.equal(firstDiffLine("a\nb\n", "a\nb\n"), -1);
  assert.equal(firstDiffLine("a\nb\n", "a\nX\n"), 1);
});

test("firstDiffLine catches a trailing-newline-only difference (the invisible one)", () => {
  // "a" -> ["a"], "a\n" -> ["a", ""] — the drift lives in the phantom last element.
  assert.equal(firstDiffLine("a", "a\n"), 1);
  assert.equal(firstDiffLine("a\n", "a\n\n"), 2);
});

test("locateTemplateKey finds both bare and quoted PLAN_TEMPLATES keys", () => {
  const src = ["export const PLAN_TEMPLATES = {", "  state: `x`,", '  "findings-consolidated": `y`,'].join("\n");
  assert.equal(locateTemplateKey(src, "state"), 2);
  assert.equal(locateTemplateKey(src, "findings-consolidated"), 3);
  assert.equal(locateTemplateKey(src, "nope"), 1); // never throws; degrades to line 1
});

// --- (a) parity -------------------------------------------------------------

test("(a) identical maps pass, and the report names how many slugs were compared", () => {
  const { issues, compared } = checkParity(TEMPLATES, DOC_OK, "", FIXTURE_FLOOR);
  assert.deepEqual(issues, []);
  assert.equal(compared, 2);
});

test("(a) THE DEFECT: a one-character drift in a template body is CAUGHT", () => {
  const drifted = { ...TEMPLATES, alpha: "# Alpha\n- onE\n" };
  const { issues } = checkParity(drifted, DOC_OK, "", FIXTURE_FLOOR);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, "parity");
  assert.match(issues[0].message, /alpha/);
  assert.match(msgs(issues), /- one/); // shows both sides of the drift
});

test("(a) THE SUBTLE ONE: a trailing-newline-only difference is CAUGHT", () => {
  const drifted = { ...TEMPLATES, beta: "# Beta" }; // lost its trailing newline
  const { issues } = checkParity(drifted, DOC_OK, "", FIXTURE_FLOOR);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, "parity");
  assert.match(issues[0].message, /beta/);
});

test("(a) a whitespace-only difference is CAUGHT (trailing space is not invisible to a gate)", () => {
  const drifted = { ...TEMPLATES, alpha: "# Alpha\n- one \n" };
  const { issues } = checkParity(drifted, DOC_OK, "", FIXTURE_FLOOR);
  assert.deepEqual(rules(issues), ["parity"]);
});

test("(a) a parity failure points at a real line in the doc, so the failure names a place", () => {
  const drifted = { ...TEMPLATES, alpha: "# Alpha\n- two\n" };
  const { issues } = checkParity(drifted, DOC_OK, "", FIXTURE_FLOOR);
  const lines = DOC_OK.split("\n");
  assert.equal(issues[0].file, DOC_REL);
  assert.equal(lines[issues[0].line - 1], "- one"); // the cited line IS the divergent one
});

test("(a) `compared` counts only slugs actually byte-compared — a gate that compares nothing is the defect", () => {
  // Doc has one region; the other template is unregioned and therefore uncompared.
  const { compared } = checkParity(TEMPLATES, doc(region("alpha", "# Alpha", "- one")), "", FIXTURE_FLOOR);
  assert.equal(compared, 1);
});

// --- (b) completeness -------------------------------------------------------

test("(b) a template with no SKELETON region is CAUGHT", () => {
  const { issues } = checkParity(TEMPLATES, doc(region("alpha", "# Alpha", "- one")), "", FIXTURE_FLOOR);
  // An unregioned template is also an UNCOMPARED one, so the coverage floor fires alongside.
  assert.deepEqual(rules(issues), ["completeness", "coverage"]);
  assert.match(issues[0].message, /beta/);
  assert.equal(issues[0].file, DOC_REL);
});

test("(b) a SKELETON region with no template is CAUGHT (orphans fail in BOTH directions)", () => {
  const withGhost = doc(
    region("alpha", "# Alpha", "- one"),
    region("beta", "# Beta"),
    region("ghost", "# Ghost"),
  );
  const { issues } = checkParity(TEMPLATES, withGhost, "", FIXTURE_FLOOR);
  assert.deepEqual(rules(issues), ["completeness"]);
  assert.match(issues[0].message, /ghost/);
});

test("(b) a region whose marker lost its fenced block fails loudly instead of skipping silently", () => {
  const broken = doc(region("alpha", "# Alpha", "- one"), "<!-- SKELETON:beta -->", "# Beta", "");
  const { issues, compared } = checkParity(TEMPLATES, broken, "", FIXTURE_FLOOR);
  assert.deepEqual(rules(issues), ["completeness", "coverage"]);
  assert.match(issues[0].message, /beta/);
  assert.equal(compared, 1);
});

test("(b) an empty doc fails every slug rather than passing vacuously", () => {
  const { issues, compared } = checkParity(TEMPLATES, "", "", FIXTURE_FLOOR);
  assert.equal(compared, 0);
  // An empty doc also lacks the standalone <!-- TEMPLATE:END --> terminator → the marker-grammar
  // rule fires alongside completeness/coverage. Every failure here is true; none is vacuous.
  assert.deepEqual(rules(issues), ["template-markers", "completeness", "completeness", "coverage"]);
});

// --- (c) encodability -------------------------------------------------------

test("(c) a template containing a triple-backtick fence is CAUGHT (it would close its region early)", () => {
  const bad = { ...TEMPLATES, alpha: "# Alpha\n```js\ncode\n```\n" };
  const { issues } = checkParity(bad, DOC_OK, "export const PLAN_TEMPLATES = {\n  alpha: `x`,", FIXTURE_FLOOR);
  assert.ok(rules(issues).includes("encodability"));
  const enc = issues.find((i) => i.rule === "encodability");
  assert.match(enc.message, /alpha/);
  assert.equal(enc.file, SRC_REL);
  assert.equal(enc.line, 2); // points at the offending key in bootstrap.mjs
});

test("(c) a template containing the literal <!-- TEMPLATE: is CAUGHT (it would truncate emit-template's last slice)", () => {
  const bad = { ...TEMPLATES, beta: "# Beta\n<!-- TEMPLATE:beta -->\n" };
  const { issues } = checkParity(bad, DOC_OK, "", FIXTURE_FLOOR);
  const enc = issues.filter((i) => i.rule === "encodability");
  assert.equal(enc.length, 1);
  assert.match(enc[0].message, /beta/);
});

// --- (d) typing / (e) line-endings / (f) duplicate-region / (g) coverage -----
// The four ways the reviewer got this gate to pass while comparing garbage, or nothing at all.

test("(f) THE SHADOWED REGION: a duplicate SKELETON marker is CAUGHT, naming BOTH lines", () => {
  // The reviewer's fixture. Two `SKELETON:alpha` regions; the FIRST — the one a human reading
  // the doc actually reads — is garbage. Last-wins silently compared the second and reported
  // issues=0. First-wins + a duplicate report means neither copy can hide.
  const shadowed = doc(
    region("alpha", "TOTAL GARBAGE"),
    region("beta", "# Beta"),
    region("alpha", "# Alpha", "- one"),
  );
  const { issues } = checkParity(TEMPLATES, shadowed, "", FIXTURE_FLOOR);
  const dup = issues.find((i) => i.rule === "duplicate-region");
  assert.ok(dup, `expected a duplicate-region issue, got: ${rules(issues).join(",")}`);
  assert.match(dup.message, /alpha/);
  const lines = shadowed.split("\n");
  const markers = lines.reduce((a, l, i) => (l === "<!-- SKELETON:alpha -->" ? [...a, i + 1] : a), []);
  assert.equal(markers.length, 2);
  assert.match(dup.message, new RegExp(`${markers[0]} and ${markers[1]}`)); // both lines named
  // And the garbage first region is what got compared, so parity fails too — it cannot hide.
  assert.ok(rules(issues).includes("parity"));
});

test("(g) THE VACUOUS PASS: checkParity({}, \"\") compares nothing and must FAIL on coverage", () => {
  // This returned issues=0, compared=0 and PASSED. `make validate` runs the CLI, not the suite,
  // so the floor has to live in the gate — an assertion here would have left it to a human.
  const { issues, compared } = checkParity({}, "");
  assert.equal(compared, 0);
  // Missing-END (marker-grammar) fires too — a malformed doc is not a passing one.
  assert.deepEqual(rules(issues), ["template-markers", "coverage"]);
  assert.match(issues.find((i) => i.rule === "coverage").message, /0 of 12/);
});

test("(g) EXPECTED_SLUGS is the real floor: the live template count must not drop below it", () => {
  assert.equal(EXPECTED_SLUGS, 12);
  assert.ok(Object.keys(PLAN_TEMPLATES).length >= EXPECTED_SLUGS);
});

test("(d) a non-string template is REPORTED, not thrown on", () => {
  const bad = { ...TEMPLATES, beta: 42 };
  let out;
  assert.doesNotThrow(() => {
    out = checkParity(bad, DOC_OK, "export const PLAN_TEMPLATES = {\n  beta: 42,", FIXTURE_FLOOR);
  }, "a non-string template used to blow up with a raw TypeError");
  const typing = out.issues.find((i) => i.rule === "typing");
  assert.ok(typing);
  assert.match(typing.message, /beta is number/);
  assert.equal(typing.file, SRC_REL);
  assert.equal(out.compared, 1); // beta's byte rules skipped; alpha still compared
});

test("(e) a CRLF doc emits ONE line-endings hint instead of a wall of unexplained parity failures", () => {
  const { issues } = checkParity(TEMPLATES, DOC_OK.replace(/\n/g, "\r\n"), "", FIXTURE_FLOOR);
  const hint = issues.filter((i) => i.rule === "line-endings");
  assert.equal(hint.length, 1);
  assert.equal(hint[0].line, 1);
  assert.match(hint[0].message, /CRLF/);
});

// --- (h) header-copy --------------------------------------------------------
// The predecessor rule classified PROSE (a 4-phrase set) and fell to the first synonym tried.
// This one COMPARES BYTES against PLAN_TEMPLATES' headers, so there is nothing to reword around.
// It was deleted, not extended: a successful synonym proves the whole CATEGORY was wrong.

test("(h) header returns the leading run up to the first blank line, and nothing below it", () => {
  assert.deepEqual(header("# A\n*sub*\n\n## Body\n"), ["# A", "*sub*"]);
  assert.deepEqual(header("# Only\n"), ["# Only"]); // a 1-line header — below the threshold, by design
  assert.deepEqual(header(""), []);
});

test("(h) a template's header lines restated in the worked-example half are CAUGHT, naming the slug", () => {
  const withCopy = [
    "# Formats",
    "",
    "# Alpha",
    "- one",
    "",
    "<!-- TEMPLATE:state -->",
    "<!-- TEMPLATE:END -->",
    "",
    region("alpha", "# Alpha", "- one"),
    region("beta", "# Beta"),
    "<!-- SKELETON:END -->",
    "",
  ].join("\n");
  const { issues } = checkParity(TEMPLATES, withCopy, "", FIXTURE_FLOOR);
  const copy = issues.filter((i) => i.rule === "header-copy");
  assert.equal(copy.length, 1);
  assert.equal(copy[0].line, 3); // the first line of the offending run, 1-based
  assert.match(copy[0].message, /PLAN_TEMPLATES\.alpha/);
  assert.match(copy[0].message, /SKELETON:alpha/); // the message says where the bytes DO belong
  assert.equal(copy[0].file, DOC_REL);
});

test("(h) the SAME bytes AFTER <!-- TEMPLATE:END --> do NOT trip it — that half is the gated one", () => {
  // The whole point: the skeleton half is where bootstrap's bytes are SUPPOSED to be stated (every
  // region body IS a header). A rule that fired there would forbid the one copy the gate enforces.
  const { issues } = checkParity(TEMPLATES, DOC_OK, "", FIXTURE_FLOOR);
  assert.deepEqual(rules(issues), []);
});

test("(h) a 1-line header does NOT fire — the named gap, pinned so it cannot be silently closed", () => {
  // `beta` (like the real `plan`/`progress`) has a 1-line header. Lowering the threshold to 1
  // would fire on every `# Progress` heading in the doc. The gap is declared in CLAUDE.md and in
  // the Region<->bytes contract; this test is here so a future maintainer meets it deliberately.
  const withBeta = [
    "# Formats", "", "# Beta", "", "<!-- TEMPLATE:state -->", "<!-- TEMPLATE:END -->", "",
    region("alpha", "# Alpha", "- one"), region("beta", "# Beta"), "<!-- SKELETON:END -->", "",
  ].join("\n");
  assert.deepEqual(rules(checkParity(TEMPLATES, withBeta, "", FIXTURE_FLOOR).issues), []);
});

// --- (f)+(h) the SCAN BOUNDARY (D-008: one shared definition) ----------------
// Every (h) test above asks what the rule does INSIDE its window. These ask where the window ENDS
// — which is where the hole was, four times. The window is now `servedRegionEnd` (imported from
// emit-template.mjs), so the two consumers cannot disagree; the marker-grammar rule `template-markers`
// is defense-in-depth catching a renamed/duplicated/post-END marker LOUDLY.

test("(f) TWO <!-- TEMPLATE:END --> MARKERS: the marker-grammar rule FAILs, naming both lines", () => {
  const d = [
    "# Formats",              // 1
    "",                       // 2
    "<!-- TEMPLATE:state -->",// 3 — a real slug, so servedRegionEnd is well-defined
    "<!-- TEMPLATE:END -->",  // 4 — first END (the served-region terminator of `state`)
    "",                       // 5
    "<!-- TEMPLATE:END -->",  // 6 — a second END
    "",
    region("alpha", "# Alpha", "- one"),
    region("beta", "# Beta"),
    "<!-- SKELETON:END -->",
    "",
  ].join("\n");
  const mk = checkParity(TEMPLATES, d, "", FIXTURE_FLOOR).issues.filter((i) => i.rule === "template-markers");
  assert.equal(mk.length, 1);
  assert.match(mk[0].message, /found 2/);
  assert.match(mk[0].message, /lines 4, 6/); // both, so the reader can see the duplicate
});

test("(h) A DECOY END CANNOT SHRINK THE SCAN: a header copy below it, before the real terminator, is CAUGHT", () => {
  // The hole, closed structurally. Under the OLD exact-line-END boundary a decoy END inserted early
  // shrank the scan and hid everything below it. servedRegionEnd anchors to the LAST SLUG's terminator,
  // so an early decoy END is inert: the copy planted below it stays inside the served region → CAUGHT.
  // (The duplicate END also trips the marker-grammar rule.)
  const d = [
    "# Formats",              // 1
    "",                       // 2
    "<!-- TEMPLATE:END -->",  // 3 — decoy; the OLD first-match scan stopped here
    "",                       // 4
    "<!-- TEMPLATE:state -->",// 5 — a real slug; its terminator is the real boundary
    "# Alpha",                // 6 — bootstrap's bytes, in the half emit-template serves
    "- one",                  // 7
    "<!-- TEMPLATE:END -->",  // 8 — the real terminator
    "",
    region("alpha", "# Alpha", "- one"),
    region("beta", "# Beta"),
    "<!-- SKELETON:END -->",
    "",
  ].join("\n");
  const { issues } = checkParity(TEMPLATES, d, "", FIXTURE_FLOOR);
  const copy = issues.filter((i) => i.rule === "header-copy");
  assert.equal(copy.length, 1);
  assert.equal(copy[0].line, 6);
  assert.match(copy[0].message, /PLAN_TEMPLATES\.alpha/);
  assert.ok(issues.some((i) => i.rule === "template-markers")); // the duplicate END, reported loudly
});

test("(S3) BOUNDARY AGREEMENT: the checker scans EXACTLY up to emit-template's servedRegionEnd", () => {
  // The load-bearing new invariant (D-008): the checker's scan boundary is not re-derived — it IS
  // servedRegionEnd. On the real doc the boundary is the <!-- TEMPLATE:END --> line, never the prose
  // substrings after it; and no exact-token boundary detection survives in the checker source.
  assert.equal(REAL_DOC.split("\n")[servedRegionEnd(REAL_DOC)].trim(), "<!-- TEMPLATE:END -->");
  const checkerSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "check-template-parity.mjs"), "utf8");
  assert.equal(checkerSrc.includes('=== "<!-- TEMPLATE:END -->"'), false);

  // A doc where a NAIVE last-exact-END disagrees with servedRegionEnd: rename the real terminator and
  // add an early decoy END. servedRegionEnd anchors to the last slug (`state`) → the renamed marker; a
  // naive END-scan would stop at the decoy. A header copy planted BETWEEN them must be CAUGHT — proving
  // the checker scanned to servedRegionEnd, not to the decoy.
  const d = [
    "# Formats", "",                 // 1,2
    "<!-- TEMPLATE:END -->", "",     // 3 decoy, 4
    "<!-- TEMPLATE:state -->",       // 5 — the last slug
    "# Alpha", "- one",              // 6,7 — copy between the decoy and the real terminator
    "<!-- TEMPLATE:END-OF-LIST -->", // 8 — the real terminator, renamed (invisible to an exact-END scan)
    "",
    region("alpha", "# Alpha", "- one"), region("beta", "# Beta"), "<!-- SKELETON:END -->", "",
  ].join("\n");
  const stop = servedRegionEnd(d);
  assert.equal(d.split("\n")[stop].trim(), "<!-- TEMPLATE:END-OF-LIST -->"); // NOT the decoy at line 3
  const copy = checkParity(TEMPLATES, d, "", FIXTURE_FLOOR).issues.filter((i) => i.rule === "header-copy");
  assert.equal(copy.length, 1);
  assert.equal(copy[0].line, 6);
});

test("(S4) REVIEWER 4's EXACT EXPLOIT IS DEAD: rename END + early decoy + planted index header → FAIL", () => {
  // Reviewer 4's exact move against the REAL doc: rename the real terminator, insert one fresh decoy
  // <!-- TEMPLATE:END --> before <!-- TEMPLATE:index -->, and plant index's real header plus a line
  // bootstrap never writes below the decoy. Under the OLD exact-line-END boundary the scan shrank to
  // the decoy (1016 -> 753) and the poison rode in with the board green. Now servedRegionEnd anchors
  // to the last slug's terminator (the renamed marker), so the poison is scanned -> header-copy; and
  // the rename leaves the real END renamed, so the marker-grammar rule FAILs too. The poison cannot hide.
  const lines = REAL_DOC.split("\n");
  const realEnd = lines.findIndex((l) => l.trim() === "<!-- TEMPLATE:END -->");
  assert.notEqual(realEnd, -1);
  lines[realEnd] = "<!-- TEMPLATE:END-OF-LIST -->"; // rename the real terminator
  const idxAt = lines.findIndex((l) => l.trim() === "<!-- TEMPLATE:index -->");
  assert.notEqual(idxAt, -1);
  lines.splice(idxAt, 0,
    "<!-- TEMPLATE:END -->", "",
    ...header(PLAN_TEMPLATES.index),
    "*Retention: NEVER trimmed, even past the 20-plan window.*", "");
  const { issues } = checkParity(PLAN_TEMPLATES, lines.join("\n"), REAL_SRC);
  assert.ok(
    issues.some((i) => i.rule === "header-copy" && i.message.includes("PLAN_TEMPLATES.index")),
    "the planted index header sits below the shared boundary and must be CAUGHT",
  );
  assert.ok(
    issues.some((i) => i.rule === "template-markers"),
    "renaming the terminator must FAIL the marker-grammar rule (its standalone END is gone / not last)",
  );
});

test("(S5) STRUCTURAL: an earlier decoy END never pulls the boundary earlier; a later slug only widens it", () => {
  // Property-style, over every decoy position. The boundary is always the terminator that FOLLOWS the
  // last slug — never an earlier decoy END — so a boundary an attacker can move may only ever WIDEN.
  const base = [
    "<!-- TEMPLATE:state -->", "state body",
    "<!-- TEMPLATE:index -->", "index body",
    "<!-- TEMPLATE:END -->", "skeleton",
  ];
  const lastSlug = base.lastIndexOf("<!-- TEMPLATE:index -->");
  for (let p = 0; p <= lastSlug; p++) {
    const d = [...base.slice(0, p), "<!-- TEMPLATE:END -->", ...base.slice(p)];
    const e = servedRegionEnd(d.join("\n"));
    assert.equal(d[e], "<!-- TEMPLATE:END -->"); // still lands on an END terminator
    assert.ok(e > d.lastIndexOf("<!-- TEMPLATE:index -->"), `decoy at ${p} shrank the boundary past the last slug`);
  }
  // A later valid slug moves the last-slug terminator later — widen only.
  const widened = [...base, "<!-- TEMPLATE:summary -->", "more", "<!-- TEMPLATE:END -->"];
  assert.ok(servedRegionEnd(widened.join("\n")) > servedRegionEnd(base.join("\n")));
});

// --- (h) against the REAL doc and the REAL templates ------------------------
// D-006: a criterion that names a specific defect tests that defect; only a criterion that
// quantifies over all instances tests the property. Iterations 1 and 2 both shipped green boards
// over a false property because their criteria named `changelog` and `lessons`. These name no slug.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REAL_DOC = readFileSync(join(ROOT, DOC_REL), "utf8");
const REAL_SRC = readFileSync(join(ROOT, SRC_REL), "utf8");

// Splice payload lines into the worked-example half, immediately after a TEMPLATE region marker.
const injectAfter = (docText, marker, payload) => {
  const lines = docText.split("\n");
  const at = lines.findIndex((l) => l.trim() === marker);
  assert.notEqual(at, -1, `fixture marker not found in the real doc: ${marker}`);
  lines.splice(at + 1, 0, "", ...payload, "");
  return lines.join("\n");
};

const headerCopies = (docText) =>
  checkParity(PLAN_TEMPLATES, docText, REAL_SRC).issues.filter((i) => i.rule === "header-copy");

test("(S1) THE INVARIANT: no slug's header bytes appear before TEMPLATE:END in the real doc", () => {
  // Quantified over every template — it names no slug. This is the property iterations 1 and 2
  // never tested: not "is the changelog block gone?" but "does the doc restate bootstrap ANYWHERE
  // un-gated?". If a future edit reintroduces ANY header copy, for ANY slug, this goes red.
  assert.deepEqual(headerCopies(REAL_DOC), [], "the worked-example half restates bootstrap's bytes");
  assert.equal(Object.keys(PLAN_TEMPLATES).length, EXPECTED_SLUGS);
});

test("(S2) THE GATE IS NOT VACUOUS: injecting ANY slug's header pair FAILs, for EVERY such slug", () => {
  // Pre-Mortem Scenario 2, killed: a rule proven to fire for ONE slug is what iteration 2 shipped.
  // Loop over every slug with a >=2-line header and demand a failure naming THAT slug.
  const multi = Object.keys(PLAN_TEMPLATES).filter((s) => header(PLAN_TEMPLATES[s]).length >= 2);
  const single = Object.keys(PLAN_TEMPLATES).filter((s) => header(PLAN_TEMPLATES[s]).length < 2);
  assert.deepEqual(single, ["plan", "progress"]); // the 1-line-header gap, enumerated not assumed
  assert.equal(multi.length, 10);
  for (const slug of multi) {
    const pair = header(PLAN_TEMPLATES[slug]).slice(0, 2);
    const hits = headerCopies(injectAfter(REAL_DOC, "<!-- TEMPLATE:progress -->", pair));
    assert.ok(
      hits.some((i) => i.message.includes(`PLAN_TEMPLATES.${slug}`)),
      `rule (h) does not fire for slug "${slug}" — a rule that cannot be shown to fire is not a rule`,
    );
  }
});

test("(S3) the reviewer's iter-2 evasion is DEAD — the synonym rule (h) missed is now a byte match", () => {
  // The exact payload that walked through the 4-phrase set: a synonym no phrase list contains,
  // followed by bootstrap's real changelog header and a planted lie. The prose is now irrelevant —
  // the HEADER BYTES are the match, and there is no way to write them that is not them.
  const payload = [
    "The freshly created file emitted by bootstrap contains exactly:",
    "",
    "```markdown",
    ...header(PLAN_TEMPLATES.changelog),
    "*THIS LINE IS A LIE BOOTSTRAP NEVER WRITES*",
    "```",
  ];
  const hits = headerCopies(injectAfter(REAL_DOC, "<!-- TEMPLATE:progress -->", payload));
  assert.ok(hits.some((i) => i.message.includes("PLAN_TEMPLATES.changelog")), "the iter-2 evasion still works");
});

test("(S4) LIVE BUG #2's shape is DEAD — a STALE SUBSET of a header (2 of 4 lines) FAILs", () => {
  // The original bug was never a whole copy: the doc restated 2 of bootstrap's 4 changelog header
  // lines and dropped the rest. A rule matching only whole headers would have sailed past it.
  const subset = header(PLAN_TEMPLATES.changelog).slice(0, 2);
  assert.equal(header(PLAN_TEMPLATES.changelog).length, 4); // it IS a subset, not the whole header
  const hits = headerCopies(injectAfter(REAL_DOC, "<!-- TEMPLATE:findings -->", subset));
  assert.ok(hits.some((i) => i.message.includes("PLAN_TEMPLATES.changelog")));
});

test("(S5) NO FALSE POSITIVES: an example reusing skeleton structure BELOW the header PASSES", () => {
  // The test that stops a future maintainer from "fixing" a false positive with an allowlist.
  // A truthful populated example genuinely reuses a skeleton's structure — a table header + its
  // divider, a `## Completed` heading. Those live below the first blank line, outside HEADER, and
  // must not fire. If this ever goes red, the RULE's scope is wrong: re-scope it, never exempt.
  const t = { gamma: "# Gamma\n*subtitle*\n\n| Plan | Date |\n|------|------|\n## Completed\n" };
  const worked = ["# Formats", "", "| Plan | Date |", "|------|------|", "## Completed", "- [x] done", ""];
  const d = [
    ...worked,
    "<!-- TEMPLATE:state -->",
    "<!-- TEMPLATE:END -->",
    "",
    region("gamma", "# Gamma", "*subtitle*", "", "| Plan | Date |", "|------|------|", "## Completed"),
    "<!-- SKELETON:END -->",
    "",
  ].join("\n");
  assert.deepEqual(rules(checkParity(t, d, "", 1).issues), []);
});

test("(A6) THE ATTACKER-CONTROLLED BOUNDARY: a decoy TEMPLATE:END hiding a planted header copy is CAUGHT", () => {
  // The iteration-3 reviewer's exploit, verbatim — the third consecutive guard to fall to the first
  // reviewer who attacked it, and the only one caught before it shipped. ONE inserted line, a
  // `<!-- TEMPLATE:END -->` above an existing TEMPLATE marker, truncated NO emit-template slice (that
  // parser splits on ANY `<!-- TEMPLATE:` marker, so the byte offset was already a slice boundary) but
  // moved rule (h)'s stop from doc line 1016 to 541, leaving TEN worked examples unscanned. Bootstrap's
  // exact `findings-consolidated` header plus a line bootstrap never writes then rode in with the whole
  // board green — PASS, 604/604 — and `emit-template --name findings-consolidated` served it to agents.
  const slug = "findings-consolidated";
  const lines = REAL_DOC.split("\n");
  const at = lines.findIndex((l) => l.trim() === `<!-- TEMPLATE:${slug} -->`);
  assert.notEqual(at, -1, "fixture marker not found in the real doc");
  lines.splice(at, 0, "<!-- TEMPLATE:END -->", ""); // the decoy boundary
  const fence = lines.findIndex((l, i) => i > at && l.trim() === "```markdown");
  lines.splice(fence + 1, 0, ...header(PLAN_TEMPLATES[slug]), "*A LINE BOOTSTRAP NEVER WRITES*");
  const { issues } = checkParity(PLAN_TEMPLATES, lines.join("\n"), REAL_SRC);
  assert.ok(
    issues.some((i) => i.rule === "header-copy" && i.message.includes(`PLAN_TEMPLATES.${slug}`)),
    "the planted header copy sits below the shared boundary and must be CAUGHT",
  );
  assert.ok(
    issues.some((i) => i.rule === "template-markers" && i.message.includes("TEMPLATE:END")),
    "the decoy boundary itself must be reported by the marker-grammar rule",
  );
});

test("(A6) the real doc has EXACTLY ONE TEMPLATE:END — rule (h)'s boundary is unambiguous", () => {
  // The other half of the fix: `stop` is the LAST end, so a decoy can only widen the scan. That is
  // fail-closed but silent, and a doc with two boundaries is a doc nobody can reason about. Pin the
  // count so the ambiguity itself stays red, not just its consequences.
  const ends = REAL_DOC.split("\n").filter((l) => l.trim() === "<!-- TEMPLATE:END -->");
  assert.equal(ends.length, 1);
  assert.deepEqual(headerCopies(REAL_DOC), []);
});

// --- report -----------------------------------------------------------------

test("report renders the house failure format: two-space indent, file:line, [rule], message", () => {
  const { issues } = checkParity({ ...TEMPLATES, beta: "# BETA\n" }, DOC_OK, "", FIXTURE_FLOOR);
  assert.match(report(issues), /^ {2}src\/references\/file-formats\.md:\d+ \[parity\] /);
});

// --- the real repo (this is the gate itself, run against live inputs) --------

// The elision has a cost, and this is the guard on it: eliding a header must not gut the
// example. What agents are served is the POPULATED body — the part a skeleton cannot show them.
// (The invariant itself — no header bytes anywhere in the worked half — is S1's job, and S1
// names no slug. This test is about the examples remaining USEFUL, not about the gate.)
test("the elided worked examples still serve agents their populated bodies", () => {
  const index = resolveTemplate("index").body.toString();
  assert.match(index, /\| Plan \| Date \| Goal \| Key Topics \|/); // table header
  assert.match(index, /\|------\|------\|------\|------------\|/); // divider
  assert.equal((index.match(/\| plan-2026-02-\d\d/g) || []).length, 2); // both rows survive
  const lessons = resolveTemplate("lessons").body.toString();
  for (const s of ["## Patterns That Work", "## What To Avoid", "## Codebase Gotchas", "## Recurring Traps"]) {
    assert.ok(lessons.includes(s), `lessons lost its ${s} section to the elision`);
  }
  for (const slug of ["findings-consolidated", "decisions-consolidated"]) {
    const t = resolveTemplate(slug).body.toString();
    assert.match(t, /## plan-2026-02-20T141005-b4e2c3d0/); // the per-plan sections survive
    assert.match(t, /<!-- COMPRESSED-SUMMARY -->/); // and the compression structure
  }
});

test("the LIVE bootstrap templates byte-match the LIVE file-formats.md skeletons — 12 slugs", () => {
  const { issues, compared } = checkParity(PLAN_TEMPLATES, REAL_DOC, REAL_SRC);
  assert.deepEqual(issues, [], report(issues));
  assert.equal(compared, 12);
  assert.equal(Object.keys(PLAN_TEMPLATES).length, 12);
});
