#!/usr/bin/env node
// Requires Node.js 18+
//
// check-test-count — executable gate verifying that the `TEST_COUNT` file matches
// the number of tests the suite ACTUALLY passes.
//
// Why this exists (audit defect #7): `check-readme-parity.mjs` compares the README
// badge against `TEST_COUNT` — but if BOTH are stale it passes. Nothing compared
// either number against reality. That is not hypothetical: TEST_COUNT sat at 302
// while the live suite reported 333 passing, and `make validate` stayed green.
//
// NOTE: wired into the `test` target of Makefile + build.ps1, deliberately NOT into
// `validate`. `validate` is the fast structural gate (no suite run). Do not "simplify" this by
// moving it into `validate` — that would make every package/validate invocation pay a full suite.
//
// THE SUITE RUNS ONCE. `make test` / `build.ps1 test` used to run `node --test <list>` and then this
// script, which spawned the whole suite again (~90s twice). This script is the one runner now: it
// enumerates every *.test.mjs itself, fails on any `# fail`, and on failure prints an excerpt of the
// failing tests (failureExcerpt) because the captured TAP is otherwise invisible. A hung test is
// killed after SUITE_TIMEOUT_MS instead of hanging the build forever.
//
// TAP source: `node --test` writes TAP when stdout is not a TTY (a spawned pipe never
// is), so no `--test-reporter` flag is passed — that flag does not exist on early
// Node 18.x and passing it would break the documented Node 18+ floor.
//
// Exit codes: 0 = TEST_COUNT matches the live pass count and the suite is green.
//             1 = mismatch, any failing test, unparseable TAP, or missing TEST_COUNT.
//
// Pure functions (parseTapSummary / parseTestCount / evaluate) are importable
// without side effects via the isEntryPoint guard — the test suite exercises them
// against captured TAP fixtures rather than by re-running the suite recursively.

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./shared.mjs";

// NOTE: recursion guard. This script runs the whole suite; the suite must never run
// this script's suite-running path, or `make test` forks indefinitely. The CLI sets
// this in the child env and refuses to run when it is already set.
const CHILD_ENV_FLAG = "IP_CHECK_TEST_COUNT_CHILD";

/**
 * Parse `node --test` TAP summary lines out of captured output.
 * Last occurrence of each key wins, so interleaved/nested summaries are tolerated.
 * @param {string} tapText - Captured stdout (+stderr) of a `node --test` run.
 * @returns {{ok: boolean, pass: number|null, fail: number|null, tests: number|null, error?: string}}
 */
export function parseTapSummary(tapText) {
  const text = String(tapText ?? "");
  const lastCount = (key) => {
    const re = new RegExp(String.raw`^# ${key} (\d+)\s*$`, "gm");
    let m;
    let last = null;
    while ((m = re.exec(text)) !== null) last = parseInt(m[1], 10);
    return last;
  };
  const pass = lastCount("pass");
  const fail = lastCount("fail");
  const tests = lastCount("tests");
  if (pass === null || fail === null) {
    return {
      ok: false,
      pass: null,
      fail: null,
      tests: null,
      error:
        "could not parse a TAP summary from the test run — no `# pass N` / `# fail N` lines found",
    };
  }
  return { ok: true, pass, fail, tests };
}

/**
 * Parse the raw contents of the TEST_COUNT file. `null` means the file is absent
 * or unreadable (the CLI passes null rather than throwing).
 * @param {string|null} raw
 * @returns {{ok: boolean, value: number|null, error?: string}}
 */
export function parseTestCount(raw) {
  if (raw === null || raw === undefined) {
    return {
      ok: false,
      value: null,
      error: "TEST_COUNT file not found or unreadable at the repo root",
    };
  }
  const trimmed = String(raw).trim();
  if (!/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      value: null,
      error: `TEST_COUNT is not a plain integer (got ${JSON.stringify(trimmed.slice(0, 40))})`,
    };
  }
  return { ok: true, value: parseInt(trimmed, 10) };
}

/** Upper bound for the whole suite run; a hung test is killed and reported, never waited on forever. */
export const SUITE_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Excerpt of a failing run for the console: every `not ok` line with the 14 lines after it, capped at
 * 300 lines; when there is no `not ok` (a crash before any summary) the last 40 lines instead.
 * Contract: string in, string out ("" for empty input); never throws.
 * @param {string} tapText
 * @returns {string}
 */
export function failureExcerpt(tapText) {
  const lines = String(tapText ?? "").split("\n");
  const keep = new Set();
  lines.forEach((l, i) => {
    if (/^\s*not ok\b/.test(l)) for (let j = i; j <= Math.min(i + 14, lines.length - 1); j++) keep.add(j);
  });
  const picked = keep.size > 0
    ? [...keep].sort((a, b) => a - b).slice(0, 300).map((i) => lines[i])
    : lines.filter((l) => l.trim() !== "").slice(-40);
  return picked.join("\n");
}

