// Requires Node.js 18+
// Tests for check-doc-parity.mjs — File Ownership table parity gate.
//
// Importing comparison from the .mjs is side-effect-free: the CLI body runs
// only under the isEntryPoint guard.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// ---------------------------------------------------------------------------
// DECISION plan-2026-09-01T100120-4f591469/D-018
// Build-channel lockstep (Makefile <-> build.ps1)
//
// Do NOT move these into a new build-parity.test.mjs or a new check-build-lockstep.mjs
// gate. A new test file must be added to the Makefile `test` list, build.ps1 Invoke-Test,
// TEST_COUNT, README and CLAUDE.md — five more hand-maintained lockstep facts to guard one
// lockstep fact — and a new gate script would be the first check-* with no module of its own
// to check. They live here — in the "two shipped documents must agree, in both directions,
// non-vacuously" test file — because that is exactly what they assert, and because
// no gate owned the invariant before. It went unowned and it drifted: every gate in
// build.ps1 was wrapped in `if (Test-Path "src/scripts/check-*.mjs")`, so deleting a
// gate script printed "Validation passed!" on Windows while the Makefile channel died.
// A lockstep invariant no gate enforces is how that drift happened. See decisions.md D-018.
//
// PowerShell is not available in this environment, so build.ps1's RUNTIME behaviour
// cannot be executed here. These are static assertions over its source text — which is
// precisely the class of check that would have caught the Test-Path drift.
// ---------------------------------------------------------------------------

const makefileSrc = readFileSync(join(repoRoot, "Makefile"), "utf8");
const buildPs1Src = readFileSync(join(repoRoot, "build.ps1"), "utf8");

/** Recipe lines of a Makefile target: the run of tab-indented lines after `name:`. */
function makeRecipe(src, target) {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`${target}:`));
  assert.ok(start >= 0, `Makefile target "${target}:" not found`);
  const out = [];
  for (let i = start + 1; i < lines.length && lines[i].startsWith("\t"); i++) out.push(lines[i]);
  assert.ok(out.length > 0, `Makefile target "${target}" has an empty recipe`);
  return out.join("\n");
}

