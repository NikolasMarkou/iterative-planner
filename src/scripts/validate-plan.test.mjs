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
    const planId = readdirSync(join(cwd, "plans")).find((d) => d.startsWith("plan_"));
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
    const planId = readdirSync(join(cwd, "plans")).find((d) => d.startsWith("plan_"));
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

  // C5(c) — the safety pin. Comment-stripping must remove ONLY template text: with the
  // guidance comment present AND 7 real EXECUTE → REFLECT transitions, the iteration
  // hard cap must still ERROR. Over-stripping here would silently disable the cap.
  it("(x) #8: guidance comment present + 7 real EXECUTE → REFLECT transitions → iteration hard cap still ERRORs (derived=7)", () => {
    const cwd = getTempDir();
    const transitionHistory = [
      "<!-- When logging EXPLORE → PLAN, add Exploration Confidence on the line below, e.g.:",
      "- EXPLORE → PLAN (gathered enough context, YYYY-MM-DDTHH:MM:SSZ)",
      "  - confidence: scope=deep|partial|shallow, solutions=adequate|thin, risks=clear|unclear",
      "- EXECUTE → REFLECT (example inside the comment — must NOT be counted)",
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
    // derived=7, not 8 — the commented example transition was stripped, the 7 real ones were not.
    assert.ok(/derived=7/.test(iterErrs[0]), `expected derived=7 (comment example not counted), got: ${iterErrs[0]}`);
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
