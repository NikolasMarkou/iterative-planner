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
import { resolveTemplate, VALID_TEMPLATES } from "./emit-template.mjs";

// --- fixtures ---------------------------------------------------------------

// A minimal doc in the real shape: worked-example prose, a REAL <!-- TEMPLATE:<slug> --> marker, the
// TEMPLATE:END boundary, then the SKELETON regions, then the SKELETON END terminator. `state` is a
// real slug in VALID_TEMPLATES; the fixture's own template keys (alpha/beta) are deliberately NOT.
// The served-artifact check (rules h/i) is scoped OFF (`[]`) for these parity fixtures — they carry
// only alpha/beta, not the 17 real markers resolveTemplate needs, so a default served scope would
// (correctly) fail every absent slug. Served-substrate behaviour is tested against the REAL doc below.
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
// Parity-fixture calls scope the served-artifact check OFF: these docs have no real slug markers.
const cp = (t, d, src = "", floor = FIXTURE_FLOOR, servedScope = []) => checkParity(t, d, src, floor, servedScope);

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
  const { issues, compared } = cp(TEMPLATES, DOC_OK);
  assert.deepEqual(issues, []);
  assert.equal(compared, 2);
});

test("(a) THE DEFECT: a one-character drift in a template body is CAUGHT", () => {
  const drifted = { ...TEMPLATES, alpha: "# Alpha\n- onE\n" };
  const { issues } = cp(drifted, DOC_OK);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, "parity");
  assert.match(issues[0].message, /alpha/);
  assert.match(msgs(issues), /- one/); // shows both sides of the drift
});

test("(a) THE SUBTLE ONE: a trailing-newline-only difference is CAUGHT", () => {
  const drifted = { ...TEMPLATES, beta: "# Beta" }; // lost its trailing newline
  const { issues } = cp(drifted, DOC_OK);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, "parity");
  assert.match(issues[0].message, /beta/);
});

test("(a) a whitespace-only difference is CAUGHT (trailing space is not invisible to a gate)", () => {
  const drifted = { ...TEMPLATES, alpha: "# Alpha\n- one \n" };
  const { issues } = cp(drifted, DOC_OK);
  assert.deepEqual(rules(issues), ["parity"]);
});

test("(a) a parity failure points at a real line in the doc, so the failure names a place", () => {
  const drifted = { ...TEMPLATES, alpha: "# Alpha\n- two\n" };
  const { issues } = cp(drifted, DOC_OK);
  const lines = DOC_OK.split("\n");
  assert.equal(issues[0].file, DOC_REL);
  assert.equal(lines[issues[0].line - 1], "- one"); // the cited line IS the divergent one
});

test("(a) `compared` counts only slugs actually byte-compared — a gate that compares nothing is the defect", () => {
  // Doc has one region; the other template is unregioned and therefore uncompared.
  const { compared } = cp(TEMPLATES, doc(region("alpha", "# Alpha", "- one")));
  assert.equal(compared, 1);
});

// --- (b) completeness -------------------------------------------------------

test("(b) a template with no SKELETON region is CAUGHT", () => {
  const { issues } = cp(TEMPLATES, doc(region("alpha", "# Alpha", "- one")));
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
  const { issues } = cp(TEMPLATES, withGhost);
  assert.deepEqual(rules(issues), ["completeness"]);
  assert.match(issues[0].message, /ghost/);
});

test("(b) a region whose marker lost its fenced block fails loudly instead of skipping silently", () => {
  const broken = doc(region("alpha", "# Alpha", "- one"), "<!-- SKELETON:beta -->", "# Beta", "");
  const { issues, compared } = cp(TEMPLATES, broken);
  assert.deepEqual(rules(issues), ["completeness", "coverage"]);
  assert.match(issues[0].message, /beta/);
  assert.equal(compared, 1);
});

test("(b) an empty doc fails every slug rather than passing vacuously", () => {
  const { issues, compared } = cp(TEMPLATES, "");
  assert.equal(compared, 0);
  // Both templates are unregioned, and the coverage floor fires. Every failure here is true.
  assert.deepEqual(rules(issues), ["completeness", "completeness", "coverage"]);
});

// --- (c) encodability -------------------------------------------------------

