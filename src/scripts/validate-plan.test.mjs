#!/usr/bin/env node
// Tests for validate-plan.mjs using Node.js built-in test runner.
// Run: node --test src/scripts/validate-plan.test.mjs
// Requires: Node.js 18+
//
// Scope (step 1 of plan_2026-05-15_71ab18dd): only the checkLeashCount regex
// reconciliation. Step 11 expands this suite for the --pre-step gate.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { randomBytes } from "crypto";

const VALIDATOR = resolve(import.meta.dirname, "validate-plan.mjs");
// Defect #8 / D-003 fixtures use the REAL bootstrap template (the guidance comment that
// caused the false positive is part of it) rather than a hand-copied approximation —
// a hand-copied one would drift from bootstrap.mjs and stop testing the actual bug.
const BOOTSTRAP = resolve(import.meta.dirname, "bootstrap.mjs");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  const name = `validate-test-${randomBytes(4).toString("hex")}`;
  const dir = join(tmpdir(), name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function removeTempDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/** Run validate-plan.mjs in a given cwd with args. Returns { stdout, stderr, exitCode }. */
// ---------------------------------------------------------------------------
// iter-3 CRITICAL B (D-012) — the masker's blind spot, from the validator's side.
//
// RED-RUN EVIDENCE (recorded against 79ef8a8 / v2.34.0, the pre-fix code):
//
//   (a) A doc whose `<!-- DECISION … -->` example sits in a 4-SPACE INDENTED code
//       block, carrying a REAL 8-hex plan id:
//         ERROR [anchor-unknown-plan]: red-doc.md:5 anchor references unknown plan
//         plan_2026-01-01_deadbeef (plan_2026-01-01_deadbeef/D-001); no per-plan
//         decisions.md and no matching section in plans/DECISIONS.md
//       FALSE — the example is literal text. The fenced sibling on the next line was
//       correctly ignored, which is what proves the gap was indented blocks specifically.
//       (`bootstrap.mjs retire` then EDITED the file on disk — see bootstrap.test.mjs.)
//
//   (b) An unclosed ``` fence prepended to a FRESH `bootstrap.mjs new` decisions.md:
//         ERROR [decisions-schema]: decisions.md:10 non-conforming entry header:
//         "## D-001 | EXPLORE → PLAN | YYYY-MM-DD"
//       FALSE — that line is inside bootstrap's own schema-example COMMENT. The fence
//       masked to EOF, so the comment's `-->` vanished from the mask, the comment stopped
//       being a comment, and the template parsed as a live entry. That is Pre-Mortem #2's
//       over-masking failure, firing on the shipped template. Baseline: 0 findings.
// ---------------------------------------------------------------------------

describe("masker: indented code blocks and unterminated fences (CRITICAL B / D-012)", () => {
  const tempDirs = [];
  function getTempDir() { const d = makeTempDir(); tempDirs.push(d); return d; }
  afterEach(() => { while (tempDirs.length) removeTempDir(tempDirs.pop()); });

  const GONE = "plan_2026-01-01_deadbeef"; // a REAL 8-hex id, and an UNKNOWN plan

  it("(a) a DECISION example in a 4-space indented code block yields ZERO anchor findings, even with a real plan id", () => {
    const cwd = getTempDir();
    writePlan(cwd);
    writeFileSync(join(cwd, "doc.md"),
      "# Doc\n\nExample (indented = documentation, not an anchor):\n\n" +
      "    <!-- DECISION " + GONE + "/D-001 — example only -->\n\n" +
      "A fenced sibling, always ignored:\n\n```\n<!-- DECISION " + GONE + "/D-002 — example only -->\n```\n");
    const r = run(cwd);
    assert.doesNotMatch(r.stdout, /\[anchor-unknown-plan\]/,
      `an indented doc example must not be an anchor, got:\n${r.stdout}`);
    assert.doesNotMatch(r.stdout, /doc\.md/, `doc.md must produce no anchor finding at all, got:\n${r.stdout}`);
  });

  it("(a') the same anchor FLUSH LEFT is still a real anchor — the fix under-masks, it does not blind the scanner", () => {
    // The over-masking guard on the READ path. If this ever goes quiet, the masker has
    // started hiding real anchors and Pre-Mortem #2 has fired.
    const cwd = getTempDir();
    writePlan(cwd);
    writeFileSync(join(cwd, "doc.md"), "# Doc\n\n<!-- DECISION " + GONE + "/D-001 — a REAL anchor -->\n");
    const r = run(cwd);
    assert.match(r.stdout, /\[anchor-unknown-plan\][^\n]*doc\.md/,
      `a flush-left comment anchor must still be reported, got:\n${r.stdout}`);
  });

  it("(b) an unterminated ``` fence in decisions.md masks NOTHING — no false [decisions-schema] ERROR", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    // bootstrap's real schema-example comment, verbatim in shape, behind an unclosed fence.
    writeFileSync(join(planDir, "decisions.md"),
      "```\n" +
      "# Decision Log\n" +
      "*Plan: plan_2026-05-15_aaaabbbb*\n\n" +
      "<!-- Schema example — DO NOT REMOVE. Real entries follow this shape.\n\n" +
      "## D-001 | EXPLORE → PLAN | YYYY-MM-DD\n" +
      "**Context**: <background>\n" +
      "**Decision**: <approach>\n" +
      "**Trade-off**: <X> **at the cost of** <Y>\n" +
      "**Reasoning**: <why>\n" +
      "-->\n");
    const r = run(cwd);
    assert.doesNotMatch(r.stdout, /\[decisions-schema\]/,
      `the template comment must stay a comment behind an unclosed fence, got:\n${r.stdout}`);
  });

  it("(b') a CLOSED fence still masks — the unterminated fix did not disable fenced masking", () => {
    const cwd = getTempDir();
    writePlan(cwd);
    writeFileSync(join(cwd, "doc.md"), "# Doc\n\n```\n<!-- DECISION " + GONE + "/D-001 -->\n```\n");
    const r = run(cwd);
    assert.doesNotMatch(r.stdout, /\[anchor-unknown-plan\]/, `got:\n${r.stdout}`);
  });
});

