#!/usr/bin/env node
// Tests for validate-plan.mjs using Node.js built-in test runner.
// Run: node --test src/scripts/validate-plan.test.mjs
// Requires: Node.js 18+
//
// Scope (step 1 of plan_2026-05-15_71ab18dd): only the checkLeashCount regex
// reconciliation. Step 11 expands this suite for the --pre-step gate.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, appendFileSync, rmSync, readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { randomBytes } from "crypto";

const VALIDATOR = resolve(import.meta.dirname, "validate-plan.mjs");
// Import-safe: validate-plan.mjs's CLI dispatch is guarded by isEntryPoint.
import { collectKnownDecisionIdsByPlan, ANCHOR_SOURCE_EXTS, HTML_STYLE_EXTS } from "./validate-plan.mjs";
import { BLOCK_COMMENT_EXTS } from "./shared.mjs";
import { ANCHOR_SOURCE_EXTS as BOOTSTRAP_ANCHOR_SOURCE_EXTS } from "./bootstrap.mjs";
// Import-safe: bootstrap.mjs's CLI dispatch is guarded by isEntryPoint. The
// verdict fixtures use bootstrap's REAL `verification` template, not a copy.
import { PLAN_TEMPLATES } from "./bootstrap.mjs";
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
export function writePlan(cwd, { state = "EXECUTE", iteration = 1, currentStep = "1 of 5", fixAttemptsBody = "- (none yet for current step)", fixAttemptsHeading = "## Fix Attempts (resets per plan step)", transitionHistoryExtra = null } = {}) {
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

  // C2 (iter-1/step-6.1) — the counting regex required `Step <digits>` followed by
  // `,` or space, so the `step-N.M` completion-fix numbering that CLAUDE.md mandates
  // and ip-orchestrator.md mints was invisible to BOTH leash tiers. Reproduced by the
  // reviewer end-to-end; these four lock the retrospective-audit half.
  it("C2: sub-step numbering `- Step 9.1, attempt M` (3 attempts) → WARN [leash]", () => {
    const cwd = getTempDir();
    writePlan(cwd, {
      fixAttemptsBody: [
        "- Step 9.1, attempt 1: tried X — failed",
        "- Step 9.1, attempt 2: tried Y — failed",
        "- Step 9.1, attempt 3: tried Z — failed",
      ].join("\n"),
    });
    const r = run(cwd);
    const lines = leashLines(r.stdout);
    assert.ok(lines.some((l) => /WARN/.test(l)), `expected WARN [leash] for sub-step numbering, got:\n${r.stdout}`);
    assert.ok(!lines.some((l) => /ERROR/.test(l)), `unexpected ERROR [leash] at 3 attempts, got:\n${r.stdout}`);
  });

  it("C2: sub-step numbering (4 attempts) → ERROR [leash], identical to the plain-integer form", () => {
    const cwd = getTempDir();
    const body = (step) => [1, 2, 3, 4].map((n) => `- Step ${step}, attempt ${n}: a`).join("\n");
    writePlan(cwd, { fixAttemptsBody: body("9.1") });
    const r = run(cwd);
    assert.ok(leashLines(r.stdout).some((l) => /ERROR/.test(l)), `expected ERROR [leash] for 4 sub-step attempts, got:\n${r.stdout}`);

    // previously-clean-stays-clean: the plain-integer form must behave identically.
    const cwd2 = getTempDir();
    writePlan(cwd2, { fixAttemptsBody: body("9") });
    const r2 = run(cwd2);
    assert.ok(leashLines(r2.stdout).some((l) => /ERROR/.test(l)), `plain-integer form regressed, got:\n${r2.stdout}`);
  });

  // Decided behavior: the step-number fragment is `\d+(?:\.\d+)*`, one quantifier
  // looser than schema.mjs's STEP_RE. An unforeseen deeper nesting is COUNTED —
  // over-counting an odd shape is the fail-safe direction for a safety cap.
  it("C2: deeper nesting `- Step 9.1.2, attempt M` (4 attempts) is COUNTED → ERROR [leash]", () => {
    const cwd = getTempDir();
    writePlan(cwd, {
      fixAttemptsBody: [1, 2, 3, 4].map((n) => `- Step 9.1.2, attempt ${n}: a`).join("\n"),
    });
    const r = run(cwd);
    assert.ok(leashLines(r.stdout).some((l) => /ERROR/.test(l)), `expected deeper nesting to be counted, got:\n${r.stdout}`);
  });

  it("C2: the `- Step N.M: LEASH HIT` summary line is still NOT counted as an attempt", () => {
    const cwd = getTempDir();
    writePlan(cwd, {
      fixAttemptsBody: [
        "- Step 6.1: LEASH HIT via pre-step gate. Transitioned to REFLECT.",
        "- Step 6.1: LEASH HIT via pre-step gate. Transitioned to REFLECT.",
        "- Step 6.1: LEASH HIT via pre-step gate. Transitioned to REFLECT.",
        "- Step 6.1: LEASH HIT via pre-step gate. Transitioned to REFLECT.",
      ].join("\n"),
    });
    const r = run(cwd);
    assert.equal(leashLines(r.stdout).length, 0, `LEASH HIT lines must not be counted as attempts, got:\n${r.stdout}`);
  });
});

