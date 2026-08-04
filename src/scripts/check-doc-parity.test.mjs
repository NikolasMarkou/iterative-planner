// Requires Node.js 18+
// Tests for check-doc-parity.mjs — File Ownership table parity gate.
//
// Importing comparison from the .mjs is side-effect-free: the CLI body runs
// only under the isEntryPoint guard.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  comparison,
  parseOwnershipTable,
  EXPECTED_MIN_KEYS,
} from "./check-doc-parity.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const script = join(here, "check-doc-parity.mjs");

/**
 * Build a temp fixture root with the layout the CLI expects
 * (src/SKILL.md + README.md) and return its path. Caller removes it.
 */
function makeFixtureRoot(skillText, readmeText) {
  const root = mkdtempSync(join(tmpdir(), "cdp-fixture-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "SKILL.md"), skillText);
  writeFileSync(join(root, "README.md"), readmeText);
  return root;
}

/** Spawn the REAL CLI against a fixture root via the opt-in env override. */
function runCliAgainst(root) {
  return spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, IP_CHECK_DOC_PARITY_ROOT: root },
  });
}

function ownershipTable(rows) {
  return [
    "### File Ownership Model",
    "| File | Owner | Readers |",
    "|------|-------|---------|",
    ...rows.map((k) => `| \`${k}\` | X | Y |`),
    "",
    "## Next Section",
  ].join("\n");
}

/** Like ownershipTable but rows are [keyCellText, ownerCellText] pairs. */
function ownershipTableWithOwners(rows) {
  return [
    "### File Ownership Model",
    "| File | Owner | Readers |",
    "|------|-------|---------|",
    ...rows.map(([k, o]) => `| ${k} | ${o} | Y |`),
    "",
    "## Next Section",
  ].join("\n");
}