/**
 * Pure comparison of a captured test run against the declared TEST_COUNT.
 * No I/O — the CLI supplies the captured TAP text and the raw TEST_COUNT contents.
 * @param {{tapText?: string, testCountRaw?: string|null, childStatus?: number|null}} input
 * @returns {{exitCode: number, stdout: string[], stderr: string[], summary: object}}
 */
export function evaluate({ tapText = "", testCountRaw = null, childStatus = 0 } = {}) {
  const stdout = [];
  const stderr = [];
  const summary = parseTapSummary(tapText);

  if (!summary.ok) {
    stderr.push(
      `check-test-count: FAIL — ${summary.error}. The suite likely crashed before printing a summary (node --test exit status: ${childStatus}).`,
    );
    return { exitCode: 1, stdout, stderr, summary };
  }

  let failed = false;

  // A red suite invalidates the count regardless of whether the numbers happen to line up.
  if (summary.fail > 0) {
    stderr.push(
      `check-test-count: FAIL — the suite reports ${summary.fail} failing test(s). Fix the suite before trusting TEST_COUNT.`,
    );
    failed = true;
  }

  // A non-zero (or signal-killed, null) exit with matching counts is still not a green run:
  // a late unhandled rejection or a test file that sets process.exitCode lands here.
  if (childStatus !== 0) {
    stderr.push(
      `check-test-count: FAIL — node --test exited with status ${childStatus} although the summary parsed (${summary.pass} pass, ${summary.fail} fail). A non-zero exit is a red suite whatever the counts say.`,
    );
    failed = true;
  }

  const expected = parseTestCount(testCountRaw);
  if (!expected.ok) {
    stderr.push(
      `check-test-count: FAIL — ${expected.error}. The suite reports ${summary.pass} passing — write that number to TEST_COUNT.`,
    );
    return { exitCode: 1, stdout, stderr, summary };
  }

  if (expected.value !== summary.pass) {
    stderr.push(
      `check-test-count: FAIL — TEST_COUNT says ${expected.value} but the suite reports ${summary.pass} passing — update TEST_COUNT (and the README test badge) to ${summary.pass}.`,
    );
    failed = true;
  } else if (!failed) {
    stdout.push(
      `check-test-count: PASS (TEST_COUNT ${expected.value} == ${summary.pass} passing, ${summary.fail} failing)`,
    );
  }

  return { exitCode: failed ? 1 : 0, stdout, stderr, summary };
}

/**
 * Enumerate the suite's test files, repo-root-relative and sorted.
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function testFiles(repoRoot) {
  const scriptsDir = join(repoRoot, "src", "scripts");
  return readdirSync(scriptsDir)
    .filter((f) => f.endsWith(".test.mjs"))
    .sort()
    .map((f) => join("src", "scripts", f));
}

const isEntryPoint = isMain(import.meta.url);

if (isEntryPoint) {
  if (process.env[CHILD_ENV_FLAG] === "1") {
    console.error(
      `check-test-count: FAIL — refusing to run recursively (${CHILD_ENV_FLAG} is set). This script must not be invoked from inside the suite it runs.`,
    );
    process.exit(1);
  }

  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

  const files = testFiles(repoRoot);
  if (files.length === 0) {
    console.error(
      "check-test-count: FAIL — no *.test.mjs files found under src/scripts/.",
    );
    process.exit(1);
  }

  const run = spawnSync(process.execPath, ["--test", ...files], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, [CHILD_ENV_FLAG]: "1" },
    maxBuffer: 64 * 1024 * 1024,
    timeout: SUITE_TIMEOUT_MS,
  });
  if (run.error && run.error.code === "ETIMEDOUT") {
    console.error(`check-test-count: FAIL — the suite did not finish within ${SUITE_TIMEOUT_MS / 60000} minutes and was killed (a test is hung).`);
    process.exit(1);
  }

  const tapText = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;

  let testCountRaw = null;
  try {
    testCountRaw = readFileSync(join(repoRoot, "TEST_COUNT"), "utf8");
  } catch {
    testCountRaw = null; // evaluate() reports the missing file; never crash here.
  }

  const result = evaluate({
    tapText,
    testCountRaw,
    childStatus: run.status,
  });

  for (const line of result.stdout) console.log(line);
  for (const line of result.stderr) console.error(line);
  if (result.exitCode !== 0) {
    const excerpt = failureExcerpt(tapText);
    if (excerpt) console.error(`--- test output excerpt ---\n${excerpt}`);
  }
  process.exit(result.exitCode);
}