function run(cwd, ...args) {
  const r = spawnSync("node", [VALIDATOR, ...args], {
    cwd,
    encoding: "utf-8",
    timeout: 15000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { stdout: r.stdout || "", stderr: r.stderr || "", exitCode: r.status ?? 1 };
}

/**
 * Build a minimally-valid plan directory inside `cwd` so other validator
 * checks don't add noise. The plan id is fixed; `.current_plan` pointer is
 * written so `node validate-plan.mjs` (no args) picks it up.
 *
 * Fields:
 *   state, iteration, currentStep, fixAttemptsBody (raw body for the Fix Attempts section)
 */
function writePlan(cwd, { state = "EXECUTE", iteration = 1, currentStep = "1 of 5", fixAttemptsBody = "- (none yet for current step)", fixAttemptsHeading = "## Fix Attempts (resets per plan step)", transitionHistoryExtra = null } = {}) {
  const planId = "plan_2026-05-15_aaaabbbb";
  const plansDir = join(cwd, "plans");
  const planDir = join(plansDir, planId);
  mkdirSync(planDir, { recursive: true });
  mkdirSync(join(planDir, "findings"), { recursive: true });
  mkdirSync(join(planDir, "checkpoints"), { recursive: true });
  writeFileSync(join(plansDir, ".current_plan"), planId);

  writeFileSync(join(planDir, "state.md"),
`# Current State: ${state}
## Iteration: ${iteration}
## Current Plan Step: ${currentStep}
## Pre-Step Checklist (reset before each EXECUTE step)
- [ ] Re-read state.md (this file)
${fixAttemptsHeading}
${fixAttemptsBody}
## Change Manifest (current iteration)
- (no changes yet)
## Last Transition: PLAN → EXECUTE (2026-05-15T11:45:00Z)
## Transition History:
- INIT → EXPLORE (task started, 2026-05-15T10:53:44Z)
- EXPLORE → PLAN (gathered enough context, 2026-05-15T11:30:00Z)
  - confidence: scope=deep, solutions=adequate, risks=clear
- PLAN → EXECUTE (user approved, 2026-05-15T11:45:00Z)
${transitionHistoryExtra || ""}
`);

  writeFileSync(join(planDir, "plan.md"),
`# Plan v1: fixture
## Goal
Fixture goal.
## Problem Statement
Fixture problem.
## Context
Fixture context.
## Files To Modify
| File | Reason | Steps |
|---|---|---|
| fake.txt | testing | 1 |
## Steps
1. fixture step.
## Assumptions
- A1: fixture.
## Failure Modes
| Dep | Slow | Bad Data | Down | Blast |
|---|---|---|---|---|
| n/a | n/a | n/a | n/a | n/a |
## Pre-Mortem & Falsification Signals
1. Fixture pre-mortem.
## Success Criteria
- SC1: fixture.
## Verification Strategy
| # | Criterion | Command | Pass |
|---|---|---|---|
| 1 | SC1 | true | exit 0 |
## Complexity Budget
- Files: 0/3
`);

  writeFileSync(join(planDir, "progress.md"),
`# Progress
## Completed
*Nothing yet.*
## In Progress
- [ ] step 1
## Remaining
*To be populated.*
## Blocked
*Nothing currently.*
`);

  writeFileSync(join(planDir, "decisions.md"),
`# Decision Log
*Plan: ${planId}*
*Append-only.*

## D-001 | EXPLORE → PLAN | 2026-05-15
**Context**: fixture.
**Decision**: fixture.
**Trade-off**: a **at the cost of** b.
**Reasoning**: fixture.
**Anchor-Refs**: (none yet)
`);

  writeFileSync(join(planDir, "findings.md"),
`# Findings Index
- [F1](findings/f1.md) — fixture
- [F2](findings/f2.md) — fixture
- [F3](findings/f3.md) — fixture
`);
  for (const f of ["f1", "f2", "f3"]) {
    writeFileSync(join(planDir, "findings", `${f}.md`),
`# ${f}
## Summary
fixture.
## Key Findings
fixture.
## Constraints
fixture.
## Code Patterns
fixture.
## Risks / Unknowns
fixture.
`);
  }

  writeFileSync(join(planDir, "verification.md"),
`# Verification
## Verdict
- Tests run: n/a
- Tests passed: n/a
- Success criteria met: n/a
- Outstanding issues: n/a
- Recommendation: continue
`);
  writeFileSync(join(planDir, "changelog.md"),
`# Changelog
*Append-only.*
`);
  return { planId, planDir };
}

/** Extract just the [leash] lines from validator output for focused assertion. */
function leashLines(stdout) {
  return stdout.split("\n").filter((l) => /\[leash\]/.test(l));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validate-plan.mjs checkLeashCount regex reconciliation", () => {
  let tempDirs = [];
  function getTempDir() { const d = makeTempDir(); tempDirs.push(d); return d; }
  afterEach(() => { for (const d of tempDirs) removeTempDir(d); tempDirs = []; });

  it("matches documented `- Step N, attempt M` style at 4+ attempts → ERROR [leash]", () => {
    const cwd = getTempDir();
    writePlan(cwd, {
      fixAttemptsBody: [
        "- Step 2, attempt 1: tried X — failed",
        "- Step 2, attempt 2: tried Y — failed",
        "- Step 2, attempt 3: tried Z — failed",
        "- Step 2, attempt 4: tried W — failed",
      ].join("\n"),
    });
    const r = run(cwd);
    const lines = leashLines(r.stdout);
    assert.ok(lines.some((l) => /ERROR/.test(l)), `expected ERROR [leash], got:\n${r.stdout}`);
    assert.ok(/4 fix attempts/.test(r.stdout), `expected count=4 in message, got:\n${r.stdout}`);
  });

  it("matches legacy `- Attempt N` style at 4+ attempts → ERROR [leash] (backward compat)", () => {
    const cwd = getTempDir();
    writePlan(cwd, {
      fixAttemptsBody: [
        "- Attempt 1: tried X — failed",
        "- Attempt 2: tried Y — failed",
        "- Attempt 3: tried Z — failed",
        "- Attempt 4: tried W — failed",
      ].join("\n"),
    });
    const r = run(cwd);
    const lines = leashLines(r.stdout);
    assert.ok(lines.some((l) => /ERROR/.test(l)), `expected ERROR [leash], got:\n${r.stdout}`);
    assert.ok(/4 fix attempts/.test(r.stdout), `expected count=4 in message, got:\n${r.stdout}`);
  });

  it("3 attempts (documented style) → WARN [leash], no ERROR [leash]", () => {
    const cwd = getTempDir();
    writePlan(cwd, {
      fixAttemptsBody: [
        "- Step 2, attempt 1: a",
        "- Step 2, attempt 2: b",
        "- Step 2, attempt 3: c",
      ].join("\n"),
    });
    const r = run(cwd);
    const lines = leashLines(r.stdout);
    assert.ok(lines.some((l) => /WARN/.test(l)), `expected WARN [leash], got:\n${r.stdout}`);
    assert.ok(!lines.some((l) => /ERROR/.test(l)), `unexpected ERROR [leash], got:\n${r.stdout}`);
  });

  it("3 attempts (legacy style) → WARN [leash], no ERROR [leash]", () => {
    const cwd = getTempDir();
    writePlan(cwd, {
      fixAttemptsBody: [
        "- Attempt 1: a",
        "- Attempt 2: b",
        "- Attempt 3: c",
      ].join("\n"),
    });
    const r = run(cwd);
    const lines = leashLines(r.stdout);
    assert.ok(lines.some((l) => /WARN/.test(l)), `expected WARN [leash], got:\n${r.stdout}`);
    assert.ok(!lines.some((l) => /ERROR/.test(l)), `unexpected ERROR [leash], got:\n${r.stdout}`);
  });

  it("2 attempts → no [leash] issue raised", () => {
    const cwd = getTempDir();
    writePlan(cwd, {
      fixAttemptsBody: [
        "- Step 2, attempt 1: a",
        "- Step 2, attempt 2: b",
      ].join("\n"),
    });
    const r = run(cwd);
    assert.equal(leashLines(r.stdout).length, 0, `expected no [leash] lines, got:\n${r.stdout}`);
  });

  it("D-002 regression: parenthetical heading `## Fix Attempts (resets per plan step)` (bootstrap default) is correctly extracted and counted", () => {
    const cwd = getTempDir();
    writePlan(cwd, {
      fixAttemptsHeading: "## Fix Attempts (resets per plan step)",
      fixAttemptsBody: [
        "- Step 2, attempt 1: a",
        "- Step 2, attempt 2: b",
        "- Step 2, attempt 3: c",
        "- Step 2, attempt 4: d",
      ].join("\n"),
    });
    const r = run(cwd);
    const lines = leashLines(r.stdout);
    assert.ok(lines.some((l) => /ERROR/.test(l)), `parenthetical heading must reach checkLeashCount; got:\n${r.stdout}`);
  });

  it("D-002 regression: bare heading `## Fix Attempts` (legacy) still extracted and counted", () => {
    const cwd = getTempDir();
    writePlan(cwd, {
      fixAttemptsHeading: "## Fix Attempts",
      fixAttemptsBody: [
        "- Step 2, attempt 1: a",
        "- Step 2, attempt 2: b",
        "- Step 2, attempt 3: c",
        "- Step 2, attempt 4: d",
      ].join("\n"),
    });
    const r = run(cwd);
    const lines = leashLines(r.stdout);
    assert.ok(lines.some((l) => /ERROR/.test(l)), `bare heading must still work; got:\n${r.stdout}`);
  });

  it("non-matching bullets do not over-count (LEASH HIT line + placeholder)", () => {
    const cwd = getTempDir();
    writePlan(cwd, {
      fixAttemptsBody: [
        "- (none yet for current step)",
        "- some unrelated note about the step",
        "- Step 2: LEASH HIT. Transitioned to REFLECT.",
      ].join("\n"),
    });
    const r = run(cwd);
    assert.equal(leashLines(r.stdout).length, 0, `expected no [leash] lines for non-matching bullets, got:\n${r.stdout}`);
  });

  // F1 — relaxed regex tolerates comma-optional + plural variants. Pre-fix these all silently bypassed.
  it("F1: comma-less `- Step N attempt M` form (4 attempts) → ERROR [leash]", () => {
    const cwd = getTempDir();
    writePlan(cwd, {
      fixAttemptsBody: [
        "- Step 1 attempt 1",
        "- Step 1 attempt 2",
        "- Step 1 attempt 3",
        "- Step 1 attempt 4",
      ].join("\n"),
    });
    const r = run(cwd);
    const lines = leashLines(r.stdout);
    assert.ok(lines.some((l) => /ERROR/.test(l)), `expected ERROR [leash] for no-comma form, got:\n${r.stdout}`);
  });

  it("F1: plural `attempts` form (4 attempts) → ERROR [leash]", () => {
    const cwd = getTempDir();
    writePlan(cwd, {
      fixAttemptsBody: [
        "- Step 2, attempts 1: a",
        "- Step 2, attempts 2: b",
        "- Step 2 attempts 3: c",
        "- Step 2  attempts 4: d",
      ].join("\n"),
    });
    const r = run(cwd);
    const lines = leashLines(r.stdout);
    assert.ok(lines.some((l) => /ERROR/.test(l)), `expected ERROR [leash] for plural+no-comma forms, got:\n${r.stdout}`);
  });
});

// ---------------------------------------------------------------------------
// Standard-path plan-dir resolution (F2: absolute-path guard, plan_2026-06-01_dfe2202a step 2)
// ---------------------------------------------------------------------------

describe("validate-plan.mjs standard-path plan-dir resolution", () => {
  let tempDirs = [];
  function getTempDir() { const d = makeTempDir(); tempDirs.push(d); return d; }
  afterEach(() => { for (const d of tempDirs) removeTempDir(d); tempDirs = []; });

  it("F2: absolute path to a real plan dir resolves on the standard path (no `plans//` not-found error)", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    const r = run(cwd, planDir);
    assert.doesNotMatch(r.stderr, /Plan directory not found/, `should not report not-found for a real abs path, got:\n${r.stderr}`);
    assert.doesNotMatch(r.stdout + r.stderr, /plans\/\//, `resolved path must not contain a doubled \`plans//\`, got:\n${r.stdout}${r.stderr}`);
  });

  it("F2: bare plan-dir name still resolves under plans/ on the standard path", () => {
    const cwd = getTempDir();
    const { planId } = writePlan(cwd);
    const r = run(cwd, planId);
    assert.doesNotMatch(r.stderr, /Plan directory not found/, `bare name should resolve under plans/, got:\n${r.stderr}`);
  });

  it("F2: nonexistent absolute path errors with the resolved absolute path (no `plans/` prefix)", () => {
    const cwd = getTempDir();
    const missing = join(cwd, "no-such-plan-dir-xyz");
    const r = run(cwd, missing);
    assert.equal(r.exitCode, 1, `missing dir should exit 1, got ${r.exitCode}`);
    assert.match(r.stderr, /Plan directory not found/, `expected not-found error, got:\n${r.stderr}`);
    assert.match(r.stderr, new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `error should report the resolved abs path, got:\n${r.stderr}`);
    assert.doesNotMatch(r.stderr, /plans\/no-such-plan-dir-xyz/, `must not prepend plans/ to an absolute path, got:\n${r.stderr}`);
  });

  it("checkPlanIdPreamble accepts plans/<id> prefixed path form (no false preamble-mismatch)", () => {
    const cwd = getTempDir();
    const { planId } = writePlan(cwd);
    // CLI arg carries the `plans/` prefix; the decisions.md preamble stores the
    // bare plan-id. The logical plan-id must be basename-normalized so the two match.
    const r = run(cwd, `plans/${planId}`);
    assert.doesNotMatch(r.stderr, /Plan directory not found/, `prefixed form should resolve, got:\n${r.stderr}`);
    assert.doesNotMatch(r.stdout, /preamble-mismatch/, `prefixed form must not raise a false preamble-mismatch, got:\n${r.stdout}`);
  });
});

// ---------------------------------------------------------------------------
// --pre-step gate suite (step 11 of plan_2026-05-15_71ab18dd, D-004)
// ---------------------------------------------------------------------------

function runPreStep(cwd, planDirOverride) {
  const args = planDirOverride ? ["--pre-step", planDirOverride] : ["--pre-step"];
  return run(cwd, ...args);
}

describe("validate-plan.mjs --pre-step gate", () => {
  let tempDirs = [];
  function getTempDir() { const d = makeTempDir(); tempDirs.push(d); return d; }
  afterEach(() => { for (const d of tempDirs) removeTempDir(d); tempDirs = []; });

  it("(a) PASS — happy path: state=EXECUTE, iter=1, 0 attempts → exit 0, GATE:PASS", () => {
    const cwd = getTempDir();
    writePlan(cwd, { state: "EXECUTE", iteration: 1, currentStep: "1 of 5" });
    const r = runPreStep(cwd);
    assert.equal(r.exitCode, 0, `expected exit 0, got ${r.exitCode}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.ok(r.stdout.trim().startsWith("GATE:PASS"), `expected GATE:PASS prefix, got:\n${r.stdout}`);
  });

  it("(b) FAIL [leash-cap] — documented format: 2 `- Step N, attempt M` lines → exit 2", () => {
    const cwd = getTempDir();
    writePlan(cwd, {
      state: "EXECUTE",
      fixAttemptsBody: [
        "- Step 2, attempt 1: tried X — failed",
        "- Step 2, attempt 2: tried Y — failed",
      ].join("\n"),
    });
    const r = runPreStep(cwd);
    assert.equal(r.exitCode, 2, `expected exit 2, got ${r.exitCode}\nstdout:\n${r.stdout}`);
    assert.ok(r.stdout.trim().startsWith("GATE:FAIL [leash-cap]"), `expected GATE:FAIL [leash-cap] prefix, got:\n${r.stdout}`);
    assert.ok(/attempts=2/.test(r.stdout), `expected attempts=2 in output, got:\n${r.stdout}`);
  });

  it("(c) FAIL [leash-cap] — legacy format: 2 `- Attempt N` lines → exit 2 (backward compat)", () => {
    const cwd = getTempDir();
    writePlan(cwd, {
      state: "EXECUTE",
      fixAttemptsBody: [
        "- Attempt 1: tried X — failed",
        "- Attempt 2: tried Y — failed",
      ].join("\n"),
    });
    const r = runPreStep(cwd);
    assert.equal(r.exitCode, 2, `expected exit 2, got ${r.exitCode}\nstdout:\n${r.stdout}`);
    assert.ok(r.stdout.trim().startsWith("GATE:FAIL [leash-cap]"), `expected GATE:FAIL [leash-cap] prefix, got:\n${r.stdout}`);
    assert.ok(/attempts=2/.test(r.stdout), `expected attempts=2 in output, got:\n${r.stdout}`);
  });

  it("(d) FAIL [wrong-state] — state=PLAN → exit 2, expected/actual reported", () => {
    const cwd = getTempDir();
    writePlan(cwd, { state: "PLAN", iteration: 1 });
    const r = runPreStep(cwd);
    assert.equal(r.exitCode, 2, `expected exit 2, got ${r.exitCode}\nstdout:\n${r.stdout}`);
    assert.ok(r.stdout.trim().startsWith("GATE:FAIL [wrong-state]"), `expected GATE:FAIL [wrong-state] prefix, got:\n${r.stdout}`);
    assert.ok(/expected=EXECUTE/.test(r.stdout), `expected expected=EXECUTE in output, got:\n${r.stdout}`);
    assert.ok(/actual=PLAN/.test(r.stdout), `expected actual=PLAN in output, got:\n${r.stdout}`);
  });

  it("(e) FAIL [iteration-cap] — iter=6 → exit 2, iteration=6 hard-cap=6 reported", () => {
    const cwd = getTempDir();
    writePlan(cwd, { state: "EXECUTE", iteration: 6 });
    const r = runPreStep(cwd);
    assert.equal(r.exitCode, 2, `expected exit 2, got ${r.exitCode}\nstdout:\n${r.stdout}`);
    assert.ok(r.stdout.trim().startsWith("GATE:FAIL [iteration-cap]"), `expected GATE:FAIL [iteration-cap] prefix, got:\n${r.stdout}`);
    assert.ok(/iteration=6/.test(r.stdout), `expected iteration=6 in output, got:\n${r.stdout}`);
    assert.ok(/hard-cap=6/.test(r.stdout), `expected hard-cap=6 in output, got:\n${r.stdout}`);
  });

  it("(f) FAIL [no-plan] — no .current_plan pointer + no positional arg → exit 2", () => {
    const cwd = getTempDir(); // empty temp dir, no plans/ subtree
    const r = runPreStep(cwd);
    assert.equal(r.exitCode, 2, `expected exit 2, got ${r.exitCode}\nstdout:\n${r.stdout}`);
    assert.ok(r.stdout.trim().startsWith("GATE:FAIL [no-plan]"), `expected GATE:FAIL [no-plan] prefix, got:\n${r.stdout}`);
  });

  it("(g) regression: full validator (no --pre-step) on 4 documented-format attempts → ERROR [leash]", () => {
    const cwd = getTempDir();
    writePlan(cwd, {
      fixAttemptsBody: [
        "- Step 2, attempt 1: a",
        "- Step 2, attempt 2: b",
        "- Step 2, attempt 3: c",
        "- Step 2, attempt 4: d",
      ].join("\n"),
    });
    const r = run(cwd); // no --pre-step
    assert.equal(r.exitCode, 1, `expected exit 1 from full validator, got ${r.exitCode}\nstdout:\n${r.stdout}`);
    assert.ok(/ERROR/.test(r.stdout), `expected ERROR in stdout, got:\n${r.stdout}`);
    assert.ok(/\[leash\]/.test(r.stdout), `expected [leash] tag in stdout, got:\n${r.stdout}`);
  });

  // F1 — pre-step gate must trip on comma-optional / plural variants too.
  it("(i) F1: FAIL [leash-cap] — 2 no-comma `- Step N attempt M` lines → exit 2", () => {
    const cwd = getTempDir();
    writePlan(cwd, {
      state: "EXECUTE",
      fixAttemptsBody: [
        "- Step 3 attempt 1: a",
        "- Step 3 attempt 2: b",
      ].join("\n"),
    });
    const r = runPreStep(cwd);
    assert.equal(r.exitCode, 2, `expected exit 2 for no-comma form, got ${r.exitCode}\nstdout:\n${r.stdout}`);
    assert.ok(r.stdout.trim().startsWith("GATE:FAIL [leash-cap]"), `expected GATE:FAIL [leash-cap], got:\n${r.stdout}`);
  });

  it("(j) F1: FAIL [leash-cap] — plural `attempts` form → exit 2", () => {
    const cwd = getTempDir();
    writePlan(cwd, {
      state: "EXECUTE",
      fixAttemptsBody: [
        "- Attempts 1: a",
        "- Attempts 2: b",
      ].join("\n"),
    });
    const r = runPreStep(cwd);
    assert.equal(r.exitCode, 2, `expected exit 2 for plural Attempts, got ${r.exitCode}\nstdout:\n${r.stdout}`);
    assert.ok(r.stdout.trim().startsWith("GATE:FAIL [leash-cap]"), `expected GATE:FAIL [leash-cap], got:\n${r.stdout}`);
  });

  // F5 — REPLAN normalized to PIVOT in decisions-schema (Complexity Assessment required).
  it("(l) F5: ## D-NNN | REPLAN | ... without Complexity Assessment → ERROR [decisions-schema]", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd, { state: "EXECUTE", iteration: 1 });
    writeFileSync(join(planDir, "decisions.md"),
`# Decision Log
*Plan: plan_2026-05-15_aaaabbbb*

## D-001 | REFLECT → REPLAN | 2026-05-15
**Context**: ctx
**Decision**: change approach
**Trade-off**: a at the cost of b
**Reasoning**: r
**Anchor-Refs**: (none yet)
`);
    const r = run(cwd);
    const schemaErrs = r.stdout.split("\n").filter((l) => /ERROR \[decisions-schema\].*Complexity Assessment/.test(l));
    assert.ok(schemaErrs.length >= 1, `expected ERROR for missing Complexity Assessment on REPLAN, got:\n${r.stdout}`);
  });

  // Defect #6 (iter-1/step-6): the decisions header regex hard-capped ids at exactly
  // 3 digits, so `## D-1000 | ... ` was reported as a NON-CONFORMING HEADER — a plan
  // that logged 1000 decisions could no longer log a valid one. 3-digit padding is a
  // MINIMUM now, not a cap (shared.mjs DECISION_ID_NUM_PATTERN).
  it("(l2) #6: ## D-1000 | ... parses as a conforming header (3-digit padding is a minimum, not a cap)", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd, { state: "EXECUTE", iteration: 1 });
    writeFileSync(join(planDir, "decisions.md"),
`# Decision Log
*Plan: plan_2026-05-15_aaaabbbb*

## D-1000 | EXECUTE | 2026-05-15
**Context**: ctx
**Decision**: past the old 3-digit ceiling
**Trade-off**: a at the cost of b
**Reasoning**: r
**Anchor-Refs**: (none yet)
`);
    const r = run(cwd);
    const badHeader = r.stdout.split("\n").filter((l) => /non-conforming entry header/.test(l));
    assert.deepEqual(badHeader, [], `D-1000 must parse as a conforming header, got:\n${r.stdout}`);
  });

  // The padding MINIMUM survives the widening: `D-1` is still a bad header, so `D-1`
  // and `D-001` can never coexist as two names for the same decision.
  it("(l3) #6: ## D-1 | ... is STILL a non-conforming header (padding minimum preserved)", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd, { state: "EXECUTE", iteration: 1 });
    writeFileSync(join(planDir, "decisions.md"),
`# Decision Log
*Plan: plan_2026-05-15_aaaabbbb*

## D-1 | EXECUTE | 2026-05-15
**Context**: ctx
**Decision**: under-padded id
**Trade-off**: a at the cost of b
**Reasoning**: r
**Anchor-Refs**: (none yet)
`);
    const r = run(cwd);
    const badHeader = r.stdout.split("\n").filter((l) => /non-conforming entry header/.test(l));
    assert.ok(badHeader.length >= 1, `D-1 must remain a non-conforming header, got:\n${r.stdout}`);
  });

  // F5 — substring false-positive: PIVOT-RECOVERY is NOT a real PIVOT.
  it("(m) F5: ## D-NNN | PIVOT-RECOVERY | ... without Complexity Assessment → NO ERROR [decisions-schema] Complexity Assessment", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd, { state: "EXECUTE", iteration: 1 });
    writeFileSync(join(planDir, "decisions.md"),
`# Decision Log
*Plan: plan_2026-05-15_aaaabbbb*

## D-001 | PIVOT-RECOVERY | 2026-05-15
**Context**: ctx
**Decision**: recover from earlier pivot
**Trade-off**: a at the cost of b
**Reasoning**: r
**Anchor-Refs**: (none yet)
`);
    const r = run(cwd);
    const wrongErr = r.stdout.split("\n").filter((l) => /ERROR \[decisions-schema\].*Complexity Assessment/.test(l));
    assert.equal(wrongErr.length, 0, `PIVOT-RECOVERY must not trip Complexity Assessment requirement, got:\n${r.stdout}`);
  });

  // OBS-001 / D-002 — isPivotPhase must accept PIVOT-as-SOURCE (`PIVOT → PLAN`),
  // not just PIVOT-as-DESTINATION. Previously the regression introduced by F5
  // silently let `## D-NNN | PIVOT → PLAN | ...` escape the Complexity Assessment
  // requirement. Pre-fix: this test FAILS (0 schema errors). Post-fix: PASSES.
  it("(n) OBS-001: ## D-NNN | PIVOT → PLAN | ... without Complexity Assessment → ERROR [decisions-schema]", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd, { state: "EXECUTE", iteration: 1 });
    writeFileSync(join(planDir, "decisions.md"),
`# Decision Log
*Plan: plan_2026-05-15_aaaabbbb*

## D-001 | PIVOT → PLAN | 2026-05-15
**Context**: ctx
**Decision**: new approach after pivot
**Trade-off**: a at the cost of b
**Reasoning**: r
**Anchor-Refs**: (none yet)
`);
    const r = run(cwd);
    const schemaErrs = r.stdout.split("\n").filter((l) => /ERROR \[decisions-schema\].*Complexity Assessment/.test(l));
    assert.ok(schemaErrs.length >= 1, `expected ERROR for missing Complexity Assessment on PIVOT → PLAN, got:\n${r.stdout}`);
  });

  // OBS-001 / D-002 — guard against over-broadening: `PIVOT-PLAN` (hyphen, not arrow)
  // is still a SUBSTRING and must NOT trip the requirement.
  it("(o) OBS-001: ## D-NNN | PIVOT-PLAN | ... must NOT trip Complexity Assessment", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd, { state: "EXECUTE", iteration: 1 });
    writeFileSync(join(planDir, "decisions.md"),
`# Decision Log
*Plan: plan_2026-05-15_aaaabbbb*

## D-001 | PIVOT-PLAN | 2026-05-15
**Context**: ctx
**Decision**: hyphenated qualifier, not a real PIVOT
**Trade-off**: a at the cost of b
**Reasoning**: r
**Anchor-Refs**: (none yet)
`);
    const r = run(cwd);
    const wrongErr = r.stdout.split("\n").filter((l) => /ERROR \[decisions-schema\].*Complexity Assessment/.test(l));
    assert.equal(wrongErr.length, 0, `PIVOT-PLAN (hyphen) must not trip Complexity Assessment, got:\n${r.stdout}`);
  });

  // 3.1c — Trade-off present but missing "at the cost of" phrase → WARN [decisions-schema].
  it("(p2) 3.1c: **Trade-off**: present but missing 'at the cost of' → WARN [decisions-schema]", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd, { state: "EXECUTE", iteration: 1 });
    writeFileSync(join(planDir, "decisions.md"),
`# Decision Log
*Plan: plan_2026-05-15_aaaabbbb*

## D-001 | EXPLORE → PLAN | 2026-05-15
**Context**: ctx
**Decision**: chose approach X instead of Y
**Trade-off**: used approach X instead of Y
**Reasoning**: r
**Anchor-Refs**: (none yet)
`);
    const r = run(cwd);
    const warnLines = r.stdout.split("\n").filter((l) => /WARN\s+\[decisions-schema\].*at the cost of/.test(l));
    assert.ok(warnLines.length >= 1, `expected WARN for missing "at the cost of" phrase, got:\n${r.stdout}`);
  });

  // F3 — pipe in changelog reason must not corrupt validation.
  it("(k) F3: changelog reason containing ` | ` is absorbed; no [changelog-malformed] WARN", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd, { state: "EXECUTE", iteration: 1 });
    writeFileSync(join(planDir, "changelog.md"),
`# Changelog
*Append-only.*

2026-05-15T10:00:00Z | iter-1/step-1 | abc1234 | src/foo.mjs | EDIT(+5,-2) | radius:LOW(1) | - | fix race: a | b condition
`);
    const r = run(cwd);
    const malformed = r.stdout.split("\n").filter((l) => /\[changelog-malformed\]/.test(l));
    assert.equal(malformed.length, 0, `pipe in reason must not produce changelog-malformed WARN, got:\n${r.stdout}`);
  });

  // OBS-005 / D-005 — iteration cap must fire from Transition History EXECUTE→REFLECT
  // count, even when the agent-written `## Iteration:` field is stale or zero.
  it("(p) OBS-005: state.md with 7 EXECUTE→REFLECT transitions + declared Iteration 0 → ERROR [iteration] hard cap", () => {
    const cwd = getTempDir();
    const transitionHistory = [
      "- INIT → EXPLORE (a)",
      "- EXPLORE → PLAN (b)",
      "- PLAN → EXECUTE (c)",
      "- EXECUTE → REFLECT (1)",
      "- EXECUTE → REFLECT (2)",
      "- EXECUTE → REFLECT (3)",
      "- EXECUTE → REFLECT (4)",
      "- EXECUTE → REFLECT (5)",
      "- EXECUTE → REFLECT (6)",
      "- EXECUTE → REFLECT (7)",
    ].join("\n");
    writePlan(cwd, { state: "EXECUTE", iteration: 0, transitionHistoryExtra: transitionHistory });
    const r = run(cwd);
    const iterErrs = r.stdout.split("\n").filter((l) => /ERROR \[iteration\]/.test(l));
    assert.ok(iterErrs.length >= 1, `expected ERROR [iteration] from derived count, got:\n${r.stdout}`);
    assert.ok(/derived=7/.test(iterErrs[0]), `error message must mention derived=7, got: ${iterErrs[0]}`);
  });

  // OBS-005 / D-005 — derived count below cap must NOT trigger ERROR.
  it("(q) OBS-005: state.md with 3 EXECUTE→REFLECT transitions + declared Iteration 0 → no [iteration] ERROR", () => {
    const cwd = getTempDir();
    const transitionHistory = [
      "- EXECUTE → REFLECT (1)",
      "- EXECUTE → REFLECT (2)",
      "- EXECUTE → REFLECT (3)",
    ].join("\n");
    writePlan(cwd, { state: "EXECUTE", iteration: 0, transitionHistoryExtra: transitionHistory });
    const r = run(cwd);
    const iterErrs = r.stdout.split("\n").filter((l) => /ERROR \[iteration\]/.test(l));
    assert.equal(iterErrs.length, 0, `derived=3 must not trigger cap, got:\n${r.stdout}`);
  });

  // -------------------------------------------------------------------------
  // Defect #8 / D-003 — state.md Transition-History scanners must be comment-blind.
  // bootstrap.mjs's own state.md template embeds an EXAMPLE `- EXPLORE → PLAN (...)`
  // line inside an HTML comment; raw scans ingested it as a real transition record.
  // -------------------------------------------------------------------------

  // C5(a) — the live-bug regression test. A FRESH `bootstrap.mjs new` plan dir (whose
  // state.md carries the guidance comment verbatim) with a correct confidence sub-line
  // under its REAL transition must produce ZERO [exploration-confidence] WARNs.
  it("(v) #8: fresh bootstrap plan dir + correct confidence sub-line → zero [exploration-confidence] WARNs", () => {
    const cwd = getTempDir();
    const b = spawnSync("node", [BOOTSTRAP, "new", "probe"], { cwd, encoding: "utf-8", timeout: 15000 });
    assert.equal(b.status, 0, `bootstrap new failed: ${b.stderr}`);
    const planId = readdirSync(join(cwd, "plans")).find((d) => /^plan[-_]/.test(d));
    const statePath = join(cwd, "plans", planId, "state.md");
    let state = readFileSync(statePath, "utf-8");
    // Guard: the fixture is only meaningful if the template comment is really there.
    assert.ok(state.includes("<!-- When logging EXPLORE → PLAN"), "bootstrap template must embed the guidance comment");
    // Log a REAL EXPLORE → PLAN transition, correctly followed by its confidence sub-line.
    state = state.replace(
      "- INIT → EXPLORE (task started)",
      "- INIT → EXPLORE (task started)\n- EXPLORE → PLAN (enough context, 2026-07-14T05:00:00Z)\n  - confidence: scope=deep, solutions=adequate, risks=clear",
    );
    writeFileSync(statePath, state);
    const r = run(cwd);
    const warns = r.stdout.split("\n").filter((l) => /\[exploration-confidence\]/.test(l));
    assert.equal(warns.length, 0, `template comment must not trip the check, got:\n${r.stdout}`);
  });

  // C5(b) — corrected, NOT deleted: remove the sub-line and the WARN comes back, once.
  it("(w) #8: fresh bootstrap plan dir with the confidence sub-line absent → exactly one [exploration-confidence] WARN", () => {
    const cwd = getTempDir();
    const b = spawnSync("node", [BOOTSTRAP, "new", "probe"], { cwd, encoding: "utf-8", timeout: 15000 });
    assert.equal(b.status, 0, `bootstrap new failed: ${b.stderr}`);
    const planId = readdirSync(join(cwd, "plans")).find((d) => /^plan[-_]/.test(d));
    const statePath = join(cwd, "plans", planId, "state.md");
    let state = readFileSync(statePath, "utf-8");
    state = state.replace(
      "- INIT → EXPLORE (task started)",
      "- INIT → EXPLORE (task started)\n- EXPLORE → PLAN (enough context, 2026-07-14T05:00:00Z)",
    );
    writeFileSync(statePath, state);
    const r = run(cwd);
    const warns = r.stdout.split("\n").filter((l) => /\[exploration-confidence\]/.test(l));
    assert.equal(warns.length, 1, `a genuinely missing confidence sub-line must still WARN exactly once, got:\n${r.stdout}`);
  });

  // C5(c) — the safety pin. With the guidance comment present AND 7 real
  // EXECUTE → REFLECT transitions, the iteration hard cap must still ERROR.
  //
  // ASSERTION INTENTIONALLY REWRITTEN at iter-2/step-5 (D-009), derived=7 → derived=8.
  // This test asserted the STRIPPING MECHANISM ("the commented example was not counted"),
  // which falsifies plan assumption B7. D-009 deliberately relocates the cap's fail-safe
  // OUT of the stripper: the counter now reads the RAW block, because a stray `<!--` pairs
  // with bootstrap's template trailer and the stripper would otherwise blank real records
  // away (measured: 4 real records → derived 0 — the cap failed OPEN). The cost, accepted
  // explicitly in D-009's Trade-off, is exactly this fixture: a comment that genuinely
  // embeds a transition-shaped line now OVER-counts by one. That is the safe, loud,
  // recoverable direction — and [state-comment-anomaly] (step 6) fires here to explain it.
  // The VERDICT is unchanged (the cap still ERRORs, which is what this test exists to pin);
  // only the derived number moves. Real plans are unaffected: bootstrap's template example
  // is `EXPLORE → PLAN`, never `EXECUTE → REFLECT` (assumption B4, re-verified at step 5).
  it("(x) #8/D-009: guidance comment w/ an example EXECUTE → REFLECT + 7 real ones → hard cap ERRORs, derived=8 (raw count: over-count, never under-count)", () => {
    const cwd = getTempDir();
    const transitionHistory = [
      "<!-- When logging EXPLORE → PLAN, add Exploration Confidence on the line below, e.g.:",
      "- EXPLORE → PLAN (gathered enough context, YYYY-MM-DDTHH:MM:SSZ)",
      "  - confidence: scope=deep|partial|shallow, solutions=adequate|thin, risks=clear|unclear",
      "- EXECUTE → REFLECT (example inside the comment — D-009: raw counting DOES count it)",
      "See references/planning-rigor.md for definitions. -->",
      "- EXECUTE → REFLECT (1)",
      "- EXECUTE → REFLECT (2)",
      "- EXECUTE → REFLECT (3)",
      "- EXECUTE → REFLECT (4)",
      "- EXECUTE → REFLECT (5)",
      "- EXECUTE → REFLECT (6)",
      "- EXECUTE → REFLECT (7)",
    ].join("\n");
    writePlan(cwd, { state: "EXECUTE", iteration: 0, transitionHistoryExtra: transitionHistory });
    const r = run(cwd);
    const iterErrs = r.stdout.split("\n").filter((l) => /ERROR \[iteration\]/.test(l));
    assert.ok(iterErrs.length >= 1, `hard cap must still fire with a comment block present, got:\n${r.stdout}`);
    // derived=8, not 7 — the raw block includes the comment's example transition. Over-count
    // is the SAFE direction; the cap's job (fire at 6+) is unaffected. See D-009.
    assert.ok(/derived=8/.test(iterErrs[0]), `expected derived=8 (raw count includes the in-comment example), got: ${iterErrs[0]}`);
  });

  // C5(c) — phantom transitions: an ILLEGAL transition inside a comment must not be
  // ingested by checkStateTransitions. Pre-fix, the `.startsWith("- ")` filter admitted
  // any example line in the comment body.
  it("(y) #8: an ILLEGAL transition inside an HTML comment is not ingested by the legality check", () => {
    const cwd = getTempDir();
    const transitionHistory = [
      "<!-- example block:",
      "- CLOSE → EXPLORE (phantom — illegal, but it lives inside a comment)",
      "-->",
    ].join("\n");
    writePlan(cwd, { state: "EXECUTE", iteration: 1, transitionHistoryExtra: transitionHistory });
    const r = run(cwd);
    const transErrs = r.stdout.split("\n").filter((l) => /\[transition\]/.test(l));
    assert.equal(transErrs.length, 0, `commented-out transitions must not be ingested, got:\n${r.stdout}`);
    // Sanity: the same line OUTSIDE a comment IS an error — proving the check still works.
    writePlan(cwd, { state: "EXECUTE", iteration: 1, transitionHistoryExtra: "- CLOSE → EXPLORE (real, illegal)" });
    const r2 = run(cwd);
    assert.ok(/ERROR \[transition\]/.test(r2.stdout), `a REAL illegal transition must still ERROR, got:\n${r2.stdout}`);
  });

  // -------------------------------------------------------------------------
  // D-009 (iter-2, CRITICAL 2) — the iteration hard cap must FAIL CLOSED.
  //
  // The review's exact fixture: a stray `<!-- note:` opener ABOVE the records, N real
  // EXECUTE → REFLECT records, and bootstrap's trailing template guidance comment (which
  // supplies the `-->`). Under HTML rules the stray opener PAIRS with that trailer, so
  // `stripHtmlComments` blanks everything between — including the `## Transition History:`
  // heading itself. RED RUN against the pre-step-5 code, 4 real records:
  //
  //     real EXECUTE → REFLECT record lines in fixture: 4
  //     PRE-FIX deriveIterationFromHistory(): 0
  //     RED  (bug reproduced: cap UNDER-counts — fails OPEN)
  //
  // Worse than the 2 the review reported: the cap read ZERO, from ANY number of real
  // records. A safety mechanism that silently evaporates. The fix reads the RAW block.
  // -------------------------------------------------------------------------

  /** state.md exactly as the reviewer's repro: stray opener above, template trailer below. */
  function strayOpenerState({ iteration = 0, records = 4 } = {}) {
    const recs = Array.from({ length: records }, (_, i) => `- EXECUTE → REFLECT (iter ${i + 1})`);
    return [
      "# Current State: EXECUTE",
      `## Iteration: ${iteration}`,
      "## Current Plan Step: 1 of 5",
      "## Pre-Step Checklist (reset before each EXECUTE step)",
      "- [ ] Re-read state.md (this file)",
      "## Fix Attempts (resets per plan step)",
      "- (none yet for current step)",
      "## Change Manifest (current iteration)",
      "<!-- note: stray opener — an authoring accident, never closed by its author",
      "## Last Transition: PLAN → EXECUTE (2026-05-15T11:45:00Z)",
      "## Transition History:",
      "- INIT → EXPLORE (task started)",
      "- EXPLORE → PLAN (gathered enough context, 2026-05-15T11:30:00Z)",
      "  - confidence: scope=deep, solutions=adequate, risks=clear",
      "- PLAN → EXECUTE (user approved, 2026-05-15T11:45:00Z)",
      ...recs,
      // bootstrap.mjs:1383-1386 — every state.md ends with this. It supplies the `-->`.
      "<!-- When logging EXPLORE → PLAN, add Exploration Confidence on the line below, e.g.:",
      "- EXPLORE → PLAN (gathered enough context, YYYY-MM-DDTHH:MM:SSZ)",
      "  - confidence: scope=deep|partial|shallow, solutions=adequate|thin, risks=clear|unclear",
      "See references/planning-rigor.md for definitions. -->",
      "",
    ].join("\n");
  }

  it("(aa) D-009: stray `<!--` opener + 4 real EXECUTE → REFLECT records → derived === 4 (pre-fix: 0)", async () => {
    const { deriveIterationFromHistory } = await import(VALIDATOR);
    assert.equal(deriveIterationFromHistory(strayOpenerState({ records: 4 })), 4,
      "the review's exact fixture: the cap must count all 4 real records, not the 0 the stripped block yields");
  });

  it("(ab) D-009: the cap NEVER under-counts, in any comment shape (opener before/between/after; balanced; backticked; none)", async () => {
    const { deriveIterationFromHistory } = await import(VALIDATOR);
    const rec = (n) => Array.from({ length: n }, (_, i) => `- EXECUTE → REFLECT (${i + 1})`);
    const head = [
      "# Current State: EXECUTE",
      "## Iteration: 0",
      "## Transition History:",
      "- INIT → EXPLORE (task started)",
    ];
    const trailer = "<!-- guidance: - EXPLORE → PLAN (example) -->";
    const shapes = {
      "no comments at all": [...head, ...rec(3)],
      "stray opener BEFORE the records": [...head, "<!-- note: stray", ...rec(3), trailer],
      "stray opener BETWEEN the records": [...head, ...rec(1), "<!-- note: stray", ...rec(2), trailer],
      "stray opener AFTER the records (the only shape D-003 ever tested)": [...head, ...rec(3), "<!-- note: stray"],
      "balanced comment holding an example transition": [...head, ...rec(3), "<!-- e.g. - EXECUTE → REFLECT (example) -->"],
      "backticked delimiter in prose": [...head, "- NOTE: a stray `<!--` in prose is not a comment", ...rec(3), trailer],
      "stray opener above the HEADING itself": ["# Current State: EXECUTE", "## Iteration: 0", "<!-- note: stray", ...head.slice(2), ...rec(3), trailer],
    };
    for (const [name, lines] of Object.entries(shapes)) {
      const derived = deriveIterationFromHistory(lines.join("\n") + "\n");
      assert.ok(derived >= 3, `[${name}] cap UNDER-counted: derived=${derived}, real records=3 — this is the fail-open D-009 forbids`);
    }
    // Equality where the comments hold no transition-shaped line (no gratuitous over-count).
    for (const name of ["no comments at all", "stray opener BEFORE the records", "stray opener BETWEEN the records", "stray opener AFTER the records (the only shape D-003 ever tested)", "backticked delimiter in prose"]) {
      const derived = deriveIterationFromHistory(shapes[name].join("\n") + "\n");
      assert.equal(derived, 3, `[${name}] expected exactly 3 (no comment here embeds a transition-shaped line)`);
    }
  });

  it("(ac) D-009: 6 real records + a stray `<!--` opener → the hard-cap ERROR still fires (pre-fix: silent)", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd, { state: "EXECUTE", iteration: 0 });
    writeFileSync(join(planDir, "state.md"), strayOpenerState({ iteration: 0, records: 6 }));
    const r = run(cwd);
    const iterErrs = r.stdout.split("\n").filter((l) => /ERROR \[iteration\]/.test(l));
    assert.equal(iterErrs.length, 1, `the hard cap must still fire through a stray opener, got:\n${r.stdout}`);
    assert.ok(/derived=6/.test(iterErrs[0]), `expected derived=6 from the raw block, got: ${iterErrs[0]}`);
  });

  // -------------------------------------------------------------------------
  // D-009 (step 6) — [state-comment-anomaly]: the diagnostic that EXPLAINS an over-count.
  // WARN only. Never ERROR, never exit 2, and SILENT on every well-formed plan.
  // -------------------------------------------------------------------------

  // WHY THE CHECK IS AN *OR* (measured, not assumed): on the review's exact fixture the
  // marker-BALANCE probe is SILENT. The stray opener pairs perfectly with bootstrap's
  // template trailer, so the markers genuinely balance — which is precisely the argument
  // D-009 makes for why balance-counting cannot be the fail-safe. What catches this shape is
  // the raw-vs-stripped DISAGREEMENT (4 records raw, 0 after stripping). Neither condition
  // alone suffices; (ai) below covers the shape the balance probe is the only one that sees.
  it("(ae) D-009: the review's stray-opener fixture → WARN [state-comment-anomaly] (via raw/stripped divergence), never an ERROR, exit != 2", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd, { state: "EXECUTE", iteration: 4 });
    writeFileSync(join(planDir, "state.md"), strayOpenerState({ iteration: 4, records: 4 }));
    const r = run(cwd);
    const hits = r.stdout.split("\n").filter((l) => /\[state-comment-anomaly\]/.test(l));
    assert.ok(hits.length >= 1, `the swallowed records must be reported, got:\n${r.stdout}`);
    for (const h of hits) assert.ok(/^\s*WARN/.test(h), `[state-comment-anomaly] must be WARN, never ERROR: ${h}`);
    assert.equal(r.stdout.split("\n").filter((l) => /ERROR \[state-comment-anomaly\]/.test(l)).length, 0);
    assert.notEqual(r.exitCode, 2, "exit 2 is reserved for the --pre-step leash gate");
    // It explains the cap: 4 real records survive raw, 0 survive the strip.
    assert.ok(/4 .*record\(s\) in the raw text but 0 after/.test(hits[0]),
      `the WARN must explain the over-count by naming both counts, got: ${hits[0]}`);
  });

  it("(ai) D-009: a genuinely UNTERMINATED opener (nothing swallowed) → the balance probe names its line", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd, { state: "EXECUTE", iteration: 1 });
    // No template trailer, no records inside: raw === stripped, so ONLY marker balance can see it.
    const state = readFileSync(join(planDir, "state.md"), "utf-8") + "<!-- note: stray, never closed\n";
    writeFileSync(join(planDir, "state.md"), state);
    const r = run(cwd);
    const hits = r.stdout.split("\n").filter((l) => /\[state-comment-anomaly\]/.test(l));
    assert.equal(hits.length, 1, `an unterminated opener must be surfaced even when nothing was swallowed, got:\n${r.stdout}`);
    assert.ok(/^\s*WARN/.test(hits[0]), "must be WARN");
    const expectedLine = state.slice(0, state.indexOf("<!-- note:")).split("\n").length;
    assert.ok(new RegExp(`state\\.md line ${expectedLine}:`).test(hits[0]), `the WARN must name the line, got: ${hits[0]}`);
  });

  it("(af) D-009: a transition-shaped line INSIDE a comment → WARN explains the raw/stripped disagreement (the cap's over-count)", () => {
    const cwd = getTempDir();
    const transitionHistory = [
      "<!-- guidance:",
      "- EXECUTE → REFLECT (an example, inside a real balanced comment)",
      "-->",
      "- EXECUTE → REFLECT (1)",
    ].join("\n");
    writePlan(cwd, { state: "EXECUTE", iteration: 1, transitionHistoryExtra: transitionHistory });
    const r = run(cwd);
    const hits = r.stdout.split("\n").filter((l) => /\[state-comment-anomaly\]/.test(l));
    assert.equal(hits.length, 1, `raw=2 vs stripped=1 must be explained exactly once, got:\n${r.stdout}`);
    assert.ok(/^\s*WARN/.test(hits[0]), "must be WARN");
    assert.ok(/2 .*raw.*1 after/.test(hits[0]) || /raw text but 1/.test(hits[0]), `the WARN must state both counts, got: ${hits[0]}`);
  });

  it("(ag) D-009: SILENT on a well-formed plan — no stray opener, no in-comment transition (the noise regression guard)", () => {
    const cwd = getTempDir();
    // The default writePlan fixture: balanced comments (none), real transitions only.
    writePlan(cwd, { state: "EXECUTE", iteration: 1, transitionHistoryExtra: "- EXECUTE → REFLECT (1)" });
    const r = run(cwd);
    const hits = r.stdout.split("\n").filter((l) => /\[state-comment-anomaly\]/.test(l));
    assert.equal(hits.length, 0, `a well-formed state.md must produce NO anomaly WARN, got:\n${r.stdout}`);
  });

  it("(ah) D-009: SILENT on a fresh `bootstrap.mjs new` plan dir (a WARN on every plan is a signal-quality regression)", () => {
    const cwd = getTempDir();
    const b = spawnSync("node", [BOOTSTRAP, "new", "anomaly silence probe"], { cwd, encoding: "utf-8", timeout: 15000 });
    assert.equal(b.status, 0, `bootstrap new failed: ${b.stderr}`);
    const planId = readFileSync(join(cwd, "plans", ".current_plan"), "utf-8").trim();
    const r = run(cwd, [join("plans", planId)]);
    const hits = r.stdout.split("\n").filter((l) => /\[state-comment-anomaly\]/.test(l));
    assert.equal(hits.length, 0, `bootstrap's own state.md template must NOT trip the anomaly WARN, got:\n${r.stdout}`);
    // And the backticked delimiter case: prose ABOUT comments is not a comment.
    const statePath = join(cwd, "plans", planId, "state.md");
    const state = readFileSync(statePath, "utf-8");
    writeFileSync(statePath, state.replace("## Change Manifest (current iteration)",
      "## Change Manifest (current iteration)\n- NOTE: a backticked `<!--` in prose must not read as an opener"));
    const r2 = run(cwd, [join("plans", planId)]);
    assert.equal(r2.stdout.split("\n").filter((l) => /\[state-comment-anomaly\]/.test(l)).length, 0,
      `a code-span delimiter is PROSE, not a comment marker, got:\n${r2.stdout}`);
  });

  it("(ad) D-009/B4: bootstrap's state.md template holds NO example EXECUTE → REFLECT (raw counting cannot over-count a fresh plan)", async () => {
    // Read the template itself, not bootstrap's source shape: PLAN_TEMPLATES.state IS the
    // state.md skeleton. (Pre-extraction this regexed the inline writeFileSync literal, so it
    // broke the moment the literal moved — the template block is the thing under test, not
    // the call site's punctuation.)
    const { PLAN_TEMPLATES } = await import(`file://${BOOTSTRAP}`);
    const m = /## Transition History:\n([\s\S]*)$/.exec(PLAN_TEMPLATES.state);
    assert.ok(m, "could not locate bootstrap's state.md Transition History template block");
    assert.ok(!/EXECUTE\s*(?:→|->)\s*REFLECT/.test(m[1]),
      `B4 FALSIFIED: bootstrap's state.md template now contains an example EXECUTE → REFLECT, so the raw-counting cap (D-009) would over-count on EVERY fresh plan. Fix the template or re-open D-009. Template block:\n${m[1]}`);
  });

  // C5 — most-recent-only: 3 historical EXPLORE → PLAN cycles must not yield 3 WARNs.
  it("(z) #8: multiple historical EXPLORE → PLAN transitions → at most one [exploration-confidence] WARN", () => {
    const cwd = getTempDir();
    // Default writePlan history already holds one EXPLORE → PLAN (with confidence).
    // Append two more cycles; only the LAST one lacks the sub-line.
    const transitionHistory = [
      "- PIVOT → PLAN (cycle 2)",
      "- EXPLORE → PLAN (cycle 2, no confidence line)",
      "- EXPLORE → PLAN (cycle 3, no confidence line either)",
    ].join("\n");
    writePlan(cwd, { state: "EXECUTE", iteration: 1, transitionHistoryExtra: transitionHistory });
    const r = run(cwd);
    const warns = r.stdout.split("\n").filter((l) => /\[exploration-confidence\]/.test(l));
    assert.equal(warns.length, 1, `only the most recent EXPLORE → PLAN is actionable, got:\n${r.stdout}`);
  });

  // #12 — checkIterationLimits: iteration 5 is the decomposition-reminder
  // threshold → WARN [iteration], NOT ERROR. The hard cap is 6+ (covered by
  // (p)). Default writePlan transition history has zero EXECUTE → REFLECT lines,
  // so derived=0 and max(5,0)=5 lands exactly on the WARN branch.
  it("(u) #12: declared Iteration 5 (no derived transitions) → WARN [iteration], no ERROR [iteration]", () => {
    const cwd = getTempDir();
    writePlan(cwd, { state: "EXECUTE", iteration: 5 });
    const r = run(cwd);
    const lines = r.stdout.split("\n");
    // "WARN" is space-padded to align with "ERROR" in the render → match \s+.
    const iterWarns = lines.filter((l) => /WARN\s+\[iteration\]/.test(l));
    const iterErrs = lines.filter((l) => /ERROR\s+\[iteration\]/.test(l));
    assert.equal(iterErrs.length, 0, `iter=5 must NOT ERROR, got:\n${r.stdout}`);
    assert.ok(iterWarns.length >= 1, `expected WARN [iteration] at iter=5, got:\n${r.stdout}`);
    assert.ok(/Iteration 5/.test(iterWarns[0]), `WARN must reference Iteration 5, got: ${iterWarns[0]}`);
    assert.ok(/decomposition/.test(iterWarns[0]), `WARN must mention decomposition analysis, got: ${iterWarns[0]}`);
  });

  // OBS-010 / D-006 — checkCompressionMarkers must NOT count prose mentions.
  it("(r) OBS-010: prose mention of `<!-- COMPRESSED-SUMMARY -->` in plans/FINDINGS.md must NOT trigger compress-markers ERROR", () => {
    const cwd = getTempDir();
    writePlan(cwd, { state: "EXPLORE", iteration: 0 });
    // Write a FINDINGS.md with the marker text inside a backtick prose mention
    writeFileSync(join(cwd, "plans", "FINDINGS.md"),
`# Consolidated Findings

## plan_X
### Index
This plan describes the \`<!-- COMPRESSED-SUMMARY -->\` marker pattern.
Other prose: <!-- COMPRESSED-SUMMARY --> inside a sentence is still NOT a marker.
`);
    const r = run(cwd);
    const cmErrs = r.stdout.split("\n").filter((l) => /ERROR \[compress-markers\]/.test(l));
    assert.equal(cmErrs.length, 0, `prose mention must not trigger compress-markers ERROR, got:\n${r.stdout}`);
  });

  // OBS-010 / D-006 — a REAL standalone marker pair must still be accepted.
  it("(s) OBS-010: real on-its-own-line marker pair is detected as one valid block", () => {
    const cwd = getTempDir();
    writePlan(cwd, { state: "EXPLORE", iteration: 0 });
    writeFileSync(join(cwd, "plans", "FINDINGS.md"),
`# Consolidated Findings

<!-- COMPRESSED-SUMMARY -->
## Summary (compressed)
Lookup table here.
<!-- /COMPRESSED-SUMMARY -->

## plan_X
real plan section
`);
    const r = run(cwd);
    const cmErrs = r.stdout.split("\n").filter((l) => /ERROR \[compress-markers\]/.test(l));
    assert.equal(cmErrs.length, 0, `real balanced marker pair must NOT error, got:\n${r.stdout}`);
  });

  // OBS-010 / D-006 — a real unbalanced marker MUST still trigger ERROR.
  it("(t) OBS-010: real unbalanced marker (open only, no close) still triggers ERROR", () => {
    const cwd = getTempDir();
    writePlan(cwd, { state: "EXPLORE", iteration: 0 });
    writeFileSync(join(cwd, "plans", "FINDINGS.md"),
`# Consolidated Findings

<!-- COMPRESSED-SUMMARY -->
## Summary (compressed)
no close marker

## plan_X
real plan section
`);
    const r = run(cwd);
    const cmErrs = r.stdout.split("\n").filter((l) => /ERROR \[compress-markers\]/.test(l));
    assert.ok(cmErrs.length >= 1, `real unbalanced marker must still ERROR, got:\n${r.stdout}`);
  });

  // v2.36.0 step 2 — the compression-block PLACEMENT check must see `## <plan-id>`
  // sections in BOTH grammars. Pre-fix it searched the literal `\n## plan_`, so a
  // misplaced block in a file whose sections are all new-format went unreported.
  const CM_WARN = /WARN\s+\[compress-markers\]/;

  it("(u) compression block placed AFTER a LEGACY `## plan_` section → WARN", () => {
    const cwd = getTempDir();
    writePlan(cwd, { state: "EXPLORE", iteration: 0 });
    writeFileSync(join(cwd, "plans", "FINDINGS.md"),
`# Consolidated Findings

## plan_2026-01-01_deadbeef
real plan section

<!-- COMPRESSED-SUMMARY -->
## Summary (compressed)
misplaced — must sit above the first plan section
<!-- /COMPRESSED-SUMMARY -->
`);
    const r = run(cwd);
    const warns = r.stdout.split("\n").filter((l) => CM_WARN.test(l));
    assert.ok(warns.length >= 1, `misplaced block (legacy grammar) must WARN, got:\n${r.stdout}`);
  });

  it("(v) compression block placed AFTER a NEW-format `## plan-…T…` section → WARN", () => {
    const cwd = getTempDir();
    writePlan(cwd, { state: "EXPLORE", iteration: 0 });
    writeFileSync(join(cwd, "plans", "FINDINGS.md"),
`# Consolidated Findings

## plan-2026-01-01T000000-deadbeef
real plan section

<!-- COMPRESSED-SUMMARY -->
## Summary (compressed)
misplaced — must sit above the first plan section
<!-- /COMPRESSED-SUMMARY -->
`);
    const r = run(cwd);
    const warns = r.stdout.split("\n").filter((l) => CM_WARN.test(l));
    assert.ok(warns.length >= 1, `misplaced block (new grammar) must WARN, got:\n${r.stdout}`);
  });

  it("(w) correctly placed compression block → no WARN, for either grammar", () => {
    const cwd = getTempDir();
    writePlan(cwd, { state: "EXPLORE", iteration: 0 });
    writeFileSync(join(cwd, "plans", "FINDINGS.md"),
`# Consolidated Findings

<!-- COMPRESSED-SUMMARY -->
## Summary (compressed)
correctly placed
<!-- /COMPRESSED-SUMMARY -->

## plan-2026-01-02T000000-deadbeef
new-format section

## plan_2026-01-01_deadbeef
legacy section
`);
    const r = run(cwd);
    const warns = r.stdout.split("\n").filter((l) => CM_WARN.test(l));
    assert.equal(warns.length, 0, `correctly placed block must NOT warn, got:\n${r.stdout}`);
  });

  it("(h) negative regression: full validator without --pre-step never emits exit code 2", () => {
    const cwd = getTempDir();
    writePlan(cwd, {
      state: "PLAN",
      iteration: 99,
      fixAttemptsBody: Array.from({ length: 10 }, (_, i) => `- Step 2, attempt ${i + 1}: x`).join("\n"),
    });
    const r = run(cwd); // no --pre-step
    assert.notEqual(r.exitCode, 2, `exit code 2 is --pre-step-exclusive per D-004; full validator returned ${r.exitCode}\nstdout:\n${r.stdout}`);
    assert.ok(r.exitCode === 0 || r.exitCode === 1, `expected exit 0 or 1 from full validator, got ${r.exitCode}\nstdout:\n${r.stdout}`);
  });
});

