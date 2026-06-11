// check-readme-parity.test.mjs — node:test suite for check-readme-parity.mjs

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkVersionBadge, checkTestCount } from "./check-readme-parity.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

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

  it("CLI: mismatched version in temp README -> exits 1", () => {
    const tmpDir = join(tmpdir(), `crp-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    // VERSION that does NOT match the badge in the temp README
    writeFileSync(join(tmpDir, "VERSION"), "9.9.9\n");
    // TEST_COUNT that DOES match the badge (so only the version check fails)
    writeFileSync(join(tmpDir, "TEST_COUNT"), "269\n");
    // README with correct test count badge but wrong version
    writeFileSync(
      join(tmpDir, "README.md"),
      "[![Skill](https://img.shields.io/badge/Skill-v2.26.0-green.svg)](CHANGELOG.md)\n" +
        "[![Tests](https://img.shields.io/badge/tests-269%20passing-brightgreen.svg)](src/scripts/bootstrap.test.mjs)\n",
    );

    // Inline wrapper: uses pure functions with temp-dir files (avoids re-spawning the full CLI)
    const wrapperSrc =
      `import { readFileSync } from "node:fs";\n` +
      `import { join } from "node:path";\n` +
      `import { checkVersionBadge, checkTestCount } from ${JSON.stringify(join(__dirname, "check-readme-parity.mjs"))};\n` +
      `const root = ${JSON.stringify(tmpDir)};\n` +
      `const version = readFileSync(join(root, "VERSION"), "utf8").trim();\n` +
      `const testCount = parseInt(readFileSync(join(root, "TEST_COUNT"), "utf8").trim(), 10);\n` +
      `const readmeText = readFileSync(join(root, "README.md"), "utf8");\n` +
      `const vResult = checkVersionBadge(readmeText, version);\n` +
      `const tResult = checkTestCount(readmeText, testCount);\n` +
      `let failed = !vResult.ok || !tResult.ok;\n` +
      `process.exit(failed ? 1 : 0);\n`;

    const wrapperFile = join(tmpDir, "wrapper.mjs");
    writeFileSync(wrapperFile, wrapperSrc);

    const result = spawnSync(process.execPath, [wrapperFile], {
      cwd: tmpDir,
      encoding: "utf8",
    });

    rmSync(tmpDir, { recursive: true, force: true });

    assert.strictEqual(
      result.status,
      1,
      `Expected exit 1 (version mismatch); got ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  });
});
