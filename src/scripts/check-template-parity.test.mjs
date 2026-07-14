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
  checkParity,
  report,
  DOC_REL,
  SRC_REL,
} from "./check-template-parity.mjs";
import { PLAN_TEMPLATES } from "./bootstrap.mjs";
import { resolveTemplate } from "./emit-template.mjs";

// --- fixtures ---------------------------------------------------------------

// A minimal doc in the real shape: prose, then SKELETON regions, then the END terminator.
const doc = (...regions) =>
  ["# Formats", "", ...regions, "<!-- SKELETON:END -->", ""].join("\n");

const region = (slug, ...bodyLines) =>
  [`<!-- SKELETON:${slug} -->`, "```markdown", ...bodyLines, "```", ""].join("\n");

// Two templates, two matching regions. Bodies carry the trailing "\n" every template has.
const TEMPLATES = { alpha: "# Alpha\n- one\n", beta: "# Beta\n" };
const DOC_OK = doc(region("alpha", "# Alpha", "- one"), region("beta", "# Beta"));

const rules = (issues) => issues.map((i) => i.rule);
const msgs = (issues) => issues.map((i) => i.message).join(" | ");

// --- primitives -------------------------------------------------------------

test("parseSkeletons lifts each region body as bytes, with a 1-based doc line for the body", () => {
  const { regions, endLine } = parseSkeletons(DOC_OK);
  assert.deepEqual([...regions.keys()], ["alpha", "beta"]);
  assert.equal(regions.get("alpha").body, "# Alpha\n- one\n");
  assert.equal(regions.get("beta").body, "# Beta\n");
  // "# Formats"=1, ""=2, marker=3, fence=4, first body line=5.
  assert.equal(regions.get("alpha").bodyLine, 5);
  assert.equal(regions.get("alpha").markerLine, 3);
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
  const { issues, compared } = checkParity(TEMPLATES, DOC_OK);
  assert.deepEqual(issues, []);
  assert.equal(compared, 2);
});

test("(a) THE DEFECT: a one-character drift in a template body is CAUGHT", () => {
  const drifted = { ...TEMPLATES, alpha: "# Alpha\n- onE\n" };
  const { issues } = checkParity(drifted, DOC_OK);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, "parity");
  assert.match(issues[0].message, /alpha/);
  assert.match(msgs(issues), /- one/); // shows both sides of the drift
});

test("(a) THE SUBTLE ONE: a trailing-newline-only difference is CAUGHT", () => {
  const drifted = { ...TEMPLATES, beta: "# Beta" }; // lost its trailing newline
  const { issues } = checkParity(drifted, DOC_OK);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, "parity");
  assert.match(issues[0].message, /beta/);
});

test("(a) a whitespace-only difference is CAUGHT (trailing space is not invisible to a gate)", () => {
  const drifted = { ...TEMPLATES, alpha: "# Alpha\n- one \n" };
  const { issues } = checkParity(drifted, DOC_OK);
  assert.deepEqual(rules(issues), ["parity"]);
});

test("(a) a parity failure points at a real line in the doc, so the failure names a place", () => {
  const drifted = { ...TEMPLATES, alpha: "# Alpha\n- two\n" };
  const { issues } = checkParity(drifted, DOC_OK);
  const lines = DOC_OK.split("\n");
  assert.equal(issues[0].file, DOC_REL);
  assert.equal(lines[issues[0].line - 1], "- one"); // the cited line IS the divergent one
});

test("(a) `compared` counts only slugs actually byte-compared — a gate that compares nothing is the defect", () => {
  // Doc has one region; the other template is unregioned and therefore uncompared.
  const { compared } = checkParity(TEMPLATES, doc(region("alpha", "# Alpha", "- one")));
  assert.equal(compared, 1);
});

// --- (b) completeness -------------------------------------------------------

test("(b) a template with no SKELETON region is CAUGHT", () => {
  const { issues } = checkParity(TEMPLATES, doc(region("alpha", "# Alpha", "- one")));
  assert.deepEqual(rules(issues), ["completeness"]);
  assert.match(issues[0].message, /beta/);
  assert.equal(issues[0].file, DOC_REL);
});

