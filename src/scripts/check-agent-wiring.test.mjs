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

// --- edge collection + serializeEdges + --emit-edges CLI ---------------------
// FEATURE 1 coverage: the optional trailing `edges` param on the three scan
// functions (edges pushed at verified-OK points only), the pure serializer,
// and the opt-in CLI file write. Spawn style precedent for this repo:
// check-readme-parity.test.mjs.

import { serializeEdges, EXPECTED_MIN_PROSE_FILES } from "./check-agent-wiring.mjs";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EDGE_TYPES = new Set(["script-path", "reference-citation", "section-pointer"]);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const checkerPath = join(__dirname, "check-agent-wiring.mjs");

// --- (a) edges ----------------------------------------------------------------

test("(a) edge: a <skill-path> invocation pushes {src, dst, type, line}, dst normalized to src/scripts/", () => {
  const edges = [];
  const issues = scanScriptPaths(
    "src/agents/ip-x.md",
    "intro\n\nRun `node <skill-path>/scripts/emit-state.mjs --state plan`.",
    edges,
  );
  assert.deepEqual(issues, []);
  assert.deepEqual(edges, [
    { src: "src/agents/ip-x.md", dst: "src/scripts/emit-state.mjs", type: "script-path", line: 3 },
  ]);
});

test("(a) edge: a violating bare path yields an issue and NO edge", () => {
  const edges = [];
  const issues = scanScriptPaths("a.md", "Run `node src/scripts/validate-plan.mjs` to audit.", edges);
  assert.equal(issues.length, 1);
  assert.deepEqual(edges, []);
});

test("(a) edge: omitting the edges array is safe and leaves issues unchanged", () => {
  const text = "Run `node src/scripts/validate-plan.mjs` then `node <skill-path>/scripts/emit-state.mjs`.";
  const withEdges = scanScriptPaths("a.md", text, []);
  const without = scanScriptPaths("a.md", text);
  assert.deepEqual(without, withEdges);
  assert.equal(without.length, 1);
});

test("(a) edge: collected inside fenced code blocks too (rule (a) scans fences)", () => {
  const edges = [];
  const issues = scanScriptPaths("a.md", "```\nnode <skill-path>/scripts/blast-radius.mjs <file>\n```", edges);
  assert.deepEqual(issues, []);
  assert.deepEqual(edges, [
    { src: "a.md", dst: "src/scripts/blast-radius.mjs", type: "script-path", line: 2 },
  ]);
});

// --- (b) edges ----------------------------------------------------------------

test("(b) edge: a resolving citation pushes dst src/references/<f>.md", () => {
  const edges = [];
  const issues = scanReferenceCitations("a.md", "See `references/file-formats.md`.", refExists, edges);
  assert.deepEqual(issues, []);
  assert.deepEqual(edges, [
    { src: "a.md", dst: "src/references/file-formats.md", type: "reference-citation", line: 1 },
  ]);
});

test("(b) edge: a dangling citation yields an issue and NO edge", () => {
  const edges = [];
  const issues = scanReferenceCitations("a.md", "See `references/nope.md`.", refExists, edges);
  assert.equal(issues.length, 1);
  assert.deepEqual(edges, []);
});

test("(b) edge: non-references citations yield no edge (rule (b) does not validate them)", () => {
  const edges = [];
  const issues = scanReferenceCitations("a.md", "See `{plan-dir}/plan.md` and `agents/ip-x.md`.", refExists, edges);
  assert.deepEqual(issues, []);
  assert.deepEqual(edges, []);
});

test("(b) edge: none from inside a fenced code block (rule (b) skips fences)", () => {
  const edges = [];
  const issues = scanReferenceCitations("a.md", "```\nsee `references/file-formats.md`\n```\n", refExists, edges);
  assert.deepEqual(issues, []);
  assert.deepEqual(edges, []);
});

// --- (c) edges ----------------------------------------------------------------

test("(c) edge: a verifying code+title pointer pushes the resolved dst", () => {
  const edges = [];
  const text = "checklist in `references/python-software.md` § C.12 Anti-pattern checklist is the gate.";
  const issues = scanSectionPointers("a.md", text, headingsFor, edges);
  assert.deepEqual(issues, []);
  assert.deepEqual(edges, [
    { src: "a.md", dst: "src/references/python-software.md", type: "section-pointer", line: 1 },
  ]);
});

