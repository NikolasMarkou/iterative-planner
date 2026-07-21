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
function makeFixtureRoot({ version, testCount, badgeVersion, badgeCount }) {
  const root = mkdtempSync(join(tmpdir(), "crp-fixture-"));
  writeFileSync(join(root, "VERSION"), `${version}\n`);
  writeFileSync(join(root, "TEST_COUNT"), `${testCount}\n`);
  writeFileSync(
    join(root, "README.md"),
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
});