// M7 — targeted negative-case tests for high-risk check functions that
// previously had only incidental (happy-path) integration coverage. Each
// builds a valid plan, corrupts ONE file, and asserts the specific [tag] fires.
describe("validate-plan.mjs — M7: targeted check-function coverage", () => {
  let tempDirs = [];
  function getTempDir() { const d = makeTempDir(); tempDirs.push(d); return d; }
  afterEach(() => { for (const d of tempDirs) removeTempDir(d); tempDirs = []; });

  it("checkChangelogFormat: bad timestamp field → WARN [changelog-malformed]", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    writeFileSync(join(planDir, "changelog.md"),
      "# Changelog\n*note*\nNOTATIME | iter-1/step-1 | abc1234 | f.js | EDIT(+1,-0) | radius:LOW(1) | - | a reason\n");
    const r = run(cwd);
    assert.match(r.stdout, /\[changelog-malformed\]/, `expected changelog-malformed, got:\n${r.stdout}`);
    // v2.33.0: the WORDING moved from the deleted inline TS regex ("bad timestamp") to schema.mjs's
    // iso-datetime type. Same severity, same slug, same line — only the message got more specific.
    assert.match(r.stdout, /attribute "ts" .*ISO-8601/);
  });

  it("checkChangelogFormat: well-formed line (pipe in reason) does NOT warn", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    writeFileSync(join(planDir, "changelog.md"),
      "# Changelog\n*note*\n2026-05-30T10:00:00Z | iter-1/step-1 | abc1234 | f.js | EDIT(+1,-0) | radius:LOW(1) | - | fix race: a | b\n");
    const r = run(cwd);
    assert.doesNotMatch(r.stdout, /\[changelog-malformed\]/, `clean line must not warn, got:\n${r.stdout}`);
  });

  it("checkPresentationContractLog: PLAN→EXECUTE without PC-PLAN → WARN [presentation-contract-unlogged]", () => {
    const cwd = getTempDir();
    writePlan(cwd); // default state.md has PLAN → EXECUTE, no PC-PLAN anywhere
    const r = run(cwd);
    assert.match(r.stdout, /\[presentation-contract-unlogged\]/, `expected unlogged-contract WARN, got:\n${r.stdout}`);
  });

  it("checkPresentationContractLog: PC-PLAN reference present → no WARN", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    // Append a PC-PLAN reference to decisions.md (one of the scanned files).
    writeFileSync(join(planDir, "decisions.md"),
      `# Decision Log\n*Plan: plan_2026-05-15_aaaabbbb*\n*Append-only.*\n\nPC-PLAN emitted to user before approval.\n\n## D-001 | EXPLORE → PLAN | 2026-05-15\n**Context**: fixture.\n**Decision**: fixture.\n**Trade-off**: a **at the cost of** b.\n**Reasoning**: fixture.\n**Anchor-Refs**: (none yet)\n`);
    const r = run(cwd);
    assert.doesNotMatch(r.stdout, /\[presentation-contract-unlogged\]/, `PC-PLAN present must suppress WARN, got:\n${r.stdout}`);
  });

  it("checkComplexityBudget: placeholder budget in EXECUTE → WARN [complexity]", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    writeFileSync(join(planDir, "plan.md"),
      "# Plan v1\n## Goal\nx\n## Success Criteria\n- SC1\n## Complexity Budget\n*To be defined during PLAN.*\n");
    const r = run(cwd);
    assert.match(r.stdout, /\[complexity\]/, `expected complexity WARN, got:\n${r.stdout}`);
  });

  // -------------------------------------------------------------------------
  // Defect #5 (iter-1/step-5): numeric Complexity Budget enforcement.
  // WARN-only, suppressed by an explicit "(justified: ...)" suffix.
  // -------------------------------------------------------------------------

  /** Overwrite plan.md with a minimal plan carrying the given Complexity Budget body. */
  function writeBudget(planDir, budgetBody) {
    writeFileSync(join(planDir, "plan.md"),
      `# Plan v1\n## Goal\nx\n## Success Criteria\n- SC1\n## Complexity Budget\n${budgetBody}\n`);
  }

  it("checkComplexityBudget: over budget without justification → WARN [budget-exceeded]", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    writeBudget(planDir, "- Files added: 7/3 max\n- New abstractions (classes/modules/interfaces): 1/2 max\n- Lines added vs removed: +45/-12 (target: net negative or neutral)");
    const r = run(cwd);
    const hits = (r.stdout.match(/\[budget-exceeded\]/g) || []).length;
    assert.equal(hits, 1, `expected exactly one budget-exceeded WARN, got:\n${r.stdout}`);
    assert.match(r.stdout, /WARN\s+\[budget-exceeded\]: Complexity Budget exceeded: Files added 7\/3 max/);
  });

  it("checkComplexityBudget: over budget WITH (justified: ...) → no WARN", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    writeBudget(planDir, "- Files added: 7/3 max (justified: reason here)");
    const r = run(cwd);
    assert.doesNotMatch(r.stdout, /\[budget-exceeded\]/, `justification must suppress the WARN, got:\n${r.stdout}`);
  });

  it("checkComplexityBudget: under budget → no WARN", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    writeBudget(planDir, "- Files added: 2/3 max\n- New abstractions (classes/modules/interfaces): 2/2 max");
    const r = run(cwd);
    assert.doesNotMatch(r.stdout, /\[budget-exceeded\]/, `2/3 and 2/2 are within budget, got:\n${r.stdout}`);
  });

  it("checkComplexityBudget: abstractions over budget → WARN [budget-exceeded]", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    writeBudget(planDir, "- Files added: 1/3 max\n- New abstractions (classes/modules/interfaces): 3/2 max");
    const r = run(cwd);
    assert.match(r.stdout, /\[budget-exceeded\]/, `expected abstractions WARN, got:\n${r.stdout}`);
    assert.match(r.stdout, /New abstractions 3\/2 max/);
  });

  it("checkComplexityBudget: real-world bold + backticked-justification shape (this plan's own budget) → no WARN", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    // Byte-shape lifted from plans/plan_2026-07-14_79ee0f59/plan.md: bold label,
    // em-dash, justification in backticks. Both lines must be parsed, neither must WARN.
    writeBudget(planDir,
      "- **Files added: 8/3 max** — `(justified: 4 source + 4 test — each with the repo-mandated sibling test file.)`\n" +
      "- **New abstractions (classes/modules/interfaces): 2/2 max** — both earned under the >=2-call-site rule.\n" +
      "- **Lines added vs removed: target +900/-150 (net +750)** — explicitly not net-neutral.");
    const r = run(cwd);
    assert.doesNotMatch(r.stdout, /\[budget-exceeded\]/, `justified 8/3 + at-cap 2/2 must be silent, got:\n${r.stdout}`);
  });

  it("checkComplexityBudget: bold over-budget line WITHOUT justification still WARNs", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    writeBudget(planDir, "- **Files added: 8/3 max** — because the plan is big.");
    const r = run(cwd);
    assert.match(r.stdout, /\[budget-exceeded\]/, `bold shape must still be parsed, got:\n${r.stdout}`);
  });

  it("checkComplexityBudget: malformed/absent budget lines → no crash, no WARN", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    writeBudget(planDir, "- Files added: many/few max\n- New abstractions: TBD\n- Lines added vs removed: +9999/-1\n- Files: 0/3");
    const r = run(cwd);
    assert.doesNotMatch(r.stdout, /\[budget-exceeded\]/, `unparseable numbers must be ignored, got:\n${r.stdout}`);
    assert.ok(r.exitCode === 0 || r.exitCode === 1, `validator must not crash, exit=${r.exitCode}\n${r.stderr}`);
  });

  it("checkComplexityBudget: budget-exceeded is WARN-only — never an ERROR, never changes the exit code", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    // Baseline: same fixture, within budget.
    writeBudget(planDir, "- Files added: 1/3 max");
    const before = run(cwd);
    assert.doesNotMatch(before.stdout, /\[budget-exceeded\]/);
    // Only the budget numbers change.
    writeBudget(planDir, "- Files added: 7/3 max");
    const after = run(cwd);
    assert.match(after.stdout, /WARN\s+\[budget-exceeded\]/);
    assert.doesNotMatch(after.stdout, /ERROR \[budget-exceeded\]/, `must never be an ERROR, got:\n${after.stdout}`);
    assert.equal(after.exitCode, before.exitCode,
      `going over budget must not change the exit code (${before.exitCode} → ${after.exitCode}):\n${after.stdout}`);
  });

  it("checkComplexityBudget: --pre-step gate is unaffected by an over-budget plan", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    writeBudget(planDir, "- Files added: 99/3 max");
    const r = run(cwd, "--pre-step");
    assert.equal(r.exitCode, 0, `pre-step must stay PASS, got exit=${r.exitCode}:\n${r.stdout}`);
    assert.match(r.stdout, /^GATE:PASS/m);
    assert.doesNotMatch(r.stdout, /budget/i);
  });

  it("checkComplexityBudget: placeholder budget → [complexity] WARN only, never [budget-exceeded]", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    writeBudget(planDir, "*To be defined during PLAN.*");
    const r = run(cwd);
    assert.match(r.stdout, /\[complexity\]/, `placeholder check must still fire, got:\n${r.stdout}`);
    assert.doesNotMatch(r.stdout, /\[budget-exceeded\]/);
  });

  it("checkComplexityBudget: PLAN state (pre-EXECUTE) → budget not yet enforced", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd, { state: "PLAN" });
    writeBudget(planDir, "- Files added: 7/3 max");
    const r = run(cwd);
    assert.doesNotMatch(r.stdout, /\[budget-exceeded\]/, `budget is only enforced from EXECUTE onward, got:\n${r.stdout}`);
  });

  it("checkVerificationEvidence: weak Evidence cell → WARN [evidence]", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    writeFileSync(join(planDir, "verification.md"),
      "# Verification\n## Criteria Verification\n| # | Criterion | Method | Command | Result | Evidence |\n|---|---|---|---|---|---|\n| 1 | SC1 | run | true | PASS | lgtm |\n## Verdict\n- Recommendation: continue\n");
    const r = run(cwd);
    assert.match(r.stdout, /\[evidence\]/, `expected evidence WARN, got:\n${r.stdout}`);
    assert.match(r.stdout, /weak Evidence/);
  });
});