test("(c) a template containing a triple-backtick fence is CAUGHT (it would close its region early)", () => {
  const bad = { ...TEMPLATES, alpha: "# Alpha\n```js\ncode\n```\n" };
  const { issues } = cp(bad, DOC_OK, "export const PLAN_TEMPLATES = {\n  alpha: `x`,");
  assert.ok(rules(issues).includes("encodability"));
  const enc = issues.find((i) => i.rule === "encodability");
  assert.match(enc.message, /alpha/);
  assert.equal(enc.file, SRC_REL);
  assert.equal(enc.line, 2); // points at the offending key in bootstrap.mjs
});

test("(c) a template containing the literal <!-- TEMPLATE: is CAUGHT (it would truncate emit-template's last slice)", () => {
  const bad = { ...TEMPLATES, beta: "# Beta\n<!-- TEMPLATE:beta -->\n" };
  const { issues } = cp(bad, DOC_OK);
  const enc = issues.filter((i) => i.rule === "encodability");
  assert.equal(enc.length, 1);
  assert.match(enc[0].message, /beta/);
});

// --- (d) typing / (e) line-endings / (f) duplicate-region / (g) coverage -----
// The ways the reviewer got this gate to pass while comparing garbage, or nothing at all.

test("(f) THE SHADOWED REGION: a duplicate SKELETON marker is CAUGHT, naming BOTH lines", () => {
  // The reviewer's fixture. Two `SKELETON:alpha` regions; the FIRST — the one a human reading
  // the doc actually reads — is garbage. Last-wins silently compared the second and reported
  // issues=0. First-wins + a duplicate report means neither copy can hide.
  const shadowed = doc(
    region("alpha", "TOTAL GARBAGE"),
    region("beta", "# Beta"),
    region("alpha", "# Alpha", "- one"),
  );
  const { issues } = cp(TEMPLATES, shadowed);
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
  // so the floor has to live in the gate — an assertion here would have left it to a human. The
  // served scope is off ([]) so this isolates the coverage floor.
  const { issues, compared } = checkParity({}, "", "", EXPECTED_SLUGS, []);
  assert.equal(compared, 0);
  assert.deepEqual(rules(issues), ["coverage"]);
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
    out = cp(bad, DOC_OK, "export const PLAN_TEMPLATES = {\n  beta: 42,");
  }, "a non-string template used to blow up with a raw TypeError");
  const typing = out.issues.find((i) => i.rule === "typing");
  assert.ok(typing);
  assert.match(typing.message, /beta is number/);
  assert.equal(typing.file, SRC_REL);
  assert.equal(out.compared, 1); // beta's byte rules skipped; alpha still compared
});

test("(e) a CRLF doc emits ONE line-endings hint instead of a wall of unexplained parity failures", () => {
  const { issues } = cp(TEMPLATES, DOC_OK.replace(/\n/g, "\r\n"));
  const hint = issues.filter((i) => i.rule === "line-endings");
  assert.equal(hint.length, 1);
  assert.equal(hint[0].line, 1);
  assert.match(hint[0].message, /CRLF/);
});

// --- (h) header-copy — the pure header extractor ----------------------------

test("(h) header returns the leading run up to the first blank line, and nothing below it", () => {
  assert.deepEqual(header("# A\n*sub*\n\n## Body\n"), ["# A", "*sub*"]);
  assert.deepEqual(header("# Only\n"), ["# Only"]); // a 1-line header — below the threshold, by design
  assert.deepEqual(header(""), []);
});

test("(h) a header pair restated in a SERVED body is CAUGHT, naming the served slug + the restated one", () => {
  // The substrate is resolveTemplate's OUTPUT, not a doc region. `state` is a real slug; its served
  // body here carries alpha's header pair, so header-copy fires naming BOTH (served via state, restates
  // PLAN_TEMPLATES.alpha). servedScope = ["state"] resolves exactly the one slug this fixture provides.
  const d = [
    "# Formats", "",
    "<!-- TEMPLATE:state -->",
    "# Alpha", "- one",
    "<!-- TEMPLATE:END -->", "",
    region("alpha", "# Alpha", "- one"), region("beta", "# Beta"), "<!-- SKELETON:END -->", "",
  ].join("\n");
  const { issues } = checkParity(TEMPLATES, d, "", FIXTURE_FLOOR, ["state"]);
  const copy = issues.filter((i) => i.rule === "header-copy");
  assert.equal(copy.length, 1);
  assert.match(copy[0].message, /PLAN_TEMPLATES\.alpha/); // the restated slug
  assert.match(copy[0].message, /--name state/);          // the served slug
  assert.match(copy[0].message, /SKELETON:alpha/);        // where the bytes DO belong
  assert.equal(copy[0].file, DOC_REL);
});

