#!/usr/bin/env node
// Tests for validate-plan.mjs using Node.js built-in test runner.
// Run: node --test src/scripts/validate-plan.test.mjs
// Requires: Node.js 18+
//
// Scope (step 1 of plan_2026-05-15_71ab18dd): only the checkLeashCount regex
// reconciliation. Step 11 expands this suite for the --pre-step gate.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join, resolve } from "path";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { randomBytes } from "crypto";

const VALIDATOR = resolve(import.meta.dirname, "validate-plan.mjs");

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
    assert.match(r.stdout, /bad timestamp/);
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
