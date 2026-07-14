// Tests for changelog.mjs — the mechanical append/import/render pipeline for changelog.xml.
//
// TWO CRITERIA CARRY THIS FILE:
//
//   C11 (byte-exact round-trip) — `import` -> `render` must reproduce a REAL changelog.md byte for
//   byte. Not a synthetic fixture: the repo's own live changelog, with its real reasons, real
//   paths, real radius values and real unicode. If this breaks, the Presentation-Contract "verbatim
//   render" guarantee breaks with it (plan.md Pre-Mortem #3) and XML must demote to a sidecar.
//
//   C12 (append durability) — 50 sequential appends, re-parsed and re-validated after EVERY one.
//   This is the direct test of Pre-Mortem #1: does append-to-XML ROT over time? A pipeline that is
//   well-formed at append 1 and misnested at append 37 is the failure mode the whole D-002
//   "no agent hand-writes XML" rule exists to prevent, so it is asserted, not assumed.
//
// The third invariant under test is NO DATA LOSS: a line the importer cannot parse must survive as
// <raw>, verbatim, and render back identically. Dropping a row of an append-only ledger is worse
// than carrying a row we do not understand.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, serialize } from "./xml.mjs";
import { validateDoc, CHANGELOG_SPEC } from "./schema.mjs";
import {
  LOCK_BUDGET_MS,
  LOCK_STALE_MS,
  MD_HEADER_LINES,
  acquireLock,
  appendEntry,
  compressedLine,
  elementsOf,
  emptyDoc,
  entryLine,
  importMarkdown,
  lockPath,
  makeDoc,
  nowTs,
  rawText,
  readDoc,
  releaseLock,
  renderDoc,
  tempPathFor,
  withLock,
  writeDocAtomic,
  xmlPath,
} from "./changelog.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = join(HERE, "..", "..");
const SCRIPT = join(HERE, "changelog.mjs");
// The REAL, live changelog written by this plan's own steps 1-9. The C11 fixture is this file.
const REAL_CHANGELOG = join(REPO, "plans", "plan_2026-07-14_79ee0f59", "changelog.md");

function tmp() {
  const d = mkdtempSync(join(tmpdir(), "ip-changelog-"));
  return d;
}