// ---------------------------------------------------------------------------
// W10 (iter-1/step-6.1) — checkFindings counted only bullets and numbered lines
// under ## Index, so a TABLE index (four resolvable rows) was reported as
// "Only 0 indexed findings". The findings.md template's Index body is just
// "*To be populated during EXPLORE.*" — no protocol file instructs bullets-only —
// so the table was conformant output and the validator was wrong.
// ---------------------------------------------------------------------------
describe("validate-plan.mjs findings Index shapes (W10)", () => {
  let tempDirs = [];
  function getTempDir() { const d = makeTempDir(); tempDirs.push(d); return d; }
  afterEach(() => { for (const d of tempDirs) removeTempDir(d); tempDirs = []; });

  /** Only the "N indexed findings" WARN — other [findings] checks are out of scope here. */
  function indexWarns(stdout) {
    return stdout.split("\n").filter((l) => /\[findings\]/.test(l) && /indexed findings/.test(l));
  }

  function withIndex(cwd, indexBody) {
    const { planDir } = writePlan(cwd, { state: "EXECUTE" });
    writeFileSync(join(planDir, "findings.md"),
`# Findings

## Index
${indexBody}

## Key Constraints
- fixture constraint
`);
    return planDir;
  }

  it("bullet Index (3 items) → no indexed-findings WARN", () => {
    const cwd = getTempDir();
    withIndex(cwd, [
      "- [F1](findings/f1.md) — fixture",
      "- [F2](findings/f2.md) — fixture",
      "- [F3](findings/f3.md) — fixture",
    ].join("\n"));
    const r = run(cwd);
    assert.equal(indexWarns(r.stdout).length, 0, `bullet Index must not warn, got:\n${r.stdout}`);
  });

  it("numbered Index (3 items) → no indexed-findings WARN", () => {
    const cwd = getTempDir();
    withIndex(cwd, [
      "1. [F1](findings/f1.md) — fixture",
      "2. [F2](findings/f2.md) — fixture",
      "3. [F3](findings/f3.md) — fixture",
    ].join("\n"));
    const r = run(cwd);
    assert.equal(indexWarns(r.stdout).length, 0, `numbered Index must not warn, got:\n${r.stdout}`);
  });

  it("table Index (4 rows, this plan's own shape) → no indexed-findings WARN", () => {
    const cwd = getTempDir();
    withIndex(cwd, [
      "| ID | Topic | File | Headline |",
      "|----|-------|------|----------|",
      "| F-01 | Core runtime scripts | `findings/f1.md` | fixture |",
      "| F-02 | Gate scripts | `findings/f2.md` | fixture |",
      "| F-03 | Protocol coherence | `findings/f3.md` | fixture |",
      "| F-04 | End-to-end lifecycle | `findings/f4.md` | fixture |",
    ].join("\n"));
    const r = run(cwd);
    assert.equal(indexWarns(r.stdout).length, 0, `table Index must not warn, got:\n${r.stdout}`);
  });

  it("table Index with only 2 data rows → still WARNs, and the header/separator rows are not counted", () => {
    const cwd = getTempDir();
    withIndex(cwd, [
      "| ID | Topic | File | Headline |",
      "|----|-------|------|----------|",
      "| F-01 | Core runtime scripts | `findings/f1.md` | fixture |",
      "| F-02 | Gate scripts | `findings/f2.md` | fixture |",
    ].join("\n"));
    const r = run(cwd);
    const warns = indexWarns(r.stdout);
    assert.equal(warns.length, 1, `a 2-row table Index must still warn, got:\n${r.stdout}`);
    assert.match(warns[0], /Only 2 indexed findings/, `header + separator rows must not be counted, got:\n${warns[0]}`);
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

  // C2 (iter-1/step-6.1) — the reviewer's end-to-end reproduction, verbatim: three
  // canonical `- Step 9.1, attempt N:` lines returned GATE:PASS/exit 0, while the same
  // file with `9.1` rewritten to `9` returned GATE:FAIL [leash-cap] attempts=3 cap=2.
  // The HARD gate was off for exactly the loop the protocol mandates.
  it("(k) C2: FAIL [leash-cap] — 3 sub-step `- Step 9.1, attempt N` lines → exit 2, attempts=3", () => {
    const cwd = getTempDir();
    const body = (step) => [1, 2, 3].map((n) => `- Step ${step}, attempt ${n}: tried X — failed`).join("\n");
    writePlan(cwd, { state: "EXECUTE", fixAttemptsBody: body("9.1") });
    const r = runPreStep(cwd);
    assert.equal(r.exitCode, 2, `expected exit 2 for sub-step numbering, got ${r.exitCode}\nstdout:\n${r.stdout}`);
    assert.ok(r.stdout.trim().startsWith("GATE:FAIL [leash-cap]"), `expected GATE:FAIL [leash-cap], got:\n${r.stdout}`);
    assert.ok(/attempts=3 cap=2/.test(r.stdout), `expected attempts=3 cap=2, got:\n${r.stdout}`);

    // The plain-integer file must return the identical verdict (it already did).
    const cwd2 = getTempDir();
    writePlan(cwd2, { state: "EXECUTE", fixAttemptsBody: body("9") });
    const r2 = runPreStep(cwd2);
    assert.equal(r2.exitCode, r.exitCode, `sub-step and plain-integer verdicts must match`);
    assert.equal(r2.stdout.trim(), r.stdout.trim(), `sub-step and plain-integer output must match`);
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

  // T-01 / D-002 — the REFLECT → EXECUTE same-iteration completion-fix edge is a
  // LEGAL transition. A Transition-History line recording it must produce ZERO
  // [transition] issues (adjacency is permitted in VALID_TRANSITIONS; the narrow
  // completion-fix trigger is enforced by prose, not the validator).
  it("(r) T-01: REFLECT → EXECUTE completion-fix transition → zero [transition] ERRORs", () => {
    const cwd = getTempDir();
    const transitionHistory = [
      "- EXECUTE → REFLECT (phase ended)",
      "- REFLECT → EXECUTE (same-iteration completion-fix remediation, 2026-07-15T05:00:00Z)",
    ].join("\n");
    writePlan(cwd, { state: "EXECUTE", iteration: 1, transitionHistoryExtra: transitionHistory });
    const r = run(cwd);
    const transitionErrs = r.stdout.split("\n").filter((l) => /\[transition\]/.test(l));
    assert.equal(transitionErrs.length, 0, `REFLECT→EXECUTE must be a legal transition, got:\n${transitionErrs.join("\n")}`);
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

  // Iteration-trust gap regression (iter-1/steps 1-2 of this plan): a declared
  // `## Iteration:` field that understates the real Transition History must not
  // let either the --pre-step HARD gate or the full validator's checkCheckpoints
  // WARN be silently bypassed. Both must read max(declared, derived), exactly
  // like checkIterationLimits already does.
  it("(k) iteration-trust: declared Iteration 1 + 6 real EXECUTE → REFLECT records → GATE:FAIL [iteration-cap], not GATE:PASS", () => {
    const cwd = getTempDir();
    const transitionHistory = [
      "- EXECUTE → REFLECT (1)",
      "- EXECUTE → REFLECT (2)",
      "- EXECUTE → REFLECT (3)",
      "- EXECUTE → REFLECT (4)",
      "- EXECUTE → REFLECT (5)",
      "- EXECUTE → REFLECT (6)",
    ].join("\n");
    writePlan(cwd, { state: "EXECUTE", iteration: 1, transitionHistoryExtra: transitionHistory });
    const r = runPreStep(cwd);
    assert.equal(r.exitCode, 2, `expected exit 2 (derived iteration must trip the hard cap), got ${r.exitCode}\nstdout:\n${r.stdout}`);
    assert.ok(r.stdout.trim().startsWith("GATE:FAIL [iteration-cap]"), `expected GATE:FAIL [iteration-cap], not GATE:PASS, got:\n${r.stdout}`);
    assert.ok(/derived=6/.test(r.stdout), `expected derived=6 in output, got:\n${r.stdout}`);
  });

  it("(l) iteration-trust: same fixture, full validator, no checkpoints/ dir → WARN [checkpoints] despite low declared iteration", () => {
    const cwd = getTempDir();
    const transitionHistory = [
      "- EXECUTE → REFLECT (1)",
      "- EXECUTE → REFLECT (2)",
      "- EXECUTE → REFLECT (3)",
      "- EXECUTE → REFLECT (4)",
      "- EXECUTE → REFLECT (5)",
      "- EXECUTE → REFLECT (6)",
    ].join("\n");
    const { planDir } = writePlan(cwd, { state: "EXECUTE", iteration: 1, transitionHistoryExtra: transitionHistory });
    // writePlan always creates checkpoints/ for the other fixtures' sake; this
    // test needs it absent so checkCheckpoints's own existsSync branch fires.
    rmSync(join(planDir, "checkpoints"), { recursive: true, force: true });
    const r = run(cwd); // no --pre-step
    const warns = r.stdout.split("\n").filter((l) => /WARN\s+\[checkpoints\]/.test(l));
    assert.ok(warns.length >= 1, `expected WARN [checkpoints] despite declared Iteration 1, got:\n${r.stdout}`);
    assert.ok(/iteration 6/.test(warns[0]), `expected the derived iteration (6) in the WARN message, got: ${warns[0]}`);
  });

  // Completion-fix (W1, same-iteration REFLECT->EXECUTE hop, plan-2026-07-31T203947-de0ded98):
  // checkCrossFileConsistency's Convergence-Metrics WARN was the THIRD declared-only
  // iteration reader in this file (after runPreStepGate and checkCheckpoints, both fixed
  // above) — the exact N-place-fix miss plans/LESSONS.md [I:5] flags. It must also use
  // max(declared, derived).
  it("(m) iteration-trust: checkCrossFileConsistency's Convergence Metrics WARN also uses max(declared, derived)", () => {
    const cwd = getTempDir();
    const transitionHistory = [
      "- EXECUTE → REFLECT (1)",
      "- EXECUTE → REFLECT (2)",
      "- EXECUTE → REFLECT (3)",
      "- EXECUTE → REFLECT (4)",
      "- EXECUTE → REFLECT (5)",
      "- EXECUTE → REFLECT (6)",
    ].join("\n");
    // state=REFLECT + declared Iteration 1 (understated), but 6 real EXECUTE → REFLECT
    // records → effective iteration is 6, which is >= 2, so the Convergence Metrics
    // section requirement must fire even though writePlan's default verification.md
    // fixture has no such section.
    writePlan(cwd, { state: "REFLECT", iteration: 1, transitionHistoryExtra: transitionHistory });
    const r = run(cwd); // no --pre-step
    const warns = r.stdout.split("\n").filter((l) => /WARN\s+\[convergence\]/.test(l));
    assert.ok(warns.length >= 1, `expected WARN [convergence] despite declared Iteration 1, got:\n${r.stdout}`);
    assert.ok(/missing Convergence Metrics section for iteration 2\+/.test(warns[0]),
      `expected the iteration-2+ Convergence Metrics message, got: ${warns[0]}`);
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

  // D-009: the Presentation Contract advisory was DELETED, not disabled. The
  // default writePlan fixture records PLAN → EXECUTE and names no contract
  // anywhere — the exact input that used to WARN. Guards against a well-meaning
  // restoration of an unenforceable check.
  it("presentation-contract advisory is gone: PLAN→EXECUTE with no PC-* reference → no WARN", () => {
    const cwd = getTempDir();
    writePlan(cwd);
    const r = run(cwd);
    assert.doesNotMatch(r.stdout, /presentation-contract/i, `the PC advisory must stay deleted (D-009), got:\n${r.stdout}`);
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

  // -------------------------------------------------------------------------
  // B3 / D-011 — the [evidence] check must tolerate bootstrap's own placeholder
  // row but keep flagging REAL criteria with empty/PENDING evidence.
  // The clean fixture is bootstrap's REAL `verification` template bytes, not a
  // hand-copied approximation: a copy would drift and stop testing the defect.
  // -------------------------------------------------------------------------
  it("checkVerificationEvidence: bootstrap's own verification skeleton produces no [evidence] WARN", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    writeFileSync(join(planDir, "verification.md"), PLAN_TEMPLATES.verification);
    const r = run(cwd);
    assert.doesNotMatch(r.stdout, /\[evidence\]/, `the validator must not warn on bootstrap's own bytes, got:\n${r.stdout}`);
  });

  it("checkVerificationEvidence: the skeleton criterion cell is a PLACEHOLDER_PATTERNS shape (spec-derived, not fixture-derived)", () => {
    // Derive the exemption's justification from bootstrap's template rather than
    // asserting a string this test authored: the row the check must tolerate is
    // whatever bootstrap actually writes.
    const row = PLAN_TEMPLATES.verification
      .split("\n")
      .find((l) => l.startsWith("| 1 |"));
    assert.ok(row, "bootstrap's verification template must contain a `| 1 |` criteria row");
    const criterion = row.split("|").map((c) => c.trim())[2];
    assert.match(criterion, /^\*to be (defined|determined|populated)/i,
      `skeleton criterion must match PLACEHOLDER_PATTERNS, got: ${criterion}`);
  });

  it("checkVerificationEvidence: REAL criterion with empty Evidence still WARNs (the check's actual purpose)", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    writeFileSync(join(planDir, "verification.md"),
      "# Verification\n## Criteria Verification\n| # | Criterion | Method | Command | Result | Evidence |\n|---|---|---|---|---|---|\n| 1 | Gate suite green at every commit | run | make test | PASS | - |\n## Verdict\n- Recommendation: continue\n");
    const r = run(cwd);
    assert.match(r.stdout, /\[evidence\]/, `a real criterion with no evidence must still warn, got:\n${r.stdout}`);
    assert.match(r.stdout, /empty Evidence cell/);
  });

  it("checkVerificationEvidence: REAL criterion with PENDING Evidence still WARNs", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    writeFileSync(join(planDir, "verification.md"),
      "# Verification\n## Criteria Verification\n| # | Criterion | Method | Command | Result | Evidence |\n|---|---|---|---|---|---|\n| 1 | Anchor scan reports each anchor once | run | node x | PENDING | PENDING |\n## Verdict\n- Recommendation: continue\n");
    const r = run(cwd);
    assert.match(r.stdout, /\[evidence\]/, `a real criterion with PENDING evidence must still warn, got:\n${r.stdout}`);
    assert.match(r.stdout, /single-word/);
  });

  // -------------------------------------------------------------------------
  // B1 / D-010 — findings/ holds two schemas. Reviewer output is linted against
  // ip-reviewer.md's template (Concerns / Blind Spots / Verdict); every other
  // topic file keeps the explorer schema.
  // -------------------------------------------------------------------------
  it("checkFindingsTopicSections: ip-reviewer.md's mandated sections are the three this check requires (spec-derived)", () => {
    // The required-section list is taken FROM the agent spec, not from fixtures
    // authored by this pass (LESSONS [I:5]).
    const spec = readFileSync(resolve(import.meta.dirname, "..", "agents", "ip-reviewer.md"), "utf-8");
    for (const section of ["## Concerns", "## Blind Spots", "## Verdict"]) {
      assert.ok(spec.includes(section), `ip-reviewer.md must mandate ${section}`);
    }
    // ...and the naming rule the filename discriminator encodes.
    assert.ok(spec.includes("review-iter-N.md"), "ip-reviewer.md must state the review-iter-N.md naming rule");
    assert.ok(spec.includes("review-iter-N-passM.md"), "ip-reviewer.md must state the re-review passM naming rule");
  });

  it("checkFindingsTopicSections: conformant review-iter-N.md → no [findings-topic] WARN", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    writeFileSync(join(planDir, "findings", "review-iter-1.md"),
      "# Adversarial Review — Iteration 1\n\n## Concerns\n1. [NOTE] x — y — z\n\n## Blind Spots\n- nothing\n\n## Verdict\nREADY_TO_CLOSE\n");
    const r = run(cwd);
    assert.doesNotMatch(r.stdout, /\[findings-topic\]/, `conformant reviewer output must not warn, got:\n${r.stdout}`);
  });

  it("checkFindingsTopicSections: conformant review-iter-N-passM.md → no [findings-topic] WARN", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    writeFileSync(join(planDir, "findings", "review-iter-2-pass3.md"),
      "# Adversarial Review — Iteration 2\n\n## Concerns\n(none)\n\n## Blind Spots\n- nothing\n\n## Verdict\nNEEDS_WORK\n");
    const r = run(cwd);
    assert.doesNotMatch(r.stdout, /\[findings-topic\]/, `re-review pass naming must be recognized, got:\n${r.stdout}`);
  });

  it("checkFindingsTopicSections: review file missing ## Verdict still WARNs (discriminator switches the list, never exempts)", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    writeFileSync(join(planDir, "findings", "review-iter-1.md"),
      "# Adversarial Review — Iteration 1\n\n## Concerns\n1. [NOTE] x — y — z\n\n## Blind Spots\n- nothing\n");
    const r = run(cwd);
    assert.match(r.stdout, /\[findings-topic\]/, `a reviewer file missing Verdict must warn, got:\n${r.stdout}`);
    assert.match(r.stdout, /review-iter-1\.md missing required section\(s\): Verdict/);
    assert.doesNotMatch(r.stdout, /Key Findings/, `reviewer files must never be linted against the explorer schema, got:\n${r.stdout}`);
  });

  it("checkFindingsTopicSections: explorer topic file still linted against the explorer schema (previously-clean stays clean)", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    writeFileSync(join(planDir, "findings", "auth-flow.md"),
      "# auth-flow\n\n## Summary\ns\n\n## Key Findings\nk\n\n## Constraints\nc\n\n## Code Patterns\np\n");
    const r = run(cwd);
    assert.match(r.stdout, /\[findings-topic\]/, `an explorer file missing Risks must still warn, got:\n${r.stdout}`);
    assert.match(r.stdout, /auth-flow\.md missing required section\(s\): Risks/);
  });

  it("checkFindingsTopicSections: fully conformant explorer topic file → no WARN", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    writeFileSync(join(planDir, "findings", "auth-flow.md"),
      "# auth-flow\n\n## Summary\ns\n\n## Key Findings\nk\n\n## Constraints\nc\n\n## Code Patterns\np\n\n## Risks & Unknowns\nr\n");
    const r = run(cwd);
    assert.doesNotMatch(r.stdout, /\[findings-topic\]/, `conformant explorer output must not warn, got:\n${r.stdout}`);
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
    // DECISION plan-2026-07-16T085306-8bd12f33/D-005 — the dref join check
    // ([changelog-dref-orphan]) also matches the broad /\[changelog-/ filter below,
    // so the fixture's decisions.md gets a real ## D-1000 entry — the test's stated
    // intent (DECISION_ID_NUM_PATTERN has no upper digit bound, D-1000 is a legal
    // dref SHAPE) is unchanged, and the run is now legitimately clean on both shape
    // AND join. Do NOT remove this fixture entry or rename the slug off the
    // `changelog-` prefix to dodge the filter (slug convention outweighs fixture
    // immutability). The incidental [decisions-schema] sequence ERROR (D-001 →
    // D-1000) is out-of-filter, mirroring test (l2)'s D-1000-only fixture
    // precedent. See decisions.md D-005 (plan-2026-07-16T085306-8bd12f33).
    appendFileSync(join(planDir, "decisions.md"),
`
## D-1000 | EXECUTE | 2026-05-15
**Context**: fixture — join target for the D-1000 dref below.
**Decision**: fixture.
**Trade-off**: a **at the cost of** b.
**Reasoning**: fixture.
`);
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
// plan-2026-07-16-8bd12f33 iter-1/step-4 (D-001, D-005) — changelog dref JOIN
// integrity. Every non-`-` dref on a well-formed changelog line must resolve to
// a `## D-NNN` entry in the SAME plan's decisions.md, else WARN
// [changelog-dref-orphan]. WARN-only (never changes the exit code); structurally
// absent from --pre-step; malformed (≠8-field) lines stay checkChangelogFormat's
// business and are skipped silently here.
// ---------------------------------------------------------------------------

describe("validate-plan.mjs — changelog: dref join integrity ([changelog-dref-orphan])", () => {
  let tempDirs = [];
  function getTempDir() { const d = makeTempDir(); tempDirs.push(d); return d; }
  afterEach(() => { for (const d of tempDirs) removeTempDir(d); tempDirs = []; });

  const drefLine = (dref) =>
    `2026-05-30T10:00:00Z | iter-1/step-1 | abc1234 | f.js | EDIT(+1,-0) | radius:LOW(1) | ${dref} | a reason`;
  const orphanLines = (stdout) => stdout.split("\n").filter((l) => /\[changelog-dref-orphan\]/.test(l));

  it("orphan dref D-999 (decisions.md has only D-001) → WARN names file:line + dref; exit code UNCHANGED vs clean run", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    // The default fixture carries a pre-existing, unrelated ERROR [verdict], so
    // "WARN never affects the exit code" is proven by before/after EQUALITY of
    // exit codes (clean dref vs orphan dref), not by asserting a literal 0.
    writeFileSync(join(planDir, "changelog.md"), `# Changelog\n*note*\n${drefLine("-")}\n`);
    const clean = run(cwd);
    writeFileSync(join(planDir, "changelog.md"), `# Changelog\n*note*\n${drefLine("D-999")}\n`);
    const r = run(cwd);
    const lines = orphanLines(r.stdout);
    assert.equal(lines.length, 1, `expected exactly one dref-orphan line, got:\n${r.stdout}`);
    assert.match(lines[0], /WARN/, `dref-orphan must be WARN severity, got: ${lines[0]}`);
    assert.match(lines[0], /changelog\.md:3/, `the WARN must name file:line, got: ${lines[0]}`);
    assert.match(lines[0], /dref D-999/, `the WARN must name the offending dref, got: ${lines[0]}`);
    assert.match(lines[0], /no matching entry in decisions\.md/, `the WARN must say what is missing, got: ${lines[0]}`);
    assert.equal(r.exitCode, clean.exitCode,
      `WARN must not change the exit code (clean=${clean.exitCode}, orphan=${r.exitCode})\nstdout:\n${r.stdout}`);
    assert.notEqual(r.exitCode, 2, "exit 2 is --pre-step-exclusive");
  });

  it("dref `-` → no [changelog-dref-orphan]", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    writeFileSync(join(planDir, "changelog.md"), `# Changelog\n*note*\n${drefLine("-")}\n`);
    const r = run(cwd);
    assert.deepEqual(orphanLines(r.stdout), [], `dash dref must be silent, got:\n${r.stdout}`);
  });

  it("resolving dref D-001 (matches the fixture's own decisions.md) → no [changelog-dref-orphan]", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    writeFileSync(join(planDir, "changelog.md"), `# Changelog\n*note*\n${drefLine("D-001")}\n`);
    const r = run(cwd);
    assert.deepEqual(orphanLines(r.stdout), [], `resolving dref must be silent, got:\n${r.stdout}`);
  });

  it("malformed line (7 fields) with an orphan-looking dref → [changelog-malformed] fires, dref-orphan does NOT (skip-silently contract)", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    // 7 fields — the reason field is missing; the last field LOOKS like an orphan dref.
    writeFileSync(join(planDir, "changelog.md"),
      "# Changelog\n2026-05-30T10:00:00Z | iter-1/step-1 | abc1234 | f.js | EDIT(+1,-0) | radius:LOW(1) | D-999\n");
    const r = run(cwd);
    assert.match(r.stdout, /WARN.*\[changelog-malformed\].*expected 8 pipe-separated fields, got 7/,
      `malformed line must stay checkChangelogFormat's business, got:\n${r.stdout}`);
    assert.deepEqual(orphanLines(r.stdout), [],
      `a malformed line must be skipped by the join check, got:\n${r.stdout}`);
  });

  it("8-field line, shape-invalid non-`-` dref (D-1) → BOTH [changelog-malformed] AND [changelog-dref-orphan] on the same line (accepted double-WARN contract)", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    // The line has 8 fields, so the join check does NOT skip it; `D-1` fails
    // CHANGELOG_SPEC's dref shape (D-\d{3,}) so checkChangelogFormat WARNs,
    // and `D-1` matches no ## D-NNN heading so the join check WARNs too.
    // checkChangelogDrefIntegrity's header comment documents this double-WARN
    // as intentional (shape is NOT re-validated there) — this test pins it.
    writeFileSync(join(planDir, "changelog.md"), `# Changelog\n*note*\n${drefLine("D-1")}\n`);
    const r = run(cwd);
    const malformed = r.stdout.split("\n").filter((l) => /\[changelog-malformed\]/.test(l));
    assert.equal(malformed.length, 1, `expected exactly one changelog-malformed line, got:\n${r.stdout}`);
    assert.match(malformed[0], /WARN/, `changelog-malformed must be WARN severity, got: ${malformed[0]}`);
    assert.match(malformed[0], /changelog\.md:3/, `shape WARN must name the same line, got: ${malformed[0]}`);
    assert.match(malformed[0], /attribute "dref"/, `shape WARN must name the dref field, got: ${malformed[0]}`);
    const orphans = orphanLines(r.stdout);
    assert.equal(orphans.length, 1, `expected exactly one dref-orphan line, got:\n${r.stdout}`);
    assert.match(orphans[0], /WARN/, `dref-orphan must be WARN severity, got: ${orphans[0]}`);
    assert.match(orphans[0], /changelog\.md:3/, `join WARN must name the same line, got: ${orphans[0]}`);
    assert.match(orphans[0], /dref D-1 /, `join WARN must name the offending dref, got: ${orphans[0]}`);
    assert.notEqual(r.exitCode, 2, "exit 2 is --pre-step-exclusive");
  });

  it("missing decisions.md → no crash, no [changelog-dref-orphan] (nothing to join against)", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd);
    rmSync(join(planDir, "decisions.md"), { force: true });
    writeFileSync(join(planDir, "changelog.md"), `# Changelog\n*note*\n${drefLine("D-999")}\n`);
    const r = run(cwd);
    assert.match(r.stdout, /Summary: \d+ error/, `validator must run to completion (no crash), got:\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.deepEqual(orphanLines(r.stdout), [], `absent decisions.md must be silent, got:\n${r.stdout}`);
  });

  it("--pre-step isolation: orphan dref present → no changelog-dref output, GATE:PASS exit 0", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd, { state: "EXECUTE", iteration: 1, currentStep: "1 of 5" });
    writeFileSync(join(planDir, "changelog.md"), `# Changelog\n*note*\n${drefLine("D-999")}\n`);
    const r = run(cwd, "--pre-step");
    assert.equal(r.exitCode, 0, `pre-step must PASS on a healthy state.md regardless of changelog content, got ${r.exitCode}\nstdout:\n${r.stdout}`);
    assert.ok(r.stdout.trim().startsWith("GATE:PASS"), `expected GATE:PASS prefix, got:\n${r.stdout}`);
    assert.doesNotMatch(r.stdout, /changelog-dref/, `--pre-step must never run the dref join check, got:\n${r.stdout}`);
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

// ---------------------------------------------------------------------------
// F2 / plan-2026-07-16-47577439 D-001 — collectKnownDecisionIdsByPlan is scoped
// to {active ∪ referenced} plan-ids, NOT a full readdirSync walk of plans/.
// The decoy proof: the old implementation parsed EVERY plans/* decisions.md, so
// every decoy dir below would appear as a Map key. Key ABSENCE proves the decoy
// files were never read.
// ---------------------------------------------------------------------------

/** Write a minimal parseable decisions.md holding exactly one D-NNN entry. */
function writeDecisionsFixture(planDir, planId, idStr) {
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(planDir, "decisions.md"),
`# Decision Log
*Plan: ${planId}*

## ${idStr} | EXECUTE | 2026-06-01
**Context**: fixture.
**Decision**: fixture.
**Trade-off**: a **at the cost of** b.
**Reasoning**: fixture.
`);
}

describe("F2 narrowing: collectKnownDecisionIdsByPlan reads only referenced plans (D-001)", () => {
  const tempDirs = [];
  function getTempDir() { const d = makeTempDir(); tempDirs.push(d); return d; }
  afterEach(() => { while (tempDirs.length) removeTempDir(tempDirs.pop()); });

  it("decoy plan dirs (new + legacy shape) are NOT parsed into the Map — only active + referenced keys exist", () => {
    const cwd = getTempDir();
    const plansFix = join(cwd, "plans");
    const active = "plan-2026-06-01T101010-aaaa1111";
    const referenced = "plan-2026-06-02T111111-bbbb2222";
    const decoys = [
      "plan-2026-06-03T121212-cccc3333",
      "plan-2026-06-04T131313-dddd4444",
      "plan_2026-01-05_eeee5555", // legacy shape — must be equally unread
    ];
    writeDecisionsFixture(join(plansFix, active), active, "D-001");
    writeDecisionsFixture(join(plansFix, referenced), referenced, "D-002");
    for (const d of decoys) writeDecisionsFixture(join(plansFix, d), d, "D-042");
    // NO consolidated plans/DECISIONS.md — per-plan files are the only source.

    const map = collectKnownDecisionIdsByPlan(
      join(plansFix, active),
      active,
      // Includes the active plan (must be skipped — already loaded) and a
      // non-plan-id string (must be guarded, not thrown on).
      new Set([referenced, active, "not-a-plan-id"]),
      plansFix,
    );

    assert.deepEqual([...map.keys()].sort(), [active, referenced].sort(),
      `Map keys must be exactly {active, referenced}, got: ${[...map.keys()].join(", ")}`);
    assert.ok(map.get(active).has(1), "active plan's D-001 must resolve");
    assert.ok(map.get(referenced).has(2), "referenced plan's D-002 must resolve");
    for (const d of decoys) {
      assert.ok(!map.has(d), `decoy ${d} must be ABSENT — its presence proves a full-corpus walk`);
    }
  });

  it("CLI anchor output is byte-identical with and without decoy plan dirs present", () => {
    const cwd = getTempDir();
    writePlan(cwd); // active plan_2026-05-15_aaaabbbb with D-001
    const referenced = "plan_2026-02-02_11223344";
    const unknown = "plan_2026-03-03_55667788";
    writeDecisionsFixture(join(cwd, "plans", referenced), referenced, "D-002");
    // One anchor per resolution class: resolved, orphan (ERROR), unknown plan
    // (ERROR), stale unknown (WARN downgrade), bad prefix (WARN).
    writeFileSync(join(cwd, "doc.md"),
      "# Doc\n\n" +
      "<!-- DECISION " + referenced + "/D-002 — resolves, no finding -->\n" +
      "<!-- DECISION " + referenced + "/D-007 — orphan in a known plan -->\n" +
      "<!-- DECISION " + unknown + "/D-001 — unknown plan -->\n" +
      "<!-- DECISION " + unknown + "/D-009 [STALE] — stale, severity WARN -->\n" +
      "<!-- DECISION plan-2026-02-02-11223344/D-002 — commit-tag shape, bad prefix -->\n");

    const before = run(cwd);
    // Sanity: every class fires as expected before adding decoys.
    assert.match(before.stdout, /ERROR\s+\[anchor-orphan\][^\n]*plan_2026-02-02_11223344\/D-007/,
      `expected orphan ERROR for D-007, got:\n${before.stdout}`);
    assert.match(before.stdout, /ERROR\s+\[anchor-unknown-plan\][^\n]*plan_2026-03-03_55667788\/D-001/,
      `expected unknown-plan ERROR for D-001, got:\n${before.stdout}`);
    assert.match(before.stdout, /WARN\s+\[anchor-unknown-plan\][^\n]*D-009 \[STALE\]/,
      `expected stale WARN downgrade for D-009, got:\n${before.stdout}`);
    assert.match(before.stdout, /WARN\s+\[anchor-badprefix\][^\n]*plan-2026-02-02-11223344/,
      `expected badprefix WARN, got:\n${before.stdout}`);
    assert.ok(!/\[anchor-orphan\][^\n]*D-002/.test(before.stdout),
      `referenced plan's D-002 must resolve cleanly, got:\n${before.stdout}`);

    for (const d of ["plan-2026-06-03T121212-cccc3333", "plan-2026-06-04T131313-dddd4444", "plan_2026-01-05_eeee5555"]) {
      writeDecisionsFixture(join(cwd, "plans", d), d, "D-042");
    }
    const after = run(cwd);
    assert.equal(after.stdout, before.stdout,
      "validator output must not change when unreferenced decoy plan dirs appear");
    assert.equal(after.exitCode, before.exitCode);
  });
});

// ---------------------------------------------------------------------------
// plan-2026-08-04T092155-0063b038 step 3 — the durable resolver tier: the
// committed manifest plans/ANCHORS.md. The point of the tier is that a
// qualified anchor resolves with NO plan directory and NO consolidated
// section, because in a consuming project the plans directory is gitignored
// and neither of those artifacts survives a fresh clone.
//
// Two grammars matter here, not one: 2 of the 8 real plan-ids anchored in this
// repo use the legacy `plan_YYYY-MM-DD_XXXXXXXX` shape and account for 20 of
// the 39 findings, so the legacy case is tested in its own right, not assumed.
// ---------------------------------------------------------------------------

const MANIFEST_HEADER =
`# Decision Anchor Manifest
*Committed, append-only. One line per anchored decision.*
`;

/** Write plans/ANCHORS.md with the header plus the given raw entry lines. */
function writeManifest(cwd, lines) {
  mkdirSync(join(cwd, "plans"), { recursive: true });
  writeFileSync(join(cwd, "plans", "ANCHORS.md"), MANIFEST_HEADER + lines.join("\n") + (lines.length ? "\n" : ""));
}

// Read-counting harness. The spy MUST be installed before validate-plan.mjs is
// imported: an `import { readFileSync } from "fs"` binding is snapshotted when
// the builtin's ESM facade is first instantiated, so patching the CJS module
// afterwards (as this test file, which imported fs at the top, would have to)
// is silently ineffective. Hence a child process that patches first, imports
// second. `totalReads` is reported so a spy that failed to take effect fails
// LOUDLY instead of reporting a comfortable manifestReads of 0.
const READ_SPY_SRC = `
const cjs = require("fs");
const orig = cjs.readFileSync;
let seen = [];
cjs.readFileSync = function (...a) { seen.push(String(a[0])); return orig.apply(this, a); };
// The module path is deliberately NOT argv[1]: validate-plan.mjs's isEntryPoint
// guard compares against argv[1], and handing it the module path there makes the
// import run the CLI instead of just exporting.
const href = require("url").pathToFileURL(process.argv[5]).href;
import(href).then((m) => {
  seen = [];
  const map = m.collectKnownDecisionIdsByPlan(
    process.argv[1], process.argv[2], new Set(JSON.parse(process.argv[4])), process.argv[3]);
  const reads = seen.slice();
  cjs.readFileSync = orig;
  const out = {};
  for (const [k, v] of map) out[k] = [...v].sort((x, y) => x - y);
  process.stdout.write(JSON.stringify({
    map: out,
    totalReads: reads.length,
    manifestReads: reads.filter((p) => p.endsWith("ANCHORS.md")).length,
  }));
});
`;

function collectWithReadCount(planDir, planId, baseDir, referenced = []) {
  const r = spawnSync("node",
    ["-e", READ_SPY_SRC, planDir, planId, baseDir, JSON.stringify(referenced), VALIDATOR],
    { encoding: "utf-8", timeout: 15000 });
  assert.equal(r.status, 0, `spy harness failed (${r.status}):\n${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.ok(parsed.totalReads > 0,
    "the read spy observed zero reads — the patch did not take effect, so any read count it reports is meaningless");
  return parsed;
}

describe("resolver tier 4: the committed plans/ANCHORS.md manifest", () => {
  const tempDirs = [];
  function getTempDir() { const d = makeTempDir(); tempDirs.push(d); return d; }
  afterEach(() => { while (tempDirs.length) removeTempDir(tempDirs.pop()); });

  const GONE_NEW = "plan-2026-03-09T081500-9f9f9f9f";
  const GONE_LEGACY = "plan_2026-03-10_a1b2c3d4";

  it("(a) a qualified anchor resolves from the manifest ALONE — no plan dir, no consolidated section", () => {
    const cwd = getTempDir();
    writePlan(cwd);
    writeFileSync(join(cwd, "doc.md"),
      "# Doc\n\n<!-- DECISION " + GONE_NEW + "/D-004 — its plan directory is long gone -->\n");

    const without = run(cwd);
    assert.match(without.stdout, /ERROR\s+\[anchor-unknown-plan\][^\n]*D-004/,
      `sanity: unresolved before the manifest lists it, got:\n${without.stdout}`);

    writeManifest(cwd, [`${GONE_NEW}/D-004 | 2026-03-09 | fixture rationale`]);
    const withManifest = run(cwd);
    assert.doesNotMatch(withManifest.stdout, /\[anchor-unknown-plan\]/,
      `the manifest line alone must resolve the anchor, got:\n${withManifest.stdout}`);
    assert.doesNotMatch(withManifest.stdout, /\[anchor-orphan\]/,
      `D-004 is listed, so it is not an orphan, got:\n${withManifest.stdout}`);
    assert.ok(!readdirSync(join(cwd, "plans")).includes(GONE_NEW),
      "the fixture must contain NO directory for the resolved plan — that is the whole point");
  });

  it("(a2) the same holds for a LEGACY-grammar plan-id (2 of this repo's 8 anchored ids, 20 of its 39 findings)", () => {
    const cwd = getTempDir();
    writePlan(cwd);
    writeFileSync(join(cwd, "doc.md"),
      "# Doc\n\n<!-- DECISION " + GONE_LEGACY + "/D-011 — legacy-shaped id -->\n");
    writeManifest(cwd, [`${GONE_LEGACY}/D-011 | 2026-03-10 | fixture rationale`]);
    const r = run(cwd);
    assert.doesNotMatch(r.stdout, /\[anchor-unknown-plan\]/,
      `a legacy plan-id must resolve from the manifest too, got:\n${r.stdout}`);
    assert.doesNotMatch(r.stdout, /\[anchor-orphan\]/, r.stdout);
  });

  it("(b) an id present in NO tier still ERRORs [anchor-unknown-plan] — the manifest only ever adds real, closed ids", () => {
    const cwd = getTempDir();
    writePlan(cwd);
    writeFileSync(join(cwd, "doc.md"),
      "# Doc\n\n<!-- DECISION " + GONE_NEW + "/D-004 — listed -->\n" +
      "<!-- DECISION " + GONE_LEGACY + "/D-004 — typo'd id, listed nowhere -->\n");
    writeManifest(cwd, [`${GONE_NEW}/D-004 | 2026-03-09 | fixture rationale`]);
    const r = run(cwd);
    assert.match(r.stdout, new RegExp(`ERROR\\s+\\[anchor-unknown-plan\\][^\\n]*${GONE_LEGACY}`),
      `an unlisted id must still hard-ERROR, got:\n${r.stdout}`);
    assert.doesNotMatch(r.stdout, new RegExp(`\\[anchor-unknown-plan\\][^\\n]*${GONE_NEW}`),
      `the listed id must NOT be reported, got:\n${r.stdout}`);
  });

  it("(c) an id listed in the manifest with an UNLISTED D-NNN ERRORs [anchor-orphan]", () => {
    const cwd = getTempDir();
    writePlan(cwd);
    writeFileSync(join(cwd, "doc.md"),
      "# Doc\n\n<!-- DECISION " + GONE_NEW + "/D-004 — listed -->\n" +
      "<!-- DECISION " + GONE_NEW + "/D-077 — same plan, decision never recorded -->\n");
    writeManifest(cwd, [`${GONE_NEW}/D-004 | 2026-03-09 | fixture rationale`]);
    const r = run(cwd);
    assert.match(r.stdout, /ERROR\s+\[anchor-orphan\][^\n]*D-077/,
      `an unlisted decision under a listed plan must still be an orphan ERROR, got:\n${r.stdout}`);
    assert.doesNotMatch(r.stdout, /\[anchor-orphan\][^\n]*D-004/, r.stdout);
  });

  it("(d) an ABSENT manifest is a pure no-op — output byte-identical to an empty and to a header-only one", () => {
    const cwd = getTempDir();
    writePlan(cwd);
    writeFileSync(join(cwd, "doc.md"),
      "# Doc\n\n<!-- DECISION " + GONE_NEW + "/D-004 — nothing resolves this -->\n");

    const absent = run(cwd);
    assert.match(absent.stdout, /ERROR\s+\[anchor-unknown-plan\][^\n]*D-004/,
      `sanity: the pre-change finding must be present, got:\n${absent.stdout}`);

    writeFileSync(join(cwd, "plans", "ANCHORS.md"), "");
    const empty = run(cwd);
    assert.equal(empty.stdout, absent.stdout, "an empty manifest must change nothing");
    assert.equal(empty.exitCode, absent.exitCode);

    writeManifest(cwd, []);
    const headerOnly = run(cwd);
    assert.equal(headerOnly.stdout, absent.stdout, "a header-only manifest must change nothing");
    assert.equal(headerOnly.exitCode, absent.exitCode);
  });

  it("(e) garbage, truncated and prose lines are ignored silently — and an id-shaped string INSIDE a rationale registers nothing", () => {
    const cwd = getTempDir();
    writePlan(cwd);
    writeFileSync(join(cwd, "doc.md"),
      "# Doc\n\n<!-- DECISION " + GONE_NEW + "/D-004 — the one real line -->\n" +
      "<!-- DECISION " + GONE_LEGACY + "/D-011 — only ever named inside prose -->\n");
    writeManifest(cwd, [
      "",
      "<!-- backfilled from source anchors at close; see plan.md step 4 -->",
      "not a line at all",
      GONE_LEGACY,                                  // truncated: no /D-NNN
      `${GONE_LEGACY}/D-011`,                       // no pipe delimiter
      `${GONE_LEGACY}/D-011 2026-03-10 rationale`,  // delimiter missing entirely
      `  ${GONE_LEGACY}/D-011 | 2026-03-10 | indented, so not a line-start id`,
      `see also ${GONE_LEGACY}/D-011 | prose that merely mentions an id`,
      `${GONE_NEW}/D-004 | 2026-03-09 | the one line that IS an entry`,
      `${GONE_NEW}/D-` ,                            // truncated mid-id
      "|||",
    ]);

    const r = run(cwd);
    assert.doesNotMatch(r.stdout, new RegExp(`\\[anchor-unknown-plan\\][^\\n]*${GONE_NEW}`),
      `the one well-formed line must still parse — otherwise this test is vacuous, got:\n${r.stdout}`);
    assert.match(r.stdout, new RegExp(`ERROR\\s+\\[anchor-unknown-plan\\][^\\n]*${GONE_LEGACY}`),
      `an id named only inside prose/garbage must NOT register — a loose regex here silently satisfies anchors, got:\n${r.stdout}`);
    assert.ok(r.exitCode !== null, "the validator must not throw on a garbage manifest");
  });

  it("(f) 50 decoy plan dirs change neither the result nor the read count — the manifest is read exactly ONCE", () => {
    const cwd = getTempDir();
    const plansFix = join(cwd, "plans");
    const active = "plan-2026-06-01T101010-aaaa1111";
    writeDecisionsFixture(join(plansFix, active), active, "D-001");
    writeFileSync(join(plansFix, "ANCHORS.md"), MANIFEST_HEADER +
      `${GONE_NEW}/D-004 | 2026-03-09 | fixture rationale\n` +
      `${GONE_LEGACY}/D-011 | 2026-03-10 | fixture rationale\n`);

    const before = collectWithReadCount(join(plansFix, active), active, plansFix, []);
    assert.equal(before.manifestReads, 1, "the manifest must be read exactly once per full collection");
    assert.deepEqual(before.map[GONE_NEW], [4]);
    assert.deepEqual(before.map[GONE_LEGACY], [11]);

    for (let i = 0; i < 50; i++) {
      const d = `plan-2026-07-${String((i % 28) + 1).padStart(2, "0")}T${String(i).padStart(6, "0")}-dec0${String(i).padStart(4, "0")}`;
      writeDecisionsFixture(join(plansFix, d), d, "D-042");
    }

    const after = collectWithReadCount(join(plansFix, active), active, plansFix, []);
    assert.deepEqual(after.map, before.map,
      "50 decoy plan dirs must not change the resolved map");
    assert.equal(after.manifestReads, 1,
      "the manifest read count must be independent of how many plan directories exist");
    assert.equal(after.totalReads, before.totalReads,
      "the total read count must not grow with plan-dir count — that would restore the forbidden full-corpus walk");
  });
});

// ---------------------------------------------------------------------------
// D-031 / D-032 — the extension PARTITION, and why it is a test rather than a
// comment. Before this gate the block-comment scan ran on every extension that was
// not HTML-style, i.e. on 13 languages in which `/*` is not a comment opener; two
// shell globs then supplied both delimiters. The replacement is an ALLOWLIST, whose
// quiet failure mode is the opposite one: an extension nobody classified gets no
// block scan and its `/* */` anchors vanish without a word. This test is what turns
// that silence into a red build — every member of ANCHOR_SOURCE_EXTS must be
// classified EXACTLY ONCE, so adding a new extension to the scan without deciding
// its comment family fails here, naming it.
// ---------------------------------------------------------------------------
describe("anchor extension partition (D-032)", () => {
  // The third class has no runtime set: these extensions are handled by the per-line
  // `#` / `--` marker arms in findAnchorsInFile and need no set of their own. It is
  // enumerated HERE, in the test, so the partition can be checked without inventing a
  // production constant that nothing would consume.
  const LINE_MARKER_ONLY_EXTS = new Set([
    ".py", ".rb", ".sh", ".bash", ".zsh", ".yml", ".yaml", ".toml", ".r", ".pl", ".pm", ".tf",
    ".sql",
  ]);

  it("every scanned extension is classified EXACTLY ONCE (block / HTML-style / line-marker-only)", () => {
    const unclassified = [];
    const multiplyClassified = [];
    for (const ext of ANCHOR_SOURCE_EXTS) {
      const n = (BLOCK_COMMENT_EXTS.has(ext) ? 1 : 0)
        + (HTML_STYLE_EXTS.has(ext) ? 1 : 0)
        + (LINE_MARKER_ONLY_EXTS.has(ext) ? 1 : 0);
      if (n === 0) unclassified.push(ext);
      if (n > 1) multiplyClassified.push(ext);
    }
    assert.deepEqual(unclassified, [],
      `unclassified extension(s) — a new member of ANCHOR_SOURCE_EXTS must be added to BLOCK_COMMENT_EXTS `
      + `(shared.mjs) or to this test's LINE_MARKER_ONLY_EXTS, or its /* */ anchors are silently invisible: `
      + `${unclassified.join(", ")}`);
    assert.deepEqual(multiplyClassified, [],
      `extension(s) in two classes at once: ${multiplyClassified.join(", ")}`);
    assert.equal(
      BLOCK_COMMENT_EXTS.size + LINE_MARKER_ONLY_EXTS.size + 1, ANCHOR_SOURCE_EXTS.size,
      "the three classes must EXHAUST the scanned set (the +1 is .md, the only HTML-style member of it)");
  });

  it("no class carries an extension the scanner never visits", () => {
    for (const ext of BLOCK_COMMENT_EXTS) {
      assert.ok(ANCHOR_SOURCE_EXTS.has(ext), `${ext} is block-scanned but never walked`);
    }
  });

  it("the two ANCHOR_SOURCE_EXTS copies (validate-plan / bootstrap) hold the same members", () => {
    assert.deepEqual([...BOOTSTRAP_ANCHOR_SOURCE_EXTS].sort(), [...ANCHOR_SOURCE_EXTS].sort(),
      "the copies are kept in sync by hand (see each file's \"Kept in sync\" comment); a divergence means "
      + "retire stamps a file the validator never scans, or vice versa");
  });

  it("the 13 hash/SQL-family extensions are NOT block-scanned (the Concern 2 defect, as a set assertion)", () => {
    for (const ext of [".py", ".rb", ".sh", ".bash", ".zsh", ".yml", ".yaml", ".toml", ".r", ".pl", ".pm", ".tf", ".sql"]) {
      assert.ok(!BLOCK_COMMENT_EXTS.has(ext),
        `${ext} has no C-style block comments; block-scanning it opens phantom spans on ordinary globs`);
    }
  });
});

// ---------------------------------------------------------------------------
// plan-2026-07-31T203947-de0ded98 step 7 — ANCHOR_SOURCE_EXTS grown to 33
// members (step 4) means 16 previously-ghosted extensions are now scanned.
// Prove two representative additions (one hash-family, one slash-family) are
// actually walked and their anchors actually reported — previously these
// files were invisible to checkReverseAnchors regardless of content.
// ---------------------------------------------------------------------------
describe("newly-scanned anchor extensions (hash-family .yml, slash-family .jsx)", () => {
  const tempDirs = [];
  function getTempDir() { const d = makeTempDir(); tempDirs.push(d); return d; }
  afterEach(() => { while (tempDirs.length) removeTempDir(tempDirs.pop()); });

  it("a hash-style `#` anchor in a .yml file is found (orphan D-999 reported, not ghosted)", () => {
    const cwd = getTempDir();
    writePlan(cwd); // active plan_2026-05-15_aaaabbbb, only D-001 known
    writeFileSync(join(cwd, "config.yml"),
      "# DECISION plan_2026-05-15_aaaabbbb/D-999 — orphan, proves the scan reached this file\n" +
      "key: value\n");
    const r = run(cwd);
    assert.match(r.stdout, /ERROR\s+\[anchor-orphan\][^\n]*config\.yml[^\n]*D-999/,
      `.yml anchor must be found and reported as orphan, got:\n${r.stdout}`);
  });

  it("a slash-style `//` anchor in a .jsx file is found (orphan D-998 reported, not ghosted)", () => {
    const cwd = getTempDir();
    writePlan(cwd); // active plan_2026-05-15_aaaabbbb, only D-001 known
    writeFileSync(join(cwd, "Widget.jsx"),
      "// DECISION plan_2026-05-15_aaaabbbb/D-998 — orphan, proves the scan reached this file\n" +
      "export default function Widget() { return null; }\n");
    const r = run(cwd);
    assert.match(r.stdout, /ERROR\s+\[anchor-orphan\][^\n]*Widget\.jsx[^\n]*D-998/,
      `.jsx anchor must be found and reported as orphan, got:\n${r.stdout}`);
  });
});

// ---------------------------------------------------------------------------
// F1 / plan-2026-07-16-47577439 D-001 — [lessons-eviction] WARN gate.
//
// The archivist's "never drop an [I:5] entry" rewrite policy had zero
// mechanical backing. The gate compares [I:5]-tagged line COUNTS between the
// current plans/LESSONS.md and the previous close's lessons_snapshot.md
// (previous close = last plans/INDEX.md data row). Count decrease → WARN with
// a verbatim -/+ diff attached as decision-support. Equal count (even fully
// reworded) or growth → silent: the count invariant is the SOLE trigger — no
// fuzzy matching, no similarity threshold, and never ERROR (must not block
// CLOSE on legitimate curation).
// ---------------------------------------------------------------------------

describe("[lessons-eviction]: [I:5] count invariant vs previous close snapshot (F1 / D-001)", () => {
  const tempDirs = [];
  function getTempDir() { const d = makeTempDir(); tempDirs.push(d); return d; }
  afterEach(() => { while (tempDirs.length) removeTempDir(tempDirs.pop()); });

  const PREV = "plan-2026-07-01T101010-beefcafe";
  const INDEX_HEADER =
    "# Plan Index\n*Topic-to-directory mapping.*\n\n" +
    "| Plan | Date | Goal | Key Topics |\n|------|------|------|------------|\n";

  /** Fixture: active plan + INDEX.md naming PREV + optional snapshot/lessons content. */
  function writeEvictionFixture(cwd, { lessons, snapshot, index = INDEX_HEADER + `| ${PREV} | 2026-07-01 | fixture goal | |\n` } = {}) {
    writePlan(cwd);
    if (index !== null) writeFileSync(join(cwd, "plans", "INDEX.md"), index);
    if (lessons !== undefined) writeFileSync(join(cwd, "plans", "LESSONS.md"), lessons);
    if (snapshot !== undefined) {
      mkdirSync(join(cwd, "plans", PREV), { recursive: true });
      writeFileSync(join(cwd, "plans", PREV, "lessons_snapshot.md"), snapshot);
    }
  }

  it("(a) WARN fires on [I:5] count decrease and names the dropped line verbatim", () => {
    const cwd = getTempDir();
    writeEvictionFixture(cwd, {
      snapshot: "# Lessons\n- [I:5] never trust a proxy gate\n- [I:5] pay parity debt in the causing step\n- [I:5] gates inspect real artifacts\n- [I:3] minor lesson\n",
      lessons: "# Lessons\n- [I:5] never trust a proxy gate\n- [I:5] pay parity debt in the causing step\n- [I:3] minor lesson\n",
    });
    const r = run(cwd);
    assert.match(r.stdout, /WARN\s+\[lessons-eviction\]/, `expected WARN, got:\n${r.stdout}`);
    assert.match(r.stdout, /2 \[I:5\] line\(s\)/, `expected current count 2 in message, got:\n${r.stdout}`);
    assert.match(r.stdout, /had 3/, `expected snapshot count 3 in message, got:\n${r.stdout}`);
    assert.match(r.stdout, /- - \[I:5\] gates inspect real artifacts/,
      `dropped line must appear verbatim in the diff summary, got:\n${r.stdout}`);
    assert.doesNotMatch(r.stdout, /ERROR\s+\[lessons-eviction\]/,
      "the gate must NEVER emit ERROR (HARD constraint: never blocks CLOSE)");
  });

  it("(b) silent on equal count with fully reworded content, and on growth", () => {
    // Equal count, every [I:5] line reworded — a legitimate tighten/merge rewrite.
    const cwdEqual = getTempDir();
    writeEvictionFixture(cwdEqual, {
      snapshot: "# Lessons\n- [I:5] original wording alpha\n- [I:5] original wording beta\n",
      lessons: "# Lessons\n- [I:5] tightened alpha wording\n- [I:5] merged-and-reworded beta\n",
    });
    const rEqual = run(cwdEqual);
    assert.doesNotMatch(rEqual.stdout, /\[lessons-eviction\]/,
      `equal [I:5] count must be silent even fully reworded (count is the SOLE trigger), got:\n${rEqual.stdout}`);

    // Growth: current has MORE [I:5] lines than the snapshot.
    const cwdGrowth = getTempDir();
    writeEvictionFixture(cwdGrowth, {
      snapshot: "# Lessons\n- [I:5] one\n",
      lessons: "# Lessons\n- [I:5] one\n- [I:5] two, newly promoted\n",
    });
    const rGrowth = run(cwdGrowth);
    assert.doesNotMatch(rGrowth.stdout, /\[lessons-eviction\]/,
      `growth must be silent, got:\n${rGrowth.stdout}`);
  });

  it("(c) INFO when the previous plan named by INDEX.md lacks lessons_snapshot.md", () => {
    const cwd = getTempDir();
    writeEvictionFixture(cwd, {
      lessons: "# Lessons\n- [I:5] one\n",
      // snapshot deliberately omitted — PREV dir never created
    });
    const r = run(cwd);
    assert.match(r.stdout, new RegExp(`INFO\\s+\\[lessons-eviction\\][^\\n]*${PREV}[^\\n]*no lessons_snapshot\\.md`),
      `expected INFO naming ${PREV}, got:\n${r.stdout}`);
    assert.doesNotMatch(r.stdout, /(WARN|ERROR)\s+\[lessons-eviction\]/,
      "missing snapshot is INFO only (legacy plan predates the mechanism)");
  });

  it("(d) INFO (baseline unavailable) when INDEX.md is absent, and when it is header-only", () => {
    // INDEX.md absent entirely.
    const cwdAbsent = getTempDir();
    writeEvictionFixture(cwdAbsent, { lessons: "# Lessons\n- [I:5] one\n", index: null });
    const rAbsent = run(cwdAbsent);
    assert.match(rAbsent.stdout, /INFO\s+\[lessons-eviction\][^\n]*no previous close on record/,
      `expected baseline-unavailable INFO with INDEX.md absent, got:\n${rAbsent.stdout}`);

    // INDEX.md present but header/separator rows only — no data row's first
    // cell matches the plan-id union.
    const cwdHeader = getTempDir();
    writeEvictionFixture(cwdHeader, { lessons: "# Lessons\n- [I:5] one\n", index: INDEX_HEADER });
    const rHeader = run(cwdHeader);
    assert.match(rHeader.stdout, /INFO\s+\[lessons-eviction\][^\n]*no previous close on record/,
      `expected baseline-unavailable INFO with header-only INDEX.md, got:\n${rHeader.stdout}`);
    assert.doesNotMatch(rHeader.stdout, /(WARN|ERROR)\s+\[lessons-eviction\]/,
      "no baseline is INFO only");
  });
});

// ---------------------------------------------------------------------------
// checkVerificationVerdict — unfilled PENDING bullets (F-03) and the
// narrative-above-bullets false positive (F-04).
//
// The skeleton fixture is bootstrap's REAL `verification` template, imported
// rather than hand-copied: a hand-copied skeleton would drift from bootstrap
// and stop testing the file agents actually get.
// ---------------------------------------------------------------------------

describe("validate-plan.mjs checkVerificationVerdict PENDING + bullet scoping", () => {
  let tempDirs = [];
  function getTempDir() { const d = makeTempDir(); tempDirs.push(d); return d; }
  afterEach(() => { for (const d of tempDirs) removeTempDir(d); tempDirs = []; });

  const verdictLines = (stdout) => stdout.split("\n").filter((l) => /\[verdict\]/.test(l));

  function writeVerification(planDir, body) {
    writeFileSync(join(planDir, "verification.md"), body);
  }

  it("(a) fresh-bootstrap skeleton at PLAN → no [verdict] issue (PENDING is correct before REFLECT)", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd, { state: "PLAN" });
    writeVerification(planDir, PLAN_TEMPLATES.verification);
    const r = run(cwd);
    assert.deepEqual(verdictLines(r.stdout), [],
      `a just-bootstrapped Verdict must be silent at PLAN, got:\n${r.stdout}`);
  });

  it("(a') same skeleton at EXECUTE → still silent", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd, { state: "EXECUTE" });
    writeVerification(planDir, PLAN_TEMPLATES.verification);
    const r = run(cwd);
    assert.deepEqual(verdictLines(r.stdout), [],
      `a just-bootstrapped Verdict must be silent at EXECUTE, got:\n${r.stdout}`);
  });

  it("(b) same skeleton at REFLECT → one WARN naming the PENDING bullets", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd, { state: "REFLECT" });
    writeVerification(planDir, PLAN_TEMPLATES.verification);
    const r = run(cwd);
    const lines = verdictLines(r.stdout);
    assert.equal(lines.length, 1, `expected exactly one [verdict] line, got:\n${r.stdout}`);
    assert.match(lines[0], /WARN/, `REFLECT is WARN (the verifier may be mid-fill), got: ${lines[0]}`);
    assert.match(lines[0], /PENDING/);
    for (const label of ["Criteria passed", "Regressions", "Scope drift", "Simplification blockers", "Recommendation"]) {
      assert.ok(lines[0].includes(label), `the WARN must name the bullet "${label}", got: ${lines[0]}`);
    }
  });

  it("(c) same skeleton at CLOSE → ERROR", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd, { state: "CLOSE" });
    writeVerification(planDir, PLAN_TEMPLATES.verification);
    const r = run(cwd);
    const lines = verdictLines(r.stdout);
    assert.equal(lines.length, 1, `expected exactly one [verdict] line, got:\n${r.stdout}`);
    assert.match(lines[0], /ERROR/, `CLOSE must be an ERROR, got: ${lines[0]}`);
    assert.match(lines[0], /PENDING/);
  });

  it("(c') a partially-filled Verdict at CLOSE names ONLY the still-PENDING bullets", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd, { state: "CLOSE" });
    writeVerification(planDir,
`# Verification
## Verdict
- Criteria passed: 5/5
- Regressions: none
- Scope drift: PENDING
- Simplification blockers: none
- Recommendation: → CLOSE
`);
    const r = run(cwd);
    const lines = verdictLines(r.stdout);
    assert.equal(lines.length, 1, `expected exactly one [verdict] line, got:\n${r.stdout}`);
    assert.match(lines[0], /ERROR/);
    assert.ok(lines[0].includes("Scope drift"), `got: ${lines[0]}`);
    assert.ok(!lines[0].includes("Regressions"), `filled bullets must not be named, got: ${lines[0]}`);
  });

  it("(d) narrative sentence above 5 correctly-ordered filled bullets → zero [verdict] issues", () => {
    // F-04 reproduction, verbatim from findings/validator-internals.md: the word
    // "regressions" in the prose used to be matched before "criteria passed" on
    // the first bullet, tripping the order check on well-formed content.
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd, { state: "REFLECT" });
    writeVerification(planDir,
`# Verification
## Verdict
Note: no regressions were introduced by this change, and scope drift was avoided throughout.

- Criteria passed: 5/5
- Regressions: none
- Scope drift: none
- Simplification blockers: none
- Recommendation: → CLOSE
`);
    const r = run(cwd);
    assert.deepEqual(verdictLines(r.stdout), [],
      `narrative above correctly-ordered bullets must be clean, got:\n${r.stdout}`);
  });

  it("(e) genuinely out-of-order filled bullets → still ERROR [verdict]", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd, { state: "REFLECT" });
    writeVerification(planDir,
`# Verification
## Verdict
- Regressions: none
- Criteria passed: 5/5
- Scope drift: none
- Simplification blockers: none
- Recommendation: → CLOSE
`);
    const r = run(cwd);
    const lines = verdictLines(r.stdout);
    assert.ok(lines.some((l) => /ERROR/.test(l) && /not in required order/.test(l)),
      `real out-of-order bullets must still ERROR, got:\n${r.stdout}`);
  });

  it("(e') `*` bullet markers and leading whitespace are recognized", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd, { state: "CLOSE" });
    writeVerification(planDir,
`# Verification
## Verdict
  * Criteria passed: PENDING (N/M)
  * Regressions: none
  * Scope drift: none
  * Simplification blockers: none
  * Recommendation: → CLOSE
`);
    const r = run(cwd);
    const lines = verdictLines(r.stdout);
    assert.equal(lines.length, 1, `expected exactly one [verdict] line, got:\n${r.stdout}`);
    assert.match(lines[0], /ERROR/);
    assert.ok(lines[0].includes("Criteria passed"), `got: ${lines[0]}`);
  });

  // -------------------------------------------------------------------------
  // Regression barrier (D-009): the v2.57.7 fix narrowed the bullet predicate
  // to /^\s*[-*]\s+/, which turned previously-CLEAN numbered-list and `+`
  // Verdicts into a hard `missing required bullet(s)` ERROR. Nothing caught it
  // because every test added with that fix asserted NEW behavior only. This
  // corpus asserts the OLD passing behavior is preserved, format by format.
  // -------------------------------------------------------------------------
  const CLEAN_VERDICT_FORMATS = {
    "`-` bullets": [
      "- Criteria passed: 5/5", "- Regressions: none", "- Scope drift: none",
      "- Simplification blockers: none", "- Recommendation: → CLOSE",
    ],
    "`*` bullets": [
      "* Criteria passed: 5/5", "* Regressions: none", "* Scope drift: none",
      "* Simplification blockers: none", "* Recommendation: → CLOSE",
    ],
    "`+` bullets": [
      "+ Criteria passed: 5/5", "+ Regressions: none", "+ Scope drift: none",
      "+ Simplification blockers: none", "+ Recommendation: → CLOSE",
    ],
    "numbered list `1.`": [
      "1. Criteria passed: 5/5", "2. Regressions: none", "3. Scope drift: none",
      "4. Simplification blockers: none", "5. Recommendation: → CLOSE",
    ],
    "numbered list `1)`": [
      "1) Criteria passed: 5/5", "2) Regressions: none", "3) Scope drift: none",
      "4) Simplification blockers: none", "5) Recommendation: → CLOSE",
    ],
    // The bold form is what `references/file-formats.md` prose uses, and it was
    // never covered by a test.
    "bold labels": [
      "- **Criteria passed**: 5/5", "- **Regressions**: none", "- **Scope drift**: none",
      "- **Simplification blockers**: none", "- **Recommendation**: → CLOSE",
    ],
  };

  it("(f) previously-clean Verdict formats stay clean at REFLECT and CLOSE", () => {
    for (const [name, lines] of Object.entries(CLEAN_VERDICT_FORMATS)) {
      for (const state of ["REFLECT", "CLOSE"]) {
        const cwd = getTempDir();
        const { planDir } = writePlan(cwd, { state });
        writeVerification(planDir, `# Verification\n## Verdict\n${lines.join("\n")}\n`);
        const r = run(cwd);
        assert.deepEqual(verdictLines(r.stdout), [],
          `a filled, correctly-ordered Verdict written as ${name} must be clean at ${state}, got:\n${r.stdout}`);
      }
    }
  });

  it("(g) a nested sub-bullet noting deferred work is not a Verdict field → zero [verdict] issues at CLOSE", () => {
    // The PENDING scan used to iterate EVERY bullet-shaped line, so this
    // fully-filled Verdict produced a CLOSE-blocking
    // `still unfilled (PENDING) at CLOSE: follow-up`.
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd, { state: "CLOSE" });
    writeVerification(planDir,
`# Verification
## Verdict
- Criteria passed: 12/12
  - follow-up: PENDING a separate plan for the 39 anchor errors
- Regressions: none
- Scope drift: none
- Simplification blockers: none
- Recommendation: → CLOSE
`);
    const r = run(cwd);
    assert.deepEqual(verdictLines(r.stdout), [],
      `a nested sub-bullet must not be treated as an unfilled Verdict bullet, got:\n${r.stdout}`);
  });

  // -------------------------------------------------------------------------
  // Fenced-code awareness (D-012): a fenced EXAMPLE inside the Verdict section
  // was parsed as real Verdict bullets, so a fully-filled Verdict hard-ERRORed
  // at CLOSE. This is the one false positive the v2.57.7/2.57.8 work
  // introduced (clean at 0d2c73d), so it gets both a positive and a negative
  // test — the fence must be skipped WITHOUT disabling the check.
  // -------------------------------------------------------------------------
  it("(i) a fenced example inside the Verdict is not parsed as Verdict bullets → clean at CLOSE", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd, { state: "CLOSE" });
    writeVerification(planDir,
`# Verification
## Verdict
The skeleton form looks like this:

\`\`\`
- Criteria passed: PENDING
\`\`\`

- Criteria passed: 12/12
- Regressions: none
- Scope drift: none
- Simplification blockers: none
- Recommendation: → CLOSE
`);
    const r = run(cwd);
    assert.deepEqual(verdictLines(r.stdout), [],
      `a fenced example must not be read as Verdict bullets, got:\n${r.stdout}`);
  });

  it("(i') `~~~` fences are skipped too", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd, { state: "CLOSE" });
    writeVerification(planDir,
`# Verification
## Verdict
~~~
- Criteria passed: PENDING
~~~

- Criteria passed: 12/12
- Regressions: none
- Scope drift: none
- Simplification blockers: none
- Recommendation: → CLOSE
`);
    const r = run(cwd);
    assert.deepEqual(verdictLines(r.stdout), [],
      `a ~~~ fenced example must not be read as Verdict bullets, got:\n${r.stdout}`);
  });

  it("(j) a fence plus a genuinely PENDING real bullet → still ERROR at CLOSE (fence skipped, check intact)", () => {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd, { state: "CLOSE" });
    writeVerification(planDir,
`# Verification
## Verdict
\`\`\`
- Regressions: PENDING
\`\`\`

- Criteria passed: 12/12
- Regressions: none
- Scope drift: PENDING
- Simplification blockers: none
- Recommendation: → CLOSE
`);
    const r = run(cwd);
    const lines = verdictLines(r.stdout);
    assert.equal(lines.length, 1, `expected exactly one [verdict] line, got:\n${r.stdout}`);
    assert.match(lines[0], /ERROR/);
    assert.ok(lines[0].includes("Scope drift"),
      `the real PENDING bullet must still be reported, got: ${lines[0]}`);
    assert.ok(!lines[0].includes("Regressions"),
      `the fenced example must not be reported, got: ${lines[0]}`);
  });

  it("(k) an UNTERMINATED fence marks nothing — the real bullets below it are still scanned", () => {
    // Deliberate, pinned behavior: swallowing to end-of-section would empty the
    // bullet list and trade one false positive for a `missing required
    // bullet(s)` false positive plus a silent PENDING miss.
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd, { state: "CLOSE" });
    writeVerification(planDir,
`# Verification
## Verdict
\`\`\`
- Criteria passed: 12/12
- Regressions: none
- Scope drift: none
- Simplification blockers: none
- Recommendation: → CLOSE
`);
    const r = run(cwd);
    assert.deepEqual(verdictLines(r.stdout), [],
      `an unterminated fence must not hide the real bullets below it, got:\n${r.stdout}`);
  });

  it("(h) a required keyword inside a bullet's VALUE does not trip the order check", () => {
    // F-04's class, not just its verbatim reproduction: "recommended" in the
    // first bullet's value matched before the Recommendation LABEL.
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd, { state: "REFLECT" });
    writeVerification(planDir,
`# Verification
## Verdict
- Criteria passed: 5/5 as recommended by the reviewer
- Regressions: none
- Scope drift: none
- Simplification blockers: none
- Recommendation: → CLOSE
`);
    const r = run(cwd);
    assert.deepEqual(verdictLines(r.stdout), [],
      `keywords must be matched against the bullet LABEL, not free bullet text, got:\n${r.stdout}`);
  });
});