test("(h) a 1-line header does NOT fire — the named gap, pinned so it cannot be silently closed", () => {
  // `beta` (like the real `plan`/`progress`) has a 1-line header. Lowering the threshold to 1 would
  // fire on every `# Progress` heading. The gap is declared in CLAUDE.md; this test meets it deliberately.
  const d = [
    "# Formats", "",
    "<!-- TEMPLATE:state -->", "# Beta", "<!-- TEMPLATE:END -->", "",
    region("alpha", "# Alpha", "- one"), region("beta", "# Beta"), "<!-- SKELETON:END -->", "",
  ].join("\n");
  assert.deepEqual(rules(checkParity(TEMPLATES, d, "", FIXTURE_FLOOR, ["state"]).issues), []);
});

test("(no false positive) a served body reusing skeleton structure BELOW the header PASSES", () => {
  // The test that stops a future maintainer from "fixing" a false positive with an allowlist.
  // A truthful populated example genuinely reuses a skeleton's structure — a table header + its
  // divider, a `## Completed` heading. Those live below the first blank line, outside HEADER, and
  // must not fire. If this ever goes red, the RULE's scope is wrong: re-scope it, never exempt.
  const t = { gamma: "# Gamma\n*subtitle*\n\n| Plan | Date |\n|------|------|\n## Completed\n" };
  const d = [
    "# Formats", "",
    "<!-- TEMPLATE:state -->",
    "| Plan | Date |", "|------|------|", "## Completed", "- [x] done",
    "<!-- TEMPLATE:END -->", "",
    region("gamma", "# Gamma", "*subtitle*", "", "| Plan | Date |", "|------|------|", "## Completed"),
    "<!-- SKELETON:END -->", "",
  ].join("\n");
  assert.deepEqual(rules(checkParity(t, d, "", 1, ["state"]).issues), []);
});

// --- the served artifacts, against the REAL doc and the REAL templates -------
// D-009: check what emit-template SERVES, not a proxy for where it ends. D-006: a criterion that
// names a specific defect tests that defect; only a criterion that quantifies over all instances
// tests the property. S1/S2 loop and name no slug; S3/S4/S5 pin the substrate and the two exploits.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REAL_DOC = readFileSync(join(ROOT, DOC_REL), "utf8");
const REAL_SRC = readFileSync(join(ROOT, SRC_REL), "utf8");

// Splice payload lines into a slug's SERVED body, immediately after its TEMPLATE region marker.
const injectAfter = (docText, marker, payload) => {
  const lines = docText.split("\n");
  const at = lines.findIndex((l) => l.trim() === marker);
  assert.notEqual(at, -1, `fixture marker not found in the real doc: ${marker}`);
  lines.splice(at + 1, 0, "", ...payload, "");
  return lines.join("\n");
};

const headerCopies = (docText) =>
  checkParity(PLAN_TEMPLATES, docText, REAL_SRC).issues.filter((i) => i.rule === "header-copy");

test("(S1) THE INVARIANT, SERVED: no header pair appears in ANY of the 17 served bodies of the real doc", () => {
  // Quantified over every template and every served body — it names no slug. This is the property
  // iterations 1-5 never tested directly: not "is the changelog block gone?" nor "is the boundary
  // sound?" but "does ANY artifact emit-template serves restate bootstrap's bytes?". If a future
  // edit reintroduces ANY header copy in ANY served body, this goes red.
  assert.deepEqual(headerCopies(REAL_DOC), [], "a served body restates bootstrap's header bytes");
  const { served } = checkParity(PLAN_TEMPLATES, REAL_DOC, REAL_SRC);
  assert.equal(served, VALID_TEMPLATES.length);
  assert.equal(Object.keys(PLAN_TEMPLATES).length, EXPECTED_SLUGS);
});