const cli = (args, opts = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", ...opts });

const FIELDS = {
  ts: "2026-07-14T06:30:00Z",
  step: "iter-1/step-10",
  commit: "abc1234",
  path: "src/scripts/changelog.mjs",
  op: "CREATE(+200)",
  radius: "radius:HIGH(6)",
  dref: "D-002",
  reason: "mechanical append/import/render",
};

const HEADER_MD = `${MD_HEADER_LINES.join("\n")}\n\n`;

// --- C11: byte-exact round-trip ---------------------------------------------

test("C11: import -> render reproduces the REAL plan changelog byte for byte", () => {
  const original = readFileSync(REAL_CHANGELOG, "utf8");
  const rendered = renderDoc(importMarkdown(original));
  assert.equal(rendered, original);
  assert.equal(Buffer.byteLength(rendered), Buffer.byteLength(original));
});

test("C11: the real changelog survives a full XML serialize -> parse -> render cycle", () => {
  const original = readFileSync(REAL_CHANGELOG, "utf8");
  const xml = serialize(importMarkdown(original)); // through the actual on-disk encoding
  const rendered = renderDoc(parse(xml));
  assert.equal(rendered, original);
});

test("C11: the imported real changelog is schema-valid with zero issues", () => {
  const doc = parse(serialize(importMarkdown(readFileSync(REAL_CHANGELOG, "utf8"))));
  assert.deepEqual(validateDoc(doc, CHANGELOG_SPEC), []);
});

test("C11: every real entry line becomes an <entry> (no silent demotion to <raw>)", () => {
  const original = readFileSync(REAL_CHANGELOG, "utf8");
  const lines = original.split("\n");
  const entryLines = lines.filter((l) => /^\d{4}-\d{2}-\d{2}T/.test(l));
  const els = elementsOf(importMarkdown(original));
  const entries = els.filter((e) => e.name === "entry");
  assert.ok(entryLines.length >= 25, `expected a real fixture, got ${entryLines.length} entries`);
  assert.equal(entries.length, entryLines.length);
  // Only the 4 header lines, the blank separator, and the trailing-newline sentinel are <raw>.
  assert.equal(els.filter((e) => e.name === "raw").length, lines.length - entryLines.length);
});

test("the header's *Format:* line LOOKS like an 8-field entry but is not coerced into one", () => {
  // `*Format: \`UTC | iter-N/step-M | ... | reason\`*` carries exactly 7 " | " separators, so a
  // naive splitter reads it as a valid 8-field row. The schema's field types are what reject it
  // (its `ts` is not a timestamp) — proof that import's guard is the schema, not a line count.
  const formatLine = MD_HEADER_LINES[2];
  assert.equal(formatLine.split(" | ").length, 8, "the fixture only bites if the line really has 8 fields");
  const els = elementsOf(importMarkdown(`${formatLine}\n`));
  assert.equal(els[0].name, "raw");
  assert.equal(rawText(els[0]), formatLine);
});

test("C11 (CLI): import --dry-run | render - round-trips the real changelog", () => {
  const planDir = join(REPO, "plans", "plan_2026-07-14_79ee0f59");
  const imported = cli(["import", "--dry-run", planDir]);
  assert.equal(imported.status, 0, imported.stderr);
  const rendered = cli(["render", "-"], { input: imported.stdout });
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.equal(rendered.stdout, readFileSync(REAL_CHANGELOG, "utf8"));
});

test("round-trip holds for a file with NO trailing newline", () => {
  const md = `${HEADER_MD}${entryLine({ attrs: FIELDS })}`;
  assert.ok(!md.endsWith("\n"));
  assert.equal(renderDoc(importMarkdown(md)), md);
});

test("round-trip holds for an empty string and for a header-only file", () => {
  assert.equal(renderDoc(importMarkdown("")), "");
  assert.equal(renderDoc(importMarkdown(HEADER_MD)), HEADER_MD);
});

// --- C12: append durability --------------------------------------------------

test("C12: 50 sequential appends — well-formed and schema-valid after EVERY one", () => {
  const dir = tmp();
  try {
    const file = xmlPath(dir);
    writeDocAtomic(file, emptyDoc());

    for (let n = 1; n <= 50; n++) {
      const doc = readDoc(dir); // re-parse from disk each round: no in-memory shortcut
      const { issues } = appendEntry(doc, {
        ...FIELDS,
        ts: `2026-07-14T06:${String(n % 60).padStart(2, "0")}:00Z`,
        step: `iter-1/step-${n}`,
        reason: `append ${n}`,
      });
      assert.deepEqual(issues, [], `append ${n} rejected`);
      writeDocAtomic(file, doc);

      // Re-parse from disk and re-validate: well-formedness must not degrade.
      const reparsed = parse(readFileSync(file, "utf8"));
      assert.deepEqual(validateDoc(reparsed, CHANGELOG_SPEC), [], `schema issues after append ${n}`);
      const entries = elementsOf(reparsed).filter((e) => e.name === "entry");
      assert.equal(entries.length, n, `entry count after append ${n}`);
      // Order stays chronological (append-only), and the newest is last.
      assert.equal(entries[n - 1].attrs.reason, `append ${n}`);
      entries.forEach((e, i) => assert.equal(e.attrs.step, `iter-1/step-${i + 1}`));
    }

    // The rendered markdown is still the legacy shape: header, blank, 50 entries, trailing newline.
    const lines = renderDoc(readDoc(dir)).split("\n");
    assert.deepEqual(lines.slice(0, 4), MD_HEADER_LINES);
    assert.equal(lines[4], "");
    assert.equal(lines.length, 4 + 1 + 50 + 1);
    assert.equal(lines[lines.length - 1], "", "trailing newline preserved across 50 appends");
    assert.ok(lines[5].startsWith("2026-07-14T06:01:00Z | iter-1/step-1 | "));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C12: appends stay after the header and before the trailing-newline sentinel", () => {
  const doc = emptyDoc();
  appendEntry(doc, FIELDS);
  const els = elementsOf(doc);
  assert.equal(els[4].name, "raw"); // the blank separator line
  assert.equal(els[5].name, "entry");
  assert.equal(els[6].name, "raw"); // the trailing-newline sentinel
  assert.equal(rawText(els[6]), "");
});

test("C12: appending to an imported real changelog keeps it valid and chronological", () => {
  const doc = importMarkdown(readFileSync(REAL_CHANGELOG, "utf8"));
  const before = elementsOf(doc).filter((e) => e.name === "entry").length;
  const { issues } = appendEntry(doc, FIELDS);
  assert.deepEqual(issues, []);
  const reparsed = parse(serialize(doc));
  assert.deepEqual(validateDoc(reparsed, CHANGELOG_SPEC), []);
  const entries = elementsOf(reparsed).filter((e) => e.name === "entry");
  assert.equal(entries.length, before + 1);
  assert.equal(entries[entries.length - 1].attrs.reason, FIELDS.reason);
  // The header is still the header; the new entry did not land in the preamble.
  assert.equal(renderDoc(reparsed).split("\n")[0], "# Changelog");
});

// --- hostile reason fields (invariant 6) -------------------------------------

const NASTY = 'renamed a→b | kept old | see "x" & <y>\nsecond line\tafter a tab';

test("a reason with pipes, a newline, a tab, an arrow, quotes and angle brackets survives append -> XML -> render", () => {
  const doc = emptyDoc();
  const { issues } = appendEntry(doc, { ...FIELDS, reason: NASTY });
  assert.deepEqual(issues, []);

  const xml = serialize(doc);
  // The newline/tab MUST be numeric refs in the attribute, or a conformant reader normalizes them
  // to a space and the reason is silently corrupted (see xml.mjs's ATTR_ESC note).
  assert.ok(xml.includes("&#10;"), "newline must be escaped as a numeric ref");
  assert.ok(xml.includes("&#9;"), "tab must be escaped as a numeric ref");
  assert.ok(xml.includes("&amp;") && xml.includes("&lt;") && xml.includes("&quot;"));
  assert.ok(xml.includes("→"), "the unicode arrow is emitted literally");

  const entry = elementsOf(parse(xml)).find((e) => e.name === "entry");
  assert.equal(entry.attrs.reason, NASTY, "the reason survives the XML round trip byte for byte");
  assert.ok(renderDoc(parse(xml)).includes(NASTY), "and it renders back intact");
});

test("pipes in a reason are absorbed by field 8 on import (the legacy split-on-first-7 rule)", () => {
  const line = `2026-07-14T06:00:00Z | iter-1/step-1 | abc1234 | src/a.js | EDIT(+1,-1) | radius:LOW(0) | - | a | b | c`;
  const md = `${HEADER_MD}${line}\n`;
  const doc = importMarkdown(md);
  const entry = elementsOf(doc).find((e) => e.name === "entry");
  assert.equal(entry.attrs.reason, "a | b | c");
  assert.equal(renderDoc(doc), md); // and it renders back byte-exact
});

test("a RENAME op carrying the unicode arrow round-trips", () => {
  const doc = emptyDoc();
  const { issues } = appendEntry(doc, { ...FIELDS, op: "RENAME(src/old.js→src/new.js)" });
  assert.deepEqual(issues, []);
  const rendered = renderDoc(parse(serialize(doc)));
  assert.ok(rendered.includes("RENAME(src/old.js→src/new.js)"));
});

// --- no data loss: <raw> ------------------------------------------------------

test("an unparseable legacy line is preserved as <raw> and re-emitted verbatim", () => {
  const junk = "2026-13-45T99:99:99Z | iter-1/step-1 | ZZZ | a|b | NOPE | radius:WAT(1) | D-1 | x";
  const md = `${HEADER_MD}${junk}\n`;
  const doc = importMarkdown(md);
  const raws = elementsOf(doc).filter((e) => e.name === "raw");
  assert.ok(raws.some((r) => rawText(r) === junk), "the bad line is kept verbatim in a <raw>");
  assert.equal(elementsOf(doc).filter((e) => e.name === "entry").length, 0);
  assert.equal(renderDoc(doc), md);
});

test("import NEVER drops a line: element count accounts for every source line", () => {
  const md = [
    ...MD_HEADER_LINES,
    "",
    "not a changelog line at all",
    "2026-07-14T06:00:00Z | iter-1/step-1 | abc1234 | src/a.js | EDIT(+1,-1) | radius:LOW(0) | - | ok",
    "   ", // whitespace-only
    "half | a | line",
    "",
  ].join("\n");
  const doc = importMarkdown(md);
  assert.equal(elementsOf(doc).length, md.split("\n").length);
  assert.equal(renderDoc(doc), md);
});

test("a <raw> whose text is XML-hostile still round-trips", () => {
  const junk = `<not-xml> & "quoted" ]]> --> <![CDATA[ oops`;
  const doc = importMarkdown(junk);
  const xml = serialize(doc);
  assert.equal(renderDoc(parse(xml)), junk);
});

test("an entry line whose fields are valid but whose spacing is odd is demoted to <raw>, not reformatted", () => {
  // Double space around a separator: it would NOT re-render byte-identically, so it stays raw.
  const odd = "2026-07-14T06:00:00Z  |  iter-1/step-1 | abc1234 | src/a.js | EDIT(+1,-1) | radius:LOW(0) | - | ok";
  const doc = importMarkdown(odd);
  assert.equal(elementsOf(doc)[0].name, "raw");
  assert.equal(renderDoc(doc), odd, "the ledger is evidence: it is preserved, never tidied");
});

// --- compression elements -----------------------------------------------------

const INLINE = "- (compressed: 14 low-decision-impact edits, iter-1/step-3..iter-1/step-7, files: 4)";
const INLINE_SINGLE = "- (compressed: 5 low-decision-impact edits, iter-2/step-1, files: 2)";
const SUMMARY_BLOCK = [
  "<!-- COMPRESSED-SUMMARY -->",
  "<!-- entries-at-compress: 187 -->",
  "<!-- elided-groups: 3, elided-lines: 42 -->",
  "<!-- /COMPRESSED-SUMMARY -->",
].join("\n");

test("an inline compression summary becomes <compressed> and renders back byte-exact", () => {
  const md = `${HEADER_MD}${INLINE}\n`;
  const doc = importMarkdown(md);
  const c = elementsOf(doc).find((e) => e.name === "compressed");
  assert.deepEqual(c.attrs, { count: "14", from: "iter-1/step-3", to: "iter-1/step-7", files: "4" });
  assert.equal(renderDoc(doc), md);
});

test("a single-step compression range (from == to) collapses on render, as bootstrap writes it", () => {
  const md = `${HEADER_MD}${INLINE_SINGLE}\n`;
  const doc = importMarkdown(md);
  const c = elementsOf(doc).find((e) => e.name === "compressed");
  assert.equal(c.attrs.from, "iter-2/step-1");
  assert.equal(c.attrs.to, "iter-2/step-1");
  assert.equal(compressedLine(c), INLINE_SINGLE, "no '..' when the range is a single step");
  assert.equal(renderDoc(doc), md);
});

test("the 4-line top-of-file metadata block becomes ONE <compressed-summary> and renders back byte-exact", () => {
  const md = `${MD_HEADER_LINES.join("\n")}\n${SUMMARY_BLOCK}\n\n${INLINE}\n`;
  const doc = importMarkdown(md);
  const els = elementsOf(doc);
  const s = els.find((e) => e.name === "compressed-summary");
  assert.deepEqual(s.attrs, { "entries-at-compress": "187", "elided-groups": "3", "elided-lines": "42" });
  assert.equal(els.filter((e) => e.name === "compressed-summary").length, 1, "4 source lines -> 1 element");
  assert.equal(renderDoc(doc), md);
  assert.deepEqual(validateDoc(parse(serialize(doc)), CHANGELOG_SPEC), []);
});

test("a MALFORMED metadata block is not coerced — every line stays <raw> and renders verbatim", () => {
  const md = `${MD_HEADER_LINES.join("\n")}\n<!-- COMPRESSED-SUMMARY -->\n<!-- entries-at-compress: many -->\n<!-- elided-groups: 3, elided-lines: 42 -->\n<!-- /COMPRESSED-SUMMARY -->\n`;
  const doc = importMarkdown(md);
  assert.equal(elementsOf(doc).filter((e) => e.name === "compressed-summary").length, 0);
  assert.equal(renderDoc(doc), md);
});

test("a compressed changelog (summary block + inline lines + live entries) round-trips whole", () => {
  const md = [
    ...MD_HEADER_LINES,
    SUMMARY_BLOCK,
    "",
    INLINE,
    "2026-07-14T06:00:00Z | iter-1/step-8 | abc1234 | src/a.js | EDIT(+1,-1) | radius:HIGH(6) | D-001 | kept",
    INLINE_SINGLE,
    "",
  ].join("\n");
  const doc = importMarkdown(md);
  assert.equal(renderDoc(doc), md);
  assert.deepEqual(validateDoc(parse(serialize(doc)), CHANGELOG_SPEC), []);
});

// --- append validation (A6: can the CLI express every field?) -----------------

test("append rejects a bad field and appends NOTHING", () => {
  const doc = emptyDoc();
  const before = serialize(doc);
  const { issues } = appendEntry(doc, { ...FIELDS, radius: "radius:WAT(1)" });
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /radius/);
  assert.equal(issues[0].severity, "WARN");
  assert.equal(issues[0].check, "changelog-malformed");
  assert.equal(serialize(doc), before, "a rejected entry must not mutate the document");
});

test("append rejects a path containing a pipe (unrepresentable in the legacy render)", () => {
  const { issues } = appendEntry(emptyDoc(), { ...FIELDS, path: "src/a|b.js" });
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /"\|"/);
});

