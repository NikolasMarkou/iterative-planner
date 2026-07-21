#!/usr/bin/env node
// Requires Node.js 18+
//
// check-changelog-parity — executable gate verifying that the FIRST release
// entry in CHANGELOG.md matches the VERSION file (Keep-a-Changelog top entry).
//
// Entry format parsed (as found in CHANGELOG.md):
//   ## [<X.Y.Z>] - YYYY-MM-DD
//   regex: /^## \[(\d+\.\d+\.\d+)\]/m  (first match = top release entry)
//
// A missing or unparseable CHANGELOG.md is a FAIL, not a skip: this gate's
// whole job is to go red when the release bookkeeping is broken.
//
// Exports one pure function (importable without side effects — isEntryPoint
// guard). CLI reads CHANGELOG.md + VERSION from repo root; exits 0 on OK,
// 1 on any failure.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Check that the FIRST `## [X.Y.Z]` entry in CHANGELOG.md matches the
 * expected version string.
 * @param {string} changelogText - Full CHANGELOG.md content.
 * @param {string} version       - Expected version, e.g. "2.55.0".
 * @returns {{ ok: boolean, changelogVersion: string, expected: string }}
 *   `changelogVersion` is "" when no parseable entry exists (ok: false).
 */
export function checkChangelogVersion(changelogText, version) {
  const m = (changelogText || "").match(/^## \[(\d+\.\d+\.\d+)\]/m);
  const changelogVersion = m ? m[1] : "";
  return {
    ok: changelogVersion === version,
    changelogVersion,
    expected: version,
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
  // DECISION plan-2026-07-21T092933-3295714d/D-003: repoRoot override is an
  // opt-in env var read HERE only (inside isEntryPoint) so tests can spawn the
  // REAL CLI FAIL branches against fixture roots. Do NOT hoist this read to
  // module scope, add an argv flag, or reintroduce a wrapper reimplementation:
  // importers and the default (env-unset) CLI must stay byte-identical. See
  // decisions.md D-003.
  const repoRoot =
    process.env.IP_CHECK_CHANGELOG_PARITY_ROOT ??
    join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const version = readFileSync(join(repoRoot, "VERSION"), "utf8").trim();

  let changelogText;
  try {
    changelogText = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
  } catch (err) {
    // Missing/unreadable CHANGELOG is a FAIL, not a skip.
    console.error(
      `check-changelog-parity: FAIL — CHANGELOG.md unreadable (${err.code ?? err.message})`,
    );
    process.exit(1);
  }

  const result = checkChangelogVersion(changelogText, version);

  if (result.ok) {
    console.log(
      `check-changelog-parity: PASS top entry (v${result.changelogVersion} == v${result.expected})`,
    );
    process.exit(0);
  }

  if (result.changelogVersion === "") {
    console.error(
      "check-changelog-parity: FAIL — no '## [X.Y.Z]' release entry found in CHANGELOG.md",
    );
  } else {
    console.error(
      `check-changelog-parity: FAIL top entry — CHANGELOG.md has v${result.changelogVersion}, expected v${result.expected}`,
    );
  }
  process.exit(1);
}