// ---------------------------------------------------------------------------
// The Verdict FIELD-LIST corpus (plan-2026-08-04-0063b038 step 6, D-011).
//
// checkVerificationVerdict now derives ONE field list — bullets whose LABEL
// matches a required keyword AND that sit at the shallowest indent among
// keyword-matching bullets — and drives presence, order and PENDING from it.
// Before that, both scans re-ran the same unanchored keyword regex over every
// bullet at every depth, so a nested sub-bullet whose label merely CONTAINED a
// keyword ("Recommendation-related follow-up") produced a CLOSE-blocking false
// `not in required order` and/or `still unfilled (PENDING)` on a Verdict whose
// five real fields were present, filled and ordered.
//
// This table is the corpus of the differential run recorded in the plan's
// verification.md (criterion C-6): every row is materialised as a real plan dir
// at CLOSE and run through BOTH the pre-change and post-change validator. It is
// exported so that harness uses the SAME rows the suite asserts on — a
// hand-copied second corpus would drift and stop testing what shipped.
//
// The six `-` / `*` / `+` / numbered / bold shapes are restated here rather
// than hoisted out of CLEAN_VERDICT_FORMATS above: that constant sits inside
// the test range the plan protects from edits (criterion C-7 requires the 15
// pre-existing checkVerificationVerdict tests to pass unmodified), so it is
// left byte-untouched.
// ---------------------------------------------------------------------------