test("append accepts every op form, every radius tier, and both dref forms (A6)", () => {
  const ops = ["CREATE(+1)", "EDIT(+1,-1)", "DELETE(-9)", "RENAME(a→b)", "REVERT(src/x.js)"];
  const radii = ["radius:LOW(0)", "radius:MED(3)", "radius:HIGH(6)", "radius:UNKNOWN(script-missing)"];
  const drefs = ["-", "D-002", "D-1000"];
  for (const op of ops) {
    for (const radius of radii) {
      for (const dref of drefs) {
        const { issues } = appendEntry(emptyDoc(), { ...FIELDS, op, radius, dref });
        assert.deepEqual(issues, [], `rejected op=${op} radius=${radius} dref=${dref}`);
      }
    }
  }
});

test("nowTs() produces the second-precision UTC shape the schema requires", () => {
  const ts = nowTs(new Date("2026-07-14T06:30:45.123Z"));
  assert.equal(ts, "2026-07-14T06:30:45Z");
  const { issues } = appendEntry(emptyDoc(), { ...FIELDS, ts: nowTs() });
  assert.deepEqual(issues, []);
});

// --- empty / absent documents --------------------------------------------------

test("append to an ABSENT changelog.xml creates a valid document with the legacy header", () => {
  const dir = tmp();
  try {
    const r = cli(["append", "--plan-dir", dir, "--iter", "1", "--step", "10", "--commit", "abc1234",
      "--path", "src/a.js", "--op", "CREATE(+10)", "--radius", "radius:LOW(1)", "--reason", "first"]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(xmlPath(dir)));

    const doc = readDoc(dir);
    assert.deepEqual(validateDoc(doc, CHANGELOG_SPEC), []);
    const rendered = renderDoc(doc);
    assert.deepEqual(rendered.split("\n").slice(0, 4), MD_HEADER_LINES);
    assert.ok(rendered.endsWith("| - | first\n"), "dref defaults to '-' and the file ends with a newline");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("render of an empty document is the empty string, not a crash", () => {
  assert.equal(renderDoc(makeDoc([])), "");
  const xml = serialize(makeDoc([]));
  assert.equal(renderDoc(parse(xml)), "");
});

test("render of a document with only a root element is sane", () => {
  assert.equal(renderDoc(parse("<changelog></changelog>")), "");
  assert.equal(renderDoc(parse("<changelog/>")), "");
});

// --- atomic writes: the per-writer temp path (K3) ---------------------------------
//
// These three tests were REWRITTEN in iter-2/step-1. They previously asserted the LITERAL path
// `${file}.tmp` — the fixed, shared temp name that is half of the concurrent-append corruption
// (D-008). Asserting a shared name is asserting the bug. They now assert the PROPERTY that matters
// and that a fixed name cannot have: after any write — success or throw — NO temp file of ANY shape
// is left in the plan dir. `tmpResidue()` is deliberately shape-agnostic, so re-introducing a fixed
// name would not make these tests pass again by accident.

/** Every temp artifact left in a plan dir. Shape-agnostic on purpose. */
const tmpResidue = (dir) => readdirSync(dir).filter((f) => f.endsWith(".tmp"));
const lockResidue = (dir) => readdirSync(dir).filter((f) => f.endsWith(".lock"));

test("K3: the temp path is per-writer — it carries the pid and is never reused", () => {
  const file = "/nowhere/changelog.xml"; // pure path arithmetic; nothing is written
  const a = tempPathFor(file);
  const b = tempPathFor(file);
  assert.ok(a.includes(`.${process.pid}.`), `temp path must carry the pid, got ${a}`);
  assert.ok(a.endsWith(".tmp") && b.endsWith(".tmp"));
  assert.notEqual(a, b, "two writes must never open the same temp path, even in one process");
  assert.notEqual(a, `${file}.tmp`, "the fixed shared temp name is exactly the bug (D-008)");
});

test("K3: writeDocAtomic leaves no temp residue and the result parses", () => {
  const dir = tmp();
  try {
    const file = xmlPath(dir);
    writeDocAtomic(file, emptyDoc());
    assert.ok(existsSync(file));
    assert.deepEqual(tmpResidue(dir), [], "the temp file must be renamed away, never left behind");
    assert.deepEqual(validateDoc(parse(readFileSync(file, "utf8")), CHANGELOG_SPEC), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("K3: a serialize failure leaves the ORIGINAL changelog.xml intact, parseable, and no residue", () => {
  const dir = tmp();
  try {
    const file = xmlPath(dir);
    writeDocAtomic(file, emptyDoc());
    const before = readFileSync(file, "utf8");

    // A document serialize() cannot represent: the failure happens BEFORE any byte is written,
    // which is the point — serialization is not streamed into the destination file.
    const broken = makeDoc([{ type: "comment", value: "x --> y" }]);
    assert.throws(() => writeDocAtomic(file, broken));

    assert.equal(readFileSync(file, "utf8"), before, "the original document is untouched");
    assert.deepEqual(validateDoc(parse(readFileSync(file, "utf8")), CHANGELOG_SPEC), []);
    assert.deepEqual(tmpResidue(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("K3: a THROW inside the write itself still leaves no temp residue (the try/finally)", () => {
  // The serialize-failure test above throws BEFORE the temp file exists, so it never exercises the
  // finally. This one does: the destination is a NON-EMPTY DIRECTORY, so writeFileSync succeeds and
  // renameSync throws — the only window in which a temp file is live on disk.
  const dir = tmp();
  try {
    const file = xmlPath(dir);
    mkdirSync(file, { recursive: true });
    writeFileSync(join(file, "occupied"), "x");

    assert.throws(() => writeDocAtomic(file, emptyDoc()), /.*/, "renaming over a non-empty dir must fail");
    assert.deepEqual(tmpResidue(dir), [], "a failed rename must not strand its temp file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("K3: a stale temp file from a crashed run does not corrupt the next write", () => {
  const dir = tmp();
  try {
    const file = xmlPath(dir);
    writeDocAtomic(file, emptyDoc());
    writeFileSync(`${file}.999999.1.tmp`, "<changelog>TRUNCATED"); // a crashed writer's leftover
    const doc = readDoc(dir);
    appendEntry(doc, FIELDS);
    writeDocAtomic(file, doc);
    assert.deepEqual(validateDoc(parse(readFileSync(file, "utf8")), CHANGELOG_SPEC), []);
    assert.equal(elementsOf(readDoc(dir)).filter((e) => e.name === "entry").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- K2: CONCURRENCY — the regression test for D-008 -------------------------------
//
// THE TEST THE 584-TEST SUITE DID NOT HAVE. C12 pinned 50 SEQUENTIAL appends; not one test issued
// two appends at once. That blind spot hid a data-loss bug in the artifact the protocol calls an
// append-only evidence ledger: `ip-executor.md` mandates an append after EACH edit and the harness
// encourages parallel tool calls, so an executor editing 5 files in one batch is the NORMAL path.
//
// Measured against a68d939 (pre-fix), all child processes exiting 0 — SILENTLY:
//   10 parallel appends, fresh changelog     ->  5, 5, 6 of 10 recorded
//    8 parallel appends, 400-entry changelog ->  2, 1, 2 of  8 recorded
//   16 parallel appends, 3000-entry changelog ->  1 of 16 recorded, 8 trials out of 8
// and (rarer, timing-dependent) changelog.xml left UNPARSEABLE — "text is not allowed outside the
// root element" — from two writers interleaving bytes in the shared ${file}.tmp.
//
// The tests below MUST FAIL on that code. A concurrency test that passes on the broken code is not
// evidence, it is decoration. Do NOT weaken the "exactly N" assertion to "at least 1".

/** N `changelog.mjs append` child processes, ALL spawned before ANY is awaited (a real race). */
function appendRace(dir, n) {
  const kids = Array.from({ length: n }, (_, i) => new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT, "append", "--plan-dir", dir, "--iter", "2",
      "--step", String(i + 1), "--commit", "uncommitted", "--path", `src/p${i + 1}.js`,
      "--op", "EDIT(+1,-1)", "--radius", "radius:LOW(0)", "--reason", `parallel ${i + 1}`],
      { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("close", (code) => resolve({ code, stderr }));
  }));
  return Promise.all(kids); // launched above, awaited here — never awaited in the loop
}

/** A plan dir whose changelog.xml already holds `pre` entries. */
function seedPlanDir(pre = 0) {
  const dir = tmp();
  const doc = emptyDoc();
  for (let i = 1; i <= pre; i++) {
    appendEntry(doc, { ...FIELDS, step: `iter-1/step-${i}`, reason: `pre ${i}` });
  }
  writeDocAtomic(xmlPath(dir), doc);
  return dir;
}

/** Every recorded entry, re-parsed FROM DISK, with the document's own well-formedness asserted. */
function readEntries(dir) {
  const doc = parse(readFileSync(xmlPath(dir), "utf8")); // throws if a writer corrupted it
  assert.deepEqual(validateDoc(doc, CHANGELOG_SPEC), [], "every entry must be schema-valid");
  return elementsOf(doc).filter((e) => e.name === "entry");
}

test("K2: 10 PARALLEL appends — all 10 recorded, document re-parses, no residue", async () => {
  const dir = seedPlanDir(0);
  try {
    const t0 = Date.now();
    const results = await appendRace(dir, 10);
    const elapsed = Date.now() - t0;

    assert.ok(elapsed < 3000, `no append may stall: the race took ${elapsed}ms (budget 3000)`);
    results.forEach((r, i) => assert.equal(r.code, 0, `child ${i + 1} failed: ${r.stderr}`));

    const entries = readEntries(dir);
    const recorded = entries.map((e) => e.attrs.reason).filter((r) => r.startsWith("parallel "));
    assert.equal(recorded.length, 10, "EVERY parallel append must be recorded — this is the bug");
    assert.deepEqual(
      [...recorded].sort(),
      Array.from({ length: 10 }, (_, i) => `parallel ${i + 1}`).sort(),
      "all 10 distinct entries, none lost and none duplicated",
    );
    assert.deepEqual(tmpResidue(dir), [], "no temp file survives the race");
    assert.deepEqual(lockResidue(dir), [], "no lock file survives the race");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("K2: 8 PARALLEL appends against a 400-entry changelog — all 8 recorded, none lost", async () => {
  // The reviewer's worst measurement: 1 of 8 recorded, 5/5 trials. A bigger document widens the
  // read-modify-write window, so this is the variant that loses the most.
  const dir = seedPlanDir(400);
  try {
    const results = await appendRace(dir, 8);
    results.forEach((r, i) => assert.equal(r.code, 0, `child ${i + 1} failed: ${r.stderr}`));

    const entries = readEntries(dir);
    assert.equal(entries.length, 408, "400 pre-existing + 8 appended, with nothing overwritten");
    const recorded = entries.filter((e) => e.attrs.reason.startsWith("parallel "));
    assert.equal(recorded.length, 8);
    assert.deepEqual(tmpResidue(dir), []);
    assert.deepEqual(lockResidue(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("K2: the ledger stays ordered — entries are appended, never interleaved into the preamble", async () => {
  const dir = seedPlanDir(0);
  try {
    await appendRace(dir, 10);
    const doc = parse(readFileSync(xmlPath(dir), "utf8"));
    const lines = renderDoc(doc).split("\n");

    // The legacy shape survives 10 racing writers: header, blank, 10 entries, trailing newline.
    assert.deepEqual(lines.slice(0, 4), MD_HEADER_LINES);
    assert.equal(lines[4], "");
    assert.equal(lines.length, 4 + 1 + 10 + 1);
    assert.equal(lines[lines.length - 1], "", "the trailing newline survives the race");

    // Chronological by construction: `ts` is stamped INSIDE the lock, so it is the time the entry
    // was RECORDED, and the lock serializes the recording. Arrival order == timestamp order.
    const ts = elementsOf(doc).filter((e) => e.name === "entry").map((e) => e.attrs.ts);
    assert.deepEqual([...ts].sort(), ts, "recorded timestamps are non-decreasing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- K4/K5: the lock's DEGRADATION paths -------------------------------------------
//
// A lock is the classic way to convert a data-loss bug into a HANG (plan.md Pre-Mortem #1). These
// tests exist to catch that, so they assert the boring, unglamorous half of the design: what the
// lock does when it CANNOT be taken, when its holder is dead, and when the work under it throws.
// If any of them is slow or flaky, the design is wrong — not the test.
//
// The invariants: append never blocks; it never hangs; it never lies about having recorded an
// entry; and it never leaves a .lock or a .tmp behind, on ANY path — success, schema rejection, or
// a throw mid-write. A stranded .lock would wedge every future append in that plan dir until the
// stale threshold expired, which is the exact failure this whole mechanism exists to avoid.

const holdLock = (file, mtimeAgeMs = 0) => {
  const lock = lockPath(file);
  writeFileSync(lock, "999999 2026-07-14T00:00:00.000Z\n"); // a pid that is not us
  if (mtimeAgeMs > 0) {
    const when = new Date(Date.now() - mtimeAgeMs);
    utimesSync(lock, when, when); // backdate: this is how a lock becomes "stale"
  }
  return lock;
};

test("K4: a lock held by a LIVE holder — append degrades within budget and records NOTHING", () => {
  const dir = seedPlanDir(1);
  try {
    const file = xmlPath(dir);
    const before = readFileSync(file, "utf8");
    holdLock(file); // fresh mtime => a live holder, never broken as stale

    const t0 = Date.now();
    const r = cli(["append", "--plan-dir", dir, "--iter", "2", "--step", "9", "--commit", "uncommitted",
      "--path", "src/a.js", "--op", "EDIT(+1,-1)", "--radius", "radius:LOW(0)", "--reason", "blocked"]);
    const elapsed = Date.now() - t0;

    assert.notEqual(r.status, 0, "a contended append must exit non-zero, not pretend success");
    assert.ok(elapsed >= LOCK_BUDGET_MS - 100, `it must actually WAIT for the budget, waited ${elapsed}ms`);
    assert.ok(elapsed < 3000, `it must NEVER stall: waited ${elapsed}ms (hard bound 3000)`);

    assert.match(r.stderr, /could not acquire lock/);
    assert.match(r.stderr, /entry NOT recorded/, "silence is the failure mode — it must SAY it lost the entry");
    assert.ok(r.stderr.includes(file), "the message must name the file the executor can go look at");

    assert.equal(readFileSync(file, "utf8"), before, "the ledger is byte-unchanged");
    assert.deepEqual(validateDoc(parse(readFileSync(file, "utf8")), CHANGELOG_SPEC), [], "and still parses");
    assert.deepEqual(tmpResidue(dir), [], "a degraded append leaves no temp file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("K5: a STALE lock (dead holder) is broken, and the append succeeds", () => {
  const dir = seedPlanDir(1);
  try {
    const file = xmlPath(dir);
    holdLock(file, LOCK_STALE_MS * 3); // mtime well past the threshold: a crashed writer's corpse

    const r = cli(["append", "--plan-dir", dir, "--iter", "2", "--step", "9", "--commit", "uncommitted",
      "--path", "src/a.js", "--op", "EDIT(+1,-1)", "--radius", "radius:LOW(0)", "--reason", "after stale"]);

    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /stale lock/, "breaking a lock is never silent — it is logged");
    const entries = readEntries(dir);
    assert.equal(entries.length, 2, "the entry is recorded: a dead holder must not wedge the ledger");
    assert.equal(entries[1].attrs.reason, "after stale");
    assert.deepEqual(lockResidue(dir), [], "the broken lock is replaced and then released");
    assert.deepEqual(tmpResidue(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("K5: a stale lock is broken ONCE, not repeatedly — a live holder that re-takes it still wins", () => {
  const dir = seedPlanDir(0);
  try {
    const file = xmlPath(dir);
    holdLock(file, LOCK_STALE_MS * 3);

    const logged = [];
    // Break the stale lock, then immediately re-hold it with a FRESH one (simulating a live writer
    // that grabbed it in the gap). The second attempt must NOT break the fresh lock: it must give up.
    const first = acquireLock(file, { budgetMs: 200, log: (m) => logged.push(m) });
    assert.ok(first, "the stale lock is broken and the lock acquired");
    assert.equal(logged.length, 1);
    assert.match(logged[0], /broke a stale lock/);

    const second = acquireLock(file, { budgetMs: 200, log: (m) => logged.push(m) });
    assert.equal(second, null, "a lock held by a LIVE holder is never broken — the loser degrades");
    assert.equal(logged.length, 1, "and no second break is logged");

    releaseLock(first);
    assert.deepEqual(lockResidue(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("K4: the lock is exclusive — a second acquire fails while the first is held, and works after release", () => {
  const dir = seedPlanDir(0);
  try {
    const file = xmlPath(dir);
    const a = acquireLock(file, { budgetMs: 150 });
    assert.ok(a, "the first writer wins");
    assert.equal(acquireLock(file, { budgetMs: 150 }), null, "the second must NOT also win (O_EXCL)");

    releaseLock(a);
    const b = acquireLock(file, { budgetMs: 150 });
    assert.ok(b, "and the lock is reusable once released");
    releaseLock(b);
    assert.deepEqual(lockResidue(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("K4: a THROW inside the locked section still releases the lock (the `finally`)", () => {
  // THE most load-bearing line in changelog.mjs. Without it, one bad append wedges every future
  // append in that plan dir until the stale threshold expires — a data-loss bug traded for a stall.
  const dir = seedPlanDir(0);
  try {
    const file = xmlPath(dir);
    assert.throws(() => withLock(file, () => { throw new Error("writeDocAtomic blew up"); }), /blew up/);
    assert.deepEqual(lockResidue(dir), [], "the lock MUST be released even when the work throws");

    const after = acquireLock(file, { budgetMs: 150 });
    assert.ok(after, "and the next writer is not wedged out");
    releaseLock(after);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("K4: withLock reports contention as a value, not an exception — it never waits forever", () => {
  const dir = seedPlanDir(0);
  try {
    const file = xmlPath(dir);
    holdLock(file);
    let ran = false;
    const r = withLock(file, () => { ran = true; }, { budgetMs: 150 });
    assert.deepEqual(r, { locked: true, value: undefined });
    assert.equal(ran, false, "the read-modify-write must NOT run without the lock");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("K4: a NORMAL append leaves no lock and no temp file", () => {
  const dir = tmp();
  try {
    const r = cli(["append", "--plan-dir", dir, "--iter", "2", "--step", "1", "--commit", "uncommitted",
      "--path", "src/a.js", "--op", "CREATE(+1)", "--radius", "radius:LOW(0)", "--reason", "clean"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(lockResidue(dir), [], "a successful append leaves NO .lock behind");
    assert.deepEqual(tmpResidue(dir), [], "a successful append leaves NO .tmp behind");
    assert.equal(readEntries(dir).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("K4: a REJECTED entry (schema failure) leaves no lock, no temp file, and the ledger unchanged", () => {
  const dir = seedPlanDir(1);
  try {
    const before = readFileSync(xmlPath(dir), "utf8");
    const r = cli(["append", "--plan-dir", dir, "--iter", "2", "--step", "1", "--commit", "NOTAHASH",
      "--path", "src/a.js", "--op", "CREATE(+1)", "--radius", "radius:LOW(0)", "--reason", "bad"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /rejected/);
    // The rejection happens UNDER the lock (validation is part of the read-modify-write), so this
    // is the path where a missing `finally` would strand the lock most easily.
    assert.deepEqual(lockResidue(dir), [], "a rejected entry must still release the lock");
    assert.deepEqual(tmpResidue(dir), []);
    assert.equal(readFileSync(xmlPath(dir), "utf8"), before, "and must not touch the ledger");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("K4: --dry-run takes NO lock — it writes nothing, so it must never contend with a real writer", () => {
  const dir = seedPlanDir(1);
  try {
    const file = xmlPath(dir);
    const before = readFileSync(file, "utf8");
    holdLock(file); // a real writer is mid-append...

    const t0 = Date.now();
    const r = cli(["append", "--dry-run", "--plan-dir", dir, "--iter", "2", "--step", "1",
      "--commit", "uncommitted", "--path", "src/a.js", "--op", "CREATE(+1)", "--radius",
      "radius:LOW(0)", "--reason", "preview"]);
    const elapsed = Date.now() - t0;

    assert.equal(r.status, 0, "...and --dry-run sails straight past it");
    assert.ok(elapsed < 1000, `--dry-run must not wait on the budget, took ${elapsed}ms`);
    assert.ok(r.stdout.includes("<entry"));
    assert.equal(readFileSync(file, "utf8"), before, "--dry-run writes nothing");

    releaseLock(lockPath(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("K4: --dry-run against a fresh plan dir creates no lock file at all", () => {
  const dir = tmp();
  try {
    const r = cli(["append", "--dry-run", "--plan-dir", dir, "--iter", "2", "--step", "1",
      "--commit", "uncommitted", "--path", "src/a.js", "--op", "CREATE(+1)", "--radius",
      "radius:LOW(0)", "--reason", "preview"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(lockResidue(dir), [], "--dry-run must not create a .lock");
    assert.deepEqual(tmpResidue(dir), []);
    assert.ok(!existsSync(xmlPath(dir)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("K4: a garbage lock file cannot confuse the recovery path (staleness is mtime, not contents)", () => {
  // The lock's holder record is for humans. Nothing parses it — so a truncated/binary/empty lock
  // file is just an opaque held lock, and its AGE is the only thing that decides its fate.
  const dir = seedPlanDir(0);
  try {
    const file = xmlPath(dir);
    writeFileSync(lockPath(file), "  not a pid at all ");
    assert.equal(acquireLock(file, { budgetMs: 150 }), null, "garbage but FRESH: still a held lock");

    const old = new Date(Date.now() - LOCK_STALE_MS * 3);
    utimesSync(lockPath(file), old, old);
    const got = acquireLock(file, { budgetMs: 150 });
    assert.ok(got, "garbage but STALE: broken by age, with no attempt to parse it");
    releaseLock(got);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- CLI ------------------------------------------------------------------------

test("CLI: --dry-run writes NOTHING (append and import alike)", () => {
  const dir = tmp();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "changelog.md"), `${HEADER_MD}`);

    const imp = cli(["import", "--dry-run", dir]);
    assert.equal(imp.status, 0, imp.stderr);
    assert.ok(imp.stdout.startsWith("<?xml"));
    assert.ok(!existsSync(xmlPath(dir)), "import --dry-run must not write changelog.xml");

    const app = cli(["append", "--dry-run", "--plan-dir", dir, "--iter", "1", "--step", "1",
      "--commit", "abc1234", "--path", "src/a.js", "--op", "CREATE(+1)", "--radius", "radius:LOW(0)",
      "--reason", "nope"]);
    assert.equal(app.status, 0, app.stderr);
    assert.ok(app.stdout.includes("<entry"));
    assert.ok(!existsSync(xmlPath(dir)), "append --dry-run must not write changelog.xml");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: import writes changelog.xml and refuses to overwrite an existing one", () => {
  const dir = tmp();
  try {
    const md = `${HEADER_MD}2026-07-14T06:00:00Z | iter-1/step-1 | abc1234 | src/a.js | EDIT(+1,-1) | radius:LOW(0) | - | ok\n`;
    writeFileSync(join(dir, "changelog.md"), md);

    const first = cli(["import", dir]);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(renderDoc(readDoc(dir)), md);

    const second = cli(["import", dir]);
    assert.notEqual(second.status, 0, "a second import must not clobber the canonical artifact");
    assert.match(second.stderr, /already exists/);
    assert.equal(renderDoc(readDoc(dir)), md, "and the existing document is unchanged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: append rejects a malformed field with a non-zero exit and writes nothing", () => {
  const dir = tmp();
  try {
    const r = cli(["append", "--plan-dir", dir, "--iter", "1", "--step", "1", "--commit", "NOTAHASH",
      "--path", "src/a.js", "--op", "CREATE(+1)", "--radius", "radius:LOW(0)", "--reason", "x"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /commit/);
    assert.ok(!existsSync(xmlPath(dir)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: append with a missing required flag exits 2 with usage", () => {
  const r = cli(["append", "--plan-dir", "/nonexistent"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /missing --iter/);
});

test("CLI: an unknown subcommand exits 2 with usage", () => {
  const r = cli(["frobnicate"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);
});

test("CLI: render of a malformed changelog.xml fails loudly with line:column, never silently", () => {
  const dir = tmp();
  try {
    writeFileSync(xmlPath(dir), "<changelog><entry ts=\"x\"></changelog>");
    const r = cli(["render", dir]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /line \d+, column \d+/);
    assert.equal(r.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: append survives a reason with pipes and an arrow passed as one argv token", () => {
  const dir = tmp();
  try {
    const reason = "split a → b | keep c";
    const r = cli(["append", "--plan-dir", dir, "--iter", "2", "--step", "3", "--commit", "uncommitted",
      "--path", "src/a.js", "--op", "EDIT(+1,-1)", "--radius", "radius:MED(3)", "--dref", "D-002",
      "--reason", reason]);
    assert.equal(r.status, 0, r.stderr);
    const entry = elementsOf(readDoc(dir)).find((e) => e.name === "entry");
    assert.equal(entry.attrs.reason, reason);
    assert.equal(entry.attrs.step, "iter-2/step-3");
    assert.ok(renderDoc(readDoc(dir)).includes(`| D-002 | ${reason}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