// ---------------------------------------------------------------------------
// Producer/validator parity: the validator must accept the intra-plan
// compression artifacts that bootstrap.mjs (maybeCompress*) itself writes, and
// the idempotent CLOSE→CLOSE transition that cmdClose can leave on legacy
// state.md files. Regression guards for review findings B1, B3, B2.
// ---------------------------------------------------------------------------
describe("validate-plan.mjs accepts bootstrap compression + idempotent-close artifacts", () => {
  let tempDirs = [];
  function getTempDir() { const d = makeTempDir(); tempDirs.push(d); return d; }
  afterEach(() => { for (const d of tempDirs) removeTempDir(d); tempDirs = []; });

  it("B1: COMPRESSED-SUMMARY block in decisions.md is not parsed as a decision entry", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    // decisions.md exactly as bootstrap.mjs maybeCompressDecisions writes it:
    // a <!-- COMPRESSED-SUMMARY --> block (whose body contains "## Summary
    // (compressed)" and "### Decision lookup" headings) above the raw entries.
    writeFileSync(join(planDir, "decisions.md"),
`# Decision Log
*Plan: plan_2026-05-15_aaaabbbb*
*Append-only.*

<!-- COMPRESSED-SUMMARY -->
<!-- entries-at-compress: 1 -->
<!-- entries-fingerprint: deadbeef -->
## Summary (compressed)
*Auto-compressed from 320 lines (1 entries). Raw entries preserved below.*

### Decision lookup
- D-001: fixture decision

### Things NOT to do (from PIVOT entries)
*(none)*

### Anchored decisions
*(none — no entries carry Anchor-Refs yet)*
<!-- /COMPRESSED-SUMMARY -->

## D-001 | EXPLORE → PLAN | 2026-05-15
**Context**: fixture.
**Decision**: fixture.
**Trade-off**: a **at the cost of** b.
**Reasoning**: fixture.
**Anchor-Refs**: (none yet)
`);
    const r = run(cwd);
    assert.doesNotMatch(r.stdout, /\[decisions-schema\]/,
      `compressed-summary block must not trigger decisions-schema error, got:\n${r.stdout}`);
    assert.doesNotMatch(r.stdout, /Summary \(compressed\)/,
      `"## Summary (compressed)" must not be reported as a non-conforming header, got:\n${r.stdout}`);
  });

  it("B3: inline `- (compressed: ...)` changelog line is not flagged as malformed", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    writeFileSync(join(planDir, "changelog.md"),
`# Changelog
*Append-only.*
- (compressed: 7 low-decision-impact edits from steps 1-3, radius LOW)
2026-05-15T11:50:00Z | iter-1/step-4 | abc1234 | src/foo.mjs | EDIT(+5,-2) | radius:LOW(3) | - | real edit
`);
    const r = run(cwd);
    assert.doesNotMatch(r.stdout, /\[changelog-malformed\]/,
      `inline compression summary line must be skipped, got:\n${r.stdout}`);
  });

  it("B2: CLOSE→CLOSE transition is accepted (idempotent re-close on legacy state.md)", () => {
    const cwd = getTempDir();
    writePlan(cwd, {
      state: "CLOSE",
      transitionHistoryExtra: [
        "- EXECUTE → REFLECT (phase ended, 2026-05-15T12:00:00Z)",
        "- REFLECT → CLOSE (all criteria met, 2026-05-15T12:10:00Z)",
        "- CLOSE → CLOSE (bootstrap close)",
      ].join("\n"),
    });
    const r = run(cwd);
    assert.doesNotMatch(r.stdout, /Invalid transition: CLOSE→CLOSE/,
      `CLOSE→CLOSE must be a valid (idempotent) transition, got:\n${r.stdout}`);
  });
});

