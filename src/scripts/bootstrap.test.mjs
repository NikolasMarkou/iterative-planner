#!/usr/bin/env node
// Comprehensive tests for bootstrap.mjs using Node.js built-in test runner.
// Run: node --test src/scripts/bootstrap.test.mjs
// Requires: Node.js 18+

import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { execFileSync, spawnSync } from "child_process";
import { tmpdir } from "os";
import { randomBytes } from "crypto";

// Path to bootstrap.mjs (relative to this test file)
const BOOTSTRAP = resolve(import.meta.dirname, "bootstrap.mjs");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a unique temp directory for a test, returns its path. */
function makeTempDir() {
  const name = `bootstrap-test-${randomBytes(4).toString("hex")}`;
  const dir = join(tmpdir(), name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Remove a temp directory (best-effort). */
function removeTempDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/** Run bootstrap.mjs in a given cwd with args. Returns { stdout, stderr, exitCode }. */
function run(cwd, ...args) {
  try {
    const result = execFileSync("node", [BOOTSTRAP, ...args], {
      cwd,
      encoding: "utf-8",
      timeout: 15000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // execFileSync returns stdout on success; stderr is lost.
    // Use spawnSync for stderr capture on success path.
    return { stdout: result, stderr: "", exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || "",
      stderr: err.stderr || "",
      exitCode: err.status ?? 1,
    };
  }
}

/** Like run() but uses spawnSync to capture stderr even on success. */
function runFull(cwd, ...args) {
  const r = spawnSync("node", [BOOTSTRAP, ...args], {
    cwd,
    encoding: "utf-8",
    timeout: 15000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { stdout: r.stdout || "", stderr: r.stderr || "", exitCode: r.status ?? 1 };
}

/** Read a file from a plan directory. */
function readPlanFile(cwd, planDir, filename) {
  return readFileSync(join(cwd, "plans", planDir, filename), "utf-8");
}

/** Get the active plan directory name from .current_plan. */
function getPointer(cwd) {
  try {
    return readFileSync(join(cwd, "plans", ".current_plan"), "utf-8").trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("bootstrap.mjs", () => {
  /** Temp dirs created during tests — cleaned up in afterEach. */
  let tempDirs = [];

  function getTempDir() {
    const dir = makeTempDir();
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs) removeTempDir(dir);
    tempDirs = [];
  });

  // =========================================================================
  // help
  // =========================================================================
  describe("help", () => {
    it("exits 0 and shows usage", () => {
      const dir = getTempDir();
      const r = run(dir, "help");
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("Usage:"), "should show usage text");
      assert.ok(r.stdout.includes("new"), "should list new command");
      assert.ok(r.stdout.includes("resume"), "should list resume command");
      assert.ok(r.stdout.includes("close"), "should list close command");
      assert.ok(r.stdout.includes("list"), "should list list command");
    });

    it("shows usage when no args", () => {
      const dir = getTempDir();
      const r = run(dir);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("Usage:"));
    });
  });

  // =========================================================================
  // new (step 3)
  // =========================================================================
  describe("new", () => {
    it("creates plan directory with all expected files", () => {
      const dir = getTempDir();
      const r = run(dir, "new", "Test goal alpha");
      assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
      assert.ok(r.stdout.includes("Initialized plans/"), "should show init message");
      assert.ok(r.stdout.includes("Test goal alpha"), "should echo goal");

      const planDir = getPointer(dir);
      assert.ok(planDir, "pointer should be set");
      assert.match(planDir, /^plan_\d{4}-\d{2}-\d{2}_[0-9a-f]{8}$/, "dir name format");

      // All expected files exist
      const base = join(dir, "plans", planDir);
      for (const f of ["state.md", "plan.md", "decisions.md", "findings.md", "progress.md", "verification.md"]) {
        assert.ok(existsSync(join(base, f)), `${f} should exist`);
      }
      // Subdirectories
      assert.ok(existsSync(join(base, "checkpoints")), "checkpoints/ should exist");
      assert.ok(existsSync(join(base, "findings")), "findings/ should exist");

      // Consolidated files
      assert.ok(existsSync(join(dir, "plans", "FINDINGS.md")), "FINDINGS.md should exist");
      assert.ok(existsSync(join(dir, "plans", "DECISIONS.md")), "DECISIONS.md should exist");
    });

    it("state.md starts in EXPLORE with iteration 0", () => {
      const dir = getTempDir();
      run(dir, "new", "Test goal");
      const planDir = getPointer(dir);
      const state = readPlanFile(dir, planDir, "state.md");
      assert.ok(state.includes("# Current State: EXPLORE"), "should be in EXPLORE");
      assert.ok(state.includes("## Iteration: 0"), "should be iteration 0");
      assert.ok(state.includes("INIT"), "should have INIT transition");
    });

    it("plan.md contains the goal", () => {
      const dir = getTempDir();
      run(dir, "new", "My specific test goal");
      const planDir = getPointer(dir);
      const plan = readPlanFile(dir, planDir, "plan.md");
      assert.ok(plan.includes("My specific test goal"), "plan.md should contain goal");
      assert.ok(plan.includes("## Goal"), "plan.md should have Goal heading");
      assert.ok(plan.includes("## Problem Statement"), "plan.md should have Problem Statement");
      assert.ok(plan.includes("## Steps"), "plan.md should have Steps");
      assert.ok(plan.includes("## Success Criteria"), "plan.md should have Success Criteria");
      assert.ok(plan.includes("## Complexity Budget"), "plan.md should have Complexity Budget");
    });

    it("findings.md has cross-plan reference when consolidated files exist", () => {
      const dir = getTempDir();
      // First plan creates consolidated files
      run(dir, "new", "first");
      run(dir, "close");
      // Second plan should reference them
      run(dir, "new", "second");
      const planDir = getPointer(dir);
      const findings = readPlanFile(dir, planDir, "findings.md");
      assert.ok(findings.includes("plans/FINDINGS.md"), "should reference consolidated findings");
    });

    it("decisions.md has cross-plan reference when consolidated files exist", () => {
      const dir = getTempDir();
      run(dir, "new", "first");
      run(dir, "close");
      run(dir, "new", "second");
      const planDir = getPointer(dir);
      const decisions = readPlanFile(dir, planDir, "decisions.md");
      assert.ok(decisions.includes("plans/DECISIONS.md"), "should reference consolidated decisions");
    });

    it("verification.md has criteria table structure", () => {
      const dir = getTempDir();
      run(dir, "new", "Test goal");
      const planDir = getPointer(dir);
      const v = readPlanFile(dir, planDir, "verification.md");
      assert.ok(v.includes("# Verification Results"), "should have header");
      assert.ok(v.includes("Criterion"), "should have criteria table");
      assert.ok(v.includes("## Verdict"), "should have verdict section");
    });

    it("progress.md starts with EXPLORE in progress", () => {
      const dir = getTempDir();
      run(dir, "new", "Test goal");
      const planDir = getPointer(dir);
      const progress = readPlanFile(dir, planDir, "progress.md");
      assert.ok(progress.includes("EXPLORE"), "should mention EXPLORE");
      assert.ok(progress.includes("## Completed"), "should have Completed section");
      assert.ok(progress.includes("## Remaining"), "should have Remaining section");
    });

    it("creates .gitignore with plans/ entry", () => {
      const dir = getTempDir();
      run(dir, "new", "Test goal");
      const gitignore = readFileSync(join(dir, ".gitignore"), "utf-8");
      assert.ok(gitignore.includes("plans/"), ".gitignore should contain plans/");
    });

    it(".gitignore is idempotent — no duplicate entries", () => {
      const dir = getTempDir();
      run(dir, "new", "first");
      run(dir, "close");
      run(dir, "new", "second");
      const gitignore = readFileSync(join(dir, ".gitignore"), "utf-8");
      const matches = gitignore.split("\n").filter((l) => l.trim() === "plans/");
      assert.equal(matches.length, 1, "should have exactly one plans/ entry");
    });

    it("appends to existing .gitignore", () => {
      const dir = getTempDir();
      writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
      run(dir, "new", "Test goal");
      const gitignore = readFileSync(join(dir, ".gitignore"), "utf-8");
      assert.ok(gitignore.includes("node_modules/"), "should preserve existing entries");
      assert.ok(gitignore.includes("plans/"), "should add plans/");
    });
  });

  // =========================================================================
  // status (step 4)
  // =========================================================================
  describe("status", () => {
    it("shows state, goal, and plan dir with active plan", () => {
      const dir = getTempDir();
      run(dir, "new", "Status test goal");
      const r = run(dir, "status");
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("EXPLORE"), "should show EXPLORE state");
      assert.ok(r.stdout.includes("Status test goal"), "should show goal");
      assert.ok(r.stdout.includes("plan_"), "should show plan dir name");
    });

    it("exits 0 with message when no active plan", () => {
      const dir = getTempDir();
      const r = run(dir, "status");
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("No active plan"), "should indicate no plan");
    });
  });

  // =========================================================================
  // resume (step 5)
  // =========================================================================
  describe("resume", () => {
    it("shows comprehensive plan state with active plan", () => {
      const dir = getTempDir();
      run(dir, "new", "Resume test goal");
      const r = run(dir, "resume");
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("Resuming"), "should show resuming header");
      assert.ok(r.stdout.includes("EXPLORE"), "should show state");
      assert.ok(r.stdout.includes("Resume test goal"), "should show goal");
      assert.ok(r.stdout.includes("state.md"), "should list recovery files");
      assert.ok(r.stdout.includes("plan.md"), "should list recovery files");
      assert.ok(r.stdout.includes("decisions.md"), "should list recovery files");
      assert.ok(r.stdout.includes("FINDINGS.md"), "should reference consolidated files");
    });

    it("errors when no active plan", () => {
      const dir = getTempDir();
      const r = run(dir, "resume");
      assert.notEqual(r.exitCode, 0, "should exit non-zero");
      assert.ok(r.stderr.includes("No active plan"), "should mention no active plan");
    });

    it("shows checkpoint count", () => {
      const dir = getTempDir();
      run(dir, "new", "Checkpoint test");
      const planDir = getPointer(dir);
      // Create a checkpoint file
      writeFileSync(join(dir, "plans", planDir, "checkpoints", "cp-000-iter1.md"), "# Checkpoint");
      const r = run(dir, "resume");
      assert.ok(r.stdout.includes("Checkpoints (1)"), "should show checkpoint count");
      assert.ok(r.stdout.includes("cp-000-iter1.md"), "should list checkpoint file");
    });

    it("shows progress summary", () => {
      const dir = getTempDir();
      run(dir, "new", "Progress test");
      const planDir = getPointer(dir);
      // Modify progress to have some completed items
      const progressPath = join(dir, "plans", planDir, "progress.md");
      writeFileSync(progressPath, `# Progress\n\n## Completed\n- [x] Did thing\n\n## In Progress\n- [ ] Doing thing\n\n## Remaining\n- [ ] Future thing\n`);
      const r = run(dir, "resume");
      assert.ok(r.stdout.includes("1 done"), "should show completed count");
      assert.ok(r.stdout.includes("2 remaining"), "should show remaining count");
    });
  });

  // =========================================================================
  // close (step 6)
  // =========================================================================
  describe("close", () => {
    it("removes pointer and preserves plan directory", () => {
      const dir = getTempDir();
      run(dir, "new", "Close test");
      const planDir = getPointer(dir);
      const r = run(dir, "close");
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("Closed plan"), "should confirm close");
      assert.equal(getPointer(dir), null, "pointer should be removed");
      // Plan directory should still exist
      assert.ok(existsSync(join(dir, "plans", planDir)), "plan dir should be preserved");
    });

    it("errors when no active plan", () => {
      const dir = getTempDir();
      const r = run(dir, "close");
      assert.notEqual(r.exitCode, 0);
      assert.ok(r.stderr.includes("No active plan"), "should report no active plan");
    });

    it("merges findings to consolidated FINDINGS.md", () => {
      const dir = getTempDir();
      run(dir, "new", "Merge test");
      const planDir = getPointer(dir);
      // Write some findings content
      const findingsPath = join(dir, "plans", planDir, "findings.md");
      writeFileSync(findingsPath, `# Findings\n\n## Index\n- [Auth](findings/auth.md)\n\n## Key Constraints\n- Auth is complex\n`);
      run(dir, "close");
      const consolidated = readFileSync(join(dir, "plans", "FINDINGS.md"), "utf-8");
      assert.ok(consolidated.includes(planDir), "should contain plan dir name as section header");
      assert.ok(consolidated.includes("Auth is complex"), "should contain merged findings content");
    });

    it("merges decisions to consolidated DECISIONS.md", () => {
      const dir = getTempDir();
      run(dir, "new", "Decision merge test");
      const planDir = getPointer(dir);
      const decisionsPath = join(dir, "plans", planDir, "decisions.md");
      writeFileSync(decisionsPath, `# Decision Log\n\n## D-001 | EXPLORE → PLAN\n**Context**: Test\n**Decision**: Go with A\n`);
      run(dir, "close");
      const consolidated = readFileSync(join(dir, "plans", "DECISIONS.md"), "utf-8");
      assert.ok(consolidated.includes(planDir), "should contain plan dir as section header");
      assert.ok(consolidated.includes("D-001"), "should contain merged decision");
      assert.ok(consolidated.includes("Go with A"), "should contain decision content");
    });

    it("demotes headings during merge (## → ###)", () => {
      const dir = getTempDir();
      run(dir, "new", "Heading demotion test");
      const planDir = getPointer(dir);
      const findingsPath = join(dir, "plans", planDir, "findings.md");
      writeFileSync(findingsPath, `# Findings\n\n## Index\n- Item one\n\n## Key Constraints\n- Constraint\n`);
      run(dir, "close");
      const consolidated = readFileSync(join(dir, "plans", "FINDINGS.md"), "utf-8");
      assert.ok(consolidated.includes("### Index"), "## should be demoted to ###");
      assert.ok(consolidated.includes("### Key Constraints"), "## should be demoted to ###");
      // Should NOT contain un-demoted ## for the merged content (other than plan section header)
      const lines = consolidated.split("\n").filter((l) => l.startsWith("## "));
      for (const line of lines) {
        assert.ok(line.startsWith(`## ${planDir}`) || line.startsWith("## plan_"), `unexpected ## heading: ${line}`);
      }
    });

    it("rewrites relative findings/ links during merge", () => {
      const dir = getTempDir();
      run(dir, "new", "Link rewrite test");
      const planDir = getPointer(dir);
      const findingsPath = join(dir, "plans", planDir, "findings.md");
      writeFileSync(findingsPath, `# Findings\n\n## Index\n- [Auth](findings/auth.md) — auth system\n`);
      run(dir, "close");
      const consolidated = readFileSync(join(dir, "plans", "FINDINGS.md"), "utf-8");
      assert.ok(consolidated.includes(`(${planDir}/findings/auth.md)`), "should rewrite findings/ links to include plan dir");
      assert.ok(!consolidated.includes("(findings/auth.md)"), "should not contain bare relative link");
    });

    it("strips cross-plan note during merge", () => {
      const dir = getTempDir();
      run(dir, "new", "first");
      run(dir, "close");
      run(dir, "new", "second with cross-plan note");
      const planDir = getPointer(dir);
      const findingsPath = join(dir, "plans", planDir, "findings.md");
      // This file should have the cross-plan note from seeding
      const content = readFileSync(findingsPath, "utf-8");
      assert.ok(content.includes("plans/FINDINGS.md"), "should have cross-plan note");
      // Add some actual content
      writeFileSync(findingsPath, content + "\n## Discovered\n- Something new\n");
      run(dir, "close");
      const consolidated = readFileSync(join(dir, "plans", "FINDINGS.md"), "utf-8");
      // The cross-plan note itself should NOT appear in consolidated (it would be redundant)
      const planSection = consolidated.split(`## ${planDir}`)[1] || "";
      assert.ok(!planSection.includes("Cross-plan context: see plans/FINDINGS.md"), "cross-plan note should be stripped");
    });

    it("newest plan appears first in consolidated files", () => {
      const dir = getTempDir();
      // Create and close first plan
      run(dir, "new", "first plan");
      const plan1 = getPointer(dir);
      const findings1 = join(dir, "plans", plan1, "findings.md");
      writeFileSync(findings1, `# Findings\n\n## Index\n- First plan finding\n`);
      run(dir, "close");

      // Create and close second plan
      run(dir, "new", "second plan");
      const plan2 = getPointer(dir);
      const findings2 = join(dir, "plans", plan2, "findings.md");
      writeFileSync(findings2, `# Findings\n\n## Index\n- Second plan finding\n`);
      run(dir, "close");

      const consolidated = readFileSync(join(dir, "plans", "FINDINGS.md"), "utf-8");
      const pos1 = consolidated.indexOf(`## ${plan1}`);
      const pos2 = consolidated.indexOf(`## ${plan2}`);
      assert.ok(pos1 > 0, "plan1 section should exist");
      assert.ok(pos2 > 0, "plan2 section should exist");
      assert.ok(pos2 < pos1, "second (newest) plan should appear before first (oldest)");
    });
  });

  // =========================================================================
  // list (step 7)
  // =========================================================================
  describe("list", () => {
    it("shows message when no plan directories", () => {
      const dir = getTempDir();
      const r = run(dir, "list");
      assert.equal(r.exitCode, 0);
      assert.ok(
        r.stdout.includes("No plan") || r.stdout.includes("No plans"),
        "should indicate no plans"
      );
    });

    it("lists active plan with marker", () => {
      const dir = getTempDir();
      run(dir, "new", "List test goal");
      const planDir = getPointer(dir);
      const r = run(dir, "list");
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes(planDir), "should show plan dir name");
      assert.ok(r.stdout.includes("active"), "should mark as active");
      assert.ok(r.stdout.includes("List test goal"), "should show goal");
    });

    it("lists multiple plans", () => {
      const dir = getTempDir();
      run(dir, "new", "Plan A");
      const plan1 = getPointer(dir);
      run(dir, "close");
      run(dir, "new", "Plan B");
      const plan2 = getPointer(dir);

      const r = run(dir, "list");
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes(plan1), "should show first plan");
      assert.ok(r.stdout.includes(plan2), "should show second plan");
      assert.ok(r.stdout.includes("2 total"), "should show total count");
    });

    it("shows closed plans without active marker", () => {
      const dir = getTempDir();
      run(dir, "new", "Closed plan");
      const plan1 = getPointer(dir);
      run(dir, "close");

      const r = run(dir, "list");
      assert.ok(r.stdout.includes(plan1), "should show closed plan");
      // The line for plan1 should not have "active" marker
      const plan1Line = r.stdout.split("\n").find((l) => l.includes(plan1));
      assert.ok(plan1Line && !plan1Line.includes("active"), "closed plan should not be marked active");
    });
  });

  // =========================================================================
  // new --force (step 8)
  // =========================================================================
  describe("new --force", () => {
    it("closes existing plan and creates new one", () => {
      const dir = getTempDir();
      run(dir, "new", "Old plan");
      const oldPlan = getPointer(dir);
      const r = run(dir, "new", "--force", "New plan");
      assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
      const newPlan = getPointer(dir);
      assert.ok(newPlan, "should have new pointer");
      assert.notEqual(newPlan, oldPlan, "should be different plan");
      // Old plan dir should still exist
      assert.ok(existsSync(join(dir, "plans", oldPlan)), "old plan dir should be preserved");
      // New plan dir should exist
      assert.ok(existsSync(join(dir, "plans", newPlan)), "new plan dir should exist");
    });

    it("merges old plan content to consolidated files on force-close", () => {
      const dir = getTempDir();
      run(dir, "new", "Force merge test");
      const oldPlan = getPointer(dir);
      // Add content to the old plan's findings
      writeFileSync(
        join(dir, "plans", oldPlan, "findings.md"),
        `# Findings\n\n## Index\n- Old finding\n`
      );
      run(dir, "new", "--force", "Fresh start");
      const consolidated = readFileSync(join(dir, "plans", "FINDINGS.md"), "utf-8");
      assert.ok(consolidated.includes(oldPlan), "consolidated should contain old plan section");
      assert.ok(consolidated.includes("Old finding"), "consolidated should contain old plan content");
    });

    it("works when no active plan exists (force is no-op)", () => {
      const dir = getTempDir();
      const r = run(dir, "new", "--force", "No prior plan");
      assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
      const planDir = getPointer(dir);
      assert.ok(planDir, "should create new plan");
    });
  });

  // =========================================================================
  // Edge cases (step 9)
  // =========================================================================
  describe("edge cases", () => {
    it("refuses to create new plan when one already exists (idempotent)", () => {
      const dir = getTempDir();
      run(dir, "new", "First plan");
      const r = run(dir, "new", "Second plan");
      assert.notEqual(r.exitCode, 0, "should fail");
      assert.ok(r.stderr.includes("already exists"), "should mention existing plan");
    });

    it("backward-compatible invocation (no 'new' subcommand)", () => {
      const dir = getTempDir();
      const r = run(dir, "My backward compat goal");
      assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
      const planDir = getPointer(dir);
      assert.ok(planDir, "should create plan");
      const plan = readPlanFile(dir, planDir, "plan.md");
      assert.ok(plan.includes("My backward compat goal"), "should contain goal");
    });

    it("backward-compatible with multi-word goal", () => {
      const dir = getTempDir();
      const r = run(dir, "word1", "word2", "word3");
      assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
      const planDir = getPointer(dir);
      const plan = readPlanFile(dir, planDir, "plan.md");
      assert.ok(plan.includes("word1 word2 word3"), "should join args as goal");
    });

    it("unknown flag errors", () => {
      const dir = getTempDir();
      const r = run(dir, "--unknown");
      assert.notEqual(r.exitCode, 0, "should fail on unknown flag");
    });

    it("goal with special characters", () => {
      const dir = getTempDir();
      const goal = "Fix the `auth` module's ## edge case & <html> issues";
      const r = run(dir, "new", goal);
      assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
      const planDir = getPointer(dir);
      const plan = readPlanFile(dir, planDir, "plan.md");
      assert.ok(plan.includes(goal), "plan should contain special-char goal verbatim");
    });

    it("empty goal defaults to fallback message", () => {
      const dir = getTempDir();
      const r = run(dir, "new", "");
      assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
      const planDir = getPointer(dir);
      const plan = readPlanFile(dir, planDir, "plan.md");
      assert.ok(plan.includes("No goal specified"), "should use default goal");
    });

    it("multiple close-open cycles produce growing consolidated files", () => {
      const dir = getTempDir();

      // Cycle 1
      run(dir, "new", "Cycle 1");
      const plan1 = getPointer(dir);
      writeFileSync(
        join(dir, "plans", plan1, "findings.md"),
        `# Findings\n\n## Index\n- Cycle 1 finding\n`
      );
      run(dir, "close");

      // Cycle 2
      run(dir, "new", "Cycle 2");
      const plan2 = getPointer(dir);
      writeFileSync(
        join(dir, "plans", plan2, "findings.md"),
        `# Findings\n\n## Index\n- Cycle 2 finding\n`
      );
      run(dir, "close");

      // Cycle 3
      run(dir, "new", "Cycle 3");
      const plan3 = getPointer(dir);
      writeFileSync(
        join(dir, "plans", plan3, "findings.md"),
        `# Findings\n\n## Index\n- Cycle 3 finding\n`
      );
      run(dir, "close");

      const consolidated = readFileSync(join(dir, "plans", "FINDINGS.md"), "utf-8");
      assert.ok(consolidated.includes("Cycle 1 finding"), "should have cycle 1");
      assert.ok(consolidated.includes("Cycle 2 finding"), "should have cycle 2");
      assert.ok(consolidated.includes("Cycle 3 finding"), "should have cycle 3");

      // Verify newest-first ordering
      const pos1 = consolidated.indexOf(`## ${plan1}`);
      const pos2 = consolidated.indexOf(`## ${plan2}`);
      const pos3 = consolidated.indexOf(`## ${plan3}`);
      assert.ok(pos3 < pos2, "cycle 3 should appear before cycle 2");
      assert.ok(pos2 < pos1, "cycle 2 should appear before cycle 1");
    });

    it("list shows plans with correct state after multiple operations", () => {
      const dir = getTempDir();
      run(dir, "new", "Plan A");
      run(dir, "close");
      run(dir, "new", "Plan B");
      // Plan B is active
      const r = run(dir, "list");
      assert.equal(r.exitCode, 0);
      const lines = r.stdout.split("\n").filter((l) => l.includes("plan_"));
      assert.equal(lines.length, 2, "should list 2 plans");
      const activeLine = lines.find((l) => l.includes("active"));
      assert.ok(activeLine, "one plan should be active");
      assert.ok(activeLine.includes("Plan B"), "active plan should be Plan B");
    });

    it("orphan warning when directories exist but no pointer", () => {
      const dir = getTempDir();
      run(dir, "new", "Orphan test");
      // Manually remove pointer to simulate crash
      rmSync(join(dir, "plans", ".current_plan"));
      // Now create a new plan — should warn about orphan (use runFull to capture stderr on success)
      const r = runFull(dir, "new", "New after orphan");
      assert.equal(r.exitCode, 0);
      assert.ok(r.stderr.includes("WARNING"), "should warn about orphaned directories");
    });

    it("status and resume report iteration and step from modified state.md", () => {
      const dir = getTempDir();
      run(dir, "new", "State reporting test");
      const planDir = getPointer(dir);
      // Simulate EXECUTE state
      writeFileSync(
        join(dir, "plans", planDir, "state.md"),
        `# Current State: EXECUTE\n## Iteration: 2\n## Current Plan Step: 3 of 5\n## Last Transition: PLAN → EXECUTE\n## Transition History:\n- test\n`
      );
      const statusR = run(dir, "status");
      assert.ok(statusR.stdout.includes("EXECUTE"), "status should show EXECUTE");
      assert.ok(statusR.stdout.includes("iter=2"), "status should show iteration");

      const resumeR = run(dir, "resume");
      assert.ok(resumeR.stdout.includes("EXECUTE"), "resume should show EXECUTE");
      assert.ok(resumeR.stdout.includes("2"), "resume should show iteration");
      assert.ok(resumeR.stdout.includes("3 of 5"), "resume should show step");
    });

    it("resume shows decision count", () => {
      const dir = getTempDir();
      run(dir, "new", "Decision count test");
      const planDir = getPointer(dir);
      writeFileSync(
        join(dir, "plans", planDir, "decisions.md"),
        `# Decision Log\n\n## D-001 | test\nContent\n\n## D-002 | test\nContent\n`
      );
      const r = run(dir, "resume");
      assert.ok(r.stdout.includes("2"), "should show decision count");
    });
  });
});
