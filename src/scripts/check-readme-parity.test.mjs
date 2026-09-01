// check-readme-parity.test.mjs — node:test suite for check-readme-parity.mjs

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkVersionBadge, checkTestCount } from "./check-readme-parity.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const script = join(__dirname, "check-readme-parity.mjs");

/**
 * Build a temp fixture root with the layout the CLI expects
 * (VERSION, TEST_COUNT, README.md) and return its path. Caller removes it.
 */
function makeFixtureRoot({ version, testCount, badgeVersion, badgeCount, readme }) {
  const root = mkdtempSync(join(tmpdir(), "crp-fixture-"));
  writeFileSync(join(root, "VERSION"), `${version}\n`);
  writeFileSync(join(root, "TEST_COUNT"), `${testCount}\n`);
  writeFileSync(
    join(root, "README.md"),
    readme ??
      `[![Skill](https://img.shields.io/badge/Skill-v${badgeVersion}-green.svg)](CHANGELOG.md)\n` +
        `[![Tests](https://img.shields.io/badge/tests-${badgeCount}%20passing-brightgreen.svg)](src/scripts/bootstrap.test.mjs)\n`,
  );
  return root;
}

/** Spawn the REAL CLI against a fixture root via the opt-in env override. */
function runCliAgainst(root) {
  return spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, IP_CHECK_README_PARITY_ROOT: root },
  });
}