// ---------------------------------------------------------------------------
// iter-1/step-11 — schema-driven changelog validation (D-001)
// ---------------------------------------------------------------------------
// The six field regexes that used to live inline in checkChangelogFormat are DELETED; the markdown
// changelog now validates through schema.mjs's CHANGELOG_SPEC. These tests are the "did not weaken"
// proof: every shape the six regexes rejected must still be rejected, and no changelog check may
// ever escalate past WARN.
//
// The changelog is MARKDOWN. The XML encoding briefly added in v2.33.0 was REVERTED in v2.35.0 (it
// replaced a one-line append with a whole-file read-modify-write and lost entries under
// concurrency). The schema is what survived.
describe("validate-plan.mjs — changelog: schema-driven", () => {
  let tempDirs = [];
  function getTempDir() { const d = makeTempDir(); tempDirs.push(d); return d; }
  afterEach(() => { for (const d of tempDirs) removeTempDir(d); tempDirs = []; });

  const GOOD_LINE = '2026-05-30T10:00:00Z | iter-1/step-1 | abc1234 | f.js | EDIT(+1,-0) | radius:LOW(1) | - | fix race: a | b';
  const changelogLines = (stdout) => stdout.split("\n").filter((l) => /\[changelog-/.test(l));

  it("no changelog.md → the changelog is optional, zero changelog issues", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    rmSync(join(planDir, "changelog.md"), { force: true });
    const r = run(cwd);
    assert.deepEqual(changelogLines(r.stdout), [], `absent changelog must be silent, got:\n${r.stdout}`);
  });

  it("changelog.md, clean line → no changelog WARNs (unchanged verdict)", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    writeFileSync(join(planDir, "changelog.md"), `# Changelog\n*note*\n${GOOD_LINE}\n`);
    const r = run(cwd);
    assert.deepEqual(changelogLines(r.stdout), [], `clean legacy line must be silent, got:\n${r.stdout}`);
  });

  // C10 at the validator level: each of the SIX deleted regexes, one bad field at a time, through
  // the legacy markdown path. If any of these stops firing, the port silently weakened validation.
  const FIELD_CASES = [
    ["timestamp (TS regex)", 0, "NOTATIME", /attribute "ts"/],
    ["timestamp (calendar-impossible)", 0, "2026-13-45T99:99:99Z", /attribute "ts"/],
    ["step (STEP regex)", 1, "step-1", /attribute "step"/],
    ["commit (COMMIT regex)", 2, "xyz", /attribute "commit"/],
    ["path (empty)", 3, "   ", /attribute "path"/],
    ["op (OP regex)", 4, "MUTATE(+1)", /attribute "op"/],
    ["op (unanchored tail)", 4, "EDIT(+1,-0)trailing", /attribute "op"/],
    ["radius (RADIUS regex)", 5, "radius:HUGE(9)", /attribute "radius"/],
    ["radius (unanchored tail)", 5, "radius:LOW(2)trailing", /attribute "radius"/],
    ["decision-ref (DREF regex)", 6, "D-1", /attribute "dref"/],
    // NOTE: the 7th old regex-adjacent rule (`!reason.trim()` → "empty reason") has no LEGACY
    // fixture on purpose: the line is `.trim()`ed before splitting, so a trailing empty reason
    // collapses the 8th field away and the line is caught by the field-COUNT rule instead. That
    // was equally true of the deleted inline check — this is parity, not a weakening. The rule
    // itself is still enforced by the spec (schema.test.mjs covers it directly).
  ];

  for (const [label, idx, bad, messageRe] of FIELD_CASES) {
    it(`changelog.md: bad ${label} → WARN [changelog-malformed]`, () => {
      const cwd = getTempDir();
      const { planDir } = writePlan(cwd);
      const fields = ["2026-05-30T10:00:00Z", "iter-1/step-1", "abc1234", "f.js", "EDIT(+1,-0)", "radius:LOW(1)", "-", "a reason"];
      fields[idx] = bad;
      writeFileSync(join(planDir, "changelog.md"), `# Changelog\n${fields.join(" | ")}\n`);
      const r = run(cwd);
      assert.match(r.stdout, /WARN.*\[changelog-malformed\]/, `bad ${label} must still be rejected, got:\n${r.stdout}`);
      assert.match(r.stdout, messageRe, `expected the schema to name the offending field, got:\n${r.stdout}`);
      assert.notEqual(r.exitCode, 2);
    });
  }

  it("changelog.md: wrong field count → WARN [changelog-malformed] (encoding rule, not a field rule)", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    writeFileSync(join(planDir, "changelog.md"), "# Changelog\n2026-05-30T10:00:00Z | iter-1/step-1 | abc1234\n");
    const r = run(cwd);
    assert.match(r.stdout, /WARN.*\[changelog-malformed\].*expected 8 pipe-separated fields, got 3/, `got:\n${r.stdout}`);
  });

  it("changelog.md: D-1000 decision-ref is accepted (the shared D-005 grammar)", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    writeFileSync(join(planDir, "changelog.md"),
      "# Changelog\n2026-05-30T10:00:00Z | iter-1/step-1 | abc1234 | f.js | EDIT(+1,-0) | radius:LOW(1) | D-1000 | a reason\n");
    const r = run(cwd);
    assert.deepEqual(changelogLines(r.stdout), [], `D-1000 must parse, got:\n${r.stdout}`);
  });

  it("the six field regexes are DELETED from validate-plan.mjs (replaced, not duplicated)", () => {
    const src = readFileSync(VALIDATOR, "utf-8");
    for (const gone of ["const TS = ", "const STEP = ", "const COMMIT = ", "const OP = ", "const RADIUS = ", "const DREF = "]) {
      assert.ok(!src.includes(gone), `field regex \`${gone}\` is back in validate-plan.mjs — the schema is the single source of truth (D-001)`);
    }
    assert.ok(!/radius:\(LOW\|MED\|HIGH\)/.test(src), "the RADIUS regex body reappeared in validate-plan.mjs");
    assert.ok(!/CREATE\\\(\\\+/.test(src), "the OP regex body reappeared in validate-plan.mjs");
  });
});

