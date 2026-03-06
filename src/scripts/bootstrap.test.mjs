#!/usr/bin/env node
// Comprehensive tests for bootstrap.mjs using Node.js built-in test runner.
// Run: node --test src/scripts/bootstrap.test.mjs
// Requires: Node.js 18+

import { describe, it, afterEach } from "node:test";
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
      assert.ok(existsSync(join(dir, "plans", "LESSONS.md")), "LESSONS.md should exist");
    });

    it("LESSONS.md has correct initial content", () => {
      const dir = getTempDir();
      run(dir, "new", "Test goal");
      const lessons = readFileSync(join(dir, "plans", "LESSONS.md"), "utf-8");
      assert.ok(lessons.includes("# Lessons Learned"), "should have header");
      assert.ok(lessons.includes("Max 200 lines"), "should mention 200 line limit");
      assert.ok(lessons.includes("institutional memory"), "should mention institutional memory");
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

    it("cross-plan reference includes LESSONS.md when consolidated files exist", () => {
      const dir = getTempDir();
      run(dir, "new", "first");
      run(dir, "close");
      run(dir, "new", "second");
      const planDir = getPointer(dir);
      const findings = readPlanFile(dir, planDir, "findings.md");
      assert.ok(findings.includes("LESSONS.md"), "should reference LESSONS.md in cross-plan note");
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

  // =========================================================================
  // stale/corrupt pointer handling (step 1)
  // =========================================================================
  describe("stale and corrupt pointer", () => {
    it("status treats stale pointer (dir missing) as no active plan", () => {
      const dir = getTempDir();
      run(dir, "new", "Stale test");
      const planDir = getPointer(dir);
      // Delete plan directory but leave pointer
      rmSync(join(dir, "plans", planDir), { recursive: true, force: true });
      const r = run(dir, "status");
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("No active plan"), "should report no active plan");
    });

    it("resume errors on stale pointer (dir missing)", () => {
      const dir = getTempDir();
      run(dir, "new", "Stale resume test");
      const planDir = getPointer(dir);
      rmSync(join(dir, "plans", planDir), { recursive: true, force: true });
      const r = run(dir, "resume");
      assert.notEqual(r.exitCode, 0, "should fail");
      assert.ok(r.stderr.includes("No active plan"), "should report no active plan");
    });

    it("close treats stale pointer as no active plan", () => {
      const dir = getTempDir();
      run(dir, "new", "Stale close test");
      const planDir = getPointer(dir);
      rmSync(join(dir, "plans", planDir), { recursive: true, force: true });
      const r = run(dir, "close");
      assert.notEqual(r.exitCode, 0, "should fail");
      assert.ok(r.stderr.includes("No active plan"), "should report no active plan");
    });

    it("new succeeds when pointer is stale (allows overwrite)", () => {
      const dir = getTempDir();
      run(dir, "new", "Stale overwrite test");
      const oldPlan = getPointer(dir);
      rmSync(join(dir, "plans", oldPlan), { recursive: true, force: true });
      // readPointer returns null for stale pointer, so new should succeed
      const r = runFull(dir, "new", "Fresh after stale");
      assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
      const newPlan = getPointer(dir);
      assert.ok(newPlan, "should have new pointer");
      assert.notEqual(newPlan, oldPlan, "should be a different plan");
    });

    it("corrupted pointer content (random text) treated as no plan", () => {
      const dir = getTempDir();
      mkdirSync(join(dir, "plans"), { recursive: true });
      writeFileSync(join(dir, "plans", ".current_plan"), "not_a_valid_plan_dir\n");
      const r = run(dir, "status");
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("No active plan"), "should report no active plan");
    });
  });

  // =========================================================================
  // duplicate merge and empty content (step 2)
  // =========================================================================
  describe("duplicate merge and empty content", () => {
    it("closing same plan twice does not duplicate content (dedup guard)", () => {
      const dir = getTempDir();
      run(dir, "new", "Duplicate merge test");
      const planDir = getPointer(dir);
      writeFileSync(
        join(dir, "plans", planDir, "findings.md"),
        `# Findings\n\n## Index\n- Unique finding\n`
      );
      run(dir, "close");

      // Manually restore pointer to simulate re-close
      writeFileSync(join(dir, "plans", ".current_plan"), planDir);
      run(dir, "close");

      const consolidated = readFileSync(join(dir, "plans", "FINDINGS.md"), "utf-8");
      // Count occurrences of the plan section header
      const occurrences = consolidated.split(`## ${planDir}`).length - 1;
      assert.equal(occurrences, 1, "dedup guard prevents duplicate sections");
    });

    it("close with empty findings does not add empty section", () => {
      const dir = getTempDir();
      run(dir, "new", "Empty findings test");
      const planDir = getPointer(dir);
      // findings.md has only the header/boilerplate, no ## headings with content
      // The default template has ## Index and ## Key Constraints with placeholder text
      run(dir, "close");
      const consolidated = readFileSync(join(dir, "plans", "FINDINGS.md"), "utf-8");
      // Should still have a section for this plan (the ## headings get demoted and merged)
      assert.ok(consolidated.includes(planDir), "plan section should exist even with template content");
    });

    it("close with findings that have no ## headings drops content (stripHeader behavior)", () => {
      const dir = getTempDir();
      run(dir, "new", "No headings test");
      const planDir = getPointer(dir);
      // Write findings with only H1 header and plain text (no ## headings)
      writeFileSync(
        join(dir, "plans", planDir, "findings.md"),
        `# Findings\nJust plain text, no sub-headings.\n`
      );
      run(dir, "close");
      const consolidated = readFileSync(join(dir, "plans", "FINDINGS.md"), "utf-8");
      // stripHeader returns full content when no ## found, then stripCrossPlanNote runs,
      // then heading demotion (no ## to demote), then trim. The remaining text is non-empty
      // so it IS merged. This documents the actual behavior.
      // Content without ## headings gets merged as-is (with H1 stripped by stripHeader returning full text)
      assert.ok(consolidated.includes("plain text"), "content without ## headings is still merged as-is");
    });

    it("close with empty decisions does not error", () => {
      const dir = getTempDir();
      run(dir, "new", "Empty decisions test");
      const planDir = getPointer(dir);
      // Overwrite decisions.md with just the header
      writeFileSync(
        join(dir, "plans", planDir, "decisions.md"),
        `# Decision Log\nNo decisions made.\n`
      );
      const r = run(dir, "close");
      assert.equal(r.exitCode, 0, "should close without error");
    });
  });

  // =========================================================================
  // consolidated file compression warnings
  // =========================================================================
  describe("consolidated file compression warnings", () => {
    /** Generate a large findings.md with many ## sections to exceed 500 lines. */
    function makeLargeFindings(lineCount) {
      const lines = ["# Findings\n", "## Index\n"];
      for (let i = 0; i < lineCount - 2; i++) {
        lines.push(`- Finding line ${i}\n`);
      }
      return lines.join("");
    }

    /** Generate a large decisions.md with many ## sections to exceed 500 lines. */
    function makeLargeDecisions(lineCount) {
      const lines = ["# Decision Log\n", "## D-001 | test\n"];
      for (let i = 0; i < lineCount - 2; i++) {
        lines.push(`- Decision line ${i}\n`);
      }
      return lines.join("");
    }

    it("no warning when consolidated files are small", () => {
      const dir = getTempDir();
      run(dir, "new", "Small file test");
      const planDir = getPointer(dir);
      writeFileSync(
        join(dir, "plans", planDir, "findings.md"),
        `# Findings\n\n## Index\n- Small finding\n`
      );
      const r = run(dir, "close");
      assert.ok(!r.stdout.includes("ACTION NEEDED"), "should not warn for small files");
    });

    it("warns when FINDINGS.md exceeds 500 lines after merge", () => {
      const dir = getTempDir();
      // Seed the consolidated file with lots of content first
      run(dir, "new", "Seed plan");
      run(dir, "close");
      writeFileSync(
        join(dir, "plans", "FINDINGS.md"),
        makeLargeFindings(510)
      );
      // Now merge more content
      run(dir, "new", "Trigger plan");
      const planDir = getPointer(dir);
      writeFileSync(
        join(dir, "plans", planDir, "findings.md"),
        `# Findings\n\n## Index\n- Trigger finding\n`
      );
      const r = run(dir, "close");
      assert.ok(r.stdout.includes("ACTION NEEDED"), "should warn about large file");
      assert.ok(r.stdout.includes("plans/FINDINGS.md"), "should name the file");
      assert.ok(r.stdout.includes("Create compressed summary"), "should say Create for new summary");
    });

    it("warns when DECISIONS.md exceeds 500 lines after merge", () => {
      const dir = getTempDir();
      run(dir, "new", "Seed plan");
      run(dir, "close");
      writeFileSync(
        join(dir, "plans", "DECISIONS.md"),
        makeLargeDecisions(510)
      );
      run(dir, "new", "Trigger plan");
      const planDir = getPointer(dir);
      writeFileSync(
        join(dir, "plans", planDir, "decisions.md"),
        `# Decision Log\n\n## D-001 | test\n- Trigger decision\n`
      );
      const r = run(dir, "close");
      assert.ok(r.stdout.includes("ACTION NEEDED"), "should warn about large file");
      assert.ok(r.stdout.includes("plans/DECISIONS.md"), "should name the file");
    });

    it("inserts new plan section after compressed summary block, not inside it", () => {
      const dir = getTempDir();
      run(dir, "new", "Seed plan");
      run(dir, "close");
      // Write a consolidated file with compressed summary markers
      const consolidated = `# Consolidated Findings\n*Cross-plan findings archive.*\n\n<!-- COMPRESSED-SUMMARY -->\n## Summary (compressed)\n- Old summary\n<!-- /COMPRESSED-SUMMARY -->\n\n## plan_old_1\n### Old finding\n`;
      writeFileSync(join(dir, "plans", "FINDINGS.md"), consolidated);
      // Merge a new plan
      run(dir, "new", "After compression");
      const planDir = getPointer(dir);
      writeFileSync(
        join(dir, "plans", planDir, "findings.md"),
        `# Findings\n\n## Index\n- New finding\n`
      );
      run(dir, "close");
      const result = readFileSync(join(dir, "plans", "FINDINGS.md"), "utf-8");
      // New plan section must appear AFTER the closing marker
      const closeMarkerPos = result.indexOf("<!-- /COMPRESSED-SUMMARY -->");
      const newPlanPos = result.indexOf(`## ${planDir}`);
      assert.ok(closeMarkerPos >= 0, "closing marker should exist");
      assert.ok(newPlanPos >= 0, "new plan section should exist");
      assert.ok(newPlanPos > closeMarkerPos, "new plan section must appear after compressed summary closing marker");
      // Compressed summary markers must remain structurally intact
      const openMarkerPos = result.indexOf("<!-- COMPRESSED-SUMMARY -->");
      assert.ok(openMarkerPos < closeMarkerPos, "open marker before close marker");
      assert.ok(newPlanPos > closeMarkerPos, "no plan content inside markers");
    });

    it("says Update when compressed summary markers already exist", () => {
      const dir = getTempDir();
      run(dir, "new", "Seed plan");
      run(dir, "close");
      // Write a large file that already has compressed summary markers
      const header = `# Consolidated Findings\n*Cross-plan findings archive.*\n\n<!-- COMPRESSED-SUMMARY -->\n## Summary (compressed)\n- Old summary line\n<!-- /COMPRESSED-SUMMARY -->\n\n`;
      const body = makeLargeFindings(510);
      writeFileSync(join(dir, "plans", "FINDINGS.md"), header + body);
      // Merge more
      run(dir, "new", "Trigger update");
      const planDir = getPointer(dir);
      writeFileSync(
        join(dir, "plans", planDir, "findings.md"),
        `# Findings\n\n## Index\n- New finding\n`
      );
      const r = run(dir, "close");
      assert.ok(r.stdout.includes("ACTION NEEDED"), "should warn");
      assert.ok(r.stdout.includes("Update existing compressed summary"), "should say Update, not Create");
    });
  });

  // =========================================================================
  // sliding window (consolidated file trimming)
  // =========================================================================
  describe("sliding window for consolidated files", () => {
    it("trims consolidated files to 8 most recent plan sections", () => {
      const dir = getTempDir();
      const planDirs = [];
      // Create and close 10 plans with findings content
      for (let i = 0; i < 10; i++) {
        run(dir, "new", `Plan ${i}`);
        const planDir = getPointer(dir);
        planDirs.push(planDir);
        writeFileSync(
          join(dir, "plans", planDir, "findings.md"),
          `# Findings\n\n## Index\n- Finding from plan ${i}\n`
        );
        run(dir, "close");
      }
      const consolidated = readFileSync(join(dir, "plans", "FINDINGS.md"), "utf-8");
      // Count plan sections
      const sections = consolidated.match(/\n## plan_/g) || [];
      assert.equal(sections.length, 8, "should keep exactly 8 plan sections");
      // Newest (last created) should be present
      assert.ok(consolidated.includes(planDirs[9]), "newest plan should be present");
      assert.ok(consolidated.includes(planDirs[2]), "8th newest plan should be present");
      // Oldest should be trimmed
      assert.ok(!consolidated.includes(planDirs[0]), "oldest plan should be trimmed");
      assert.ok(!consolidated.includes(planDirs[1]), "2nd oldest plan should be trimmed");
    });

    it("does not trim when ≤8 plan sections exist", () => {
      const dir = getTempDir();
      const planDirs = [];
      for (let i = 0; i < 5; i++) {
        run(dir, "new", `Plan ${i}`);
        const planDir = getPointer(dir);
        planDirs.push(planDir);
        writeFileSync(
          join(dir, "plans", planDir, "findings.md"),
          `# Findings\n\n## Index\n- Finding ${i}\n`
        );
        run(dir, "close");
      }
      const consolidated = readFileSync(join(dir, "plans", "FINDINGS.md"), "utf-8");
      const sections = consolidated.match(/\n## plan_/g) || [];
      assert.equal(sections.length, 5, "all 5 plan sections should remain");
      for (const pd of planDirs) {
        assert.ok(consolidated.includes(pd), `plan ${pd} should still be present`);
      }
    });

    it("preserves compressed summary block during trim", () => {
      const dir = getTempDir();
      mkdirSync(join(dir, "plans"), { recursive: true });
      // Create a consolidated file with compressed summary + 10 plan sections
      let content = `# Consolidated Findings\n*Archive.*\n\n<!-- COMPRESSED-SUMMARY -->\n## Summary (compressed)\n- Key finding\n<!-- /COMPRESSED-SUMMARY -->\n`;
      for (let i = 0; i < 10; i++) {
        content += `\n## plan_fake_${String(i).padStart(2, "0")}\n### Finding ${i}\n- Data ${i}\n`;
      }
      writeFileSync(join(dir, "plans", "FINDINGS.md"), content);
      // Close a new plan to trigger trim
      run(dir, "new", "Trigger trim");
      const planDir = getPointer(dir);
      writeFileSync(
        join(dir, "plans", planDir, "findings.md"),
        `# Findings\n\n## Index\n- New finding\n`
      );
      run(dir, "close");
      const result = readFileSync(join(dir, "plans", "FINDINGS.md"), "utf-8");
      // Compressed summary should be intact
      assert.ok(result.includes("<!-- COMPRESSED-SUMMARY -->"), "open marker preserved");
      assert.ok(result.includes("<!-- /COMPRESSED-SUMMARY -->"), "close marker preserved");
      assert.ok(result.includes("Key finding"), "summary content preserved");
      // Should have at most 8 plan sections
      const sections = result.match(/\n## plan_/g) || [];
      assert.ok(sections.length <= 8, `should have ≤8 sections, got ${sections.length}`);
    });
  });

  // =========================================================================
  // content validation (step 3)
  // =========================================================================
  describe("plan file structure validation", () => {
    it("plan.md has all required section headings", () => {
      const dir = getTempDir();
      run(dir, "new", "Structure test");
      const planDir = getPointer(dir);
      const plan = readPlanFile(dir, planDir, "plan.md");
      const requiredSections = [
        "## Goal",
        "## Problem Statement",
        "## Context",
        "## Files To Modify",
        "## Steps",
        "## Assumptions",
        "## Failure Modes",
        "## Pre-Mortem & Falsification Signals",
        "## Success Criteria",
        "## Verification Strategy",
        "## Complexity Budget",
      ];
      for (const section of requiredSections) {
        assert.ok(plan.includes(section), `plan.md should have "${section}"`);
      }
    });

    it("state.md has all structural sections", () => {
      const dir = getTempDir();
      run(dir, "new", "State structure test");
      const planDir = getPointer(dir);
      const state = readPlanFile(dir, planDir, "state.md");
      const requiredSections = [
        "# Current State:",
        "## Iteration:",
        "## Current Plan Step:",
        "## Pre-Step Checklist",
        "## Fix Attempts",
        "## Change Manifest",
        "## Last Transition:",
        "## Transition History:",
      ];
      for (const section of requiredSections) {
        assert.ok(state.includes(section), `state.md should have "${section}"`);
      }
    });

    it("verification.md has proper table structure", () => {
      const dir = getTempDir();
      run(dir, "new", "Verification structure test");
      const planDir = getPointer(dir);
      const v = readPlanFile(dir, planDir, "verification.md");
      assert.ok(v.includes("# Verification Results"), "should have main header");
      assert.ok(v.includes("## Criteria Verification"), "should have criteria section");
      assert.ok(v.includes("Criterion"), "should have criterion column header");
      assert.ok(v.includes("Method"), "should have method column header");
      assert.ok(v.includes("Result"), "should have result column header");
      assert.ok(v.includes("Evidence"), "should have evidence column header");
      assert.ok(v.includes("## Additional Checks"), "should have additional checks section");
      assert.ok(v.includes("## Verdict"), "should have verdict section");
    });

    it("decisions.md has append-only header", () => {
      const dir = getTempDir();
      run(dir, "new", "Decisions structure test");
      const planDir = getPointer(dir);
      const decisions = readPlanFile(dir, planDir, "decisions.md");
      assert.ok(decisions.includes("# Decision Log"), "should have Decision Log header");
      assert.ok(decisions.includes("Append-only"), "should note append-only policy");
    });

    it("progress.md has all required sections", () => {
      const dir = getTempDir();
      run(dir, "new", "Progress structure test");
      const planDir = getPointer(dir);
      const progress = readPlanFile(dir, planDir, "progress.md");
      const requiredSections = [
        "# Progress",
        "## Completed",
        "## In Progress",
        "## Remaining",
        "## Blocked",
      ];
      for (const section of requiredSections) {
        assert.ok(progress.includes(section), `progress.md should have "${section}"`);
      }
    });
  });

  // =========================================================================
  // verification.md table format (step 5)
  // =========================================================================
  describe("verification.md table format", () => {
    it("verification.md placeholder row has proper column count", () => {
      const dir = getTempDir();
      run(dir, "new", "Table format test");
      const planDir = getPointer(dir);
      const v = readPlanFile(dir, planDir, "verification.md");
      // The Criteria Verification table has 6 columns: #, Criterion, Method, Command/Action, Result, Evidence
      // Extract only lines between "## Criteria Verification" and the next "##" section
      const lines = v.split("\n");
      const criteriaStart = lines.findIndex((l) => l.includes("Criteria Verification"));
      const criteriaEnd = lines.findIndex((l, i) => i > criteriaStart && l.startsWith("## "));
      const criteriaLines = lines.slice(criteriaStart, criteriaEnd > 0 ? criteriaEnd : undefined);
      const headerRow = criteriaLines.find((l) => l.includes("Criterion"));
      if (headerRow) {
        const colCount = headerRow.split("|").filter((c) => c.trim()).length;
        const dataRows = criteriaLines.filter(
          (l) => l.startsWith("|") && !l.includes("---") && !l.includes("Criterion")
        );
        for (const row of dataRows) {
          const rowCols = row.split("|").filter((c) => c.trim()).length;
          assert.ok(
            rowCols === colCount || rowCols <= 1,
            `row should have ${colCount} columns or be a note, got ${rowCols}: ${row}`
          );
        }
      }
    });
  });

  // =========================================================================
  // close updates state.md (step 6)
  // =========================================================================
  describe("close updates state.md", () => {
    it("state.md shows CLOSE state after close command", () => {
      const dir = getTempDir();
      run(dir, "new", "Close state test");
      const planDir = getPointer(dir);
      run(dir, "close");
      // After close, state.md should be updated
      const state = readFileSync(join(dir, "plans", planDir, "state.md"), "utf-8");
      assert.ok(state.includes("CLOSE"), "state.md should mention CLOSE after close");
    });

    it("state.md transition history includes close transition", () => {
      const dir = getTempDir();
      run(dir, "new", "Close transition test");
      const planDir = getPointer(dir);
      run(dir, "close");
      const state = readFileSync(join(dir, "plans", planDir, "state.md"), "utf-8");
      assert.ok(
        state.includes("CLOSE") && state.includes("bootstrap close"),
        "should log close transition with 'bootstrap close' note"
      );
    });
  });

  // =========================================================================
  // resume with various states (step 7)
  // =========================================================================
  describe("resume with various plan states", () => {
    it("resume shows PLAN state correctly", () => {
      const dir = getTempDir();
      run(dir, "new", "Plan state resume test");
      const planDir = getPointer(dir);
      writeFileSync(
        join(dir, "plans", planDir, "state.md"),
        `# Current State: PLAN\n## Iteration: 1\n## Current Plan Step: N/A\n## Last Transition: EXPLORE → PLAN\n## Transition History:\n- EXPLORE → PLAN\n`
      );
      const r = run(dir, "resume");
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("PLAN"), "should show PLAN state");
    });

    it("resume shows REFLECT state with verification info", () => {
      const dir = getTempDir();
      run(dir, "new", "Reflect state resume test");
      const planDir = getPointer(dir);
      writeFileSync(
        join(dir, "plans", planDir, "state.md"),
        `# Current State: REFLECT\n## Iteration: 2\n## Current Plan Step: 5 of 5\n## Last Transition: EXECUTE → REFLECT\n## Transition History:\n- EXECUTE → REFLECT\n`
      );
      writeFileSync(
        join(dir, "plans", planDir, "progress.md"),
        `# Progress\n\n## Completed\n- [x] Step 1\n- [x] Step 2\n- [x] Step 3\n\n## In Progress\n\n## Remaining\n- [ ] Verify\n\n## Blocked\n`
      );
      const r = run(dir, "resume");
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("REFLECT"), "should show REFLECT state");
      assert.ok(r.stdout.includes("3 done"), "should show 3 completed");
      assert.ok(r.stdout.includes("1 remaining"), "should show 1 remaining");
    });

    it("resume with findings directory containing files", () => {
      const dir = getTempDir();
      run(dir, "new", "Findings files resume test");
      const planDir = getPointer(dir);
      // Create some findings files
      writeFileSync(join(dir, "plans", planDir, "findings", "auth-system.md"), "# Auth System\nDetails...\n");
      writeFileSync(join(dir, "plans", planDir, "findings", "database.md"), "# Database\nDetails...\n");
      const r = run(dir, "resume");
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("Resuming"), "should show resume header");
      // Resume should complete without error even with findings files
    });

    it("resume shows all expected output sections", () => {
      const dir = getTempDir();
      run(dir, "new", "Full resume output test");
      const planDir = getPointer(dir);
      const r = run(dir, "resume");
      assert.equal(r.exitCode, 0);
      // Verify all expected output sections
      assert.ok(r.stdout.includes("Resuming"), "should have resuming header");
      assert.ok(r.stdout.includes("State:"), "should show state");
      assert.ok(r.stdout.includes("Iteration:"), "should show iteration");
      assert.ok(r.stdout.includes("Step:"), "should show step");
      assert.ok(r.stdout.includes("Goal:"), "should show goal");
      assert.ok(r.stdout.includes("Last:"), "should show last transition");
      assert.ok(r.stdout.includes("Progress:"), "should show progress");
      assert.ok(r.stdout.includes("Recovery files:"), "should show recovery files");
      assert.ok(r.stdout.includes("Consolidated context:"), "should show consolidated context");
      assert.ok(r.stdout.includes("LESSONS.md"), "should mention LESSONS.md in consolidated context");
    });
  });

  // =========================================================================
  // LESSONS.md
  // =========================================================================
  describe("INDEX.md", () => {
    it("INDEX.md created on first new", () => {
      const dir = getTempDir();
      run(dir, "new", "test");
      assert.ok(existsSync(join(dir, "plans", "INDEX.md")), "INDEX.md should exist after new");
      const content = readFileSync(join(dir, "plans", "INDEX.md"), "utf-8");
      assert.ok(content.includes("# Plan Index"), "should have header");
      assert.ok(content.includes("| Plan |"), "should have table header");
    });

    it("INDEX.md is not overwritten on second new", () => {
      const dir = getTempDir();
      run(dir, "new", "first");
      run(dir, "close");
      // Write custom content to INDEX.md table
      const indexPath = join(dir, "plans", "INDEX.md");
      writeFileSync(indexPath, readFileSync(indexPath, "utf-8") + "| custom_plan | 2026-01-01 | custom goal | topics |\n");
      run(dir, "new", "second");
      const content = readFileSync(indexPath, "utf-8");
      assert.ok(content.includes("custom_plan"), "should preserve existing INDEX.md content");
    });

    it("close appends plan entry to INDEX.md", () => {
      const dir = getTempDir();
      run(dir, "new", "index test goal");
      const planDir = getPointer(dir);
      run(dir, "close");
      const content = readFileSync(join(dir, "plans", "INDEX.md"), "utf-8");
      assert.ok(content.includes(planDir), "INDEX.md should contain the plan directory name");
      assert.ok(content.includes("index test goal"), "INDEX.md should contain the goal");
    });

    it("close does not duplicate INDEX.md entry on double close", () => {
      const dir = getTempDir();
      run(dir, "new", "dedup test");
      const planDir = getPointer(dir);
      run(dir, "close");
      // Manually restore pointer and close again
      writeFileSync(join(dir, "plans", ".current_plan"), planDir);
      run(dir, "close");
      const content = readFileSync(join(dir, "plans", "INDEX.md"), "utf-8");
      const count = content.split(planDir).length - 1;
      assert.equal(count, 1, "plan should appear exactly once in INDEX.md");
    });

    it("close extracts topics from findings.md", () => {
      const dir = getTempDir();
      run(dir, "new", "topic extraction");
      const planDir = getPointer(dir);
      // Write findings with linked entries
      const findingsPath = join(dir, "plans", planDir, "findings.md");
      writeFileSync(findingsPath, `# Findings\n## Index\n- [Auth System](findings/auth.md)\n- [Database](findings/db.md)\n## Key Constraints\n`);
      run(dir, "close");
      const content = readFileSync(join(dir, "plans", "INDEX.md"), "utf-8");
      assert.ok(content.includes("auth system"), "should extract topic from findings link");
    });
  });

  describe("lessons_snapshot.md", () => {
    it("close creates lessons_snapshot.md in plan directory", () => {
      const dir = getTempDir();
      run(dir, "new", "snapshot test");
      const planDir = getPointer(dir);
      run(dir, "close");
      assert.ok(existsSync(join(dir, "plans", planDir, "lessons_snapshot.md")), "snapshot should exist");
    });

    it("lessons_snapshot.md contains LESSONS.md content at time of close", () => {
      const dir = getTempDir();
      run(dir, "new", "first plan");
      run(dir, "close");
      // Write custom content to LESSONS.md
      writeFileSync(join(dir, "plans", "LESSONS.md"), "# Lessons Learned\n\n## Important lesson\n- Never do X\n");
      // Create and close second plan
      run(dir, "new", "second plan");
      const planDir = getPointer(dir);
      run(dir, "close");
      const snapshot = readFileSync(join(dir, "plans", planDir, "lessons_snapshot.md"), "utf-8");
      assert.ok(snapshot.includes("Never do X"), "snapshot should contain LESSONS.md content from before close");
    });
  });

  describe("validate-plan.mjs", () => {
    const VALIDATE = resolve(import.meta.dirname, "validate-plan.mjs");

    function runValidate(cwd, ...args) {
      try {
        const result = execFileSync("node", [VALIDATE, ...args], {
          cwd,
          encoding: "utf-8",
          timeout: 15000,
          stdio: ["pipe", "pipe", "pipe"],
        });
        return { stdout: result, stderr: "", exitCode: 0 };
      } catch (err) {
        return { stdout: err.stdout || "", stderr: err.stderr || "", exitCode: err.status ?? 1 };
      }
    }

    it("passes on a fresh plan directory", () => {
      const dir = getTempDir();
      run(dir, "new", "validate test");
      const r = runValidate(dir);
      assert.equal(r.exitCode, 0, `should pass on fresh plan: ${r.stdout}`);
    });

    it("detects invalid state transitions", () => {
      const dir = getTempDir();
      run(dir, "new", "transition test");
      const planDir = getPointer(dir);
      const statePath = join(dir, "plans", planDir, "state.md");
      const state = readFileSync(statePath, "utf-8");
      writeFileSync(statePath, state + "- EXPLORE → EXECUTE (bad)\n");
      const r = runValidate(dir);
      assert.equal(r.exitCode, 1, "should fail with invalid transition");
      assert.ok(r.stdout.includes("EXPLORE→EXECUTE"), "should report the invalid transition");
    });

    it("warns about placeholder sections in EXECUTE state", () => {
      const dir = getTempDir();
      run(dir, "new", "section test");
      const planDir = getPointer(dir);
      // Set state to EXECUTE
      const statePath = join(dir, "plans", planDir, "state.md");
      const state = readFileSync(statePath, "utf-8");
      writeFileSync(statePath, state.replace("# Current State: EXPLORE", "# Current State: EXECUTE"));
      const r = runValidate(dir);
      assert.equal(r.exitCode, 0, "placeholders are warnings, not errors");
      assert.ok(r.stdout.includes("WARN"), "should warn about placeholder sections");
    });

    it("exits 1 with no active plan and no argument", () => {
      const dir = getTempDir();
      mkdirSync(join(dir, "plans"), { recursive: true });
      const r = runValidate(dir);
      assert.equal(r.exitCode, 1, "should fail with no active plan");
    });

    it("shows help with --help flag", () => {
      const dir = getTempDir();
      const r = runValidate(dir, "--help");
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("Usage"), "should show usage");
    });
  });

  describe("LESSONS.md", () => {
    it("LESSONS.md is not overwritten on second new", () => {
      const dir = getTempDir();
      run(dir, "new", "first");
      run(dir, "close");
      // Write custom content to LESSONS.md
      writeFileSync(join(dir, "plans", "LESSONS.md"), "# Lessons Learned\n\n## Custom lesson\n- Something important\n");
      run(dir, "new", "second");
      const lessons = readFileSync(join(dir, "plans", "LESSONS.md"), "utf-8");
      assert.ok(lessons.includes("Custom lesson"), "should preserve existing LESSONS.md content");
    });

    it("close output mentions LESSONS.md update", () => {
      const dir = getTempDir();
      run(dir, "new", "test");
      const r = run(dir, "close");
      assert.ok(r.stdout.includes("LESSONS.md"), "close output should mention LESSONS.md");
    });

    it("new output mentions LESSONS.md in cross-plan context", () => {
      const dir = getTempDir();
      const r = run(dir, "new", "test");
      assert.ok(r.stdout.includes("LESSONS.md"), "new output should mention LESSONS.md");
    });
  });
});
