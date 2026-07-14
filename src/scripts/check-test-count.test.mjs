// check-test-count.test.mjs — node:test suite for check-test-count.mjs
//
// NOTE: this suite NEVER invokes check-test-count.mjs's suite-running path. That path
// spawns `node --test src/scripts/*.test.mjs` — which includes THIS file — so calling
// it here would recurse (a fork bomb, or at best a multi-minute test). The TAP parser
// and the comparison logic are pure functions and are tested against CAPTURED FIXTURE
// STRINGS; the only CLI spawn below asserts the recursion guard itself, which exits
// immediately without running anything.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseTapSummary,
  parseTestCount,
  evaluate,
  testFiles,
} from "./check-test-count.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// Captured fixtures — real `node --test` TAP output shapes, trimmed to the tail.
// ---------------------------------------------------------------------------

const TAP_GREEN = `ok 1 - parses a fresh plan dir
  ---
  duration_ms: 0.774145
  ...
1..4
# tests 4
# suites 0
# pass 4
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 125.675833
`;

const TAP_WITH_FAILURES = `not ok 2 - budget check fires
  ---
  duration_ms: 1.2
  location: 'src/scripts/validate-plan.test.mjs:88:3'
  failureType: 'testCodeFailure'
  ...
1..10
# tests 10
# suites 3
# pass 7
# fail 3
# cancelled 0
# skipped 0
# todo 0
# duration_ms 900.1
`;

// Node prints a per-file summary when several files run, then a final aggregate.
// The parser must take the LAST occurrence of each key, not the first.
const TAP_INTERLEAVED = `1..2
# tests 2
# pass 2
# fail 0
ok 3 - second file
1..333
# tests 333
# suites 47
# pass 333
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 16180.5
`;

const TAP_MALFORMED = `TypeError: Cannot read properties of undefined (reading 'x')
    at file:///repo/src/scripts/thing.mjs:12:5
`;

describe("check-test-count — parseTapSummary", () => {
  it("green run: extracts pass/fail/tests", () => {
    const r = parseTapSummary(TAP_GREEN);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.pass, 4);
    assert.strictEqual(r.fail, 0);
    assert.strictEqual(r.tests, 4);
  });

  it("run with failures: extracts a nonzero fail count", () => {
    const r = parseTapSummary(TAP_WITH_FAILURES);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.pass, 7);
    assert.strictEqual(r.fail, 3);
    assert.strictEqual(r.tests, 10);
  });

  it("interleaved summaries: last occurrence wins (aggregate, not per-file)", () => {
    const r = parseTapSummary(TAP_INTERLEAVED);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.pass, 333);
    assert.strictEqual(r.fail, 0);
    assert.strictEqual(r.tests, 333);
  });

  it("malformed output (crash, no summary): ok:false with a message, no throw", () => {
    const r = parseTapSummary(TAP_MALFORMED);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.pass, null);
    assert.match(r.error, /could not parse a TAP summary/i);
  });

  it("empty / null / undefined output: ok:false, no throw", () => {
    for (const input of ["", null, undefined]) {
      const r = parseTapSummary(input);
      assert.strictEqual(r.ok, false, `input ${JSON.stringify(input)}`);
      assert.match(r.error, /could not parse a TAP summary/i);
    }
  });

  it("does not match `# pass` embedded mid-line (anchored at line start)", () => {
    const r = parseTapSummary("ok 1 - a test named # pass 999\n");
    assert.strictEqual(r.ok, false);
  });
});

describe("check-test-count — parseTestCount", () => {
  it("valid integer", () => {
    assert.deepStrictEqual(parseTestCount("333\n"), { ok: true, value: 333 });
  });

  it("missing file (null): ok:false with a clear message", () => {
    const r = parseTestCount(null);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /TEST_COUNT file not found/i);
  });

  it("non-integer contents: ok:false with a clear message", () => {
    const r = parseTestCount("three hundred\n");
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /not a plain integer/i);
  });
});

describe("check-test-count — evaluate", () => {
  it("counts match and suite is green: exit 0 with a PASS line", () => {
    const r = evaluate({ tapText: TAP_GREEN, testCountRaw: "4" });
    assert.strictEqual(r.exitCode, 0);
    assert.strictEqual(r.stderr.length, 0);
    assert.match(r.stdout.join("\n"), /PASS/);
  });

  it("mismatch: exit 1 and the message names BOTH numbers", () => {
    const r = evaluate({ tapText: TAP_INTERLEAVED, testCountRaw: "302" });
    assert.strictEqual(r.exitCode, 1);
    const msg = r.stderr.join("\n");
    assert.match(msg, /TEST_COUNT says 302/);
    assert.match(msg, /333 passing/);
    assert.match(msg, /update TEST_COUNT/i);
  });

  it("any failing test: exit 1 even when the pass count matches TEST_COUNT", () => {
    const r = evaluate({ tapText: TAP_WITH_FAILURES, testCountRaw: "7" });
    assert.strictEqual(r.exitCode, 1);
    assert.match(r.stderr.join("\n"), /3 failing test\(s\)/);
  });

  it("malformed TAP: exit 1, clear message, surfaces the child exit status", () => {
    const r = evaluate({
      tapText: TAP_MALFORMED,
      testCountRaw: "333",
      childStatus: 1,
    });
    assert.strictEqual(r.exitCode, 1);
    const msg = r.stderr.join("\n");
    assert.match(msg, /could not parse a TAP summary/i);
    assert.match(msg, /exit status: 1/);
  });

  it("missing TEST_COUNT file: exit 1, clear message naming the live count", () => {
    const r = evaluate({ tapText: TAP_GREEN, testCountRaw: null });
    assert.strictEqual(r.exitCode, 1);
    const msg = r.stderr.join("\n");
    assert.match(msg, /TEST_COUNT file not found/i);
    assert.match(msg, /4 passing/);
  });

  it("no arguments at all: exit 1, no throw", () => {
    const r = evaluate();
    assert.strictEqual(r.exitCode, 1);
    assert.ok(r.stderr.length > 0);
  });
});

describe("check-test-count — testFiles", () => {
  it("enumerates the suite's *.test.mjs files, sorted, repo-root-relative", () => {
    const files = testFiles(repoRoot);
    assert.ok(files.length >= 8, `expected >= 8 test files, got ${files.length}`);
    assert.ok(files.every((f) => f.endsWith(".test.mjs")));
    assert.deepStrictEqual(files, [...files].sort());
    assert.ok(
      files.includes(join("src", "scripts", "check-test-count.test.mjs")),
      "its own test file must be part of the enumerated suite",
    );
  });
});

describe("check-test-count — CLI recursion guard", () => {
  // Asserts the guard WITHOUT running the suite: with the child flag already set,
  // the CLI must refuse immediately. This is the only CLI spawn in this file.
  it("refuses to run when IP_CHECK_TEST_COUNT_CHILD is set", () => {
    const r = spawnSync(
      process.execPath,
      [join(__dirname, "check-test-count.mjs")],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, IP_CHECK_TEST_COUNT_CHILD: "1" },
      },
    );
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /refusing to run recursively/i);
  });
});