test("(S2) THE GATE IS NOT VACUOUS, SERVED: injecting each slug's header pair into its OWN served body FAILs", () => {
  // Pre-Mortem Scenario 2, killed: a rule proven to fire for ONE slug is what iteration 2 shipped.
  // Loop over every slug with a >=2-line header; inject its pair right after its OWN marker (so
  // resolveTemplate serves it) and demand a failure naming THAT slug.
  const multi = Object.keys(PLAN_TEMPLATES).filter((s) => header(PLAN_TEMPLATES[s]).length >= 2);
  const single = Object.keys(PLAN_TEMPLATES).filter((s) => header(PLAN_TEMPLATES[s]).length < 2);
  assert.deepEqual(single, ["plan", "progress"]); // the 1-line-header gap, enumerated not assumed
  assert.equal(multi.length, 10);
  for (const slug of multi) {
    const pair = header(PLAN_TEMPLATES[slug]).slice(0, 2);
    const hits = headerCopies(injectAfter(REAL_DOC, `<!-- TEMPLATE:${slug} -->`, pair));
    assert.ok(
      hits.some((i) => i.message.includes(`PLAN_TEMPLATES.${slug}`)),
      `rule (h) does not fire for slug "${slug}" — a rule that cannot be shown to fire is not a rule`,
    );
  }
});

