// Tests for check-agent-wiring.mjs — the prose-layer wiring gate.
// Run: node --test src/scripts/check-agent-wiring.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tagLines,
  norm,
  headingCore,
  parseHeadings,
  resolveTarget,
  scanScriptPaths,
  scanReferenceCitations,
  scanSectionPointers,
  scanSkillPathResolution,
  report,
} from "./check-agent-wiring.mjs";

// --- fixtures ---------------------------------------------------------------

// The real python-software.md shape: C.11 is Toolchain, C.12 is the checklist.
// This is the F-001 trap — an existence-only checker passes a pointer to C.11.
const PYTHON_DOC = [
  "# Python Caveat",
  "## C. Python style + anti-patterns",
  "### C.11 Toolchain",
  "### C.12 Anti-pattern checklist (REVIEW GATE — run all 20 in REFLECT)",
  "### B.16 When NOT to apply these patterns (read first)",
].join("\n");

const REFS = new Set(["python-software.md", "file-formats.md"]);
const refExists = (name) => REFS.has(name);
const headingsFor = (rel) =>
  rel === "src/references/python-software.md" ? parseHeadings(PYTHON_DOC) : null;

const msgs = (issues) => issues.map((i) => i.message).join(" | ");

// --- primitives -------------------------------------------------------------

test("tagLines marks fenced regions (fence delimiters included)", () => {
  const lines = tagLines("a\n```\nb\n```\nc");
  assert.deepEqual(
    lines.map((l) => l.fenced),
    [false, true, true, true, false],
  );
  assert.equal(lines[2].no, 3);
});

test("norm strips markdown emphasis, quotes, and case", () => {
  assert.equal(norm('**"Anti-pattern`  Checklist"**'), "anti-pattern checklist");
});

test("headingCore cuts trailing em-dash and parenthetical qualifiers", () => {
  assert.equal(
    headingCore("Anti-pattern checklist (REVIEW GATE — run all 20)"),
    "anti-pattern checklist",
  );
  assert.equal(
    headingCore("Revert procedures — manifest-touching reverts"),
    "revert procedures",
  );
});

test("parseHeadings splits section code from title, and skips fenced headings", () => {
  const hs = parseHeadings("### C.12 Anti-pattern checklist\n```\n# Not A Heading\n```\n## Format");
  assert.deepEqual(hs, [
    { code: "C.12", title: "Anti-pattern checklist" },
    { code: null, title: "Format" },
  ]);
});

test("resolveTarget maps citation prefixes to repo paths; unknown -> null", () => {
  assert.equal(resolveTarget("references/x.md", "self.md"), "src/references/x.md");
  assert.equal(resolveTarget("agents/ip-x.md", "self.md"), "src/agents/ip-x.md");
  assert.equal(resolveTarget("scripts/modules/state-x.md", "self.md"), "src/scripts/modules/state-x.md");
  assert.equal(resolveTarget("SKILL.md", "self.md"), "src/SKILL.md");
  assert.equal(resolveTarget("{plan-dir}/changelog.md", "self.md"), null);
  assert.equal(resolveTarget(null, "src/references/self.md"), "src/references/self.md");
});

// --- (a) script-path --------------------------------------------------------

test("(a) catches a bare relative script path (F-004's class)", () => {
  const issues = scanScriptPaths("a.md", "Run `node src/scripts/validate-plan.mjs` to audit.");
  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, "script-path");
  assert.equal(issues[0].line, 1);
  assert.match(issues[0].message, /src\/scripts\/validate-plan\.mjs/);
});

test("(a) catches a path-less script invocation", () => {
  assert.equal(scanScriptPaths("a.md", "node scripts/blast-radius.mjs <file>").length, 1);
});

test("(a) passes a <skill-path> invocation", () => {
  assert.deepEqual(
    scanScriptPaths("a.md", "Run `node <skill-path>/scripts/emit-state.mjs --state plan`."),
    [],
  );
});

test("(a) ignores module-import paths — only `node` invocations count", () => {
  // state-plan.md:2 cites bootstrap.mjs as an import source, not a CLI call.
  assert.deepEqual(
    scanScriptPaths("a.md", "helpers exported from `src/scripts/bootstrap.mjs` are imported"),
    [],
  );
  assert.deepEqual(
    scanScriptPaths("a.md", "await import('<skill-path>/scripts/bootstrap.mjs')"),
    [],
  );
});

// --- (b) reference-citation -------------------------------------------------

test("(b) catches a dangling references/ citation", () => {
  const issues = scanReferenceCitations("a.md", "See `references/nope.md` for details.", refExists);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, "reference-citation");
  assert.match(issues[0].message, /references\/nope\.md/);
});

test("(b) passes a resolving citation and ignores non-references paths", () => {
  assert.deepEqual(
    scanReferenceCitations("a.md", "See `references/file-formats.md` and `{plan-dir}/plan.md`.", refExists),
    [],
  );
});

test("(b) does not fire inside a fenced code block", () => {
  const text = "```\nsee `references/nope.md`\n```\n";
  assert.deepEqual(scanReferenceCitations("a.md", text, refExists), []);
});

// --- (c) section-pointer ----------------------------------------------------

