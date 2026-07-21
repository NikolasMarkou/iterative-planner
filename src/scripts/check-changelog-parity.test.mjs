// check-changelog-parity.test.mjs — node:test suite for check-changelog-parity.mjs

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkChangelogVersion } from "./check-changelog-parity.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const script = join(__dirname, "check-changelog-parity.mjs");

/**
 * Build a temp fixture root with the layout the CLI expects
 * (VERSION, CHANGELOG.md) and return its path. Caller removes it.
 * Pass `changelog: null` to omit CHANGELOG.md entirely.
 */
function makeFixtureRoot({ version, changelog }) {
  const root = mkdtempSync(join(tmpdir(), "ccp-fixture-"));
  writeFileSync(join(root, "VERSION"), `${version}\n`);
  if (changelog !== null) {
    writeFileSync(join(root, "CHANGELOG.md"), changelog);
  }
  return root;
}

/** Spawn the REAL CLI against a fixture root via the opt-in env override. */
function runCliAgainst(root) {
  return spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, IP_CHECK_CHANGELOG_PARITY_ROOT: root },
  });
}

describe("check-changelog-parity", () => {
  it("checkChangelogVersion: matching top entry -> ok: true", () => {
    const text = "# Changelog\n\n## [2.55.0] - 2026-07-21\n\nStuff.\n";
    const result = checkChangelogVersion(text, "2.55.0");
    assert.deepStrictEqual(result, {
      ok: true,
      changelogVersion: "2.55.0",
      expected: "2.55.0",
    });
  });

  it("checkChangelogVersion: mismatched top entry -> ok: false with parsed version", () => {
    const text = "# Changelog\n\n## [2.54.0] - 2026-07-14\n";
    const result = checkChangelogVersion(text, "2.55.0");
    assert.deepStrictEqual(result, {
      ok: false,
      changelogVersion: "2.54.0",
      expected: "2.55.0",
    });
  });

  it("checkChangelogVersion: no parseable entry -> ok: false, changelogVersion empty", () => {
    const text = "# Changelog\n\nNo releases yet.\n\n## Unreleased\n";
    const result = checkChangelogVersion(text, "2.55.0");
    assert.deepStrictEqual(result, {
      ok: false,
      changelogVersion: "",
      expected: "2.55.0",
    });
  });

  it("checkChangelogVersion: FIRST entry wins over later entries", () => {
    const text =
      "# Changelog\n\n## [3.0.0] - 2026-08-01\n\n## [2.55.0] - 2026-07-21\n";
    const result = checkChangelogVersion(text, "2.55.0");
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.changelogVersion, "3.0.0");
  });

  it("real-repo: CHANGELOG top entry matches VERSION — exits 0 with PASS line", () => {
    const result = spawnSync(process.execPath, [script], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.strictEqual(
      result.status,
      0,
      `Expected exit 0; got ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
    assert.match(
      result.stdout,
      /^check-changelog-parity: PASS top entry \(v\d+\.\d+\.\d+ == v\d+\.\d+\.\d+\)/,
    );
  });

  it("real CLI FAIL: mismatched top entry -> exit 1 + FAIL top entry on stderr", () => {
    const root = makeFixtureRoot({
      version: "2.55.0",
      changelog: "# Changelog\n\n## [9.9.9] - 2026-07-21\n",
    });
    try {
      const result = runCliAgainst(root);
      assert.strictEqual(
        result.status,
        1,
        `Expected exit 1 (mismatch); got ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
      assert.match(
        result.stderr,
        /check-changelog-parity: FAIL top entry — CHANGELOG\.md has v9\.9\.9, expected v2\.55\.0/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("real CLI FAIL: no parseable release entry -> exit 1 + no-entry FAIL on stderr", () => {
    const root = makeFixtureRoot({
      version: "2.55.0",
      changelog: "# Changelog\n\n## Unreleased\n\n- pending things\n",
    });
    try {
      const result = runCliAgainst(root);
      assert.strictEqual(
        result.status,
        1,
        `Expected exit 1 (no entry); got ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
      assert.match(
        result.stderr,
        /check-changelog-parity: FAIL — no '## \[X\.Y\.Z\]' release entry found in CHANGELOG\.md/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("real CLI FAIL: missing CHANGELOG.md -> exit 1 + unreadable FAIL (not a skip, no stack trace)", () => {
    const root = makeFixtureRoot({ version: "2.55.0", changelog: null });
    try {
      const result = runCliAgainst(root);
      assert.strictEqual(
        result.status,
        1,
        `Expected exit 1 (missing file); got ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
      assert.match(
        result.stderr,
        /check-changelog-parity: FAIL — CHANGELOG\.md unreadable \(ENOENT\)/,
      );
      assert.doesNotMatch(result.stderr, /at .*node:internal/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