test("(c) edge: a verifying title-only pointer pushes the resolved dst", () => {
  const doc = "## Intra-plan compression\n";
  const hf = (rel) => (rel === "src/references/file-formats.md" ? parseHeadings(doc) : null);
  const edges = [];
  const issues = scanSectionPointers("a.md", "See `references/file-formats.md` § Intra-plan compression.", hf, edges);
  assert.deepEqual(issues, []);
  assert.deepEqual(edges, [
    { src: "a.md", dst: "src/references/file-formats.md", type: "section-pointer", line: 1 },
  ]);
});

test("(c) edge: a title-disagree violation yields an issue and NO edge", () => {
  const edges = [];
  const text = "checklist in `references/python-software.md` § C.11 Anti-pattern checklist.";
  const issues = scanSectionPointers("a.md", text, headingsFor, edges);
  assert.equal(issues.length, 1);
  assert.deepEqual(edges, []);
});

test("(c) edge: an unverifiable target (resolveTarget null) yields no edge and no issue", () => {
  const edges = [];
  const issues = scanSectionPointers("a.md", "See `{plan-dir}/changelog.md` § Whatever Section.", headingsFor, edges);
  assert.deepEqual(issues, []);
  assert.deepEqual(edges, []);
});

// --- serializeEdges -----------------------------------------------------------

test("serializeEdges emits fixed key order src,dst,type,line regardless of input key order", () => {
  const out = serializeEdges([{ line: 5, type: "script-path", dst: "src/scripts/x.mjs", src: "a.md" }]);
  assert.equal(out, '{"src":"a.md","dst":"src/scripts/x.mjs","type":"script-path","line":5}\n');
});

test("serializeEdges sorts by (src, line, dst, type) — line compared numerically", () => {
  const e = (src, dst, type, line) => ({ src, dst, type, line });
  const input = [
    e("b.md", "a", "script-path", 1), // src tier: sorts after every a.md despite lowest line
    e("a.md", "a", "script-path", 10), // line tier: 10 after 2 (numeric — string compare would put "10" first)
    e("a.md", "z", "script-path", 2), // dst tier: z after a at the same line
    e("a.md", "a", "section-pointer", 2), // type tier: after reference-citation at same src/line/dst
    e("a.md", "a", "reference-citation", 2),
  ];
  const got = serializeEdges(input).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(got, [
    e("a.md", "a", "reference-citation", 2),
    e("a.md", "a", "section-pointer", 2),
    e("a.md", "z", "script-path", 2),
    e("a.md", "a", "script-path", 10),
    e("b.md", "a", "script-path", 1),
  ]);
});

test("serializeEdges dedupes identical edges", () => {
  const edge = { src: "a.md", dst: "src/SKILL.md", type: "section-pointer", line: 3 };
  const out = serializeEdges([edge, { ...edge }]);
  assert.equal(out, '{"src":"a.md","dst":"src/SKILL.md","type":"section-pointer","line":3}\n');
});

test("serializeEdges: empty/missing input -> empty string; non-empty ends with exactly one newline", () => {
  assert.equal(serializeEdges([]), "");
  assert.equal(serializeEdges(undefined), "");
  const out = serializeEdges([{ src: "a", dst: "b", type: "script-path", line: 1 }]);
  assert.ok(out.endsWith("}\n"));
  assert.ok(!out.endsWith("\n\n"));
});

// --- --emit-edges CLI (spawn) ---------------------------------------------------