// The five canonical fields, correctly filled and correctly ordered.
function fiveFields({ indent = "", marker = "-", bold = false } = {}) {
  const labels = ["Criteria passed", "Regressions", "Scope drift", "Simplification blockers", "Recommendation"];
  const values = ["12/12", "none", "none", "none", "→ CLOSE"];
  return labels.map((label, i) => {
    const m = marker === "1." ? `${i + 1}.` : marker === "1)" ? `${i + 1})` : marker;
    const lab = bold ? `**${label}**` : label;
    return `${indent}${m === "" ? "" : m + " "}${lab}: ${values[i]}`;
  });
}

// Splice extra lines in directly after index `i`.
const after = (arr, i, ...extra) => [...arr.slice(0, i + 1), ...extra, ...arr.slice(i + 1)];

const FENCE = "```";
const TILDE_FENCE = "~~~";
const MISSING_ALL = /missing required bullet\(s\): Criteria passed, Regressions, Scope drift, Simplification blockers, Recommended transition/;

// Each row: { name, body, expect }.
//   body   — the text of the `## Verdict` section (the fixture writes
//            `# Verification\n## Verdict\n${body}\n`).
//   expect — "CLEAN" (zero [verdict] lines at CLOSE), or
//            { count, match: [RegExp], notMatch: [RegExp] } asserted against
//            the [verdict] lines at CLOSE.
export const VERDICT_CORPUS = [
  // --- the 19 shapes of the G-07 format-tolerance matrix -------------------
  { name: "`-` bullets", body: fiveFields().join("\n"), expect: "CLEAN" },
  { name: "`*` bullets", body: fiveFields({ marker: "*" }).join("\n"), expect: "CLEAN" },
  { name: "`+` bullets", body: fiveFields({ marker: "+" }).join("\n"), expect: "CLEAN" },
  { name: "numbered list `1.`", body: fiveFields({ marker: "1." }).join("\n"), expect: "CLEAN" },
  { name: "numbered list `1)`", body: fiveFields({ marker: "1)" }).join("\n"), expect: "CLEAN" },
  { name: "bold labels with a `-` marker", body: fiveFields({ bold: true }).join("\n"), expect: "CLEAN" },
  {
    name: "bold labels with NO bullet marker (plain paragraphs)",
    body: fiveFields({ marker: "", bold: true }).join("\n"),
    expect: { count: 1, match: [/ERROR/, MISSING_ALL] },
  },
  { name: "uniform 2-space indent", body: fiveFields({ indent: "  " }).join("\n"), expect: "CLEAN" },
  { name: "uniform 4-space indent", body: fiveFields({ indent: "    " }).join("\n"), expect: "CLEAN" },
  { name: "uniform tab indent", body: fiveFields({ indent: "\t" }).join("\n"), expect: "CLEAN" },
  {
    name: "nested sub-bullet, keyword-free label",
    body: after(fiveFields(), 0, "  - follow-up: PENDING a separate plan").join("\n"),
    expect: "CLEAN",
  },
  {
    name: "nested sub-bullet whose LABEL collides with a required keyword",
    body: after(fiveFields(), 0, "  - Recommendation-related follow-up: PENDING a separate plan").join("\n"),
    expect: "CLEAN",
  },
  {
    name: "fenced ``` example above the real bullets",
    body: ["The skeleton form looks like this:", "", FENCE, "- Criteria passed: PENDING", FENCE, "", ...fiveFields()].join("\n"),
    expect: "CLEAN",
  },
  {
    name: "fenced ~~~ example above the real bullets",
    body: [TILDE_FENCE, "- Criteria passed: PENDING", TILDE_FENCE, "", ...fiveFields()].join("\n"),
    expect: "CLEAN",
  },
  {
    name: "markdown table instead of bullets",
    body: ["| Field | Value |", "|---|---|", "| Criteria passed | 12/12 |", "| Regressions | none |",
      "| Scope drift | none |", "| Simplification blockers | none |", "| Recommendation | → CLOSE |"].join("\n"),
    expect: { count: 1, match: [/ERROR/, MISSING_ALL] },
  },
  {
    name: "blockquoted bullets",
    body: fiveFields().map((l) => `> ${l}`).join("\n"),
    expect: { count: 1, match: [/ERROR/, MISSING_ALL] },
  },
  {
    name: "narrative sentence above the bullets",
    body: ["Note: no regressions were introduced by this change, and scope drift was avoided throughout.", "", ...fiveFields()].join("\n"),
    expect: "CLEAN",
  },
  {
    name: "genuinely out-of-order fields",
    body: (() => { const f = fiveFields(); return [f[1], f[0], f[2], f[3], f[4]].join("\n"); })(),
    expect: { count: 1, match: [/ERROR/, /not in required order/] },
  },
  {
    name: "required keyword inside a field's VALUE",
    body: (() => { const f = fiveFields(); f[0] = "- Criteria passed: 12/12 as recommended by the reviewer"; return f.join("\n"); })(),
    expect: "CLEAN",
  },

  // --- shapes added by this step ------------------------------------------
  {
    name: "nested collision whose MARKER differs from its parent's",
    body: after(fiveFields(), 0, "  * Recommendation-adjacent note: PENDING follow-up").join("\n"),
    expect: "CLEAN",
  },
  {
    name: "nested collision two levels deep",
    body: after(fiveFields(), 0, "  - detail: the criteria breakdown", "    - Recommendation for later: PENDING another plan").join("\n"),
    expect: "CLEAN",
  },
  {
    name: "required keyword inside a NESTED bullet's VALUE (label keyword-free)",
    body: after(fiveFields(), 0, "  - note: the reviewer recommended a soak test, and regressions were watched").join("\n"),
    expect: "CLEAN",
  },
  {
    name: "uniform 2-space indent COMBINED with a nested collision",
    body: after(fiveFields({ indent: "  " }), 0, "    - Regressions noted in passing: PENDING triage").join("\n"),
    expect: "CLEAN",
  },
  {
    name: "mixed tab/space nesting (space-free fields, tab-indented collision)",
    body: after(fiveFields(), 0, "\t- Recommendation follow-up: PENDING soak testing").join("\n"),
    expect: "CLEAN",
  },
  {
    name: "uniform tab indent with a collision nested one level deeper",
    body: after(fiveFields({ indent: "\t" }), 0, "\t\t- Scope drift watch item: PENDING the next iteration").join("\n"),
    expect: "CLEAN",
  },
  {
    name: "collision positioned BEFORE the real field it collides with",
    body: after(fiveFields(), 2, "  - Recommendation timing: PENDING the reviewer's note").join("\n"),
    expect: "CLEAN",
  },
  {
    name: "collision positioned AFTER the real field it collides with",
    body: after(fiveFields(), 4, "  - Recommendation rationale: PENDING the reviewer's note").join("\n"),
    expect: "CLEAN",
  },
  {
    name: "fenced example AND a nested collision together",
    body: [FENCE, "- Criteria passed: PENDING", FENCE, "",
      ...after(fiveFields(), 0, "  - Recommendation-related follow-up: PENDING a separate plan")].join("\n"),
    expect: "CLEAN",
  },
  {
    name: "five fields nested under a keyword-free lead-in bullet",
    body: ["- Verdict:", ...fiveFields({ indent: "  " })].join("\n"),
    expect: "CLEAN",
  },
  {
    name: "keyword-free lead-in bullet, nested fields, AND a deeper collision",
    body: ["- Verdict:", ...after(fiveFields({ indent: "  " }), 0, "    - Regressions follow-up: PENDING triage")].join("\n"),
    expect: "CLEAN",
  },
  {
    name: "numbered fields with a nested `-` collision",
    body: after(fiveFields({ marker: "1." }), 0, "   - Recommendation-related follow-up: PENDING a separate plan").join("\n"),
    expect: "CLEAN",
  },
  {
    name: "collision carrying a PENDING value under a filled field (the reproduced PENDING variant)",
    body: after(fiveFields(), 0, "  - Regressions: PENDING further soak testing").join("\n"),
    expect: "CLEAN",
  },
  {
    name: "a genuinely PENDING real field alongside a nested collision (the check stays intact)",
    body: (() => {
      const f = fiveFields();
      f[2] = "- Scope drift: PENDING";
      return after(f, 0, "  - Regressions follow-up: PENDING soak testing").join("\n");
    })(),
    expect: { count: 1, match: [/ERROR/, /still unfilled \(PENDING\)/, /Scope drift/], notMatch: [/follow-up/] },
  },
  {
    name: "a nested collision is the ONLY occurrence of a required label",
    body: [fiveFields()[0], "  - Recommendation-related follow-up: tracked in another plan",
      ...fiveFields().slice(1, 4)].join("\n"),
    expect: { count: 1, match: [/ERROR/, /missing required bullet\(s\): Recommended transition/] },
  },
];