// ---------------------------------------------------------------------------
// CRITICAL 3 (iter-2, D-010) — the decisions parser must not eat its own input.
//
// The deleted regex was `blankCompressedSummaryBlock(content).replace(/<!--[\s\S]*?-->/g, "")`.
// It was wrong twice: it DELETED lines (so every reported line number was offset by
// the size of any stripped comment), and it was blind to markdown code spans (so a
// backticked `<!--` written in PROSE opened a phantom span that ran to the next `-->`
// in a LATER entry, silently deleting everything between).
//
// RED-RUN EVIDENCE (recorded against a68d939, the pre-fix code, on this repo's own
// plans/plan_2026-07-14_79ee0f59/decisions.md):
//   ERROR [decisions-schema]: decisions.md D-NNN sequence broken at position 8: expected D-008, got D-010
//   ERROR [decisions-schema]: decisions.md D-007 (line 59) is a PIVOT entry but missing **Complexity Assessment** block
// Both FALSE. D-008 and D-009 exist (lines 84 and 91) — they were swallowed whole. D-007
// is at line 69, not 59, and its **Complexity Assessment** is present at line 80. The
// benign half is the two false ERRORs; the DANGEROUS half is that everything inside the
// phantom span was invisible to validation, so a genuinely missing field would have gone
// silently unreported. The check FAILED OPEN. The tests below pin both directions.
// ---------------------------------------------------------------------------