test("(S3) THE SUBSTRATE IS THE SERVED ARTIFACTS: the check resolves all 17 slugs via resolveTemplate", () => {
  // The load-bearing new criterion. Proven three ways: (1) the served count equals the full slug
  // set; (2) resolveTemplate HONORS a mid-line-only marker (unanchored indexOf — invisible to any
  // anchored-line boundary scan), which is exactly why the substrate must BE resolveTemplate; (3) no
  // boundary / servedRegion computation survives in the checker source — it imports the slicer.
  const { served } = checkParity(PLAN_TEMPLATES, REAL_DOC, REAL_SRC);
  assert.equal(served, 17);
  assert.equal(VALID_TEMPLATES.length, 17);

  const midLineDoc =
    "<!-- TEMPLATE:state -->\nreal state body\n<!-- TEMPLATE:END -->\n" +
    "prose then <!-- TEMPLATE:summary --> mid-line\nMID-LINE SERVED CONTENT\n<!-- SKELETON:END -->\n";
  const served2 = resolveTemplate("summary", Buffer.from(midLineDoc));
  assert.ok(served2.ok, "resolveTemplate must honor a mid-line substring marker");
  assert.match(served2.body.toString(), /MID-LINE SERVED CONTENT/);

  const checkerSrc = readFileSync(join(ROOT, "src/scripts/check-template-parity.mjs"), "utf8");
  // Token built dynamically (concatenated) so a source grep for the deleted boundary fn stays 0.
  assert.equal(checkerSrc.includes("servedRegion" + "End"), false); // the proxy is fully deleted
  assert.match(checkerSrc, /import \{ resolveTemplate/);             // the slicer itself is imported
});

test("(S4) REVIEWER 5's EXACT EXPLOIT IS DEAD: mid-line summary marker past END serving index's header → FAIL", () => {
  // Reviewer 5's exact move against the REAL doc: neutralize summary's real standalone marker, then
  // plant the same marker as a MID-LINE substring past <!-- TEMPLATE:END -->, followed by index's real
  // 2-line header and a line bootstrap never writes. resolveTemplate("summary")'s unanchored
  // first-occurrence now lands on the mid-line substring and SERVES the poison; the served-artifact
  // check inspects THAT body -> header-copy naming index. Under the old anchored boundary this rode in
  // with the board green (615/615). It cannot anymore.
  const lines = REAL_DOC.split("\n");
  const sumAt = lines.findIndex((l) => l.trim() === "<!-- TEMPLATE:summary -->");
  assert.notEqual(sumAt, -1);
  lines[sumAt] = "<!-- SUMMARYSECTION -->"; // neutralize the standalone marker (nothing checks it exists)
  const endAt = lines.findIndex((l) => l.trim() === "<!-- TEMPLATE:END -->");
  assert.notEqual(endAt, -1);
  lines.splice(endAt + 1, 0,
    "Fetch it via <!-- TEMPLATE:summary --> below.",
    ...header(PLAN_TEMPLATES.index),
    "*Retention: NEVER trimmed, even past the 20-plan window.*");
  const poisoned = lines.join("\n");

  // sanity: emit-template now SERVES the poison for `summary`
  const served = resolveTemplate("summary", Buffer.from(poisoned));
  assert.ok(served.ok);
  assert.ok(served.body.toString().includes(header(PLAN_TEMPLATES.index)[0]),
    "the poison must actually reach summary's served body");

  const { issues } = checkParity(PLAN_TEMPLATES, poisoned, REAL_SRC);
  assert.ok(
    issues.some((i) => i.rule === "header-copy" && i.message.includes("PLAN_TEMPLATES.index")),
    "the poison summary body restates index's header and must be CAUGHT",
  );
});

test("(S5) RESOLVE-FAILURE IS A LOUD FAIL: a removed slug marker FAILs naming it, never a silent skip", () => {
  // Concern 2's enabling half, closed. A slug whose marker is removed/renamed so resolveTemplate
  // returns !ok must FAIL naming the slug — never drop silently from the check (which was the
  // enabling half of the fifth break). Remove `decisions`' marker and demand a served-resolve FAIL.
  const slug = "decisions";
  const lines = REAL_DOC.split("\n");
  const at = lines.findIndex((l) => l.trim() === `<!-- TEMPLATE:${slug} -->`);
  assert.notEqual(at, -1);
  lines[at] = "<!-- a plain comment, no longer a marker -->";
  const { issues } = checkParity(PLAN_TEMPLATES, lines.join("\n"), REAL_SRC);
  const sr = issues.filter((i) => i.rule === "served-resolve");
  assert.ok(
    sr.some((i) => i.message.includes(`'${slug}'`)),
    `a removed marker must FAIL naming '${slug}', got: ${msgs(issues)}`,
  );
});

test("(S3b) the iter-2 evasion is DEAD — a synonym no phrase list contains is now a byte match in a served body", () => {
  // The exact payload that walked through the 4-phrase set: a synonym no phrase list contains,
  // followed by bootstrap's real changelog header and a planted lie, injected into progress's served
  // body. The prose is irrelevant now — the HEADER BYTES are the match, and there is no way to write
  // them that is not them.
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

test("(S4b) LIVE BUG #2's shape is DEAD — a STALE SUBSET of a header (2 of 4 lines) FAILs in a served body", () => {
  // The original bug was never a whole copy: the doc restated 2 of bootstrap's 4 changelog header
  // lines and dropped the rest. A rule matching only whole headers would have sailed past it.
  const subset = header(PLAN_TEMPLATES.changelog).slice(0, 2);
  assert.equal(header(PLAN_TEMPLATES.changelog).length, 4); // it IS a subset, not the whole header
  const hits = headerCopies(injectAfter(REAL_DOC, "<!-- TEMPLATE:findings -->", subset));
  assert.ok(hits.some((i) => i.message.includes("PLAN_TEMPLATES.changelog")));
});

// --- report -----------------------------------------------------------------

test("report renders the house failure format: two-space indent, file:line, [rule], message", () => {
  const { issues } = cp({ ...TEMPLATES, beta: "# BETA\n" }, DOC_OK);
  assert.match(report(issues), /^ {2}src\/references\/file-formats\.md:\d+ \[parity\] /);
});

// --- the real repo (this is the gate itself, run against live inputs) --------

// The elision has a cost, and this is the guard on it: eliding a header must not gut the
// example. What agents are served is the POPULATED body — the part a skeleton cannot show them.
// (The invariant itself — no header bytes in any served body — is S1's job, and S1 names no slug.
// This test is about the examples remaining USEFUL, not about the gate.)
test("the elided worked examples still serve agents their populated bodies", () => {
  const index = resolveTemplate("index").body.toString();
  assert.match(index, /\| Plan \| Date \| Goal \| Key Topics \|/); // table header
  assert.match(index, /\|------\|------\|------\|------------\|/); // divider
  assert.equal((index.match(/\| plan-2026-02-\d\d/g) || []).length, 2); // both rows survive
  const lessons = resolveTemplate("lessons").body.toString();
  for (const s of ["## Recurring Patterns", "## Failed Approaches (+ why)", "## Successful Strategies", "## Codebase Gotchas"]) {
    assert.ok(lessons.includes(s), `lessons lost its ${s} section to the elision`);
  }
  for (const slug of ["findings-consolidated", "decisions-consolidated"]) {
    const t = resolveTemplate(slug).body.toString();
    assert.match(t, /## plan-2026-02-20T141005-b4e2c3d0/); // the per-plan sections survive
    assert.match(t, /<!-- COMPRESSED-SUMMARY -->/); // and the compression structure
  }
});

test("the LIVE bootstrap templates byte-match the LIVE file-formats.md skeletons — 12 slugs, 17 served", () => {
  const { issues, compared, served } = checkParity(PLAN_TEMPLATES, REAL_DOC, REAL_SRC);
  assert.deepEqual(issues, [], report(issues));
  assert.equal(compared, 12);
  assert.equal(served, 17);
  assert.equal(Object.keys(PLAN_TEMPLATES).length, 12);
});