describe("validate-plan.mjs Verdict field-list discriminator corpus (D-011)", () => {
  let tempDirs = [];
  function getTempDir() { const d = makeTempDir(); tempDirs.push(d); return d; }
  afterEach(() => { for (const d of tempDirs) removeTempDir(d); tempDirs = []; });

  const verdictLines = (stdout) => stdout.split("\n").filter((l) => /\[verdict\]/.test(l));

  function runCorpusRow(row, state) {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd, { state });
    writeFileSync(join(planDir, "verification.md"), `# Verification\n## Verdict\n${row.body}\n`);
    return verdictLines(run(cwd).stdout);
  }

  it("every corpus row produces exactly its expected [verdict] outcome at CLOSE", () => {
    for (const row of VERDICT_CORPUS) {
      const lines = runCorpusRow(row, "CLOSE");
      if (row.expect === "CLEAN") {
        assert.deepEqual(lines, [], `"${row.name}" must be CLEAN at CLOSE, got:\n${lines.join("\n")}`);
        continue;
      }
      assert.equal(lines.length, row.expect.count,
        `"${row.name}" expected ${row.expect.count} [verdict] line(s), got:\n${lines.join("\n")}`);
      const joined = lines.join("\n");
      for (const re of row.expect.match || []) {
        assert.match(joined, re, `"${row.name}" expected ${re} in:\n${joined}`);
      }
      for (const re of row.expect.notMatch || []) {
        assert.doesNotMatch(joined, re, `"${row.name}" must NOT contain ${re} in:\n${joined}`);
      }
    }
  });

  it("every CLEAN corpus row is also clean at REFLECT", () => {
    for (const row of VERDICT_CORPUS.filter((r) => r.expect === "CLEAN")) {
      const lines = runCorpusRow(row, "REFLECT");
      assert.deepEqual(lines, [], `"${row.name}" must be CLEAN at REFLECT too, got:\n${lines.join("\n")}`);
    }
  });

  it("the corpus keeps its floor and its named shapes (anti-vacuity for C-6)", () => {
    assert.ok(VERDICT_CORPUS.length >= 30,
      `the corpus is the differential's substrate — it must keep at least 30 rows, has ${VERDICT_CORPUS.length}`);
    const names = VERDICT_CORPUS.map((r) => r.name).join(" | ");
    for (const shape of [
      "two levels deep",            // deeper-than-one-level nesting
      "MARKER differs",             // nested marker differing from its parent
      "NESTED bullet's VALUE",      // keyword in a nested value, not a label
      "uniform 2-space indent COMBINED",
      "mixed tab/space nesting",
      "lead-in bullet",
      "ONLY occurrence",
    ]) {
      assert.ok(names.includes(shape),
        `C-6's falsifier names this shape — the corpus must keep a row for "${shape}"`);
    }
    assert.equal(new Set(VERDICT_CORPUS.map((r) => r.name)).size, VERDICT_CORPUS.length,
      "corpus row names must be unique — the differential report keys on them");
  });

  it("the label-tightness rule accepts the five real labels and rejects every observed decoy", () => {
    // The discriminating axis, asserted directly rather than only through
    // whole-file fixtures: a real field's label IS the required label (plus
    // trivial decoration); a decoy is that label embedded in a longer phrase.
    // Position never enters into it — the same label is accepted at indent 0 and
    // rejected at indent 0, whatever its neighbours look like.
    // [field index this label writes, label text]
    const accepted = [
      [0, "Criteria passed"], [0, "Criteria pass count"], [0, "**Criteria passed**"],
      [0, "Criteria passed (C-1..C-13)"], [0, "criteria passed."],
      [1, "Regressions"], [1, "Regression"],
      [2, "Scope drift"], [2, "`Scope drift`"], [2, "SCOPE DRIFT"], [2, "Scope  drift"],
      [3, "Simplification blockers"], [3, "Simplification blocker"],
      [4, "Recommendation"], [4, "Recommended"], [4, "Recommended transition"],
      [4, "Recommended state"],
    ];
    // [field index the decoy would be mistaken for, label text, name reported missing]
    const rejected = [
      [0, "Criteria passed summary", "Criteria passed"], [0, "Criteria passed overall", "Criteria passed"],
      [0, "Criteria passed rollup", "Criteria passed"],
      [4, "Recommendation-related follow-up", "Recommended transition"],
      [4, "Recommendation-adjacent note", "Recommended transition"],
      [4, "Recommendation for later", "Recommended transition"],
      [4, "Recommendation follow-up", "Recommended transition"],
      [4, "Recommendation timing", "Recommended transition"],
      [4, "Recommendation rationale", "Recommended transition"],
      [4, "Recommendation deferred to the follow-up plan", "Recommended transition"],
      [1, "Regressions noted in passing", "Regressions"], [1, "Regressions follow-up", "Regressions"],
      [1, "Regressions and next steps", "Regressions"],
      [2, "Scope drift watch item", "Scope drift"],
      [1, "Verdict", "Regressions"], [1, "follow-up", "Regressions"],
      [1, "detail", "Regressions"], [1, "note", "Regressions"],
    ];
    const runWith = (i, label) => {
      const cwd = getTempDir();
      const { planDir } = writePlan(cwd, { state: "CLOSE" });
      const f = fiveFields();
      f[i] = `- ${label}: none`;
      writeFileSync(join(planDir, "verification.md"), `# Verification\n## Verdict\n${f.join("\n")}\n`);
      return verdictLines(run(cwd).stdout);
    };
    for (const [i, label] of accepted) {
      assert.deepEqual(runWith(i, label), [],
        `"${label}" must be read as a Verdict field label, got a [verdict] issue`);
    }
    for (const [i, label, reported] of rejected) {
      const lines = runWith(i, label);
      assert.ok(lines.some((l) => l.includes(`missing required bullet(s): ${reported}`)),
        `"${label}" is commentary, not the ${reported} field — expected it reported missing, got:\n${lines.join("\n")}`);
    }
  });

  it("a Verdict whose ONLY keyword-carrying tail bullet is a nested collision now ERRORs (true positive gained)", () => {
    // Deliberately NOT a corpus row: this fixture is a Verdict with FOUR real
    // fields, which the pre-change validator accepted silently because the
    // nested collision satisfied the fifth keyword at a monotonic position.
    // Post-change it reports the field that is genuinely absent. Pinned here so
    // the behavior change is visible and reviewable rather than incidental.
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd, { state: "CLOSE" });
    writeFileSync(join(planDir, "verification.md"),
      "# Verification\n## Verdict\n" +
      fiveFields().slice(0, 4).join("\n") + "\n" +
      "  - Recommendation deferred to the follow-up plan: tracked separately\n");
    const lines = verdictLines(run(cwd).stdout);
    assert.equal(lines.length, 1, `expected exactly one [verdict] line, got:\n${lines.join("\n")}`);
    assert.match(lines[0], /ERROR/);
    assert.match(lines[0], /missing required bullet\(s\): Recommended transition/,
      `a Verdict with only four real fields must name the absent one, got: ${lines[0]}`);
  });
});