describe("decisions parser: code-span-aware, line-count-preserving (CRITICAL 3 / D-010)", () => {
  const tempDirs = [];
  function getTempDir() { const d = makeTempDir(); tempDirs.push(d); return d; }
  afterEach(() => { while (tempDirs.length) removeTempDir(tempDirs.pop()); });

  function schemaFindings(stdout) {
    return stdout.split("\n").filter((l) => /\[decisions-schema\]/.test(l));
  }

  /** Overwrite the fixture plan's decisions.md and run the validator. */
  function withDecisions(body) {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    writeFileSync(join(planDir, "decisions.md"), body);
    return { ...run(cwd), planDir, body };
  }

  // K6 — the reproduced shape: a PIVOT entry that DISCUSSES a backticked `<!--`, and a
  // later entry containing a backticked `-->`. Everything is schema-correct.
  const K6_BODY = `# Decision Log
*Plan: plan_2026-05-15_aaaabbbb*
*Append-only.*

## D-001 | EXPLORE → PLAN | 2026-05-15
**Context**: fixture.
**Decision**: fixture.
**Trade-off**: a **at the cost of** b.
**Reasoning**: fixture.

## D-002 | PIVOT | 2026-05-15
**Context**: the scrubber pairs a backticked \`<!--\` with a downstream closer.
**What Failed**: the naive regex.
**What Was Learned**: a delimiter in a code span is prose.
**Root Cause Analysis**: code-span blindness.
**Complexity Assessment**: no new files, no new abstractions.
**Decision**: mask code spans before pairing delimiters.
**Trade-off**: one shared primitive **at the cost of** a wider blast radius.
**Reasoning**: four divergent regexes produced this bug three times.

## D-003 | EXECUTE | 2026-05-15
**Context**: the closing delimiter \`-->\` is likewise prose here.
**Decision**: fixture.
**Trade-off**: a **at the cost of** b.
**Reasoning**: fixture.
`;

  it("K6: an entry that discusses `<!--` in a code span produces NO finding (was: 2 false ERRORs)", () => {
    const r = withDecisions(K6_BODY);
    assert.deepEqual(schemaFindings(r.stdout), [],
      "a decision entry writing ABOUT html comments must not trip the schema check");
  });

  it("K6: the phantom span does not hide the entries inside it (D-002 and D-003 are seen)", () => {
    // Pre-fix, the span from D-002's backticked opener to D-003's backticked closer
    // deleted D-002's Complexity Assessment AND swallowed entries whole — which is how
    // the real file produced a bogus "sequence broken ... got D-010".
    const r = withDecisions(K6_BODY);
    assert.ok(!/sequence broken/.test(r.stdout), "no entry may be swallowed");
  });

  it("K6: reported line numbers are EXACT (the old regex deleted lines and reported them offset)", () => {
    // A genuine violation, placed AFTER a real multi-line HTML comment. The old
    // line-DELETING scrub reported it short by the height of the comment.
    const body = `# Decision Log
*Plan: plan_2026-05-15_aaaabbbb*
*Append-only.*

<!-- Schema example — DO NOT REMOVE.
     line 6
     line 7
     line 8
## D-001 | EXPLORE → PLAN | YYYY-MM-DD
**Context**: <template, not a real entry>
-->

## D-001 | EXPLORE → PLAN | 2026-05-15
**Context**: fixture.
**Decision**: fixture.
**Reasoning**: fixture — this entry is genuinely missing its Trade-off line.
`;
    const r = withDecisions(body);
    const trueLine = body.split("\n").findIndex((l) => l.startsWith("## D-001 | EXPLORE → PLAN | 2026-05-15")) + 1;
    assert.equal(trueLine, 13, "sanity: the real D-001 header is on line 13 of the fixture");
    const finding = schemaFindings(r.stdout).find((l) => /Trade-off/.test(l));
    assert.ok(finding, `expected a missing-Trade-off finding, got: ${r.stdout}`);
    assert.match(finding, new RegExp(`\\(line ${trueLine}\\)`),
      `line number must equal the real line (${trueLine}); got: ${finding}`);
  });

  // K7 — THE FAIL-OPEN DIRECTION (the important one). Genuine violations positioned
  // INSIDE what the old regex would have swallowed must STILL be reported.
  // Cross-checked against a68d939: each of these produced NO finding there.
  it("K7: a genuinely missing **Trade-off** INSIDE the would-be-swallowed span is still reported", () => {
    const r = withDecisions(`# Decision Log
*Plan: plan_2026-05-15_aaaabbbb*
*Append-only.*

## D-001 | EXPLORE → PLAN | 2026-05-15
**Context**: this entry mentions a backticked \`<!--\` — the phantom opener.
**Decision**: fixture.
**Trade-off**: a **at the cost of** b.
**Reasoning**: fixture.

## D-002 | EXECUTE | 2026-05-15
**Context**: this entry sits INSIDE the span the old regex swallowed.
**Decision**: fixture.
**Reasoning**: fixture — no Trade-off line anywhere. This MUST be reported.

## D-003 | EXECUTE | 2026-05-15
**Context**: and this one supplies the phantom closer \`-->\`.
**Decision**: fixture.
**Trade-off**: a **at the cost of** b.
**Reasoning**: fixture.
`);
    const findings = schemaFindings(r.stdout);
    assert.ok(findings.some((l) => /D-002/.test(l) && /Trade-off/.test(l)),
      `D-002's missing Trade-off must be reported, not hidden. Got: ${findings.join(" | ") || "(none)"}`);
  });

  it("K7: a genuinely broken D-NNN sequence INSIDE the swallowed span is still reported", () => {
    const r = withDecisions(`# Decision Log
*Plan: plan_2026-05-15_aaaabbbb*
*Append-only.*

## D-001 | EXPLORE → PLAN | 2026-05-15
**Context**: phantom opener here: \`<!--\`
**Decision**: fixture.
**Trade-off**: a **at the cost of** b.
**Reasoning**: fixture.

## D-005 | EXECUTE | 2026-05-15
**Context**: the id jumps 001 -> 005. Phantom closer: \`-->\`
**Decision**: fixture.
**Trade-off**: a **at the cost of** b.
**Reasoning**: fixture.
`);
    assert.match(r.stdout, /sequence broken/,
      "a real gap in the D-NNN sequence must survive the scrub");
  });

  it("K7: a PIVOT genuinely missing **Complexity Assessment** INSIDE the span is still reported", () => {
    const r = withDecisions(`# Decision Log
*Plan: plan_2026-05-15_aaaabbbb*
*Append-only.*

## D-001 | EXPLORE → PLAN | 2026-05-15
**Context**: phantom opener: \`<!--\`
**Decision**: fixture.
**Trade-off**: a **at the cost of** b.
**Reasoning**: fixture.

## D-002 | PIVOT | 2026-05-15
**Context**: a real PIVOT entry with NO Complexity Assessment block.
**Decision**: fixture.
**Trade-off**: a **at the cost of** b.
**Reasoning**: phantom closer: \`-->\`
`);
    assert.match(r.stdout, /D-002 \(line \d+\) is a PIVOT entry but missing \*\*Complexity Assessment\*\*/,
      "a real PIVOT entry missing its Complexity Assessment must survive the scrub");
  });

  // K8 — the scrub must still do its ORIGINAL job. Over-masking (Pre-Mortem #2) would
  // leave a REAL comment visible, and bootstrap's schema example would then parse as a
  // phantom D-001 entry.
  it("K8: bootstrap's real <!-- schema example --> still does NOT register as an entry", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    // Use the SHAPE bootstrap actually writes: a comment containing a `## D-001` heading.
    writeFileSync(join(planDir, "decisions.md"), `# Decision Log
*Plan: plan_2026-05-15_aaaabbbb*
*Append-only. Never edit past entries.*

<!-- Schema example — DO NOT REMOVE. Real entries follow this shape.
     In-code anchors carry the plan-id prefix: \`# DECISION plan_2026-05-15_aaaabbbb/D-NNN\`.

## D-001 | EXPLORE → PLAN | YYYY-MM-DD
**Context**: <one-paragraph background>
**Decision**: <chosen approach>
**Trade-off**: <X> **at the cost of** <Y>
**Reasoning**: <why>
-->

## D-001 | EXPLORE → PLAN | 2026-05-15
**Context**: the one real entry.
**Decision**: fixture.
**Trade-off**: a **at the cost of** b.
**Reasoning**: fixture.
`);
    const r = run(cwd);
    // The template's `YYYY-MM-DD` header would be a BAD header, and its D-001 would
    // collide with the real D-001, if the comment were not scrubbed. Note the comment
    // body contains a backticked span — masking must not stop it being a comment.
    assert.deepEqual(schemaFindings(r.stdout), [],
      `the schema example must stay invisible. Got: ${r.stdout}`);
  });
});

