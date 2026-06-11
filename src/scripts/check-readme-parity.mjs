#!/usr/bin/env node
// Requires Node.js 18+
//
// check-readme-parity — executable gate verifying that:
//   (a) the README version badge matches the VERSION file, and
//   (b) the README test-count badge matches the TEST_COUNT file.
//
// Badge formats parsed (as found in README.md):
//   Version:    ![Skill](https://img.shields.io/badge/Skill-v<VER>-green.svg)
//               regex: /Skill-v(\d+\.\d+\.\d+)-/
//   Test count: ![Tests](https://img.shields.io/badge/tests-<N>%20passing-brightgreen.svg)
//               regex: /tests-(\d+)%20passing/
//
// Exports two pure functions (importable without side effects — isEntryPoint guard).
// CLI reads VERSION, TEST_COUNT, README.md from repo root; exits 0 on all OK, 1 on any failure.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Check that the README version badge matches the expected version string.
 * @param {string} readmeText - Full README.md content.
 * @param {string} version    - Expected version, e.g. "2.26.0".
 * @returns {{ ok: boolean, readmeVersion: string, expected: string }}
 */
export function checkVersionBadge(readmeText, version) {
  const m = (readmeText || "").match(/Skill-v(\d+\.\d+\.\d+)-/);
  const readmeVersion = m ? m[1] : "";
  return {
    ok: readmeVersion === version,
    readmeVersion,
    expected: version,
  };
}

/**
 * Check that the README test-count badge matches the expected count.
 * @param {string} readmeText - Full README.md content.
 * @param {number} testCount  - Expected test count integer.
 * @returns {{ ok: boolean, readmeCount: number, expected: number }}
 */
export function checkTestCount(readmeText, testCount) {
  const m = (readmeText || "").match(/tests-(\d+)%20passing/);
  const readmeCount = m ? parseInt(m[1], 10) : NaN;
  return {
    ok: readmeCount === testCount,
    readmeCount,
    expected: testCount,
  };
}

const isEntryPoint = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const version = readFileSync(join(repoRoot, "VERSION"), "utf8").trim();
  const testCount = parseInt(
    readFileSync(join(repoRoot, "TEST_COUNT"), "utf8").trim(),
    10,
  );
  const readmeText = readFileSync(join(repoRoot, "README.md"), "utf8");

  const vResult = checkVersionBadge(readmeText, version);
  const tResult = checkTestCount(readmeText, testCount);

  let failed = false;

  if (vResult.ok) {
    console.log(
      `check-readme-parity: PASS version badge (v${vResult.readmeVersion} == v${vResult.expected})`,
    );
  } else {
    console.error(
      `check-readme-parity: FAIL version badge — README has v${vResult.readmeVersion}, expected v${vResult.expected}`,
    );
    failed = true;
  }

  if (tResult.ok) {
    console.log(
      `check-readme-parity: PASS test count (${tResult.readmeCount} == ${tResult.expected})`,
    );
  } else {
    console.error(
      `check-readme-parity: FAIL test count — README has ${tResult.readmeCount}, expected ${tResult.expected}`,
    );
    failed = true;
  }

  process.exit(failed ? 1 : 0);
}