// ---------------------------------------------------------------------------
// The INDEPENDENT Verdict acceptance corpus (plan-2026-08-04-0063b038 step 6.1,
// D-013).
//
// Authored by the orchestrator from the SPEC (references/file-formats.md: exactly
// five bullets, in order) BEFORE any fix design existed, precisely so the fix
// could not be graded by fixtures its own author chose. Step 6's corpus above was
// written in the same commit as the rule it validated, and contained no row where
// a real field sits DEEPER than a keyword-carrying bullet — which is why the
// min-indent discriminator shipped with six CLOSE-blocking false positives.
//
// Rows C01-C20 must be CLEAN; rows E01-E05 must ERROR. Keep both corpora: this
// one states what a Verdict IS, the one above records the shapes that have
// actually broken.
// ---------------------------------------------------------------------------

// Each row: { name, body | rawBody, expect }. `rawBody` is the whole file (used
// where the line endings or the trailing newline are the point).
export const ACCEPTANCE_CORPUS = [
  { name: "C01 flat, all five at indent 0", body: fiveFields().join("\n"), expect: "CLEAN" },
  { name: "C02 uniform 2-space indent", body: fiveFields({ indent: "  " }).join("\n"), expect: "CLEAN" },
  { name: "C03 uniform 4-space indent", body: fiveFields({ indent: "    " }).join("\n"), expect: "CLEAN" },
  { name: "C04 uniform tab indent", body: fiveFields({ indent: "\t" }).join("\n"), expect: "CLEAN" },
  {
    name: "C05 RAGGED: four fields at indent 0, the LAST at indent 2",
    body: [...fiveFields().slice(0, 4), ...fiveFields({ indent: "  " }).slice(4)].join("\n"),
    expect: "CLEAN",
  },
  {
    name: "C06 RAGGED: four fields at 2 spaces, one TAB-indented",
    body: (() => {
      const f = fiveFields({ indent: "  " });
      f[2] = fiveFields({ indent: "\t" })[2];
      return f.join("\n");
    })(),
    expect: "CLEAN",
  },
  {
    name: "C07 five fields nested under a keyword-FREE lead-in bullet",
    body: ["- Verdict:", ...fiveFields({ indent: "  " })].join("\n"),
    expect: "CLEAN",
  },
  {
    name: "C08 lead-in whose OWN label carries the FIRST required label",
    body: ["- Criteria passed summary:", ...fiveFields({ indent: "  " })].join("\n"),
    expect: "CLEAN",
  },
  {
    name: "C09 all five plus a keyword-FREE nested sub-bullet",
    body: after(fiveFields(), 0, "  - follow-up: PENDING a separate plan").join("\n"),
    expect: "CLEAN",
  },
  {
    name: "C10 all five plus a nested sub-bullet whose label CONTAINS a required label",
    body: after(fiveFields(), 0, "  - Recommendation-related follow-up: PENDING a separate plan").join("\n"),
    expect: "CLEAN",
  },
  {
    name: "C11 a required keyword appears in a bullet's VALUE, not its label",
    body: (() => { const f = fiveFields(); f[0] = "- Criteria passed: 12/12 as recommended by the reviewer"; return f.join("\n"); })(),
    expect: "CLEAN",
  },
  {
    name: "C12 a fenced code block inside the Verdict containing example bullets",
    body: ["The skeleton form looks like this:", "", FENCE, "- Criteria passed: PENDING",
      "- Recommendation: PENDING", FENCE, "", ...fiveFields()].join("\n"),
    expect: "CLEAN",
  },
  { name: "C13a numbered fields `1.`", body: fiveFields({ marker: "1." }).join("\n"), expect: "CLEAN" },
  { name: "C13b numbered fields `1)`", body: fiveFields({ marker: "1)" }).join("\n"), expect: "CLEAN" },
  { name: "C14a `+` bullet markers", body: fiveFields({ marker: "+" }).join("\n"), expect: "CLEAN" },
  { name: "C14b `*` bullet markers", body: fiveFields({ marker: "*" }).join("\n"), expect: "CLEAN" },
  { name: "C15 bold labels carrying a bullet prefix", body: fiveFields({ bold: true }).join("\n"), expect: "CLEAN" },
  {
    name: "C16 a narrative sentence above the five bullets",
    body: ["Note: no regressions were introduced by this change, and scope drift was avoided throughout.", "", ...fiveFields()].join("\n"),
    expect: "CLEAN",
  },
  {
    name: "C17 CRLF line endings throughout",
    rawBody: ["# Verification", "## Verdict", ...fiveFields(), ""].join("\r\n"),
    expect: "CLEAN",
  },
  {
    name: "C18 Verdict is the LAST section, no trailing newline",
    rawBody: ["# Verification", "## Notes", "nothing of note", "", "## Verdict", ...fiveFields()].join("\n"),
    expect: "CLEAN",
  },
  {
    name: "C19 two-level nesting: lead-in -> keyword-matching sub-lead-in -> the five fields",
    body: ["- Verdict:", "  - Criteria passed rollup:", ...fiveFields({ indent: "    " })].join("\n"),
    expect: "CLEAN",
  },
  {
    name: "C20a a label matching TWO required labels is counted once (extra compound bullet)",
    body: [...fiveFields(), "- Regressions and scope drift: none in either"].join("\n"),
    expect: "CLEAN",
  },
  {
    name: "C20b a label matching TWO required labels is counted once (compound stands in for both)",
    body: (() => {
      const f = fiveFields();
      return [f[0], "- Regressions and scope drift: none in either", f[3], f[4]].join("\n");
    })(),
    expect: "CLEAN",
  },

  {
    name: "E01 a required field genuinely absent",
    body: (() => { const f = fiveFields(); f.splice(2, 1); return f.join("\n"); })(),
    expect: { count: 1, match: [/ERROR/, /missing required bullet\(s\): Scope drift/] },
  },
  {
    name: "E02 the five fields present but OUT OF ORDER",
    body: (() => { const f = fiveFields(); return [f[1], f[0], f[2], f[3], f[4]].join("\n"); })(),
    expect: { count: 1, match: [/ERROR/, /not in required order/] },
  },
  {
    name: "E03 a field still literally PENDING at CLOSE",
    body: (() => { const f = fiveFields(); f[2] = "- Scope drift: PENDING"; return f.join("\n"); })(),
    expect: { count: 1, match: [/ERROR/, /still unfilled \(PENDING\)/, /Scope drift/] },
  },
  {
    name: "E04 only FOUR real fields; the fifth label occurs ONLY in a decoy sub-bullet",
    body: [...fiveFields().slice(0, 4), "  - Recommendation deferred to the follow-up plan: tracked separately"].join("\n"),
    expect: { count: 1, match: [/ERROR/, /missing required bullet\(s\): Recommended transition/] },
  },
  {
    name: "E05 no bullets at all in the Verdict section",
    body: "Everything passed and the plan is done.",
    expect: { count: 1, match: [/ERROR/, MISSING_ALL] },
  },
];