/** Body of a PowerShell `function Name {` block, by brace counting. */
function psFunction(src, name) {
  const open = src.indexOf(`function ${name} {`);
  assert.ok(open >= 0, `build.ps1 function ${name} not found`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  assert.fail(`build.ps1 function ${name} has unbalanced braces`);
}

const sorted = (xs) => [...new Set(xs)].sort();
const matchAll = (text, re) => [...text.matchAll(re)].map((m) => m[1]);

test("build channels: `validate` runs the same gate scripts (no channel-only gate)", () => {
  const mk = sorted(matchAll(makeRecipe(makefileSrc, "validate"), /node src\/scripts\/(check-[a-z-]+\.mjs)/g));
  const ps = sorted(matchAll(psFunction(buildPs1Src, "Invoke-Validate"), /node src\/scripts\/(check-[a-z-]+\.mjs)/g));
  assert.ok(mk.length >= 6, `anti-vacuity: parsed only ${mk.length} gates from the Makefile validate recipe`);
  assert.deepEqual(ps, mk, "build.ps1 Invoke-Validate and the Makefile validate target run different gate sets");
  assert.ok(!mk.includes("check-test-count.mjs"), "check-test-count.mjs must stay OUT of validate (validate must stay fast)");
});

test("build.ps1: no mandatory script or gate is wrapped in a Test-Path skip", () => {
  const validate = psFunction(buildPs1Src, "Invoke-Validate");
  // Anti-vacuity: the assertion below is only meaningful if gates are actually invoked here.
  const invocations = matchAll(validate, /node src\/scripts\/(check-[a-z-]+\.mjs)/g);
  assert.ok(invocations.length >= 6, `anti-vacuity: found only ${invocations.length} gate invocations to guard`);
  const skips = [...validate.matchAll(/^\s*if \(Test-Path "(src\/scripts\/[^"]+)"\)/gm)].map((m) => m[1]);
  assert.deepEqual(skips, [], `build.ps1 silently skips a missing script instead of failing: ${skips.join(", ")}`);
});

test("build channels: `build` prunes the previous build dir before copying", () => {
  const mk = makeRecipe(makefileSrc, "build");
  const ps = psFunction(buildPs1Src, "Invoke-Build");
  const mkPrune = mk.indexOf("rm -rf $(BUILD_DIR)/$(SKILL_NAME)");
  const mkFirstCopy = mk.indexOf("mkdir -p $(BUILD_DIR)/$(SKILL_NAME)");
  assert.ok(mkPrune >= 0 && mkPrune < mkFirstCopy, "Makefile build must rm -rf the skill build dir BEFORE recreating it");
  const psPrune = ps.search(/Remove-Item -Recurse -Force \$skillDir/);
  const psCreate = ps.indexOf("New-Item -ItemType Directory -Force -Path $skillDir");
  assert.ok(psPrune >= 0 && psPrune < psCreate, "build.ps1 Invoke-Build must remove $skillDir BEFORE recreating it");
});

test("build channels: `package` and `package-tar` remove the old archive before creating it", () => {
  const mkZip = makeRecipe(makefileSrc, "package");
  assert.ok(/rm -f \$\(DIST_DIR\)\/\$\(SKILL_NAME\)-v\$\(VERSION\)\.zip[\s\S]*zip -r/.test(mkZip), "Makefile package must rm -f the zip before zip -r");
  const mkTar = makeRecipe(makefileSrc, "package-tar");
  assert.ok(/rm -f \$\(DIST_DIR\)\/\$\(SKILL_NAME\)-v\$\(VERSION\)\.tar\.gz[\s\S]*tar -czvf/.test(mkTar), "Makefile package-tar must rm -f the tarball before tar");
  const psZip = psFunction(buildPs1Src, "Invoke-Package");
  assert.ok(/Remove-Item \$zipFile[\s\S]*ZipFile\]::Open/.test(psZip), "build.ps1 Invoke-Package must remove the old zip before Open");
  const psTar = psFunction(buildPs1Src, "Invoke-PackageTar");
  assert.ok(/Remove-Item -Force \$tarFile[\s\S]*tar -czvf/.test(psTar), "build.ps1 Invoke-PackageTar must remove the old tarball before tar");
});

test("build channels: `lint` node --check the same script list", () => {
  const mk = sorted(matchAll(makeRecipe(makefileSrc, "lint"), /node --check src\/scripts\/([a-z-]+\.mjs)/g));
  const ps = sorted(matchAll(psFunction(buildPs1Src, "Invoke-Lint"), /"([a-z-]+\.mjs)"/g));
  assert.ok(mk.length >= 14, `anti-vacuity: parsed only ${mk.length} lint targets from the Makefile`);
  assert.deepEqual(ps, mk, "build.ps1 Invoke-Lint and the Makefile lint target check different scripts");
});

test("build channels: `test` runs the suite exactly once, through check-test-count", () => {
  const mk = makeRecipe(makefileSrc, "test");
  const ps = psFunction(buildPs1Src, "Invoke-Test");
  for (const [name, body] of [["Makefile", mk], ["build.ps1", ps]]) {
    assert.ok(/node src\/scripts\/check-test-count\.mjs/.test(body), `${name} test no longer runs check-test-count`);
    const code = body.split("\n").filter((l) => !l.trimStart().startsWith("#") && !/^\s*@?echo|Write-Host/.test(l)).join("\n");
    assert.ok(!/node --test/.test(code), `${name} test runs \`node --test\` directly AND via check-test-count (suite twice)`);
  }
});

test("build channels: build-combined declares the same rewrite key/value pairs", () => {
  // Makefile: `@$(SED_I) 's|PATTERN|REPLACEMENT|g' ...` — PATTERN is a BRE, so unescape it.
  const mk = sorted(
    [...makeRecipe(makefileSrc, "build-combined").matchAll(/^\t@\$\(SED_I\) 's\|([^|]*)\|([^|]*)\|g'/gm)]
      .map((m) => `${m[1].replace(/\\(.)/g, "$1")} ${m[2]}`),
  );
  // build.ps1: hashtable entries `'KEY' = 'VALUE'` (single-quoted, '' escapes a quote).
  const unps = (s) => s.replace(/''/g, "'");
  const ps = sorted(
    [...psFunction(buildPs1Src, "Invoke-BuildCombined").matchAll(/^ +'((?:[^']|'')*)' = '((?:[^']|'')*)'\s*$/gm)]
      .map((m) => `${unps(m[1])} ${unps(m[2])}`),
  );
  assert.ok(mk.length >= 29, `anti-vacuity: parsed only ${mk.length} rewrite pairs from the Makefile`);
  assert.deepEqual(ps, mk, "the two build-combined rewrite maps have drifted");
});

test("build-combined (Makefile, actually run): no `node <skill-path>/scripts/emit-` line survives", () => {
  const out = mkdtempSync(join(tmpdir(), "bc-"));
  try {
    const r = spawnSync("make", ["build-combined", `BUILD_DIR=${out}`], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(r.status, 0, `make build-combined failed: ${r.stderr}`);
    const text = readFileSync(join(out, "iterative-planner-combined.md"), "utf8");
    const left = text.split("\n").filter((l) => l.includes("node <skill-path>/scripts/emit-"));
    assert.deepEqual(left, [], "an emit-* pointer survived the Makefile rewrite");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("build-combined (build.ps1, simulated): applying its rewrite map to the source prose leaves no emit-* line", () => {
  // PowerShell cannot run here, so apply build.ps1's own hashtable, in order, to the same
  // files the combined build concatenates and require the same acceptance as the Makefile.
  const unps = (s) => s.replace(/''/g, "'");
  const pairs = [...psFunction(buildPs1Src, "Invoke-BuildCombined").matchAll(/^ +'((?:[^']|'')*)' = '((?:[^']|'')*)'\s*$/gm)]
    .map((m) => [unps(m[1]), unps(m[2])]);
  assert.ok(pairs.length >= 29, `anti-vacuity: parsed only ${pairs.length} pairs from build.ps1`);
  const files = [join(repoRoot, "src", "SKILL.md")];
  for (const dir of ["references", join("scripts", "modules")]) {
    const d = join(repoRoot, "src", dir);
    for (const f of readdirSync(d).sort()) if (f.endsWith(".md")) files.push(join(d, f));
  }
  let text = files.map((f) => readFileSync(f, "utf8")).join("\n");
  for (const [k, v] of pairs) text = text.split(k).join(v);
  const left = text.split("\n").filter((l) => l.includes("node <skill-path>/scripts/emit-"));
  assert.deepEqual(left, [], "an emit-* pointer would survive build.ps1's rewrite map");
});

// DECISION plan-2026-09-01T100120-4f591469/D-029
// Do NOT "finish the job" by rewriting the ~22 surviving `node <skill-path>/scripts/...`
// pointers in the combined file. They name real commands of the full package and have no
// inlined substitute (unlike `emit-*`, whose output IS inlined), so rewriting them deletes
// the reader's only record that the command exists. The honesty is published ONCE, in the
// trailing Note, and this test is what keeps that Note identical in both build channels.
// Do NOT move the Note above SKILL.md either: its YAML frontmatter must stay first.
// See decisions.md D-029.
test("build channels: build-combined emits the SAME trailing Note text", () => {
  // W6/D-029: the combined file discloses ONCE that no script pointer in it is runnable,
  // instead of rewriting ~22 pointers. A disclosure that exists in only one channel is
  // worse than none — the Windows reader silently gets the old, narrower claim. The two
  // channels build the same lines by different escaping (Make: shell `\\``; PowerShell: "``"),
  // so compare the DECODED text, not the source lines.
  const mkNote = [...makeRecipe(makefileSrc, "build-combined")
    .matchAll(/^\t@echo "(> [^"]*)" >> /gm)].map((m) => m[1].replace(/\\`/g, "`"));
  const psNote = [...psFunction(buildPs1Src, "Invoke-BuildCombined")
    .matchAll(/^ +\$content \+= "(> .*?)`n"$/gm)].map((m) => m[1].replace(/``/g, "`"));
  assert.ok(mkNote.length >= 5, `anti-vacuity: parsed only ${mkNote.length} Note lines from the Makefile`);
  assert.deepEqual(psNote, mkNote, "the two build-combined Note blocks have drifted");
  // The disclosure must actually make its claim, not merely exist.
  const joined = mkNote.join(" ");
  assert.match(joined, /runnable as written/, "the Note no longer states that script pointers are not runnable");
  assert.match(joined, /scripts\/\.\.\./, "the Note no longer names the `node <skill-path>/scripts/...` form it disclaims");
});

test("build.ps1: declares #Requires -Version 7 and encodes every content round-trip", () => {
  assert.equal(buildPs1Src.split("\n")[0], "#Requires -Version 7");
  const io = buildPs1Src
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .filter((l) => /\b(Get-Content|Set-Content)\b/.test(l));
  assert.ok(io.length >= 8, `anti-vacuity: found only ${io.length} Get-Content/Set-Content lines`);
  const unencoded = io.filter((l) => !/-Encoding utf8/.test(l));
  assert.deepEqual(unencoded, [], "Get-Content/Set-Content without an explicit -Encoding utf8 (PS 5.1 would use the ANSI codepage)");
});

test("build channels: sync-skill prunes the same four litter paths and enforces the same install allowlist", () => {
  const mkSync = makefileSrc.slice(makefileSrc.indexOf("\nsync-skill:"), makefileSrc.indexOf("\n.PHONY: help"));
  const psSync = psFunction(buildPs1Src, "Invoke-SyncSkill");
  assert.ok(mkSync.length > 200, "anti-vacuity: sync-skill section not found in the Makefile");
  const mkLitter = (mkSync.match(/else rm -rf (.+?); fi$/m) || [, ""])[1]
    .split(/\s+/).map((t) => t.replace(/"/g, "").replace("$(SKILL_INSTALL_DIR)/", ""));
  const psLitter = [...((psSync.match(/foreach \(\$litter in @\(([^)]*)\)\)/) || [, ""])[1].matchAll(/"([^"]+)"/g))].map((m) => m[1]);
  assert.deepEqual(mkLitter, ["src", "CLAUDE.md", "Makefile", "build.ps1"], "Makefile litter prune list changed");
  assert.deepEqual(psLitter, mkLitter, "build.ps1 and the Makefile prune different litter paths");
  const mkAllow = (mkSync.match(/case "\$\$e" in ([^;)]+)\)/) || [, ""])[1].split("|");
  const psAllow = [...((psSync.match(/\$allowed = @\(([^)]*)\)/) || [, ""])[1].matchAll(/"([^"]+)"/g))].map((m) => m[1]);
  assert.equal(mkAllow.length, 10, "anti-vacuity: Makefile allowlist should hold 10 entries");
  assert.deepEqual(sorted(psAllow), sorted(mkAllow), "build.ps1 and the Makefile allow different install entries");
  assert.match(mkSync, /test -n "\$\(HOME\)"/, "Makefile prune lost its empty-HOME guard");
  assert.match(psSync, /IsNullOrEmpty\(\$HOME\)/, "build.ps1 prune lost its empty-HOME guard");
  assert.ok(!/Test-Path[^\n]*litter/.test(psSync), "build.ps1 wraps the prune in a Test-Path skip");
  // The allowlist is the 10 names the build package and sync-skill write, with commands and without .git/.gitignore.
  const expected = ["SKILL.md", "README.md", "LICENSE", "CHANGELOG.md", "VERSION", "scripts", "references", "agents", "commands", ".claude"];
  assert.deepEqual(sorted(mkAllow), sorted(expected), "install allowlist changed");
  assert.ok(!mkAllow.includes(".git") && !mkAllow.includes(".gitignore"), "allowlist must not name .git/.gitignore");
  // Clone-install mode (D-009): a .git in the install skips BOTH the prune and the allowlist, in both channels.
  assert.match(mkSync, /if \[ -e "\$\(SKILL_INSTALL_DIR\)\/\.git" \]; then echo "WARNING:[^\n]*else rm -rf /, "Makefile prune lost its .git clone guard");
  assert.match(mkSync, /if \[ ! -e "\$\(SKILL_INSTALL_DIR\)\/\.git" \]; then bad=0;/, "Makefile allowlist lost its .git clone guard");
  assert.match(psSync, /\$isClone = Test-Path -LiteralPath \(Join-Path \$skillInstallDir "\.git"\)/, "build.ps1 lost its clone detection");
  assert.match(psSync, /if \(\$isClone\) \{\s*Write-Host "WARNING:[\s\S]*?\} else \{\s*foreach \(\$litter/, "build.ps1 prune lost its clone guard");
  assert.match(psSync, /if \(-not \$isClone\) \{\s*foreach \(\$entry/, "build.ps1 allowlist lost its clone guard");
  // The allowlist check precedes the success line in the Makefile (as it already does in build.ps1).
  assert.ok(mkSync.indexOf("unexpected entry in install") < mkSync.indexOf("Sync verified"), "Makefile prints Sync verified before the allowlist check");
});

test("build channels: sync-skill guards (empty HOME, symlinked install) run BEFORE any mkdir/rm/cp, and every install path is quoted", () => {
  const mkSync = makefileSrc.slice(makefileSrc.indexOf("\nsync-skill:"), makefileSrc.indexOf("\n.PHONY: help"));
  const psSync = psFunction(buildPs1Src, "Invoke-SyncSkill");
  const firstMut = mkSync.search(/^\t(mkdir|rm|cp) /m);
  assert.ok(firstMut > 0, "anti-vacuity: no mutating recipe line found in sync-skill");
  assert.ok(mkSync.indexOf('test -n "$(HOME)"') < firstMut, "Makefile HOME guard must precede the first mkdir/rm/cp");
  assert.ok(mkSync.indexOf("-L \"$$d\"") > 0 && mkSync.indexOf("-L \"$$d\"") < firstMut, "Makefile symlink guard must precede the first mkdir/rm/cp");
  const psFirstMut = psSync.search(/New-Item|Remove-Item|Copy-Item/);
  assert.ok(psSync.indexOf("IsNullOrEmpty($HOME)") > 0 && psSync.indexOf("IsNullOrEmpty($HOME)") < psFirstMut, "build.ps1 HOME guard must precede the first New-Item/Remove-Item/Copy-Item");
  assert.ok(psSync.indexOf("ReparsePoint") > 0 && psSync.indexOf("ReparsePoint") < psFirstMut, "build.ps1 symlink guard must precede the first mutation");
  assert.ok(psSync.indexOf("$skillInstallDir = Join-Path $HOME") > psSync.indexOf("IsNullOrEmpty($HOME)"), "build.ps1 must not join paths onto an unchecked $HOME");
  const bare = mkSync.split("\n").filter((l) => /^\t/.test(l) && /(^|[^"])\$\((SKILL|AGENTS|COMMANDS)_INSTALL_DIR\)/.test(l.replace(/echo "[^"]*"/g, "").replace(/"\$\([A-Z_]+\)[^"]*"/g, "")));
  assert.deepEqual(bare, [], "sync-skill recipe lines use an unquoted $(..._INSTALL_DIR) path (a HOME with a space splits an rm -rf)");
});

test("build channels: in-place sed goes through SED_I (GNU vs BSD), never a bare sed -i", () => {
  assert.match(makefileSrc, /^SED_I := \$\(shell t=\$\$\(mktemp\)/m, "Makefile lost its SED_I detection");
  const bare = makefileSrc.split("\n").filter((l) => /^\t/.test(l) && /\bsed -i\b/.test(l));
  assert.deepEqual(bare, [], "Makefile recipe uses a bare sed -i (breaks on BSD/macOS)");
});

test("build channels: the __SKILL_DATE__ stamp is UTC in both channels, and doc copies are not skip-wrapped", () => {
  assert.ok(!/Get-Date/.test(buildPs1Src), "build.ps1 stamps the local date (Makefile uses date -u)");
  assert.equal((buildPs1Src.match(/\[DateTime\]::UtcNow/g) || []).length, 2, "both build.ps1 date stamps must be UtcNow");
  assert.ok(!/2>\/dev\/null \|\| true/.test(makeRecipe(makefileSrc, "build")), "Makefile build swallows a missing doc file");
  assert.ok(!/if \(Test-Path \$_\)/.test(buildPs1Src), "build.ps1 skips a missing doc file");
});

test("build channels: every top-level entry the build package writes is on the install allowlist", () => {
  const mkBuild = makefileSrc.slice(makefileSrc.indexOf("\nbuild:"), makefileSrc.indexOf("\n.PHONY: build-combined"));
  const psBuild = psFunction(buildPs1Src, "Invoke-Build");
  const mkSync = makefileSrc.slice(makefileSrc.indexOf("\nsync-skill:"), makefileSrc.indexOf("\n.PHONY: help"));
  const allow = (mkSync.match(/case "\$\$e" in ([^;)]+)\)/) || [, ""])[1].split("|");
  // Top-level names: the package dir itself via $(BUILD_DIR)/$(SKILL_NAME)/<name>[/] and $skillDir/<name>.
  const mkNames = new Set([...mkBuild.matchAll(/\$\(BUILD_DIR\)\/\$\(SKILL_NAME\)\/([A-Za-z][\w.-]*)/g)].map((m) => m[1]));
  const psNames = new Set([...psBuild.matchAll(/\$skillDir\/([A-Za-z][\w.-]*)/g)].map((m) => m[1]));
  for (const must of ["agents", "commands", "scripts", "references"]) {
    assert.ok(mkNames.has(must), `anti-vacuity: Makefile build no longer writes ${must}/`);
    assert.ok(psNames.has(must), `anti-vacuity: build.ps1 build no longer writes ${must}/`);
  }
  for (const n of mkNames) assert.ok(allow.includes(n), `Makefile build writes ${n} but the install allowlist lacks it`);
  for (const n of psNames) assert.ok(allow.includes(n), `build.ps1 build writes ${n} but the install allowlist lacks it`);
});

test("build channels: build and sync-skill both ship commands/ip-dashboard.md (install, exact-name prune, verify)", () => {
  const mkBuild = makefileSrc.slice(makefileSrc.indexOf("\nbuild:"), makefileSrc.indexOf("\n.PHONY: build-combined"));
  const mkSync = makefileSrc.slice(makefileSrc.indexOf("\nsync-skill:"), makefileSrc.indexOf("\n.PHONY: help"));
  const psBuild = psFunction(buildPs1Src, "Invoke-Build");
  const psSync = psFunction(buildPs1Src, "Invoke-SyncSkill");
  assert.ok(mkBuild.length > 200 && mkSync.length > 200, "anti-vacuity: Makefile build/sync-skill sections not found");
  assert.ok(psBuild.length > 200 && psSync.length > 200, "anti-vacuity: build.ps1 build/sync-skill functions not found");
  assert.match(mkBuild, /COMMAND_FILES[\s\S]*commands\//, "Makefile build does not copy src/commands into the package");
  assert.match(psBuild, /src\/commands\/\*\.md[\s\S]*\/commands\//, "build.ps1 build does not copy src/commands into the package");
  // install
  assert.match(mkSync, /^\tcp src\/commands\/ip-dashboard\.md "\$\(COMMANDS_INSTALL_DIR\)\/ip-dashboard\.md"$/m, "Makefile does not install the command");
  assert.match(psSync, /Copy-Item "src\/commands\/ip-dashboard\.md"/, "build.ps1 does not install the command");
  // prune: exact name only, never a glob, in the shared commands dir
  assert.match(mkSync, /^\trm -f "\$\(COMMANDS_INSTALL_DIR\)\/ip-dashboard\.md"$/m, "Makefile prune is not the exact command name");
  assert.match(psSync, /Remove-Item \(Join-Path \$commandsInstallDir "ip-dashboard\.md"\)/, "build.ps1 prune is not the exact command name");
  assert.ok(!/\$\(COMMANDS_INSTALL_DIR\)"?\/[*]/.test(mkSync), "Makefile globs the shared commands dir");
  assert.ok(!/commandsInstallDir[^\n]*[*]/.test(psSync.replace(/Join-Path \$HOME[^\n]{0,}/, "")), "build.ps1 globs the shared commands dir");
  // verify
  assert.match(mkSync, /diff -q src\/commands\/ip-dashboard\.md "\$\(COMMANDS_INSTALL_DIR\)\/ip-dashboard\.md"/, "Makefile does not verify the command");
  assert.match(psSync, /Get-FileHash "src\/commands\/ip-dashboard\.md"/, "build.ps1 does not verify the command");
});

test("Agent Definitions Model column matches each agent's frontmatter model (SKILL.md and README)", () => {
  const agentsDir = join(repoRoot, "src", "agents");
  const files = readdirSync(agentsDir).filter((f) => /^ip-.*\.md$/.test(f));
  const model = (f) => (readFileSync(join(agentsDir, f), "utf8").match(/^model:\s*(\S+)/m) || [, "inherit"])[1];
  const rows = (rel) => readFileSync(join(repoRoot, rel), "utf8").split("\n").filter((l) => l.startsWith("|")).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
  const skill = rows("src/SKILL.md"), readme = rows("README.md");
  // SKILL.md names the file in cell 2; README names the agent in cell 1 (bold, `ip-` prefix optional on the orchestrator).
  const find = (tbl, f, pick) => tbl.find((r) => r.length >= 4 && pick(r, f));
  const bySkill = (r, f) => r[1] === `\`agents/${f}\``;
  const byReadme = (r, f) => r[0].toLowerCase().replace(/[*]/g, "").replace(/^ip-/, "") === f.replace(/^ip-|\.md$/g, "");
  assert.equal(files.length, 8, "expected 8 ip-*.md agents");
  for (const f of files) for (const [tbl, pick, name] of [[skill, bySkill, "SKILL.md"], [readme, byReadme, "README.md"]]) {
    const row = find(tbl, f, pick);
    assert.ok(row, `${name}: no Agent Definitions row for ${f}`);
    assert.equal(row[row.length - 1], model(f), `${name}: Model cell for ${f} disagrees with frontmatter`);
  }
});

test("parseOwnershipTable: duplicate key keeps both owner cells, fenced rows are ignored, any heading ends the table", () => {
  const doc = [
    "## File Ownership", "", "| File | Owner | Readers |", "|---|---|---|",
    "| `a.md` | alpha | x |", "| `a.md` | beta | x |", "| `b.md` | gamma | x |",
    "```", "| `fenced.md` | zed | x |", "```",
    "#### Sub heading", "| `after.md` | late | x |", "",
  ].join("\n");
  const t = parseOwnershipTable(doc);
  assert.equal(t.owners.get("a.md"), "alpha || beta");
  assert.ok(!t.keys.has("fenced.md"), "a row inside a code fence is not part of the table");
  assert.ok(!t.keys.has("after.md"), "a #### heading ends the table");
  assert.deepEqual([...t.keys].sort(), ["a.md", "b.md"]);
  // the second row's owner now participates in the comparison
  const other = ["## File Ownership", "| File | Owner |", "|---|---|", "| `a.md` | alpha |", "| `b.md` | gamma |"].join("\n");
  assert.deepEqual(comparison(doc, other).ownerMismatches.map((m) => m.key), ["a.md"]);
});