test("(b) a SKELETON region with no template is CAUGHT (orphans fail in BOTH directions)", () => {
  const withGhost = doc(
    region("alpha", "# Alpha", "- one"),
    region("beta", "# Beta"),
    region("ghost", "# Ghost"),
  );
  const { issues } = checkParity(TEMPLATES, withGhost);
  assert.deepEqual(rules(issues), ["completeness"]);
  assert.match(issues[0].message, /ghost/);
});

test("(b) a region whose marker lost its fenced block fails loudly instead of skipping silently", () => {
  const broken = doc(region("alpha", "# Alpha", "- one"), "<!-- SKELETON:beta -->", "# Beta", "");
  const { issues, compared } = checkParity(TEMPLATES, broken);
  assert.deepEqual(rules(issues), ["completeness"]);
  assert.match(issues[0].message, /beta/);
  assert.equal(compared, 1);
});

test("(b) an empty doc fails every slug rather than passing vacuously", () => {
  const { issues, compared } = checkParity(TEMPLATES, "");
  assert.equal(compared, 0);
  assert.deepEqual(rules(issues), ["completeness", "completeness"]);
});

// --- (c) encodability -------------------------------------------------------

test("(c) a template containing a triple-backtick fence is CAUGHT (it would close its region early)", () => {
  const bad = { ...TEMPLATES, alpha: "# Alpha\n```js\ncode\n```\n" };
  const { issues } = checkParity(bad, DOC_OK, "export const PLAN_TEMPLATES = {\n  alpha: `x`,");
  assert.ok(rules(issues).includes("encodability"));
  const enc = issues.find((i) => i.rule === "encodability");
  assert.match(enc.message, /alpha/);
  assert.equal(enc.file, SRC_REL);
  assert.equal(enc.line, 2); // points at the offending key in bootstrap.mjs
});

test("(c) a template containing the literal <!-- TEMPLATE: is CAUGHT (it would truncate emit-template's last slice)", () => {
  const bad = { ...TEMPLATES, beta: "# Beta\n<!-- TEMPLATE:beta -->\n" };
  const { issues } = checkParity(bad, DOC_OK);
  const enc = issues.filter((i) => i.rule === "encodability");
  assert.equal(enc.length, 1);
  assert.match(enc[0].message, /beta/);
});

// --- report -----------------------------------------------------------------

test("report renders the house failure format: two-space indent, file:line, [rule], message", () => {
  const { issues } = checkParity({ ...TEMPLATES, beta: "# BETA\n" }, DOC_OK);
  assert.match(report(issues), /^ {2}src\/references\/file-formats\.md:\d+ \[parity\] /);
});

// --- the real repo (this is the gate itself, run against live inputs) --------

// THE REVIEWER'S EXPLOIT, pinned dead. The gate above compares bootstrap only to the
// SKELETON regions; `emit-template` serves agents the TEMPLATE (worked-example) regions.
// So a byte-claim restated in the worked example is an UNGATED copy: the reviewer edited
// the changelog header there, the gate still printed PASS, and `emit-template --name
// changelog` served the lie. The fix was to delete that copy, not to gate a third one —
// which is why this is a suite assertion (one literal, no allowlist) and not a checker rule.
test("the changelog TEMPLATE region restates NO bootstrap bytes — it points at the gated skeleton", () => {
  const region = resolveTemplate("changelog");
  assert.equal(region.ok, true);
  const text = region.body.toString();
  // The deleted block's distinctive literal. Re-inserting it (the reviewer's exact move)
  // turns this red. Do NOT grow this into a per-slug list — that is the rejected design.
  assert.equal(
    text.includes("*Append-only per-edit ledger."),
    false,
    "the changelog worked example restates bootstrap's header bytes again — an ungated copy " +
      "emit-template serves to agents. Delete it; the bytes belong only in <!-- SKELETON:changelog -->.",
  );
  assert.ok(text.includes("<!-- SKELETON:changelog -->"), "the pointer to the gated copy is gone");
});

test("the LIVE bootstrap templates byte-match the LIVE file-formats.md skeletons — 12 slugs", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const docText = readFileSync(join(root, DOC_REL), "utf8");
  const srcText = readFileSync(join(root, SRC_REL), "utf8");
  const { issues, compared } = checkParity(PLAN_TEMPLATES, docText, srcText);
  assert.deepEqual(issues, [], report(issues));
  assert.equal(compared, 12);
  assert.equal(Object.keys(PLAN_TEMPLATES).length, 12);
});