describe("validate-plan.mjs Verdict independent acceptance corpus (D-013)", () => {
  let tempDirs = [];
  function getTempDir() { const d = makeTempDir(); tempDirs.push(d); return d; }
  afterEach(() => { for (const d of tempDirs) removeTempDir(d); tempDirs = []; });

  const verdictLines = (stdout) => stdout.split("\n").filter((l) => /\[verdict\]/.test(l));

  function runRow(row, state) {
    const cwd = getTempDir();
    const { planDir } = writePlan(cwd, { state });
    writeFileSync(join(planDir, "verification.md"),
      row.rawBody !== undefined ? row.rawBody : `# Verification\n## Verdict\n${row.body}\n`);
    return verdictLines(run(cwd).stdout);
  }

  it("every acceptance row produces exactly its expected [verdict] outcome at CLOSE", () => {
    for (const row of ACCEPTANCE_CORPUS) {
      const lines = runRow(row, "CLOSE");
      if (row.expect === "CLEAN") {
        assert.deepEqual(lines, [], `"${row.name}" must be CLEAN at CLOSE, got:\n${lines.join("\n")}`);
        continue;
      }
      assert.equal(lines.length, row.expect.count,
        `"${row.name}" expected ${row.expect.count} [verdict] line(s), got:\n${lines.join("\n")}`);
      const joined = lines.join("\n");
      for (const re of row.expect.match || []) {
        assert.match(joined, re, `"${row.name}" expected ${re} in:\n${joined}`);
      }
    }
  });

  it("every CLEAN acceptance row is also clean at REFLECT", () => {
    for (const row of ACCEPTANCE_CORPUS.filter((r) => r.expect === "CLEAN")) {
      const lines = runRow(row, "REFLECT");
      assert.deepEqual(lines, [], `"${row.name}" must be CLEAN at REFLECT too, got:\n${lines.join("\n")}`);
    }
  });

  it("the acceptance corpus keeps all 25 authored rows (anti-vacuity)", () => {
    // The arbiter listed 20 MUST-BE-CLEAN shapes and 5 MUST-ERROR shapes. C13,
    // C14 and C20 are each carried by two rows, so the table holds 25 CLEAN-side
    // rows only if none was dropped; assert both halves by their authored ids.
    const names = ACCEPTANCE_CORPUS.map((r) => r.name);
    assert.equal(new Set(names).size, names.length, "row names must be unique");
    for (let i = 1; i <= 20; i++) {
      const id = `C${String(i).padStart(2, "0")}`;
      assert.ok(names.some((n) => n.startsWith(id)), `MUST-BE-CLEAN row ${id} is missing from the corpus`);
    }
    for (let i = 1; i <= 5; i++) {
      const id = `E${String(i).padStart(2, "0")}`;
      assert.ok(names.some((n) => n.startsWith(id)), `MUST-ERROR row ${id} is missing from the corpus`);
    }
    assert.equal(ACCEPTANCE_CORPUS.filter((r) => r.expect === "CLEAN").length, 23,
      "20 authored CLEAN shapes, three of them split across two rows each");
    assert.equal(ACCEPTANCE_CORPUS.filter((r) => r.expect !== "CLEAN").length, 5,
      "5 authored MUST-ERROR shapes");
  });
});