// ---------------------------------------------------------------------------
// transitionHistoryBlock: the heading is a LINE, not a substring (D-010).
//
// Found while fixing CRITICAL 3: the block was located with a raw
// `stripped.indexOf("## Transition History:")`, which also matches the heading's own
// NAME quoted mid-line in prose. This repo's own state.md Change Manifest quotes it
// verbatim, so the block began ~45 lines early, at the Change Manifest. Two bugs were
// cancelling out: the code-span-blind comment scrub was blanking the very lines that
// the early block start had wrongly included. Fixing CRITICAL 3 alone unmasked it —
// measured live: 14 prose lines scanned as transition records (7 bogus [transition]
// ERRORs), and the iteration hard-cap counter derived 0 from 3 real records.
// ---------------------------------------------------------------------------

describe("transitionHistoryBlock: heading matched at line start (D-010)", () => {
  const tempDirs = [];
  function getTempDir() { const d = makeTempDir(); tempDirs.push(d); return d; }
  afterEach(() => { while (tempDirs.length) removeTempDir(tempDirs.pop()); });

  it("a prose mention of the heading mid-line does not start the block early", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    // A Change Manifest note quoting the heading inside a code span — verbatim the
    // shape from this repo's real state.md — plus a prose line carrying an arrow.
    writeFileSync(join(planDir, "state.md"), `# Current State: EXECUTE
## Iteration: 1
## Current Plan Step: 1 of 5
## Pre-Step Checklist (reset before each EXECUTE step)
- [ ] Re-read state.md (this file)
## Fix Attempts (resets per plan step)
- (none yet for current step)
## Change Manifest (current iteration)
- [x] step-4 — all raw \`state.indexOf("## Transition History:")\` scans replaced.
- NOTE: a stray opener would erase real \`EXECUTE → REFLECT\` records. Not a transition.
## Last Transition: PLAN → EXECUTE (2026-05-15T11:45:00Z)
## Transition History:
- INIT → EXPLORE (task started, 2026-05-15T10:53:44Z)
- EXPLORE → PLAN (gathered enough context, 2026-05-15T11:30:00Z)
  - confidence: scope=deep, solutions=adequate, risks=clear
- PLAN → EXECUTE (user approved, 2026-05-15T11:45:00Z)
`);
    const r = run(cwd);
    assert.ok(!/\[transition\]/.test(r.stdout),
      `Change Manifest prose must not be scanned as transition records. Got: ${r.stdout}`);
  });

  it("the iteration hard cap still counts real EXECUTE → REFLECT records (cannot under-count to 0)", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd, { iteration: 1 });
    // 6 real records + a Change Manifest that quotes the heading in prose. Pre-fix the
    // block started at the Change Manifest and the derived count came out wrong; the
    // hard-cap ERROR must fire regardless of the (stale) `## Iteration: 1` declaration.
    const records = Array.from({ length: 6 }, (_, i) => `- EXECUTE → REFLECT (iteration ${i + 1})`).join("\n");
    writeFileSync(join(planDir, "state.md"), `# Current State: EXECUTE
## Iteration: 1
## Current Plan Step: 1 of 5
## Pre-Step Checklist (reset before each EXECUTE step)
- [ ] Re-read state.md (this file)
## Fix Attempts (resets per plan step)
- (none yet for current step)
## Change Manifest (current iteration)
- NOTE: raw \`state.indexOf("## Transition History:")\` scans replaced.
## Last Transition: PLAN → EXECUTE (2026-05-15T11:45:00Z)
## Transition History:
- INIT → EXPLORE (task started, 2026-05-15T10:53:44Z)
- EXPLORE → PLAN (gathered enough context, 2026-05-15T11:30:00Z)
  - confidence: scope=deep, solutions=adequate, risks=clear
- PLAN → EXECUTE (user approved, 2026-05-15T11:45:00Z)
${records}
`);
    const r = run(cwd);
    assert.match(r.stdout, /exceeds hard limit \(6\+\)/,
      `the hard cap must see all 6 real records. Got: ${r.stdout}`);
  });
});
