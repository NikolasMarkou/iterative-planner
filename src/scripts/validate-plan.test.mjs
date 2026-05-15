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
function writePlan(cwd, { state = "EXECUTE", iteration = 1, currentStep = "1 of 5", fixAttemptsBody = "- (none yet for current step)", fixAttemptsHeading = "## Fix Attempts (resets per plan step)" } = {}) {
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