test("real repo: README mirrors SKILL.md File Ownership -> exit 0", () => {
  const res = spawnSync("node", [script], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(
    res.status,
    0,
    `expected exit 0; stdout=${res.stdout} stderr=${res.stderr}`,
  );
});

test("pin: EXPECTED_MIN_KEYS equals the live key count parsed from the real SKILL.md and README.md", () => {
  // The floor is EXACT, not headroom-tolerant (the check-register.mjs /
  // check-template-parity.mjs idiom). Parsing is replicated the way the CLI
  // floors each side (check-doc-parity.mjs isEntryPoint): parseOwnershipTable
  // per doc, independently.
  const explain = (side, live) =>
    `EXPECTED_MIN_KEYS (${EXPECTED_MIN_KEYS}) != live ${side} key count (${live}). ` +
    "Adding or removing a File Ownership row is a deliberate change: update the constant and its " +
    "'Real count today' comment in check-doc-parity.mjs in the same commit. Do NOT make the gate " +
    "derive its floor at runtime — a self-derived floor ratifies whatever is on disk, which is the " +
    "vacuity the floor exists to prevent.";
  for (const [side, rel] of [["SKILL.md", join("src", "SKILL.md")], ["README.md", "README.md"]]) {
    const live = parseOwnershipTable(readFileSync(join(repoRoot, rel), "utf8")).keys.size;
    assert.strictEqual(EXPECTED_MIN_KEYS, live, explain(side, live));
  }
});

test("negative: SKILL key absent from README is reported missing", () => {
  const skill = [
    "### File Ownership Model",
    "| File | Owner | Readers |",
    "|------|-------|---------|",
    "| `a.md` | X | Y |",
    "| `b.md` | X | Y |",
    "| `c.md` | X | Y |",
    "",
    "## Next Section",
  ].join("\n");
  const readme = [
    "### File ownership",
    "| File | Owner | Readers |",
    "|------|-------|---------|",
    "| `a.md` | X | Y |",
    "| `b.md` | X | Y |",
    "",
    "## Next Section",
  ].join("\n");
  const { missing } = comparison(skill, readme);
  assert.equal(missing.length, 1);
  assert.ok(missing.includes("c.md"), `expected c.md in ${JSON.stringify(missing)}`);
});

test("negative: README key absent from SKILL is reported extra", () => {
  const skill = [
    "### File Ownership Model",
    "| File | Owner | Readers |",
    "|------|-------|---------|",
    "| `a.md` | X | Y |",
    "| `b.md` | X | Y |",
    "",
    "## Next Section",
  ].join("\n");
  const readme = [
    "### File ownership",
    "| File | Owner | Readers |",
    "|------|-------|---------|",
    "| `a.md` | X | Y |",
    "| `b.md` | X | Y |",
    "| `z.md` | X | Y |",
    "",
    "## Next Section",
  ].join("\n");
  const { extra } = comparison(skill, readme);
  assert.equal(extra.length, 1);
  assert.ok(extra.includes("z.md"), `expected z.md in ${JSON.stringify(extra)}`);
});

test("merged cell + (index) suffix: no false positive", () => {
  const skill = [
    "### File Ownership Model",
    "| File | Owner | Readers |",
    "|------|-------|---------|",
    "| `findings.md` (index) | Orchestrator | All |",
    "| `plans/LESSONS.md` | Archivist | All |",
    "| `plans/SYSTEM.md` | Archivist | All |",
    "",
    "## Next Section",
  ].join("\n");
  const readme = [
    "### File ownership",
    "| File | Owner | Readers |",
    "|------|-------|---------|",
    "| `findings.md` (index) | Orchestrator | All |",
    "| `plans/LESSONS.md`, `plans/SYSTEM.md` | Archivist | All |",
    "",
    "## Next Section",
  ].join("\n");
  const { missing } = comparison(skill, readme);
  assert.deepEqual(missing, []);
});

test("real CLI FAIL: missing row -> exit 1 + stderr names the missing key", () => {
  const root = makeFixtureRoot(
    ownershipTable(["a.md", "b.md", "c.md"]),
    ownershipTable(["a.md", "b.md"]),
  );
  try {
    const res = runCliAgainst(root);
    assert.equal(res.status, 1, `expected exit 1; stdout=${res.stdout} stderr=${res.stderr}`);
    assert.match(
      res.stderr,
      /check-doc-parity: FAIL — README File Ownership table is missing 1 row\(s\) present in SKILL\.md:/,
    );
    assert.match(res.stderr, /^c\.md$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real CLI FAIL: extra row -> exit 1 + stderr names the extra key", () => {
  const root = makeFixtureRoot(
    ownershipTable(["a.md", "b.md"]),
    ownershipTable(["a.md", "b.md", "z.md"]),
  );
  try {
    const res = runCliAgainst(root);
    assert.equal(res.status, 1, `expected exit 1; stdout=${res.stdout} stderr=${res.stderr}`);
    assert.match(
      res.stderr,
      /check-doc-parity: FAIL — README File Ownership table has 1 row\(s\) not present in SKILL\.md:/,
    );
    assert.match(res.stderr, /^z\.md$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("owner cells: whitespace-only differences are NOT a mismatch", () => {
  const skill = ownershipTableWithOwners([
    ["`a.md`", "Owner  One (Post-Step   Gate)"],
    ["`b.md`", "Owner Two"],
  ]);
  const readme = ownershipTableWithOwners([
    ["`a.md`", "Owner One   (Post-Step Gate)"],
    ["`b.md`", " Owner Two "],
  ]);
  const { missing, extra, ownerMismatches } = comparison(skill, readme);
  assert.deepEqual(missing, []);
  assert.deepEqual(extra, []);
  assert.deepEqual(ownerMismatches, []);
});

test("owner cells: merged-cell tokens inherit the row owner cell", () => {
  const skill = ownershipTableWithOwners([
    ["`x.md`", "Archivist"],
    ["`y.md`", "Orchestrator"],
  ]);
  const readme = ownershipTableWithOwners([
    ["`x.md`, `y.md`", "Archivist"],
  ]);
  const { ownerMismatches } = comparison(skill, readme);
  assert.equal(ownerMismatches.length, 1);
  assert.equal(ownerMismatches[0].key, "y.md");
  assert.equal(ownerMismatches[0].skill, "Orchestrator");
  assert.equal(ownerMismatches[0].readme, "Archivist");
});

test("real CLI PASS: owner cells identical modulo whitespace -> exit 0", () => {
  // Filler rows keep the fixture at/above EXPECTED_MIN_KEYS so the anti-vacuity
  // floor stays out of this test's way. Derived from the imported constant, not
  // hardcoded: a literal here is value-coupled to the floor without naming it,
  // so the next legitimate bump would silently become a 4-site edit.
  const filler = Array.from({ length: EXPECTED_MIN_KEYS - 2 }, (_, i) => [`\`f${i}.md\``, "Owner F"]);
  const root = makeFixtureRoot(
    ownershipTableWithOwners([
      ["`a.md`", "Owner One  (scope)"],
      ["`b.md`", "Owner Two"],
      ...filler,
    ]),
    ownershipTableWithOwners([
      ["`a.md`", "Owner One (scope)"],
      ["`b.md`", "Owner  Two"],
      ...filler,
    ]),
  );
  try {
    const res = runCliAgainst(root);
    assert.equal(res.status, 0, `expected exit 0; stdout=${res.stdout} stderr=${res.stderr}`);
    assert.match(res.stdout, /owner cells match/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real CLI FAIL [doc-parity-owner]: drifted owner cell -> exit 1 + slug + key + both cells", () => {
  const root = makeFixtureRoot(
    ownershipTableWithOwners([
      ["`a.md`", "Orchestrator"],
      ["`b.md`", "Executor (append per edit)"],
    ]),
    ownershipTableWithOwners([
      ["`a.md`", "Orchestrator"],
      ["`b.md`", "Executor"],
    ]),
  );
  try {
    const res = runCliAgainst(root);
    assert.equal(res.status, 1, `expected exit 1; stdout=${res.stdout} stderr=${res.stderr}`);
    assert.match(
      res.stderr,
      /check-doc-parity: FAIL \[doc-parity-owner\] — owner cell differs for 1 key\(s\) \(exact match after whitespace normalization\):/,
    );
    assert.match(res.stderr, /^`b\.md`$/m);
    assert.match(res.stderr, /^ {2}SKILL\.md: {2}Executor \(append per edit\)$/m);
    assert.match(res.stderr, /^ {2}README\.md: Executor$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- anti-vacuity floor + CRLF/BOM tolerance (plan-2026-07-21-38d0cd87 step 2)

test("CRLF doc parses the same keys and owners as LF (A7: whitespace handling absorbs \\r)", () => {
  const lf = ownershipTableWithOwners([
    ["`a.md`", "Owner One"],
    ["`b.md`", "Owner Two (scope)"],
  ]);
  const crlf = lf.replace(/\n/g, "\r\n");
  const fromLf = parseOwnershipTable(lf);
  const fromCrlf = parseOwnershipTable(crlf);
  assert.deepEqual([...fromCrlf.keys].sort(), [...fromLf.keys].sort());
  assert.deepEqual(
    Object.fromEntries(fromCrlf.owners),
    Object.fromEntries(fromLf.owners),
  );
});

test("BOM determinism: BOM on the heading line hides the table (0 keys); BOM elsewhere is harmless", () => {
  const table = ownershipTable(["a.md", "b.md"]);
  // BOM directly prefixes the File Ownership heading -> the heading regex
  // misses -> no table found. Deterministic: the CLI floor turns this into a
  // loud FAIL (pinned by the spawn test below).
  assert.equal(parseOwnershipTable("\uFEFF" + table).keys.size, 0);
  // BOM prefixes a different first line -> the heading still matches.
  assert.equal(parseOwnershipTable("\uFEFF# Title\n" + table).keys.size, 2);
});

test("real CLI PASS: CRLF README at/above the floor -> exit 0 (A7 pinned end-to-end)", () => {
  // Key count must stay at/above EXPECTED_MIN_KEYS — that is this fixture's
  // stated premise ("at/above the floor"), so the floor, not CRLF handling, is
  // never what decides the exit code. Derived from the imported constant so the
  // fixture tracks a floor bump instead of becoming the new drift point.
  const keys = Array.from({ length: EXPECTED_MIN_KEYS }, (_, i) => `k${i}.md`);
  const root = makeFixtureRoot(
    ownershipTable(keys),
    ownershipTable(keys).replace(/\n/g, "\r\n"),
  );
  try {
    const res = runCliAgainst(root);
    assert.equal(res.status, 0, `expected exit 0; stdout=${res.stdout} stderr=${res.stderr}`);
    assert.match(res.stdout, new RegExp(`${EXPECTED_MIN_KEYS} keys`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real CLI FAIL [doc-parity-floor]: parity-clean tables below the floor -> exit 1 naming both sides", () => {
  // The silent-pass class: both sides agree perfectly (parity finds nothing)
  // but almost nothing was parsed. Used to print PASS.
  const root = makeFixtureRoot(
    ownershipTable(["a.md", "b.md", "c.md"]),
    ownershipTable(["a.md", "b.md", "c.md"]),
  );
  try {
    const res = runCliAgainst(root);
    assert.equal(res.status, 1, `expected exit 1; stdout=${res.stdout} stderr=${res.stderr}`);
    assert.match(
      res.stderr,
      new RegExp(
        `check-doc-parity: FAIL \\[doc-parity-floor\\] — SKILL\\.md side parsed 3 key\\(s\\), below EXPECTED_MIN_KEYS = ${EXPECTED_MIN_KEYS}`,
      ),
    );
    assert.match(res.stderr, /README\.md side parsed 3 key\(s\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real CLI FAIL [doc-parity-floor]: BOM-prefixed SKILL.md heading -> loud FAIL naming SKILL.md (0 keys)", () => {
  const keys = Array.from({ length: 12 }, (_, i) => `k${i}.md`);
  const root = makeFixtureRoot(
    "\uFEFF" + ownershipTable(keys),
    ownershipTable(keys),
  );
  try {
    const res = runCliAgainst(root);
    assert.equal(res.status, 1, `expected exit 1; stdout=${res.stdout} stderr=${res.stderr}`);
    assert.match(res.stderr, /\[doc-parity-floor\] — SKILL\.md side parsed 0 key\(s\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real CLI FAIL: missing AND extra simultaneously -> exit 1 + both messages", () => {
  const root = makeFixtureRoot(
    ownershipTable(["a.md", "b.md", "c.md"]),
    ownershipTable(["a.md", "b.md", "z.md"]),
  );
  try {
    const res = runCliAgainst(root);
    assert.equal(res.status, 1, `expected exit 1; stdout=${res.stdout} stderr=${res.stderr}`);
    assert.match(res.stderr, /is missing 1 row\(s\) present in SKILL\.md:/);
    assert.match(res.stderr, /has 1 row\(s\) not present in SKILL\.md:/);
    assert.match(res.stderr, /^c\.md$/m);
    assert.match(res.stderr, /^z\.md$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