// v2.60.0 — [index-orphan]: a plan named by INDEX.md with NO surviving copy anywhere.
// The per-plan directory is ephemeral by design, so a missing directory alone is NORMAL and
// must stay silent. The defect is a missing directory AND a missing consolidated section.
describe("[index-orphan]: INDEX row with no surviving copy (E2 / F-1, F-2)", () => {
  const tempDirs = [];
  function getTempDir() { const d = makeTempDir(); tempDirs.push(d); return d; }
  afterEach(() => { while (tempDirs.length) removeTempDir(tempDirs.pop()); });

  const GONE = "plan-2026-07-01T101010-beefcafe";
  const INDEX_HEADER =
    "# Plan Index\n*Topic-to-directory mapping.*\n\n" +
    "| Plan | Date | Goal | Key Topics |\n|------|------|------|------------|\n";

  /** Fixture: active plan + an INDEX.md row naming GONE, with optional dir/section. */
  function writeOrphanFixture(cwd, { withDir = false, withSection = false, index } = {}) {
    const { planId } = writePlan(cwd);
    writeFileSync(
      join(cwd, "plans", "INDEX.md"),
      index !== undefined ? index : INDEX_HEADER + `| ${GONE} | 2026-07-01 | fixture goal | |\n`,
    );
    if (withDir) mkdirSync(join(cwd, "plans", GONE), { recursive: true });
    writeFileSync(
      join(cwd, "plans", "FINDINGS.md"),
      withSection
        ? `# Consolidated Findings\n\n## ${GONE}\n\n### Topic\n\n- surviving body\n`
        : `# Consolidated Findings\n*Archive.*\n`,
    );
    return planId;
  }

  it("(a) WARNs when both the directory and the consolidated section are gone", () => {
    const cwd = getTempDir();
    const planId = writeOrphanFixture(cwd);
    const r = run(cwd, planId);
    assert.match(r.stdout, /WARN\s+\[index-orphan\]/, `expected WARN, got:\n${r.stdout}`);
    assert.match(r.stdout, new RegExp(GONE), "message must name the orphaned plan");
  });

  it("(b) stays silent when the consolidated section survives (directory gone is normal)", () => {
    const cwd = getTempDir();
    const planId = writeOrphanFixture(cwd, { withSection: true });
    const r = run(cwd, planId);
    assert.doesNotMatch(r.stdout, /\[index-orphan\]/,
      `a surviving section means nothing was lost; got:\n${r.stdout}`);
  });

  it("(c) stays silent when the plan directory still exists", () => {
    const cwd = getTempDir();
    const planId = writeOrphanFixture(cwd, { withDir: true });
    const r = run(cwd, planId);
    assert.doesNotMatch(r.stdout, /\[index-orphan\]/, `got:\n${r.stdout}`);
  });

  it("(d) NEVER emits ERROR — the check must not block CLOSE on a pre-existing backlog", () => {
    const cwd = getTempDir();
    const planId = writeOrphanFixture(cwd);
    const r = run(cwd, planId);
    assert.doesNotMatch(r.stdout, /ERROR\s+\[index-orphan\]/,
      "HARD constraint: [index-orphan] is WARN-only and must never block CLOSE");
  });

  it("(e) ignores header and separator rows, and a row whose first cell is not a plan-id", () => {
    const cwd = getTempDir();
    const planId = writeOrphanFixture(cwd, {
      index: INDEX_HEADER + "| not-a-plan-id | 2026-07-01 | x | |\n| | | | |\n",
    });
    const r = run(cwd, planId);
    assert.doesNotMatch(r.stdout, /\[index-orphan\]/,
      `non-plan-id rows must be skipped, got:\n${r.stdout}`);
  });
});

// ---------------------------------------------------------------------------
// A3 / D-007 — span-aware block-comment anchor scanning.
//
// PRE-FIX EVIDENCE (captured against 4d98b1a, before this change):
//   * full-repo scan: 45 anchors, ZERO duplicates — the repo's two live phantom
//     openers (blast-radius.mjs:214's `plans/*/changelog.md`, and a sibling in this
//     file) are unterminated, so they were benign. POST-fix the same scan returns the
//     same 45 anchors plus the two D-007 anchors this change adds. That empty
//     differential is the previously-clean-stays-clean evidence for the real corpus;
//     the fixtures below are the constructed half.
//   * the phantom-OPENER fixture emitted the identical ERROR line TWICE (once from the
//     per-line slash scan, once from the phantom block body) — the "39 errors became
//     40" mechanism.
//   * the phantom-CLOSER fixture emitted NOTHING at all: the prose closer ended the
//     span early and the anchor below it was dropped. Fail-open, and invisible to
//     `bootstrap.mjs retire` too.
// ---------------------------------------------------------------------------

describe("block-comment anchor scan is span-aware (A3 / D-007)", () => {
  const tempDirs = [];
  function getTempDir() { const d = makeTempDir(); tempDirs.push(d); return d; }
  afterEach(() => { while (tempDirs.length) removeTempDir(tempDirs.pop()); });

  const PLAN = "plan_2026-05-15_aaaabbbb"; // writePlan's active plan; knows D-001 only

  const orphanLines = (stdout, id) =>
    stdout.split("\n").filter((l) => l.includes("[anchor-orphan]") && l.includes(`D-${id}`));

  it("a phantom `/*` opener in a string literal reports the anchor EXACTLY ONCE", () => {
    const cwd = getTempDir();
    writePlan(cwd);
    writeFileSync(join(cwd, "glob.js"),
      `const g = "plans/*";\n` +
      `// DECISION ${PLAN}/D-902 — one report, not two\n` +
      `const h = "a */ b";\n`);
    const r = run(cwd);
    const hits = orphanLines(r.stdout, "902");
    assert.equal(hits.length, 1, `expected exactly ONE report, got ${hits.length}:\n${hits.join("\n")}`);
  });

  it("a phantom `/*` opener inside a `//` comment reports the anchor EXACTLY ONCE", () => {
    const cwd = getTempDir();
    writePlan(cwd);
    writeFileSync(join(cwd, "prose.js"),
      `// pathspecs like plans/*/changelog.md are prose, not an opener\n` +
      `// DECISION ${PLAN}/D-903 — one report, not two\n` +
      `function f() { return 1; }\n`);
    const r = run(cwd);
    const hits = orphanLines(r.stdout, "903");
    assert.equal(hits.length, 1, `expected exactly ONE report, got ${hits.length}:\n${hits.join("\n")}`);
  });

  it("an anchor BELOW a prose `*/` inside a real block comment is still found (silent-loss fix)", () => {
    const cwd = getTempDir();
    writePlan(cwd);
    writeFileSync(join(cwd, "doc.js"),
      `/*\n` +
      ` A doc block that mentions the regex ending in star-slash: */\n` +
      ` DECISION ${PLAN}/D-904 — pre-fix this produced ZERO output\n` +
      `*/\n`);
    const r = run(cwd);
    assert.match(r.stdout, /\[anchor-orphan\][^\n]*doc\.js[^\n]*D-904/,
      `the anchor below the prose closer must be found, got:\n${r.stdout}`);
  });

  it("a genuine block comment anchor is still found, exactly once (no over-strip)", () => {
    const cwd = getTempDir();
    writePlan(cwd);
    writeFileSync(join(cwd, "block.js"),
      `/* DECISION ${PLAN}/D-905 — a plain block anchor */\nfunction f() { return 1; }\n`);
    const r = run(cwd);
    const hits = orphanLines(r.stdout, "905");
    assert.equal(hits.length, 1, `expected exactly ONE report, got ${hits.length}:\n${hits.join("\n")}`);
  });

  it("previously-clean input stays clean: three anchor forms in one file → exactly three reports", () => {
    const cwd = getTempDir();
    writePlan(cwd);
    writeFileSync(join(cwd, "mixed.js"),
      `// DECISION ${PLAN}/D-906 — line form\n` +
      `const s = "not an anchor: DECISION ${PLAN}/D-909";\n` +
      `/* DECISION ${PLAN}/D-907 — block form */\n` +
      `try { f(); } catch { /* best-effort */ }\n` +
      `if (/\\*\\*Complexity Assessment\\*\\*/.test(b)) {}\n` +
      `// DECISION ${PLAN}/D-908 — line form after a regex literal\n`);
    const r = run(cwd);
    for (const id of ["906", "907", "908"]) {
      assert.equal(orphanLines(r.stdout, id).length, 1,
        `D-${id} must be reported exactly once, got:\n${r.stdout}`);
    }
    assert.equal(orphanLines(r.stdout, "909").length, 0,
      `a DECISION token in a STRING LITERAL is not an anchor, got:\n${r.stdout}`);
  });
});

// ---------------------------------------------------------------------------
// A6 / D-008 — the anchor-orphan message names only the tiers actually read.
// ---------------------------------------------------------------------------

describe("[anchor-orphan] message is tier-accurate (A6 / D-008)", () => {
  const tempDirs = [];
  function getTempDir() { const d = makeTempDir(); tempDirs.push(d); return d; }
  afterEach(() => { while (tempDirs.length) removeTempDir(tempDirs.pop()); });

  const GONE = "plan-2026-04-04T090000-11223344";

  it("a plan resolved ONLY through plans/ANCHORS.md is not described as having a decisions.md", () => {
    const cwd = getTempDir();
    writePlan(cwd);
    writeFileSync(join(cwd, "plans", "ANCHORS.md"),
      `# Anchored Decisions\n\n${GONE}/D-004 | 2026-04-04 | durable tier entry\n`);
    writeFileSync(join(cwd, "src.js"), `// DECISION ${GONE}/D-008 — sibling id, never anchored\n`);
    const r = run(cwd);
    const line = r.stdout.split("\n").find((l) => l.includes("[anchor-orphan]") && l.includes("D-008"));
    assert.ok(line, `expected an orphan report for D-008, got:\n${r.stdout}`);
    assert.ok(line.includes("plans/ANCHORS.md"),
      `the message must name the tier that actually resolved the plan, got:\n${line}`);
    assert.ok(!line.includes("decisions.md"),
      `no plan directory or decisions.md was read — the message must not claim one, got:\n${line}`);
    assert.ok(!/plan exists but/.test(line),
      `the plan directory does not exist; the message must not assert it does, got:\n${line}`);
  });

  it("a plan resolved through its own decisions.md still names that file", () => {
    const cwd = getTempDir();
    writePlan(cwd);
    writeFileSync(join(cwd, "src.js"), `// DECISION ${"plan_2026-05-15_aaaabbbb"}/D-777 — orphan\n`);
    const r = run(cwd);
    const line = r.stdout.split("\n").find((l) => l.includes("[anchor-orphan]") && l.includes("D-777"));
    assert.ok(line, `expected an orphan report, got:\n${r.stdout}`);
    assert.ok(line.includes("plans/plan_2026-05-15_aaaabbbb/decisions.md"),
      `the message must name the per-plan decisions.md that was read, got:\n${line}`);
  });
});