test("CLI --emit-edges: exit 0, JSONL file with 4 ordered keys and known types", () => {
  const tmp = mkdtempSync(join(tmpdir(), "caw-edges-"));
  try {
    const out = join(tmp, "kg.jsonl");
    const r = spawnSync(process.execPath, [checkerPath, "--emit-edges", out], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.strictEqual(r.status, 0, `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /emit-edges: wrote \d+ edge\(s\) to /);
    assert.ok(existsSync(out), "edge file was not written");
    const content = readFileSync(out, "utf8");
    assert.ok(content.endsWith("\n"));
    const lines = content.slice(0, -1).split("\n");
    assert.ok(lines.length > 0, "real repo should produce a non-empty edge set");
    for (const l of lines) {
      const o = JSON.parse(l);
      assert.deepEqual(Object.keys(o), ["src", "dst", "type", "line"]);
      assert.ok(EDGE_TYPES.has(o.type), `unknown edge type: ${o.type}`);
      assert.equal(typeof o.line, "number");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI --emit-edges: two runs on an unchanged tree are byte-identical", () => {
  const tmp = mkdtempSync(join(tmpdir(), "caw-edges-"));
  try {
    const a = join(tmp, "a.jsonl");
    const b = join(tmp, "b.jsonl");
    for (const p of [a, b]) {
      const r = spawnSync(process.execPath, [checkerPath, "--emit-edges", p], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      assert.strictEqual(r.status, 0, `exit ${r.status}\nstderr: ${r.stderr}`);
    }
    const bufA = readFileSync(a);
    assert.ok(bufA.length > 0);
    assert.ok(bufA.equals(readFileSync(b)), "emit-edges output differs between runs");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// --- scan floor + IP_CHECK_AGENT_WIRING_ROOT (plan-2026-07-21-38d0cd87 step 2) --

/**
 * Build a temp fixture root with the three scanned dirs (+ src/SKILL.md) and
 * the given number of trivial .md files per dir. Caller removes it.
 */
function makeWiringFixtureRoot({ agents = 0, modules = 0, references = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "caw-fixture-"));
  const dirs = [
    ["src/agents", agents],
    ["src/scripts/modules", modules],
    ["src/references", references],
  ];
  for (const [rel, n] of dirs) {
    mkdirSync(join(root, rel), { recursive: true });
    for (let i = 0; i < n; i++) {
      writeFileSync(join(root, rel, `f${i}.md`), "# Fixture\n\nNo wiring here.\n");
    }
  }
  writeFileSync(join(root, "src", "SKILL.md"), "# Fixture SKILL\n");
  return root;
}

/** Spawn the REAL CLI against a root via the opt-in env override. */
function runWiringCliAgainst(root) {
  return spawnSync(process.execPath, [checkerPath], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, IP_CHECK_AGENT_WIRING_ROOT: root },
  });
}

test("real CLI PASS: IP_CHECK_AGENT_WIRING_ROOT pointing at the real repo -> exit 0 (override path itself works)", () => {
  const res = runWiringCliAgainst(repoRoot);
  assert.strictEqual(res.status, 0, `exit ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  assert.match(res.stdout, /^check-agent-wiring: PASS \(\d+ prose files/);
});

test("real CLI FAIL [scan-floor]: an emptied scan dir -> exit 1 naming the empty source", () => {
  const root = makeWiringFixtureRoot({ agents: 0, modules: 1, references: 1 });
  try {
    const res = runWiringCliAgainst(root);
    assert.strictEqual(res.status, 1, `exit ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
    assert.match(res.stderr, /check-agent-wiring: FAIL \[scan-floor\]/);
    assert.match(res.stderr, /src\/agents contributed 0 \.md files/);
    assert.ok(!res.stdout.includes("PASS"), "a floored run must not print PASS");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real CLI FAIL [scan-floor]: all dirs contribute but total is below EXPECTED_MIN_PROSE_FILES", () => {
  const root = makeWiringFixtureRoot({ agents: 1, modules: 1, references: 1 });
  try {
    const res = runWiringCliAgainst(root);
    assert.strictEqual(res.status, 1, `exit ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
    assert.match(
      res.stderr,
      new RegExp(
        `scanned only 4 prose file\\(s\\), below EXPECTED_MIN_PROSE_FILES = ${EXPECTED_MIN_PROSE_FILES}`,
      ),
    );
    assert.ok(!res.stderr.includes("contributed 0"), "no per-dir failure expected when every dir contributes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI no-flag purity: exit 0, PASS line, no emission output, default artifact state unchanged", () => {
  // Never delete or write working-tree files from tests: record the default
  // path's state BEFORE the run and assert it is unchanged after.
  const defaultPath = join(repoRoot, "src", "references", "kg-edges.jsonl");
  const existedBefore = existsSync(defaultPath);
  const bytesBefore = existedBefore ? readFileSync(defaultPath) : null;
  const r = spawnSync(process.execPath, [checkerPath], { cwd: repoRoot, encoding: "utf8" });
  assert.strictEqual(r.status, 0, `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /^check-agent-wiring: PASS \(\d+ prose files/);
  assert.ok(!r.stdout.includes("emit-edges:"), "no-flag run must not mention emission");
  assert.strictEqual(r.stderr, "");
  assert.strictEqual(existsSync(defaultPath), existedBefore, "no-flag run changed default artifact existence");
  if (existedBefore) {
    assert.ok(readFileSync(defaultPath).equals(bytesBefore), "no-flag run changed default artifact bytes");
  }
});