describe("check-readme-parity", () => {
  it("real-repo: VERSION and TEST_COUNT match README badges — exits 0", () => {
    const result = spawnSync(
      process.execPath,
      [join(__dirname, "check-readme-parity.mjs")],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.strictEqual(
      result.status,
      0,
      `Expected exit 0; got ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  });

  it("checkVersionBadge: wrong version string -> ok: false", () => {
    const readmeText = readFileSync(join(repoRoot, "README.md"), "utf8");
    const result = checkVersionBadge(readmeText, "0.0.0");
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.expected, "0.0.0");
    assert.match(result.readmeVersion, /^\d+\.\d+\.\d+$/);
  });

  it("checkVersionBadge (C4): anchored to the BADGE — a bare version string is not a badge", () => {
    // Pre-fix this PASSed: /Skill-v(\d+\.\d+\.\d+)-/ matched anywhere, so a
    // README with no badge but any surviving `Skill-v<VER>-` text looked fine.
    const noBadge = "# Title\n\nThe badge markup is `Skill-v2.60.0-green.svg`.\n";
    assert.strictEqual(checkVersionBadge(noBadge, "2.60.0").ok, false);
    assert.strictEqual(checkVersionBadge(noBadge, "2.60.0").readmeVersion, "");
    // The real badge line still passes (previously-clean stays clean).
    const badge =
      "[![Skill](https://img.shields.io/badge/Skill-v2.60.0-green.svg)](CHANGELOG.md)\n";
    assert.strictEqual(checkVersionBadge(badge, "2.60.0").ok, true);
    assert.strictEqual(checkVersionBadge(badge + noBadge, "2.60.0").ok, true);
  });

  it("real CLI FAIL (C4): badge deleted, version string still present -> exit 1", () => {
    const root = mkdtempSync(join(tmpdir(), "crp-badge-"));
    try {
      writeFileSync(join(root, "VERSION"), "2.60.0\n");
      writeFileSync(join(root, "TEST_COUNT"), "269\n");
      writeFileSync(
        join(root, "README.md"),
        "# Title\n\nRelease `Skill-v2.60.0-green.svg` was cut today.\n" +
          "[![Tests](https://img.shields.io/badge/tests-269%20passing-brightgreen.svg)](x)\n",
      );
      const result = runCliAgainst(root);
      assert.strictEqual(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
      assert.match(result.stderr, /FAIL version badge/);
      assert.match(result.stdout, /PASS test count/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checkTestCount: anchored to the BADGE — a bare count string is not a badge", () => {
    // Pre-fix this PASSed: /tests-(\d+)%20passing/ matched anywhere, so a README
    // with no test badge but any surviving `tests-<N>%20passing` text looked fine.
    const noBadge = "# Title\n\nThe badge markup is `tests-806%20passing-brightgreen.svg`.\n";
    assert.strictEqual(checkTestCount(noBadge, 806).ok, false);
    assert.ok(Number.isNaN(checkTestCount(noBadge, 806).readmeCount));
    // The real badge line still passes (previously-clean stays clean).
    const badge =
      "[![Tests](https://img.shields.io/badge/tests-806%20passing-brightgreen.svg)](x)\n";
    assert.strictEqual(checkTestCount(badge, 806).ok, true);
    assert.strictEqual(checkTestCount(badge + noBadge, 806).ok, true);
  });

  it("real CLI FAIL: test badge deleted, count string still present -> exit 1", () => {
    const root = mkdtempSync(join(tmpdir(), "crp-tbadge-"));
    try {
      writeFileSync(join(root, "VERSION"), "2.60.0\n");
      writeFileSync(join(root, "TEST_COUNT"), "269\n");
      writeFileSync(
        join(root, "README.md"),
        "[![Skill](https://img.shields.io/badge/Skill-v2.60.0-green.svg)](CHANGELOG.md)\n" +
          "\nThe suite badge reads `tests-269%20passing-brightgreen.svg` today.\n",
      );
      const result = runCliAgainst(root);
      assert.strictEqual(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
      assert.match(result.stderr, /FAIL test count/);
      assert.match(result.stdout, /PASS version badge/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checkTestCount: wrong test count -> ok: false", () => {
    const readmeText = readFileSync(join(repoRoot, "README.md"), "utf8");
    const result = checkTestCount(readmeText, 999999);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.expected, 999999);
    assert.ok(Number.isFinite(result.readmeCount));
  });

  it("real CLI FAIL: version mismatch -> exit 1 + FAIL version badge on stderr", () => {
    // VERSION does NOT match the badge; TEST_COUNT DOES (only the version check fails).
    const root = makeFixtureRoot({
      version: "9.9.9",
      testCount: 269,
      badgeVersion: "2.26.0",
      badgeCount: 269,
    });
    try {
      const result = runCliAgainst(root);
      assert.strictEqual(
        result.status,
        1,
        `Expected exit 1 (version mismatch); got ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
      assert.match(
        result.stderr,
        /check-readme-parity: FAIL version badge — README has v2\.26\.0, expected v9\.9\.9/,
      );
      // The passing half still reports PASS on stdout.
      assert.match(result.stdout, /check-readme-parity: PASS test count \(269 == 269\)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("real CLI FAIL: test-count mismatch -> exit 1 + FAIL test count on stderr", () => {
    // TEST_COUNT does NOT match the badge; VERSION DOES (only the count check fails).
    const root = makeFixtureRoot({
      version: "2.26.0",
      testCount: 999,
      badgeVersion: "2.26.0",
      badgeCount: 269,
    });
    try {
      const result = runCliAgainst(root);
      assert.strictEqual(
        result.status,
        1,
        `Expected exit 1 (count mismatch); got ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
      assert.match(
        result.stderr,
        /check-readme-parity: FAIL test count — README has 269, expected 999/,
      );
      assert.match(result.stdout, /check-readme-parity: PASS version badge \(v2\.26\.0 == v2\.26\.0\)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("real CLI FAIL: version AND count mismatch -> exit 1 + both FAIL lines", () => {
    const root = makeFixtureRoot({
      version: "9.9.9",
      testCount: 999,
      badgeVersion: "2.26.0",
      badgeCount: 269,
    });
    try {
      const result = runCliAgainst(root);
      assert.strictEqual(
        result.status,
        1,
        `Expected exit 1 (both mismatches); got ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
      assert.match(
        result.stderr,
        /check-readme-parity: FAIL version badge — README has v2\.26\.0, expected v9\.9\.9/,
      );
      assert.match(
        result.stderr,
        /check-readme-parity: FAIL test count — README has 269, expected 999/,
      );
      const failLines = result.stderr
        .split("\n")
        .filter((l) => l.includes("check-readme-parity: FAIL"));
      assert.strictEqual(failLines.length, 2, `expected exactly 2 FAIL lines:\n${result.stderr}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // --- W14: the two failure modes must not print the same sentence ----------

  it("real CLI FAIL: NO version badge at all -> `(no badge found)`, not `README has v`", () => {
    const root = makeFixtureRoot({
      version: "2.26.0",
      testCount: 269,
      readme:
        "# Skill\n\nNo badges here at all.\n" +
        "[![Tests](https://img.shields.io/badge/tests-269%20passing-brightgreen.svg)](x)\n",
    });
    try {
      const result = runCliAgainst(root);
      assert.strictEqual(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
      assert.match(
        result.stderr,
        /check-readme-parity: FAIL version badge — README has \(no badge found\), expected v2\.26\.0/,
      );
      // The old message read "README has v, expected v2.26.0" — as if the file
      // contained a bare "v". That exact shape must be gone.
      assert.doesNotMatch(result.stderr, /README has v,/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("real CLI FAIL: NO test badge at all -> `(no badge found)`, not `README has NaN`", () => {
    const root = makeFixtureRoot({
      version: "2.26.0",
      testCount: 269,
      readme:
        "[![Skill](https://img.shields.io/badge/Skill-v2.26.0-green.svg)](CHANGELOG.md)\n" +
        "No test badge on this page.\n",
    });
    try {
      const result = runCliAgainst(root);
      assert.strictEqual(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
      assert.match(
        result.stderr,
        /check-readme-parity: FAIL test count — README has \(no badge found\), expected 269/,
      );
      assert.doesNotMatch(result.stderr, /README has NaN/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("W14 does not swallow the wrong-value case: a badge with the WRONG version still prints the comparison", () => {
    const root = makeFixtureRoot({
      version: "9.9.9",
      testCount: 999,
      badgeVersion: "2.26.0",
      badgeCount: 269,
    });
    try {
      const result = runCliAgainst(root);
      assert.match(
        result.stderr,
        /FAIL version badge — README has v2\.26\.0, expected v9\.9\.9/,
      );
      assert.match(result.stderr, /FAIL test count — README has 269, expected 999/);
      assert.doesNotMatch(result.stderr, /no badge found/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checkVersionBadge/checkTestCount report `found` so callers can tell the two failures apart", () => {
    const none = "# Skill\n\nnothing here\n";
    assert.deepStrictEqual(checkVersionBadge(none, "1.2.3"), {
      ok: false,
      found: false,
      readmeVersion: "",
      expected: "1.2.3",
    });
    const t = checkTestCount(none, 7);
    assert.strictEqual(t.found, false);
    assert.ok(Number.isNaN(t.readmeCount));
    const real = readFileSync(join(repoRoot, "README.md"), "utf8");
    assert.strictEqual(checkVersionBadge(real, "0.0.0").found, true);
    assert.strictEqual(checkTestCount(real, -1).found, true);
  });
});
