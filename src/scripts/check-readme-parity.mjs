#!/usr/bin/env node
// Requires Node.js 18+
//
// check-readme-parity — executable gate verifying that:
//   (a) the README version badge matches the VERSION file, and
//   (b) the README test-count badge matches the TEST_COUNT file.
//
// Badge formats parsed (as found in README.md):
//   Version:    ![Skill](https://img.shields.io/badge/Skill-v<VER>-green.svg)
//               matched as a whole shields.io image badge (VERSION_BADGE_RE),
//               not as a bare `Skill-v<VER>-` substring
//   Test count: ![Tests](https://img.shields.io/badge/tests-<N>%20passing-brightgreen.svg)
//               matched as a whole shields.io image badge (TEST_BADGE_RE),
//               not as a bare `tests-<N>%20passing` substring
//
// Exports two pure functions (importable without side effects — isEntryPoint guard).
// CLI reads VERSION, TEST_COUNT, README.md from repo root; exits 0 on all OK, 1 on any failure.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// DECISION plan-2026-09-01T100120-4f591469/D-014 — anchored to the BADGE, not a bare version
// substring: the old regex passed as long as any line carried the string, badge or not.
// Do not loosen this back to a substring match.
const VERSION_BADGE_RE =
  /!\[[^\]]*\]\(https:\/\/img\.shields\.io\/badge\/Skill-v(\d+\.\d+\.\d+)-[^)]*\)/;

/**
 * Check that the README version badge matches the expected version string.
 * `found` distinguishes the two failure modes the caller must report
 * differently: NO badge matched at all (found=false, readmeVersion="") versus a
 * badge carrying the wrong version. Without it the message read "README has v",
 * as if the README literally contained a bare "v".
 * @param {string} readmeText - Full README.md content.
 * @param {string} version    - Expected version, e.g. "2.26.0".
 * @returns {{ ok: boolean, found: boolean, readmeVersion: string, expected: string }}
 */
export function checkVersionBadge(readmeText, version) {
  const m = (readmeText || "").match(VERSION_BADGE_RE);
  const readmeVersion = m ? m[1] : "";
  return {
    ok: readmeVersion === version,
    found: Boolean(m),
    readmeVersion,
    expected: version,
  };
}

// DECISION plan-2026-09-01T100120-4f591469/D-016 — sibling of VERSION_BADGE_RE, same reason:
// anchored to the badge, not a bare substring.
const TEST_BADGE_RE =
  /!\[[^\]]*\]\(https:\/\/img\.shields\.io\/badge\/tests-(\d+)%20passing-[^)]*\)/;

/**
 * Check that the README test-count badge matches the expected count.
 * Carries the same `found` flag as checkVersionBadge, for the same reason: the
 * no-badge case previously reported "README has NaN".
 * @param {string} readmeText - Full README.md content.
 * @param {number} testCount  - Expected test count integer.
 * @returns {{ ok: boolean, found: boolean, readmeCount: number, expected: number }}
 */
export function checkTestCount(readmeText, testCount) {
  const m = (readmeText || "").match(TEST_BADGE_RE);
  const readmeCount = m ? parseInt(m[1], 10) : NaN;
  return {
    ok: readmeCount === testCount,
    found: Boolean(m),
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
  // repoRoot override: opt-in env var read HERE only (inside isEntryPoint), so tests can
  // spawn real CLI FAIL branches against fixture roots without touching module scope or CLI behavior.
  const repoRoot =
    process.env.IP_CHECK_README_PARITY_ROOT ??
    join(dirname(fileURLToPath(import.meta.url)), "..", "..");
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
      `check-readme-parity: FAIL version badge — README has ${vResult.found ? `v${vResult.readmeVersion}` : "(no badge found)"}, expected v${vResult.expected}`,
    );
    failed = true;
  }

  if (tResult.ok) {
    console.log(
      `check-readme-parity: PASS test count (${tResult.readmeCount} == ${tResult.expected})`,
    );
  } else {
    console.error(
      `check-readme-parity: FAIL test count — README has ${tResult.found ? tResult.readmeCount : "(no badge found)"}, expected ${tResult.expected}`,
    );
    failed = true;
  }

  process.exit(failed ? 1 : 0);
}