test("(c) THE TRAP: a pointer whose code names a real heading but whose title disagrees is CAUGHT", () => {
  // C.11 EXISTS (Toolchain) — an existence-only check would pass this.
  const text = "checklist in `references/python-software.md` § C.11 Anti-pattern checklist.";
  const issues = scanSectionPointers("a.md", text, headingsFor);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, "section-pointer");
  assert.match(issues[0].message, /toolchain/i);
});

test("(c) the correct code+title pointer passes (title may be a prefix of the heading)", () => {
  const text = "checklist in `references/python-software.md` § C.12 Anti-pattern checklist is the gate.";
  assert.deepEqual(scanSectionPointers("a.md", text, headingsFor), []);
});

test("(c) a bare section letter `§ C` is reported as unverifiable", () => {
  const text = "check code against the checklist in `references/python-software.md` § C.";
  const issues = scanSectionPointers("a.md", text, headingsFor);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /unverifiable/);
});

test("(c) a bare section code in prose (no §) is reported — F-001's live form", () => {
  const text = "The 20-item checklist in C.11 is the REVIEW GATE.";
  const issues = scanSectionPointers("src/references/python-software.md", text, headingsFor);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /bare section code `C\.11`/);
});

test("(c) a sentence-final bare code is still caught (`see Section B.10.`)", () => {
  const issues = scanSectionPointers(
    "src/references/python-software.md",
    "(Class vs function: see Section B.10.)",
    headingsFor,
  );
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /B\.10/);
});

test("(c) `§B.16` without a title is caught; with its title it passes", () => {
  const bad = scanSectionPointers("src/references/python-software.md", "**Read §B.16 (when NOT to apply) first**", headingsFor);
  assert.equal(bad.length, 1);
  assert.match(bad[0].message, /must be followed by its heading title/);
  const good = scanSectionPointers("src/references/python-software.md", "Read § B.16 When NOT to apply these patterns first.", headingsFor);
  assert.deepEqual(good, []);
});

test("(c) an unknown section code is caught", () => {
  const text = "see `references/python-software.md` § C.99 Ghost section.";
  const issues = scanSectionPointers("a.md", text, headingsFor);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /names no heading/);
});

test("(c) title-only pointers resolve against the target's headings", () => {
  const doc = "## Intra-plan compression\n";
  const hf = (rel) => (rel === "src/references/file-formats.md" ? parseHeadings(doc) : null);
  assert.deepEqual(
    scanSectionPointers("a.md", "See `references/file-formats.md` § Intra-plan compression.", hf),
    [],
  );
  const issues = scanSectionPointers("a.md", "See `references/file-formats.md` § Ghost Section.", hf);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /matches no heading/);
});

test("(c) does NOT fire on a heading that IS the section code (### C.11 Toolchain)", () => {
  assert.deepEqual(scanSectionPointers("a.md", PYTHON_DOC, headingsFor), []);
});

test("(c) does NOT fire inside a fenced code block", () => {
  const text = "```\nThe checklist in C.11 and § C are examples\n```\n";
  assert.deepEqual(scanSectionPointers("src/references/python-software.md", text, headingsFor), []);
});

test("(c) skips pointers whose target cannot be read (unverifiable, not an error)", () => {
  const text = "See `{plan-dir}/changelog.md` § Whatever Section.";
  assert.deepEqual(scanSectionPointers("a.md", text, headingsFor), []);
});

test("(c) picks the nearest preceding citation when a line holds two pointers", () => {
  const doc = "## PLAN State\n";
  const hf = (rel) =>
    rel === "src/references/python-software.md"
      ? parseHeadings(PYTHON_DOC)
      : rel === "src/agents/ip-orchestrator.md"
        ? parseHeadings(doc)
        : null;
  const text =
    "See `references/python-software.md` § C.12 Anti-pattern checklist and `agents/ip-orchestrator.md` § PLAN State.";
  assert.deepEqual(scanSectionPointers("a.md", text, hf), []);
});

// --- (d) skill-path-resolution ----------------------------------------------

test("(d) catches an agent that invokes <skill-path> with no resolution pointer", () => {
  const issues = scanSkillPathResolution("src/agents/ip-x.md", "Run `node <skill-path>/scripts/x.mjs`.");
  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, "skill-path-resolution");
});

test("(d) passes when a resolution pointer line is present", () => {
  const withResolving =
    "Resolving `<skill-path>`: see SKILL.md.\nRun `node <skill-path>/scripts/x.mjs`.";
  assert.deepEqual(scanSkillPathResolution("src/agents/ip-x.md", withResolving), []);
  const withPreamble =
    "Every spawn prompt carries `SKILL PATH: <abs>` — that is `<skill-path>`.\nRun `node <skill-path>/scripts/x.mjs`.";
  assert.deepEqual(scanSkillPathResolution("src/agents/ip-x.md", withPreamble), []);
});

test("(d) is silent for a file that never invokes a skill-path script", () => {
  assert.deepEqual(scanSkillPathResolution("src/agents/ip-x.md", "No scripts here."), []);
});

// --- report -----------------------------------------------------------------

test("report renders file:line [rule] message", () => {
  const issues = scanScriptPaths("src/agents/ip-archivist.md", "run `node src/scripts/validate-plan.mjs`");
  assert.match(report(issues)[0], /^ {2}src\/agents\/ip-archivist\.md:1 \[script-path\] /);
});
