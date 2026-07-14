#!/usr/bin/env node
// Comprehensive tests for bootstrap.mjs using Node.js built-in test runner.
// Run: node --test src/scripts/bootstrap.test.mjs
// Requires: Node.js 18+

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, unlinkSync, renameSync, copyFileSync } from "fs";
import { join, resolve } from "path";
import { execFileSync, spawnSync } from "child_process";
import { tmpdir } from "os";
import { randomBytes, createHash } from "crypto";

// Path to bootstrap.mjs (relative to this test file)
const BOOTSTRAP = resolve(import.meta.dirname, "bootstrap.mjs");
const SHARED = resolve(import.meta.dirname, "shared.mjs");

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
      assert.match(planDir, /^plan-\d{4}-\d{2}-\d{2}T\d{6}-[0-9a-f]{8}$/, "dir name format");

      // All expected files exist
      const base = join(dir, "plans", planDir);
      for (const f of ["state.md", "plan.md", "decisions.md", "findings.md", "progress.md", "verification.md", "changelog.md"]) {
        assert.ok(existsSync(join(base, f)), `${f} should exist`);
      }
      // The changelog is MARKDOWN, and an append is one line (v2.35.0 reverted the XML encoding —
      // it made every append a whole-file read-modify-write, which lost entries under concurrency).
      assert.ok(!existsSync(join(base, "changelog.xml")), "no changelog.xml is created");
      const changelog = readFileSync(join(base, "changelog.md"), "utf-8");
      assert.ok(changelog.startsWith("# Changelog"), "changelog should have header");
      assert.ok(changelog.includes("Append-only per-edit ledger"), "changelog should describe purpose");
      assert.ok(changelog.includes("references/blast-radius.md"), "changelog should reference blast-radius doc");
      // Subdirectories
      assert.ok(existsSync(join(base, "checkpoints")), "checkpoints/ should exist");
      assert.ok(existsSync(join(base, "findings")), "findings/ should exist");

      // Consolidated files
      assert.ok(existsSync(join(dir, "plans", "FINDINGS.md")), "FINDINGS.md should exist");
      assert.ok(existsSync(join(dir, "plans", "DECISIONS.md")), "DECISIONS.md should exist");
      assert.ok(existsSync(join(dir, "plans", "LESSONS.md")), "LESSONS.md should exist");
      assert.ok(existsSync(join(dir, "plans", "SYSTEM.md")), "SYSTEM.md should exist");
    });

    it("LESSONS.md has correct initial content", () => {
      const dir = getTempDir();
      run(dir, "new", "Test goal");
      const lessons = readFileSync(join(dir, "plans", "LESSONS.md"), "utf-8");
      assert.ok(lessons.includes("# Lessons Learned"), "should have header");
      assert.ok(lessons.includes("Max 200 lines"), "should mention 200 line limit");
      assert.ok(lessons.includes("institutional memory"), "should mention institutional memory");
    });

    it("SYSTEM.md skeleton has correct schema and is under cap", () => {
      const dir = getTempDir();
      run(dir, "new", "Test goal");
      const system = readFileSync(join(dir, "plans", "SYSTEM.md"), "utf-8");
      assert.ok(system.includes("# System Atlas"), "should have System Atlas header");
      assert.ok(system.includes("*Last refreshed: (none yet)"), "should have placeholder Last refreshed line");
      assert.ok(system.includes("max 300 lines"), "should mention 300 line cap");
      // Six core sections (domain-neutral) — must all be present.
      for (const section of ["## Identity", "## Components", "## Boundaries", "## Invariants", "## Flows", "## Known Patterns"]) {
        assert.ok(system.includes(section), `should have section: ${section}`);
      }
      // Optional codebase section is present in skeleton (becomes optional only after first archivist rewrite).
      assert.ok(system.includes("## Codebase Specialization"), "should have optional Codebase Specialization section");
      // The skeleton carries the doc's BULLET-LIST schema, not italic placeholder paragraphs. These
      // content bullets were silently missing from the skeleton until the schema was re-synced; pin
      // them so the omission cannot come back. They are ITALIC — every bullet in a fresh atlas is a
      // schema hint, not an established fact (see the unpopulated-marking test below).
      for (const bullet of [
        "- *In scope vs out of scope.*",
        "- *External dependencies (services, APIs, files).*",
        "- *Boundary inputs the planner reads but does not own (e.g. CLAUDE.md, config files).*",
        "- *Each grounded in a finding-id or decision-id reference",
        "- *Module map: top-level directories and their purpose.*",
        "- *Key files (by frequency-of-relevance).*",
        "- *Build / test / run commands.*",
      ]) {
        assert.ok(system.includes(bullet), `skeleton should carry the doc's schema bullet: ${bullet}`);
      }
      // Skeleton must be well under the 300-line hard cap.
      const lineCount = system.split("\n").length;
      assert.ok(lineCount < 100, `skeleton should be under 100 lines (got ${lineCount})`);
    });

    // THE DEFECT: SYSTEM.md is read at the START of EXPLORE and PLAN. A fresh one is EMPTY, but its
    // bullets are content-shaped ("Top-level building blocks. 5-15 entries."), so an agent mines them
    // as established system facts. It was the only bootstrap-written file whose empty state was
    // textually indistinguishable from a populated one. The marking is mechanical, not vibes: the
    // banner is present AND no bullet is un-italicized.
    it("a fresh SYSTEM.md reads as UNPOPULATED — banner present, zero un-italicized content bullets", () => {
      const dir = getTempDir();
      run(dir, "new", "Test goal");
      const system = readFileSync(join(dir, "plans", "SYSTEM.md"), "utf-8");
      assert.ok(
        system.includes("*UNPOPULATED SKELETON — every bullet below is a schema hint, not an established fact."),
        "a fresh atlas must announce itself as an unpopulated skeleton",
      );
      const bare = system.split("\n").filter((l) => /^- (?!\*)/.test(l));
      assert.deepEqual(
        bare,
        [],
        `every schema hint must be italicized so it cannot be read as an asserted fact; bare: ${bare.join(" // ")}`,
      );
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
      assert.ok(r.stdout.includes("plan-"), "should show plan dir name");
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

    it("does not record an invalid CLOSE→CLOSE transition when already CLOSE (B2)", () => {
      const dir = getTempDir();
      run(dir, "new", "Idempotent close test");
      const planDir = getPointer(dir);
      const statePath = join(dir, "plans", planDir, "state.md");
      // Simulate the documented CLOSE flow: the agent sets Current State to CLOSE
      // (REFLECT→CLOSE already logged) before invoking `bootstrap.mjs close`.
      const state = readFileSync(statePath, "utf-8")
        .replace(/^# Current State:.*$/m, "# Current State: CLOSE");
      writeFileSync(statePath, state);
      run(dir, "close");
      const after = readFileSync(statePath, "utf-8");
      assert.ok(!after.includes("CLOSE → CLOSE (bootstrap close)"),
        `re-close must not append a CLOSE→CLOSE history bullet:\n${after}`);
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

    // iter-2/step-3 — `-` (0x2D) sorts before `_` (0x5F), so a raw name sort put EVERY
    // new-format dir ahead of EVERY legacy dir regardless of date. Fixture: the legacy
    // dir is the NEWER of the two, so a lexical sort would print it first (wrong) and a
    // chronological sort prints it last (right).
    it("orders mixed-grammar dirs chronologically, not lexically", () => {
      const dir = getTempDir();
      mkdirSync(join(dir, "plans"), { recursive: true });
      const older = "plan-2020-01-01T000000-aaaaaaaa"; // new grammar, OLDER
      const newer = "plan_2030-12-31_bbbbbbbb";        // legacy grammar, NEWER
      for (const name of [older, newer]) {
        mkdirSync(join(dir, "plans", name), { recursive: true });
        writeFileSync(join(dir, "plans", name, "state.md"), "# Current State: CLOSED\n");
        writeFileSync(join(dir, "plans", name, "plan.md"), `# Plan\n\n## Goal\n\ngoal ${name}\n`);
      }
      const r = run(dir, "list");
      assert.equal(r.exitCode, 0);
      const iOlder = r.stdout.indexOf(older);
      const iNewer = r.stdout.indexOf(newer);
      assert.ok(iOlder !== -1 && iNewer !== -1, `both dirs must be listed, got:\n${r.stdout}`);
      assert.ok(iOlder < iNewer, `2020 (new grammar) must precede 2030 (legacy), got:\n${r.stdout}`);
    });

    it("breaks same-day ties deterministically (planDateFromId resolves only to the day)", () => {
      const dir = getTempDir();
      mkdirSync(join(dir, "plans"), { recursive: true });
      const early = "plan-2026-07-14T010101-aaaaaaaa";
      const late = "plan-2026-07-14T235959-bbbbbbbb";
      for (const name of [late, early]) {
        mkdirSync(join(dir, "plans", name), { recursive: true });
        writeFileSync(join(dir, "plans", name, "state.md"), "# Current State: CLOSED\n");
        writeFileSync(join(dir, "plans", name, "plan.md"), `# Plan\n\n## Goal\n\ngoal\n`);
      }
      const a = run(dir, "list");
      const b = run(dir, "list");
      assert.equal(a.stdout, b.stdout, "list output must be stable across runs");
      assert.ok(a.stdout.indexOf(early) < a.stdout.indexOf(late), `same-day tie must order by full name, got:\n${a.stdout}`);
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
  // --force is positional (defect #3 — plan_2026-07-14_79ee0f59 step 3)
  // A `--force` token in GOAL TEXT must never force-close the active plan.
  // =========================================================================
  describe("new --force is positional only", () => {
    it("does NOT force-close when --force appears in word-split goal text", () => {
      const dir = getTempDir();
      run(dir, "new", "Original plan");
      const original = getPointer(dir);
      assert.ok(original, "precondition: an active plan exists");

      // A caller that word-splits the goal "add a --force flag" — the exact
      // destructive case: this used to close `original` silently.
      const r = run(dir, "new", "add", "a", "--force", "flag");

      assert.notEqual(r.exitCode, 0, "should refuse: an active plan exists");
      assert.equal(getPointer(dir), original, "pointer must still name the original plan");

      // The original plan must still be active (not force-closed).
      const state = readPlanFile(dir, original, "state.md");
      assert.ok(!/^# Current State: CLOSE\b/m.test(state), "original plan must not be closed");

      // And no second plan directory may have been created.
      const plans = readdirSync(join(dir, "plans")).filter((n) => /^plan[-_]/.test(n));
      assert.equal(plans.length, 1, `exactly one plan dir should exist, got: ${plans.join(", ")}`);
    });

    it("still force-closes on the documented `new --force \"goal\"` form", () => {
      const dir = getTempDir();
      run(dir, "new", "Old plan");
      const oldPlan = getPointer(dir);
      const r = run(dir, "new", "--force", "New plan");
      assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
      const newPlan = getPointer(dir);
      assert.notEqual(newPlan, oldPlan, "should have created a different plan");
      assert.ok(existsSync(join(dir, "plans", oldPlan)), "old plan dir preserved");
      const oldState = readPlanFile(dir, oldPlan, "state.md");
      assert.ok(/^# Current State: CLOSE\b/m.test(oldState), "old plan should be closed by force");
      // Goal must not carry the flag token.
      const plan = readPlanFile(dir, newPlan, "plan.md");
      assert.ok(plan.includes("New plan"), "goal should be the text after --force");
      assert.ok(!plan.includes("--force"), "flag token must not leak into the goal");
    });

    it("preserves a mid-goal --force token verbatim (single argv element)", () => {
      const dir = getTempDir();
      const goal = "goal with --force in the middle";
      const r = run(dir, "new", goal);
      assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
      const planDir = getPointer(dir);
      const plan = readPlanFile(dir, planDir, "plan.md");
      assert.ok(plan.includes(goal), `goal must be preserved verbatim, got:\n${plan.slice(0, 400)}`);
    });

    it("preserves a word-split --force token in the goal (no silent stripping)", () => {
      const dir = getTempDir();
      const r = run(dir, "new", "add", "a", "--force", "flag");
      assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
      const planDir = getPointer(dir);
      const plan = readPlanFile(dir, planDir, "plan.md");
      assert.ok(
        plan.includes("add a --force flag"),
        `goal must keep the --force token, got:\n${plan.slice(0, 400)}`
      );
    });

    it("backward-compatible bare goal form still creates a plan", () => {
      const dir = getTempDir();
      const r = run(dir, "refactor the parser module");
      assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
      const planDir = getPointer(dir);
      assert.ok(planDir, "bare goal form should create a plan");
      const plan = readPlanFile(dir, planDir, "plan.md");
      assert.ok(plan.includes("refactor the parser module"), "goal should be preserved");
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

    it("near-miss subcommand is rejected with a suggestion", () => {
      const dir = getTempDir();
      const r = run(dir, "staus");
      assert.notEqual(r.exitCode, 0, "should reject typo'd subcommand");
      assert.ok(r.stderr.includes("status"), "should suggest the nearest subcommand");
      assert.ok(!getPointer(dir), "should not create a plan");
    });

    it("single-word goal not near any subcommand still creates a plan", () => {
      const dir = getTempDir();
      const r = run(dir, "refactor");
      assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
      const planDir = getPointer(dir);
      assert.ok(planDir, "should create plan for a non-near single-word goal");
      const plan = readPlanFile(dir, planDir, "plan.md");
      assert.ok(plan.includes("refactor"), "should contain goal");
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
      const lines = r.stdout.split("\n").filter((l) => /plan[-_]\d{4}/.test(l));
      assert.equal(lines.length, 2, "should list 2 plans");
      const activeLine = lines.find((l) => l.includes("active"));
      assert.ok(activeLine, "one plan should be active");
      assert.ok(activeLine.includes("Plan B"), "active plan should be Plan B");
    });

    it("orphan warning when pointer file exists but points to non-existent dir", () => {
      const dir = getTempDir();
      run(dir, "new", "Orphan test");
      // Overwrite pointer to point to non-existent directory (simulates crash)
      writeFileSync(join(dir, "plans", ".current_plan"), "plan_1999-01-01_deadbeef");
      // Now create a new plan — should warn about orphan (use runFull to capture stderr on success)
      const r = runFull(dir, "new", "New after orphan");
      assert.equal(r.exitCode, 0);
      assert.ok(r.stderr.includes("WARNING"), "should warn about orphaned directories");
    });

    it("no orphan warning when pointer file is absent (normal close)", () => {
      const dir = getTempDir();
      run(dir, "new", "Closed plan");
      run(dir, "close");
      // Pointer removed by close — this is normal, not an orphan
      const r = runFull(dir, "new", "New after close");
      assert.equal(r.exitCode, 0);
      assert.ok(!r.stderr.includes("WARNING"), "should not warn after normal close");
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

    it("path-traversal pointer rejected by plan-id regex", () => {
      // Even if an attacker-supplied pointer points to a real-existing path,
      // the regex must reject anything outside the canonical plan_*-*-*_hex8 shape.
      const dir = getTempDir();
      mkdirSync(join(dir, "plans"), { recursive: true });
      // Path traversal attempt — the path itself doesn't matter, the regex must reject the shape.
      writeFileSync(join(dir, "plans", ".current_plan"), "../../etc\n");
      const r = run(dir, "status");
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("No active plan"), "regex must reject traversal sequence");
    });

    it("pointer with valid shape but wrong-format date rejected", () => {
      // Date-component must be YYYY-MM-DD; bare digits or wrong separators fail.
      const dir = getTempDir();
      mkdirSync(join(dir, "plans"), { recursive: true });
      // Make a directory matching the wrong shape so existsSync would otherwise succeed
      mkdirSync(join(dir, "plans", "plan_2026_05_15_a3f1b2c9"), { recursive: true });
      writeFileSync(join(dir, "plans", ".current_plan"), "plan_2026_05_15_a3f1b2c9\n");
      const r = run(dir, "status");
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("No active plan"), "regex must reject wrong date format");
    });

    it("pointer with non-hex characters in seed rejected", () => {
      const dir = getTempDir();
      mkdirSync(join(dir, "plans"), { recursive: true });
      mkdirSync(join(dir, "plans", "plan_2026-05-15_ZZZZZZZZ"), { recursive: true });
      writeFileSync(join(dir, "plans", ".current_plan"), "plan_2026-05-15_ZZZZZZZZ\n");
      const r = run(dir, "status");
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("No active plan"), "regex must reject non-hex seed");
    });

    it("pointer with whitespace/newline trimmed and validated", () => {
      // Trim handles whitespace, then the regex applies. Legitimate plan should still match.
      const dir = getTempDir();
      run(dir, "new", "Whitespace trim test");
      const planDir = getPointer(dir);
      // Rewrite pointer with extra leading newline + trailing whitespace
      writeFileSync(join(dir, "plans", ".current_plan"), `\n  ${planDir}  \n\n`);
      const r = run(dir, "status");
      assert.equal(r.exitCode, 0);
      // Active plan should still be discovered
      assert.ok(r.stdout.includes(planDir) || r.stdout.includes("EXPLORE"),
        `legitimate plan must survive whitespace trim. stdout: ${r.stdout}`);
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
      // stripHeader returns empty string when no ## found, so nothing is merged.
      // This prevents H1 headers from being injected under H2 plan sections.
      assert.ok(!consolidated.includes("plain text"), "content without ## headings should not be merged");
      assert.ok(!consolidated.includes(planDir), "no plan section created when content has no ## headings");
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
    it("trims consolidated files to 4 most recent plan sections", () => {
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
      const sections = consolidated.match(/\n## plan[-_]/g) || [];
      assert.equal(sections.length, 4, "should keep exactly 4 plan sections");
      // Newest (last created) should be present
      assert.ok(consolidated.includes(planDirs[9]), "newest plan should be present");
      assert.ok(consolidated.includes(planDirs[6]), "4th newest plan should be present");
      // Oldest should be trimmed
      assert.ok(!consolidated.includes(planDirs[0]), "oldest plan should be trimmed");
      assert.ok(!consolidated.includes(planDirs[5]), "5th newest plan should be trimmed");
    });

    it("does not trim when ≤4 plan sections exist", () => {
      const dir = getTempDir();
      const planDirs = [];
      for (let i = 0; i < 3; i++) {
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
      const sections = consolidated.match(/\n## plan[-_]/g) || [];
      assert.equal(sections.length, 3, "all 3 plan sections should remain");
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
      // Should have at most 4 plan sections
      const sections = result.match(/\n## plan[-_]/g) || [];
      assert.ok(sections.length <= 4, `should have ≤4 sections, got ${sections.length}`);
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
      assert.ok(v.includes("## Not Verified"), "should have not verified section");
      assert.ok(v.includes("## Verdict"), "should have verdict section");
    });

    it("verification.md Additional Checks has 3 required pre-populated rows", () => {
      const dir = getTempDir();
      run(dir, "new", "Additional Checks rows test");
      const planDir = getPointer(dir);
      const v = readPlanFile(dir, planDir, "verification.md");
      // Step 1 change — required rows: Regression, Scope drift, Diff review (all PENDING)
      assert.ok(v.includes("| Regression |"), "should have Regression row");
      assert.ok(v.includes("| Scope drift |"), "should have Scope drift row");
      assert.ok(v.includes("| Diff review |"), "should have Diff review row");
      // The old "Optional: lint, ..." placeholder must be gone
      assert.ok(!v.match(/^\*Optional: lint, type checks/m), "should not contain old Optional-only placeholder");
    });

    it("verification.md Verdict has 5-bullet skeleton in order", () => {
      const dir = getTempDir();
      run(dir, "new", "Verdict skeleton test");
      const planDir = getPointer(dir);
      const v = readPlanFile(dir, planDir, "verification.md");
      // Step 2 — 5 required Verdict bullets
      const verdictStart = v.indexOf("## Verdict");
      assert.ok(verdictStart >= 0, "should have Verdict section");
      const verdict = v.slice(verdictStart);
      const expectedOrder = [
        "Criteria passed:",
        "Regressions:",
        "Scope drift:",
        "Simplification blockers:",
        "Recommendation:",
      ];
      let lastIdx = -1;
      for (const bullet of expectedOrder) {
        const idx = verdict.indexOf(bullet);
        assert.ok(idx >= 0, `Verdict should contain "${bullet}"`);
        assert.ok(idx > lastIdx, `Verdict bullet "${bullet}" should appear after previous bullet`);
        lastIdx = idx;
      }
    });

    it("findings.md has Corrections section", () => {
      const dir = getTempDir();
      run(dir, "new", "Corrections section test");
      const planDir = getPointer(dir);
      const findings = readPlanFile(dir, planDir, "findings.md");
      // Step 1 — Corrections section
      assert.ok(findings.includes("## Corrections"), "findings.md should have ## Corrections section");
      assert.ok(findings.includes("[CORRECTED iter-N]"), "should mention [CORRECTED iter-N] marker convention");
    });

    it("decisions.md has schema example block", () => {
      const dir = getTempDir();
      run(dir, "new", "Decisions schema example test");
      const planDir = getPointer(dir);
      const decisions = readPlanFile(dir, planDir, "decisions.md");
      // Step 2 — commented schema example
      assert.ok(decisions.includes("<!-- Schema example"), "should include HTML-comment schema example");
      assert.ok(decisions.includes("D-001 | EXPLORE → PLAN"), "schema example should show D-001 header form");
      assert.ok(decisions.includes("**Trade-off**:"), "schema example should show Trade-off field");
      assert.ok(decisions.includes("**Anchor-Refs**:"), "schema example should mention Anchor-Refs field");
    });

    it("decisions.md has *Plan: <plan-id>* preamble line", () => {
      const dir = getTempDir();
      run(dir, "new", "Plan-id preamble test");
      const planDir = getPointer(dir);
      const decisions = readPlanFile(dir, planDir, "decisions.md");
      // v2.14.0 — plan-id preamble for self-identification post-trim
      assert.ok(decisions.includes(`*Plan: ${planDir}*`), `decisions.md should contain "*Plan: ${planDir}*" preamble`);
      // Preamble must appear before the schema example block
      const preambleIdx = decisions.indexOf(`*Plan: ${planDir}*`);
      const schemaIdx = decisions.indexOf("<!-- Schema example");
      assert.ok(preambleIdx >= 0 && preambleIdx < schemaIdx, "preamble must appear before schema example block");
    });

    it("decisions.md schema example references qualified anchor format", () => {
      const dir = getTempDir();
      run(dir, "new", "Qualified anchor schema example test");
      const planDir = getPointer(dir);
      const decisions = readPlanFile(dir, planDir, "decisions.md");
      // v2.14.0 — anchor format in schema comment must use plan-id prefix
      const qualifiedAnchorPattern = `# DECISION ${planDir}/D-NNN`;
      assert.ok(
        decisions.includes(qualifiedAnchorPattern),
        `schema example should reference qualified anchor "${qualifiedAnchorPattern}"`
      );
    });

    it("state.md has Exploration Confidence guidance for EXPLORE → PLAN", () => {
      const dir = getTempDir();
      run(dir, "new", "Exploration confidence slot test");
      const planDir = getPointer(dir);
      const state = readPlanFile(dir, planDir, "state.md");
      // Step 2 — Exploration Confidence slot in transition log
      assert.ok(state.includes("Exploration Confidence"), "state.md should mention Exploration Confidence");
      assert.ok(state.includes("confidence: scope="), "should show confidence shape: scope=");
    });

    it("verification.md has convergence metrics section", () => {
      const dir = getTempDir();
      run(dir, "new", "Convergence metrics test");
      const planDir = getPointer(dir);
      const v = readPlanFile(dir, planDir, "verification.md");
      assert.ok(v.includes("## Convergence Metrics"), "should have convergence metrics section");
      assert.ok(v.includes("Pass rate"), "should have pass rate row");
      assert.ok(v.includes("Convergence score"), "should have convergence score row");
      assert.ok(v.includes("convergence-metrics.md"), "should reference convergence-metrics.md");
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

    it("pipe character in goal is escaped in INDEX.md table", () => {
      const dir = getTempDir();
      run(dir, "new", "Fix auth | pipe test");
      const planDir = getPointer(dir);
      run(dir, "close");
      const content = readFileSync(join(dir, "plans", "INDEX.md"), "utf-8");
      // Should have escaped pipe so it doesn't break the table
      assert.ok(content.includes("\\|"), "pipe in goal should be escaped");
      // Count columns in the data row (should be exactly 4 data columns)
      const dataRows = content.split("\n").filter((l) => l.includes(planDir));
      assert.equal(dataRows.length, 1, "should have exactly one row for the plan");
      const cols = dataRows[0].split("|").filter((c) => c.trim()).length;
      assert.equal(cols, 4, "row should have exactly 4 columns despite pipe in goal");
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

    it("extractSection captures full multi-line content", () => {
      const dir = getTempDir();
      run(dir, "new", "extract test");
      const planDir = getPointer(dir);
      // Write findings with 5 indexed items
      writeFileSync(
        join(dir, "plans", planDir, "findings.md"),
        "# Findings\n\n## Index\n- Finding A\n- Finding B\n- Finding C\n- Finding D\n- Finding E\n\n## Key Constraints\n- Constraint 1\n"
      );
      // Set state to PLAN (triggers findings count check)
      const statePath = join(dir, "plans", planDir, "state.md");
      const state = readFileSync(statePath, "utf-8");
      writeFileSync(statePath, state.replace("# Current State: EXPLORE", "# Current State: PLAN"));
      const r = runValidate(dir);
      // Should NOT warn about insufficient findings (5 >= 3)
      assert.ok(!r.stdout.includes("indexed findings"), "should not warn about findings count when >=3 exist");
    });

    it("warns when fewer than 3 findings in PLAN state", () => {
      const dir = getTempDir();
      run(dir, "new", "low findings test");
      const planDir = getPointer(dir);
      writeFileSync(
        join(dir, "plans", planDir, "findings.md"),
        "# Findings\n\n## Index\n- Finding A\n- Finding B\n\n## Key Constraints\n- None\n"
      );
      const statePath = join(dir, "plans", planDir, "state.md");
      const state = readFileSync(statePath, "utf-8");
      writeFileSync(statePath, state.replace("# Current State: EXPLORE", "# Current State: PLAN"));
      const r = runValidate(dir);
      assert.ok(r.stdout.includes("Only 2 indexed findings"), "should warn about only 2 findings");
    });

    it("does not warn about findings in EXPLORE state", () => {
      const dir = getTempDir();
      run(dir, "new", "explore findings test");
      const planDir = getPointer(dir);
      writeFileSync(
        join(dir, "plans", planDir, "findings.md"),
        "# Findings\n\n## Index\n- Finding A\n\n## Key Constraints\n- None\n"
      );
      // State is EXPLORE by default — should not warn
      const r = runValidate(dir);
      assert.ok(!r.stdout.includes("indexed findings"), "should not warn about findings count in EXPLORE");
    });

    it("warns about missing summary.md at CLOSE state", () => {
      const dir = getTempDir();
      run(dir, "new", "summary check test");
      const planDir = getPointer(dir);
      const statePath = join(dir, "plans", planDir, "state.md");
      writeFileSync(statePath,
        "# Current State: CLOSE\n## Iteration: 1\n## Current Plan Step: done\n## Last Transition: REFLECT → CLOSE\n## Transition History:\n- INIT → EXPLORE (start)\n- EXPLORE → PLAN (ready)\n- PLAN → EXECUTE (approved)\n- EXECUTE → REFLECT (done)\n- REFLECT → CLOSE (pass)\n"
      );
      writeFileSync(join(dir, "plans", planDir, "verification.md"), "# Verification\n");
      // No summary.md — should warn
      const r = runValidate(dir);
      assert.ok(r.stdout.includes("summary.md missing"), "should warn about missing summary.md at CLOSE");
    });

    it("no summary.md warning when summary exists at CLOSE", () => {
      const dir = getTempDir();
      run(dir, "new", "summary present test");
      const planDir = getPointer(dir);
      const statePath = join(dir, "plans", planDir, "state.md");
      writeFileSync(statePath,
        "# Current State: CLOSE\n## Iteration: 1\n## Current Plan Step: done\n## Last Transition: REFLECT → CLOSE\n## Transition History:\n- INIT → EXPLORE (start)\n- EXPLORE → PLAN (ready)\n- PLAN → EXECUTE (approved)\n- EXECUTE → REFLECT (done)\n- REFLECT → CLOSE (pass)\n"
      );
      writeFileSync(join(dir, "plans", planDir, "verification.md"), "# Verification\n");
      writeFileSync(join(dir, "plans", planDir, "summary.md"), "# Summary\nDone.\n");
      const r = runValidate(dir);
      assert.ok(!r.stdout.includes("summary.md missing"), "should not warn when summary.md exists");
    });

    it("detects iteration/version mismatch", () => {
      const dir = getTempDir();
      run(dir, "new", "iter mismatch test");
      const planDir = getPointer(dir);
      writeFileSync(
        join(dir, "plans", planDir, "state.md"),
        "# Current State: EXECUTE\n## Iteration: 3\n## Current Plan Step: 1\n## Last Transition: PLAN → EXECUTE\n## Transition History:\n- INIT → EXPLORE (start)\n- EXPLORE → PLAN (ready)\n- PLAN → EXECUTE (approved)\n"
      );
      writeFileSync(
        join(dir, "plans", planDir, "plan.md"),
        "# Plan v1\n\n## Goal\nTest\n\n## Problem Statement\nTest\n\n## Files To Modify\nf.js\n\n## Steps\n1. Do\n\n## Assumptions\nNone\n\n## Failure Modes\nNone\n\n## Pre-Mortem & Falsification Signals\nNone\n\n## Success Criteria\nPass\n\n## Verification Strategy\nRun\n\n## Complexity Budget\n0/3\n"
      );
      const r = runValidate(dir);
      assert.ok(r.stdout.includes("iteration (3) != plan.md version (v1)"), "should warn about iteration/version mismatch");
    });

    it("extractSection handles last section without trailing heading", () => {
      const dir = getTempDir();
      run(dir, "new", "last section test");
      const planDir = getPointer(dir);
      // Findings where Index is the last section
      writeFileSync(
        join(dir, "plans", planDir, "findings.md"),
        "# Findings\n\n## Index\n- Finding A\n- Finding B\n- Finding C\n"
      );
      const statePath = join(dir, "plans", planDir, "state.md");
      const state = readFileSync(statePath, "utf-8");
      writeFileSync(statePath, state.replace("# Current State: EXPLORE", "# Current State: PLAN"));
      const r = runValidate(dir);
      assert.ok(!r.stdout.includes("indexed findings"), "should correctly count findings in last section");
    });

    it("counts numbered-list findings correctly", () => {
      const dir = getTempDir();
      run(dir, "new", "numbered findings test");
      const planDir = getPointer(dir);
      writeFileSync(
        join(dir, "plans", planDir, "findings.md"),
        "# Findings\n\n## Index\n1. Auth module uses JWT\n2. Session store in Redis\n3. Token expiry is 24h\n"
      );
      const statePath = join(dir, "plans", planDir, "state.md");
      const state = readFileSync(statePath, "utf-8");
      writeFileSync(statePath, state.replace("# Current State: EXPLORE", "# Current State: PLAN"));
      const r = runValidate(dir);
      assert.ok(!r.stdout.includes("indexed findings"), "should count numbered-list findings without warning");
    });

    it("warns about placeholder convergence metrics at iteration 2+", () => {
      const dir = getTempDir();
      run(dir, "new", "convergence placeholder test");
      const planDir = getPointer(dir);
      // Set state to REFLECT at iteration 2 — convergence metrics should be filled
      writeFileSync(
        join(dir, "plans", planDir, "state.md"),
        "# Current State: REFLECT\n## Iteration: 2\n## Current Plan Step: 3\n## Last Transition: EXECUTE → REFLECT\n## Transition History:\n- INIT → EXPLORE (start)\n- EXPLORE → PLAN (ready)\n- PLAN → EXECUTE (approved)\n- EXECUTE → REFLECT (done)\n"
      );
      // verification.md has the section header but placeholder dashes
      const r = runValidate(dir);
      assert.ok(r.stdout.includes("placeholder values"), "should warn when convergence metrics are still placeholders at iteration 2+");
    });

    // ---------------------------------------------------------------------
    // v2.14.0 plan-qualified DECISION anchors
    // ---------------------------------------------------------------------

    /** Set the INIT timestamp in state.md (controls pre-/post-cutover gating). */
    function setInitTimestamp(dir, planDir, isoTs) {
      const statePath = join(dir, "plans", planDir, "state.md");
      const state = readFileSync(statePath, "utf-8");
      const updated = state.replace(
        /## Last Transition: INIT → EXPLORE \([^)]+\)/,
        `## Last Transition: INIT → EXPLORE (${isoTs})`
      );
      writeFileSync(statePath, updated);
    }

    /** Write a minimal valid decisions.md with one D-001 entry, with or without preamble. */
    function writeDecisionsWithEntry(dir, planDir, { withPreamble = true, withAnchorRefs = false } = {}) {
      const refs = withAnchorRefs ? "**Anchor-Refs**: `src/sample.py:3`\n" : "";
      const preamble = withPreamble ? `*Plan: ${planDir}*\n` : "";
      writeFileSync(
        join(dir, "plans", planDir, "decisions.md"),
        `# Decision Log\n${preamble}*Append-only.*\n\n## D-001 | EXPLORE → PLAN | 2026-05-07\n**Context**: test\n**Decision**: do it\n**Trade-off**: speed **at the cost of** thoroughness\n**Reasoning**: testing\n${refs}`
      );
    }

    it("qualified anchor matching active plan resolves silently", () => {
      const dir = getTempDir();
      run(dir, "new", "qualified silent");
      const planDir = getPointer(dir);
      writeDecisionsWithEntry(dir, planDir);
      writeFileSync(join(dir, "src.py"), `# DECISION ${planDir}/D-001: rationale\nx = 1\n`);
      const r = runValidate(dir);
      assert.ok(!r.stdout.includes("anchor-orphan"), "qualified anchor matching active plan should not be orphan");
      assert.ok(!r.stdout.includes("anchor-unqualified"), "qualified anchor should not trigger unqualified WARN");
      assert.ok(!r.stdout.includes("anchor-unknown-plan"), "active plan should be known");
    });

    it("bare D-NNN anchor emits WARN [anchor-unqualified] (resolution still works)", () => {
      const dir = getTempDir();
      run(dir, "new", "bare anchor migration");
      const planDir = getPointer(dir);
      writeDecisionsWithEntry(dir, planDir);
      writeFileSync(join(dir, "src.py"), `# DECISION D-001: bare legacy form\nx = 1\n`);
      const r = runValidate(dir);
      assert.ok(r.stdout.includes("anchor-unqualified"), "bare anchor should WARN [anchor-unqualified]");
      // Severity must be WARN not ERROR (migration nudge)
      const lines = r.stdout.split("\n").filter((l) => l.includes("anchor-unqualified"));
      assert.ok(lines.every((l) => l.trim().startsWith("WARN")), "anchor-unqualified must be WARN");
      assert.ok(!r.stdout.includes("anchor-orphan"), "bare anchor with matching D-001 should still resolve");
    });

    // iter-2/step-1 — the commit tag (`plan-YYYY-MM-DD-HASH`) is the plan-dir name minus
    // `THHMMSS`. Pasted into an anchor it matches NO anchor regex: the read union fails,
    // the optional prefix group is skipped, then `D-` must match `plan-…` and does not.
    // Before this check the anchor produced ZERO findings — invisible, not orphaned.
    it("commit-tag-shaped anchor prefix emits exactly one WARN [anchor-badprefix]", () => {
      const dir = getTempDir();
      run(dir, "new", "badprefix commit tag");
      const planDir = getPointer(dir); // plan-YYYY-MM-DDTHHMMSS-XXXXXXXX
      const commitTag = planDir.replace(/T\d{6}-/, "-"); // exactly the derivation agents perform
      assert.notEqual(commitTag, planDir, "fixture must actually drop the THHMMSS segment");
      writeDecisionsWithEntry(dir, planDir);
      writeFileSync(join(dir, "src.js"), `// DECISION ${commitTag}/D-001: rationale\nconst x = 1;\n`);
      const r = runValidate(dir);
      const bad = r.stdout.split("\n").filter((l) => l.includes("[anchor-badprefix]"));
      assert.equal(bad.length, 1, `exactly one badprefix WARN expected, got:\n${r.stdout}`);
      assert.ok(bad[0].trim().startsWith("WARN"), "anchor-badprefix must be WARN, not ERROR");
      assert.ok(bad[0].includes(commitTag), "message must name the offending prefix");
      assert.ok(bad[0].includes("commit tag"), "message must hint at the likely cause");
      // No double-reporting: the line is not ALSO an unqualified/orphan/unknown-plan finding.
      assert.ok(!r.stdout.includes("anchor-unqualified"), "badprefix must not double-report as unqualified");
      assert.ok(!r.stdout.includes("anchor-orphan"), "badprefix must not double-report as orphan");
      assert.ok(!r.stdout.includes("anchor-unknown-plan"), "badprefix must not double-report as unknown-plan");
      assert.equal(r.exitCode, 0, `a WARN alone must not change the exit code, got:\n${r.stdout}`);
    });

    it("garbage anchor prefix emits WARN [anchor-badprefix]", () => {
      const dir = getTempDir();
      run(dir, "new", "badprefix garbage");
      const planDir = getPointer(dir);
      writeDecisionsWithEntry(dir, planDir);
      writeFileSync(join(dir, "src.py"), `# DECISION foo/D-001: not a plan-id at all\nx = 1\n`);
      const r = runValidate(dir);
      const bad = r.stdout.split("\n").filter((l) => l.includes("[anchor-badprefix]"));
      assert.equal(bad.length, 1, `exactly one badprefix WARN expected, got:\n${r.stdout}`);
      assert.ok(bad[0].includes('"foo"'), "message must name the offending prefix");
      assert.equal(r.exitCode, 0, "WARN-only must exit 0");
    });

    it("both real plan-id grammars produce zero [anchor-badprefix]", () => {
      const dir = getTempDir();
      run(dir, "new", "badprefix negative");
      const planDir = getPointer(dir); // new grammar
      writeDecisionsWithEntry(dir, planDir);
      // A legacy-qualified anchor for a legacy plan dir that really exists, plus a
      // new-grammar anchor for the active plan, plus a bare anchor (owned by
      // anchor-unqualified, NOT by anchor-badprefix).
      const legacy = "plan_2026-05-07_7556fb98";
      mkdirSync(join(dir, "plans", legacy), { recursive: true });
      writeFileSync(
        join(dir, "plans", legacy, "decisions.md"),
        `# Decision Log\n*Plan: ${legacy}*\n\n## D-001 | PLAN | 2026-05-07\n**Context**: c\n**Decision**: d\n**Trade-off**: x **at the cost of** y\n**Reasoning**: r\n`
      );
      writeFileSync(
        join(dir, "src.js"),
        `// DECISION ${planDir}/D-001: new grammar\n// DECISION ${legacy}/D-001: legacy grammar\n// DECISION D-001: bare\nconst x = 1;\n`
      );
      const r = runValidate(dir);
      const bad = r.stdout.split("\n").filter((l) => l.includes("[anchor-badprefix]"));
      assert.deepEqual(bad, [], `real grammars must not be flagged, got:\n${r.stdout}`);
      assert.ok(r.stdout.includes("anchor-unqualified"), "the bare anchor keeps its own WARN");
    });

    it("qualified anchor naming unknown plan emits ERROR [anchor-unknown-plan]", () => {
      const dir = getTempDir();
      run(dir, "new", "unknown plan");
      const planDir = getPointer(dir);
      writeDecisionsWithEntry(dir, planDir);
      writeFileSync(
        join(dir, "src.py"),
        `# DECISION plan_2099-12-31_deadbeef/D-001: from a plan that doesn't exist\nx = 1\n`
      );
      const r = runValidate(dir);
      assert.ok(r.stdout.includes("anchor-unknown-plan"), "should ERROR on unknown plan name");
      assert.equal(r.exitCode, 1, "unknown plan must exit non-zero");
    });

    it("qualified anchor with known plan but unknown id emits ERROR [anchor-orphan]", () => {
      const dir = getTempDir();
      run(dir, "new", "orphan id");
      const planDir = getPointer(dir);
      writeDecisionsWithEntry(dir, planDir); // only D-001 exists
      writeFileSync(join(dir, "src.py"), `# DECISION ${planDir}/D-007: id never declared\nx = 1\n`);
      const r = runValidate(dir);
      assert.ok(r.stdout.includes("anchor-orphan"), "should ERROR [anchor-orphan] for unknown id");
      assert.equal(r.exitCode, 1, "orphan must exit non-zero");
    });

    // Defect #6 (iter-1/step-6): the validator's 4 anchor regexes hard-capped ids at
    // exactly 3 digits, so a `D-1000` anchor was INVISIBLE to the scanner — a real
    // orphan would go unreported (silent false-negative), and retire had nothing to
    // stamp. Both halves of the "retire stamps exactly what the validator scans"
    // contract had to widen together; this pins the validator half.
    it("scans a 4-digit anchor id (D-1000): orphan is reported, not silently skipped", () => {
      const dir = getTempDir();
      run(dir, "new", "wide id");
      const planDir = getPointer(dir);
      writeDecisionsWithEntry(dir, planDir); // only D-001 exists
      writeFileSync(join(dir, "src.py"), `# DECISION ${planDir}/D-1000: id past the old cap\nx = 1\n`);
      const r = runValidate(dir);
      assert.ok(r.stdout.includes("anchor-orphan"), `D-1000 anchor must be scanned + reported, got:\n${r.stdout}`);
      assert.match(r.stdout, /D-1000/, `the reported id must be D-1000 (not a truncated D-100), got:\n${r.stdout}`);
    });

    it("qualified anchor with [STALE] downgrades orphan to WARN", () => {
      const dir = getTempDir();
      run(dir, "new", "stale orphan");
      const planDir = getPointer(dir);
      writeDecisionsWithEntry(dir, planDir);
      writeFileSync(
        join(dir, "src.py"),
        `# DECISION ${planDir}/D-099 [STALE]: known orphan, marked stale\nx = 1\n`
      );
      const r = runValidate(dir);
      assert.ok(r.stdout.includes("anchor-orphan"), "should still flag orphan");
      const orphanLines = r.stdout.split("\n").filter((l) => l.includes("anchor-orphan"));
      assert.ok(orphanLines.every((l) => l.trim().startsWith("WARN")), "STALE orphan must be WARN not ERROR");
      assert.equal(r.exitCode, 0, "STALE-only orphans should not fail validation");
    });

    // `.md` joined ANCHOR_SOURCE_EXTS in 2.32.0. In Markdown the ONLY recognized
    // anchor form is an HTML comment opening with the DECISION token. Without the
    // positive block below the scanner change would be unfalsifiable.
    it("md HTML-comment anchor naming unknown plan emits ERROR [anchor-unknown-plan]", () => {
      const dir = getTempDir();
      run(dir, "new", "md anchor visible");
      const planDir = getPointer(dir);
      writeDecisionsWithEntry(dir, planDir);
      mkdirSync(join(dir, "docs"), { recursive: true });
      writeFileSync(
        join(dir, "docs", "note.md"),
        `# Notes\n\n<!-- DECISION plan_2099-12-31_deadbeef/D-001: from a plan that doesn't exist -->\n\ntext\n`
      );
      const r = runValidate(dir);
      assert.ok(r.stdout.includes("anchor-unknown-plan"), `md HTML anchor should be seen, got:\n${r.stdout}`);
      assert.ok(r.stdout.includes("docs/note.md:3"), `should report the md file and line, got:\n${r.stdout}`);
      const lines = r.stdout.split("\n").filter((l) => l.includes("anchor-unknown-plan"));
      assert.ok(lines.every((l) => l.trim().startsWith("ERROR")), "un-STALE md orphan must be ERROR");
      assert.equal(r.exitCode, 1, "unknown plan in .md must exit non-zero");
    });

    // W1 (iter 2): a single HTML comment holding TWO anchors must report BOTH.
    // The pre-fix single-pass htmlRe stopped at the first `-->` and reported only
    // the first — the exact "only the first was found" bug the block scan already
    // fixed. The two-stage scan (outer span finder + inner /g loop) mirrors it.
    it("md comment with two anchors reports BOTH (multi-anchor)", () => {
      const dir = getTempDir();
      run(dir, "new", "multi-anchor visible");
      const planDir = getPointer(dir);
      writeDecisionsWithEntry(dir, planDir);
      mkdirSync(join(dir, "docs"), { recursive: true });
      writeFileSync(
        join(dir, "docs", "multi.md"),
        `# Notes\n\n<!-- DECISION plan_2099-01-01_aaaaaaaa/D-001 first, DECISION plan_2099-01-01_bbbbbbbb/D-002 second -->\n`
      );
      const r = runValidate(dir);
      assert.ok(r.stdout.includes("plan_2099-01-01_aaaaaaaa"), `first anchor must be reported, got:\n${r.stdout}`);
      assert.ok(r.stdout.includes("plan_2099-01-01_bbbbbbbb"), `second anchor must be reported, got:\n${r.stdout}`);
      const findings = r.stdout.split("\n").filter((l) => /\[anchor-[a-z-]+\]:/.test(l));
      assert.equal(findings.length, 2, `exactly two anchor findings expected, got:\n${findings.join("\n")}`);
      assert.equal(r.exitCode, 1, "two unknown-plan anchors must exit non-zero");
    });

    // Negative fixture, scanned against the REAL doc files rather than a synthetic
    // string: these three define/illustrate the anchor grammar with `#`- and
    // `//`-style examples inside fences, and decision-anchoring.md's grammar table
    // row literally begins `<!--\s*DECISION`. None may ever be reported. This is a
    // live regression guard on future edits to those docs.
    it("real doc files with DECISION examples produce zero anchor findings", () => {
      const dir = getTempDir();
      run(dir, "new", "real doc negative fixture");
      const fixtures = [
        [resolve(import.meta.dirname, "..", "references", "decision-anchoring.md"), join("src", "references"), "decision-anchoring.md"],
        [resolve(import.meta.dirname, "..", "references", "file-formats.md"), join("src", "references"), "file-formats.md"],
        [resolve(import.meta.dirname, "modules", "state-execute.md"), join("src", "scripts", "modules"), "state-execute.md"],
      ];
      for (const [src, destDir, name] of fixtures) {
        assert.ok(existsSync(src), `fixture source must exist: ${src}`);
        mkdirSync(join(dir, destDir), { recursive: true });
        writeFileSync(join(dir, destDir, name), readFileSync(src, "utf-8"));
      }
      const r = runValidate(dir);
      const offending = r.stdout
        .split("\n")
        .filter((l) => l.includes("anchor-"))
        .filter((l) => fixtures.some(([, , name]) => l.includes(name)));
      assert.deepEqual(offending, [], `real doc files must not be reported as anchors, got:\n${offending.join("\n")}`);
      assert.equal(r.exitCode, 0, `validator must stay clean with real docs present, got:\n${r.stdout}`);
    });

    it("missing plan-id preamble: ERROR for post-cutover INIT", () => {
      const dir = getTempDir();
      run(dir, "new", "preamble strict");
      const planDir = getPointer(dir);
      setInitTimestamp(dir, planDir, "2099-01-01T00:00:00Z"); // post-cutover
      writeDecisionsWithEntry(dir, planDir, { withPreamble: false });
      const r = runValidate(dir);
      assert.ok(r.stdout.includes("ERROR [preamble-missing]"), "post-cutover INIT should yield ERROR for missing preamble");
      assert.equal(r.exitCode, 1);
    });

    it("missing plan-id preamble: WARN for pre-cutover INIT", () => {
      const dir = getTempDir();
      run(dir, "new", "preamble lenient");
      const planDir = getPointer(dir);
      setInitTimestamp(dir, planDir, "2025-01-01T00:00:00Z"); // pre-cutover
      writeDecisionsWithEntry(dir, planDir, { withPreamble: false });
      const r = runValidate(dir);
      assert.ok(r.stdout.includes("WARN  [preamble-missing]"), "pre-cutover INIT should yield WARN for missing preamble");
      assert.ok(!r.stdout.includes("ERROR [preamble-missing]"), "pre-cutover must NOT be ERROR");
    });

    it("preamble plan-id mismatch is always ERROR", () => {
      const dir = getTempDir();
      run(dir, "new", "preamble mismatch");
      const planDir = getPointer(dir);
      setInitTimestamp(dir, planDir, "2025-01-01T00:00:00Z"); // pre-cutover (still ERROR for mismatch)
      writeFileSync(
        join(dir, "plans", planDir, "decisions.md"),
        `# Decision Log\n*Plan: plan_2099-12-31_cafef00d*\n*Append-only.*\n\n## D-001 | EXPLORE → PLAN | 2025-01-01\n**Context**: x\n**Decision**: y\n**Trade-off**: a **at the cost of** b\n**Reasoning**: r\n`
      );
      const r = runValidate(dir);
      assert.ok(r.stdout.includes("preamble-mismatch"), "mismatched preamble plan-id must be flagged");
      assert.equal(r.exitCode, 1, "mismatch is always ERROR");
    });

    it("Anchor-Refs missing with matching anchor: ERROR for post-cutover", () => {
      const dir = getTempDir();
      run(dir, "new", "anchor-refs strict");
      const planDir = getPointer(dir);
      setInitTimestamp(dir, planDir, "2099-01-01T00:00:00Z"); // post-cutover
      writeDecisionsWithEntry(dir, planDir, { withAnchorRefs: false });
      writeFileSync(join(dir, "src.py"), `# DECISION ${planDir}/D-001: anchor exists, no Anchor-Refs\nx = 1\n`);
      const r = runValidate(dir);
      assert.ok(r.stdout.includes("ERROR [anchor-refs-missing]"), "post-cutover must ERROR on missing Anchor-Refs");
      assert.equal(r.exitCode, 1);
    });

    it("Anchor-Refs missing with matching anchor: WARN for pre-cutover", () => {
      const dir = getTempDir();
      run(dir, "new", "anchor-refs lenient");
      const planDir = getPointer(dir);
      setInitTimestamp(dir, planDir, "2025-01-01T00:00:00Z"); // pre-cutover
      writeDecisionsWithEntry(dir, planDir, { withAnchorRefs: false, withPreamble: false });
      writeFileSync(join(dir, "src.py"), `# DECISION ${planDir}/D-001: anchor present, no Anchor-Refs\nx = 1\n`);
      const r = runValidate(dir);
      assert.ok(r.stdout.includes("WARN  [anchor-refs]"), "pre-cutover should WARN on missing Anchor-Refs");
      assert.ok(!r.stdout.includes("ERROR [anchor-refs-missing]"), "pre-cutover must NOT be ERROR");
    });

    it("Anchor-Refs validity: WARN if referenced file missing", () => {
      const dir = getTempDir();
      run(dir, "new", "anchor-refs file missing");
      const planDir = getPointer(dir);
      writeFileSync(
        join(dir, "plans", planDir, "decisions.md"),
        `# Decision Log\n*Plan: ${planDir}*\n*Append-only.*\n\n## D-001 | EXPLORE → PLAN | 2026-05-07\n**Context**: x\n**Decision**: y\n**Trade-off**: a **at the cost of** b\n**Reasoning**: r\n**Anchor-Refs**: \`src/nonexistent.py:42\`\n`
      );
      const r = runValidate(dir);
      assert.ok(r.stdout.includes("anchor-refs-stale"), "missing file in Anchor-Refs should yield WARN [anchor-refs-stale]");
    });

    it("two-plan disambiguation: D-001 in plan A and plan B do not collide", () => {
      // Pre-Mortem Scenario B regression check.
      const dir = getTempDir();
      run(dir, "new", "plan A");
      const planA = getPointer(dir);
      writeDecisionsWithEntry(dir, planA);
      run(dir, "close");
      run(dir, "new", "plan B");
      const planB = getPointer(dir);
      writeDecisionsWithEntry(dir, planB);
      // Anchor in source references plan A's D-001 explicitly. Plan B is active.
      writeFileSync(join(dir, "src.py"), `# DECISION ${planA}/D-001: from plan A\nx = 1\n`);
      const r = runValidate(dir);
      assert.ok(!r.stdout.includes("anchor-orphan"), "qualified anchor for plan A must resolve via plan A's per-plan decisions.md");
      assert.ok(!r.stdout.includes("anchor-unknown-plan"), "plan A is a known plan dir");
    });
  });

  describe("INDEX.md topic extraction", () => {
    it("extracts topics only from Index section, not from corrections", () => {
      const dir = getTempDir();
      run(dir, "new", "topic scoping test");
      const planDir = getPointer(dir);
      // Write findings with [CORRECTED iter-2] outside Index section
      writeFileSync(
        join(dir, "plans", planDir, "findings.md"),
        "# Findings\n\n## Index\n- [Auth System](findings/auth.md) — auth\n- [DB Schema](findings/db.md) — db\n- [API Routes](findings/api.md) — api\n\n## Key Constraints\n- Something\n\n## Corrections\n- [CORRECTED iter-2] Redis not isolated\n"
      );
      run(dir, "close");
      const index = readFileSync(join(dir, "plans", "INDEX.md"), "utf-8");
      assert.ok(!index.includes("corrected iter-2"), "should not extract [CORRECTED] annotations as topics");
      assert.ok(index.includes("auth system"), "should extract topics from Index section");
    });

    // F4 — pipes in topic labels must be escaped, mirroring the goal-column escape.
    it("F4: pipe in topic label is escaped (`\\|`), table row keeps 5 cells", () => {
      const dir = getTempDir();
      run(dir, "new", "pipe-topic test");
      const planDir = getPointer(dir);
      writeFileSync(
        join(dir, "plans", planDir, "findings.md"),
        "# Findings\n\n## Index\n- [auth | session](findings/auth.md) — combined topic\n- [db schema](findings/db.md) — db\n- [api routes](findings/api.md) — api\n"
      );
      run(dir, "close");
      const index = readFileSync(join(dir, "plans", "INDEX.md"), "utf-8");
      // The row for our plan must contain the escaped form, not a raw |.
      const rowLine = index.split("\n").find((l) => l.includes(planDir));
      assert.ok(rowLine, "INDEX.md row for plan must exist");
      assert.ok(rowLine.includes("auth \\| session"), `expected escaped pipe in topic, row was: ${rowLine}`);
      // Row should contain exactly 5 pipes that delimit cells (or 6 boundary pipes).
      // Equivalently: subtract escaped \| occurrences, then count |.
      const escaped = (rowLine.match(/\\\|/g) || []).length;
      const allPipes = (rowLine.match(/\|/g) || []).length;
      const delimiterPipes = allPipes - escaped;
      assert.equal(delimiterPipes, 5, `expected 5 delimiter pipes (4 internal + leading/trailing as 4+1?), got ${delimiterPipes} in: ${rowLine}`);
    });
  });

  describe("v2.17.4 fixes", () => {
    it("cmdClose inserts transition entry under '## Transition History:' even with trailing sections", () => {
      const dir = getTempDir();
      run(dir, "new", "transition anchor test");
      const planDir = getPointer(dir);
      // Append a trailing section after Transition History
      const statePath = join(dir, "plans", planDir, "state.md");
      const original = readFileSync(statePath, "utf-8");
      writeFileSync(statePath, original + "\n## Agent Scratchpad\n- noise\n");
      run(dir, "close");
      const closed = readFileSync(statePath, "utf-8");
      const historyIdx = closed.indexOf("## Transition History:");
      const scratchIdx = closed.indexOf("## Agent Scratchpad");
      const closeLineIdx = closed.indexOf("EXPLORE → CLOSE (bootstrap close)");
      assert.ok(historyIdx >= 0, "Transition History section still present");
      assert.ok(closeLineIdx >= 0, "CLOSE transition line written");
      assert.ok(scratchIdx >= 0, "Agent Scratchpad section preserved");
      assert.ok(closeLineIdx > historyIdx && closeLineIdx < scratchIdx,
        `CLOSE line must land between '## Transition History:' (${historyIdx}) and the trailing section (${scratchIdx}), got ${closeLineIdx}`);
    });

    it("trimConsolidatedWindow counts a section beginning at byte 0 (no preceding newline)", () => {
      const dir = getTempDir();
      // Build a pathological consolidated file where the FIRST plan section
      // sits at byte 0 with no `# Consolidated Findings` H1 boilerplate.
      // Without the B11 fix, the leading `\n## plan_` regex misses byte-0
      // and the file is never trimmed below 5 sections. With the fix the
      // sliding window correctly trims to 4.
      mkdirSync(join(dir, "plans"), { recursive: true });
      // Consolidated files are newest-first by protocol invariant. Section
      // ordered top-down is plan_05 (newest) → plan_01 (oldest). First
      // section sits at byte 0 (no H1 header) to exercise the B11 fix.
      const synthetic = [
        "## plan_2026-01-05_eeeeeeee\n### Index\n- E\n",
        "## plan_2026-01-04_dddddddd\n### Index\n- D\n",
        "## plan_2026-01-03_cccccccc\n### Index\n- C\n",
        "## plan_2026-01-02_bbbbbbbb\n### Index\n- B\n",
        "## plan_2026-01-01_aaaaaaaa\n### Index\n- A\n",
      ].join("\n");
      writeFileSync(join(dir, "plans", "FINDINGS.md"), synthetic);
      // Create a new plan, close it — close path calls trimConsolidatedWindow
      // unconditionally. Use a plan with no findings.md content so the merge
      // step is a no-op and we can observe trim isolation.
      run(dir, "new", "trim-only test");
      const planDir = getPointer(dir);
      // Empty findings.md so prependToConsolidated is a no-op
      writeFileSync(join(dir, "plans", planDir, "findings.md"), "# Findings\n");
      run(dir, "close");
      const merged = readFileSync(join(dir, "plans", "FINDINGS.md"), "utf-8");
      const sectionMatches = merged.match(/(^|\n)## plan_/g) || [];
      assert.equal(sectionMatches.length, 4,
        `expected exactly 4 plan sections after trim, got ${sectionMatches.length}; content=${JSON.stringify(merged.slice(0, 200))}`);
      // Oldest section (plan_01) at the BOTTOM of the file is trimmed;
      // the newest section (plan_05) at byte 0 is retained.
      assert.ok(!merged.includes("plan_2026-01-01_aaaaaaaa"),
        "oldest section (bottom of file) must be trimmed by sliding window");
      assert.ok(merged.includes("plan_2026-01-05_eeeeeeee"),
        "newest section (at byte 0) must be retained");
    });

    it("appendToIndex skips leading blank lines in Goal", () => {
      const dir = getTempDir();
      run(dir, "new", "ignored placeholder");
      const planDir = getPointer(dir);
      // Rewrite plan.md so the Goal section starts with a blank line.
      const planPath = join(dir, "plans", planDir, "plan.md");
      writeFileSync(
        planPath,
        "# Plan v0\n\n## Goal\n\nActual goal after blank line\n\n## Problem Statement\n*todo*\n"
      );
      run(dir, "close");
      const index = readFileSync(join(dir, "plans", "INDEX.md"), "utf-8");
      assert.ok(index.includes("Actual goal after blank line"),
        "Goal column must skip leading blank lines, not emit empty cell");
    });

    it("appendToIndex filters non-link brackets in Index section", () => {
      const dir = getTempDir();
      run(dir, "new", "topic link filter");
      const planDir = getPointer(dir);
      // Index with mixed link-form topics AND bare-bracket annotations.
      writeFileSync(
        join(dir, "plans", planDir, "findings.md"),
        "# Findings\n\n## Index\n- [Auth](findings/auth.md) — real topic\n- [CORRECTED iter-1] not a topic\n- [TODO] also not a topic\n- [DB](findings/db.md) — real topic\n"
      );
      run(dir, "close");
      const index = readFileSync(join(dir, "plans", "INDEX.md"), "utf-8");
      assert.ok(index.includes("auth"), "real topic 'auth' retained");
      assert.ok(index.includes("db"), "real topic 'db' retained");
      assert.ok(!/corrected iter-1/i.test(index), "[CORRECTED iter-1] must not appear as topic");
      assert.ok(!/\btodo\b/i.test(index), "[TODO] must not appear as topic");
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

  // =========================================================================
  // maybeCompressDecisions (v2.18.0+ intra-plan compression)
  // =========================================================================
  describe("maybeCompressDecisions", () => {
    // Build a synthetic decisions.md body with the given entries.
    // Each entry is { id, phase, date, body }. Body is multi-line (already
    // includes **Decision**: etc).
    function buildDecisionsMd(entries, padLines = 0) {
      const head = [
        "# Decision Log",
        "*Plan: plan_2099-01-01_deadbeef*",
        "*Append-only. Never edit past entries.*",
        "",
        "*Cross-plan context: see plans/FINDINGS.md, plans/DECISIONS.md, and plans/LESSONS.md*",
        "",
        "<!-- Schema example — DO NOT REMOVE. Real entries follow this shape.",
        "## D-001 | EXPLORE → PLAN | YYYY-MM-DD",
        "**Decision**: <chosen approach in one sentence>",
        "-->",
        ""
      ];
      const body = [];
      for (const e of entries) {
        body.push(`## ${e.id} | ${e.phase} | ${e.date}`);
        body.push(e.body);
        body.push("");
      }
      const pad = [];
      for (let i = 0; i < padLines; i++) pad.push(`<!-- pad line ${i} -->`);
      return [...head, ...body, ...pad].join("\n");
    }

    function makeEntry(idNum, opts = {}) {
      const id = `D-${String(idNum).padStart(3, "0")}`;
      const phase = opts.phase || "EXPLORE → PLAN";
      const date = opts.date || "2026-05-15";
      const decision = opts.decision || `Decision text for ${id}.`;
      const anchorRefs = opts.anchorRefs || "(none yet)";
      const body = [
        `**Context**: Some context for ${id}.`,
        `**Decision**: ${decision}`,
        `**Trade-off**: X **at the cost of** Y.`,
        `**Reasoning**: Because reasons.`,
        `**Anchor-Refs**: ${anchorRefs}`
      ].join("\n");
      return { id, phase, date, body };
    }

    // Dynamic import of bootstrap.mjs to access exported helper.
    async function loadHelper() {
      const mod = await import(`file://${BOOTSTRAP}`);
      return mod.maybeCompressDecisions;
    }

    function writeDecisionsFile(planDir, content) {
      mkdirSync(planDir, { recursive: true });
      writeFileSync(join(planDir, "decisions.md"), content);
    }

    it("Test 1: file >300 lines with 5 entries gets compressed", async () => {
      const maybeCompressDecisions = await loadHelper();
      const dir = getTempDir();
      const planDir = join(dir, "plans", "plan_2099-01-01_deadbeef");
      // 5 entries, padded so total > 300 lines
      const entries = [1, 2, 3, 4, 5].map((n) => makeEntry(n));
      const content = buildDecisionsMd(entries, /* pad */ 320);
      writeDecisionsFile(planDir, content);

      const before = readFileSync(join(planDir, "decisions.md"), "utf-8");
      assert.ok(before.split("\n").length > 300, "fixture must exceed 300 lines");

      const result = maybeCompressDecisions(planDir);
      assert.equal(result.compressed, true, `expected compressed=true, got ${JSON.stringify(result)}`);
      assert.equal(result.reason, "compressed");

      const after = readFileSync(join(planDir, "decisions.md"), "utf-8");
      // Exactly one COMPRESSED-SUMMARY block
      const openCount = (after.match(/<!-- COMPRESSED-SUMMARY -->/g) || []).length;
      assert.equal(openCount, 1, "should have exactly one open marker");
      assert.ok(after.includes("<!-- /COMPRESSED-SUMMARY -->"), "should have close marker");
      // All 5 D-NNN headers present verbatim
      for (let n = 1; n <= 5; n++) {
        const id = `D-${String(n).padStart(3, "0")}`;
        assert.ok(new RegExp(`^## ${id} \\|`, "m").test(after), `${id} header preserved`);
      }
      // Preamble survived
      assert.ok(after.includes("*Plan: plan_2099-01-01_deadbeef*"), "preamble preserved");
      // Schema HTML comment survived
      assert.ok(after.includes("<!-- Schema example"), "schema comment preserved");
      // Block sits BEFORE first REAL ## D-NNN entry (skipping the schema
      // comment which contains `## D-001 | EXPLORE → PLAN | YYYY-MM-DD`).
      const blockIdx = after.indexOf("<!-- COMPRESSED-SUMMARY -->");
      const schemaCloseIdx = after.indexOf("-->", after.indexOf("<!-- Schema example"));
      const firstEntryIdx = after.indexOf("## D-001 | EXPLORE → PLAN | 2026-05-15", schemaCloseIdx);
      assert.ok(firstEntryIdx > 0, "real D-001 entry must exist after schema comment");
      assert.ok(blockIdx < firstEntryIdx, `block (${blockIdx}) must precede first real entry (${firstEntryIdx})`);
    });

    it("M8: preamble beyond first 10 non-blank lines is NOT detected (matches validator window)", async () => {
      const maybeCompressDecisions = await loadHelper();
      const dir = getTempDir();
      const planDir = join(dir, "plans", "plan_2099-01-01_deadbeef");
      // 11 non-blank lines with NO preamble, THEN the *Plan: line (12th
      // non-blank) — past the validator's first-10-non-blank window. Old
      // bootstrap scanned the whole file and would have compressed this;
      // aligned bootstrap reports no-preamble, agreeing with the validator.
      const head = [
        "# Decision Log",
        "*filler a*", "*filler b*", "*filler c*", "*filler d*", "*filler e*",
        "*filler f*", "*filler g*", "*filler h*", "*filler i*", "*filler j*",
        "*Plan: plan_2099-01-01_deadbeef*",
        "",
      ];
      const body = [];
      for (const e of [1, 2, 3, 4, 5].map((n) => makeEntry(n))) {
        body.push(`## ${e.id} | ${e.phase} | ${e.date}`);
        body.push(e.body);
        body.push("");
      }
      const pad = [];
      for (let i = 0; i < 320; i++) pad.push(`<!-- pad ${i} -->`);
      const content = [...head, ...body, ...pad].join("\n");
      writeDecisionsFile(planDir, content);
      assert.ok(content.split("\n").length > 300, "fixture must exceed 300 lines");

      const result = maybeCompressDecisions(planDir);
      assert.equal(result.compressed, false, `out-of-window preamble must not compress, got ${JSON.stringify(result)}`);
      assert.equal(result.reason, "no-preamble", "must report no-preamble (window aligned with validator)");
      assert.equal(readFileSync(join(planDir, "decisions.md"), "utf-8"), content, "file must be untouched");
    });

    it("Test 2: file under threshold returns under-threshold", async () => {
      const maybeCompressDecisions = await loadHelper();
      const dir = getTempDir();
      const planDir = join(dir, "plans", "plan_2099-01-01_deadbeef");
      const entries = [1, 2, 3].map((n) => makeEntry(n));
      const content = buildDecisionsMd(entries, /* pad */ 5);
      writeDecisionsFile(planDir, content);
      assert.ok(content.split("\n").length <= 300, "fixture must be under 300 lines");

      const result = maybeCompressDecisions(planDir);
      assert.equal(result.compressed, false);
      assert.equal(result.reason, "under-threshold");
      // File untouched
      const after = readFileSync(join(planDir, "decisions.md"), "utf-8");
      assert.equal(after, content, "file must be untouched");
    });

    it("Test 3: already-compressed file with no new entries is idempotent", async () => {
      const maybeCompressDecisions = await loadHelper();
      const dir = getTempDir();
      const planDir = join(dir, "plans", "plan_2099-01-01_deadbeef");
      const entries = [1, 2, 3, 4, 5].map((n) => makeEntry(n));
      const content = buildDecisionsMd(entries, 320);
      writeDecisionsFile(planDir, content);
      // First compression
      const r1 = maybeCompressDecisions(planDir);
      assert.equal(r1.compressed, true, "first run should compress");
      const afterFirst = readFileSync(join(planDir, "decisions.md"), "utf-8");

      // Second compression — no entries added
      const r2 = maybeCompressDecisions(planDir);
      assert.equal(r2.compressed, false);
      assert.equal(r2.reason, "no-new-entries");
      const afterSecond = readFileSync(join(planDir, "decisions.md"), "utf-8");
      assert.equal(afterSecond, afterFirst, "file must be untouched by second run");
    });

    it("Test 4: existing block + new entries → block REPLACED", async () => {
      const maybeCompressDecisions = await loadHelper();
      const dir = getTempDir();
      const planDir = join(dir, "plans", "plan_2099-01-01_deadbeef");
      const entries = [1, 2, 3, 4, 5].map((n) => makeEntry(n));
      const content = buildDecisionsMd(entries, 320);
      writeDecisionsFile(planDir, content);
      maybeCompressDecisions(planDir); // first pass

      // Append 2 new entries to the file
      const newEntries = [makeEntry(6), makeEntry(7)];
      let updated = readFileSync(join(planDir, "decisions.md"), "utf-8");
      for (const e of newEntries) {
        updated += `\n## ${e.id} | ${e.phase} | ${e.date}\n${e.body}\n`;
      }
      writeFileSync(join(planDir, "decisions.md"), updated);

      const r = maybeCompressDecisions(planDir);
      assert.equal(r.compressed, true, "should re-compress on new entries");
      const after = readFileSync(join(planDir, "decisions.md"), "utf-8");
      // Exactly ONE block remains
      const openCount = (after.match(/<!-- COMPRESSED-SUMMARY -->/g) || []).length;
      assert.equal(openCount, 1, "should have exactly one block (replaced)");
      // New entries-at-compress count = 7
      assert.ok(after.includes("<!-- entries-at-compress: 7 -->"), "block reflects 7 entries");
      // Lookup includes D-006 and D-007
      assert.ok(after.includes("**D-006**"), "D-006 in lookup");
      assert.ok(after.includes("**D-007**"), "D-007 in lookup");
      // Raw entries D-001..D-007 all present
      for (let n = 1; n <= 7; n++) {
        const id = `D-${String(n).padStart(3, "0")}`;
        assert.ok(new RegExp(`^## ${id} \\|`, "m").test(after), `${id} header preserved`);
      }
    });

    it("Test 5: PIVOT entry appears under 'Things NOT to do'", async () => {
      const maybeCompressDecisions = await loadHelper();
      const dir = getTempDir();
      const planDir = join(dir, "plans", "plan_2099-01-01_deadbeef");
      const entries = [
        makeEntry(1),
        makeEntry(2, { phase: "REFLECT → PIVOT", decision: "Pivot away from approach X to approach Y." }),
        makeEntry(3),
        makeEntry(4),
        makeEntry(5)
      ];
      const content = buildDecisionsMd(entries, 320);
      writeDecisionsFile(planDir, content);
      const r = maybeCompressDecisions(planDir);
      assert.equal(r.compressed, true);
      const after = readFileSync(join(planDir, "decisions.md"), "utf-8");
      assert.ok(after.includes("### Things NOT to do"), "section header present");
      // Pivot entry referenced
      const pivotSectionIdx = after.indexOf("### Things NOT to do");
      const anchoredSectionIdx = after.indexOf("### Anchored decisions");
      const pivotSection = after.slice(pivotSectionIdx, anchoredSectionIdx);
      assert.ok(pivotSection.includes("D-002"), "PIVOT entry D-002 listed");
      assert.ok(pivotSection.includes("Pivot away from approach X"), "Decision text included");
    });

    it("Test 6: anchored entry appears under 'Anchored decisions'", async () => {
      const maybeCompressDecisions = await loadHelper();
      const dir = getTempDir();
      const planDir = join(dir, "plans", "plan_2099-01-01_deadbeef");
      const entries = [
        makeEntry(1),
        makeEntry(2, { anchorRefs: "`src/foo.mjs:42`, `src/bar.mjs:100-110`" }),
        makeEntry(3),
        makeEntry(4),
        makeEntry(5)
      ];
      const content = buildDecisionsMd(entries, 320);
      writeDecisionsFile(planDir, content);
      const r = maybeCompressDecisions(planDir);
      assert.equal(r.compressed, true);
      const after = readFileSync(join(planDir, "decisions.md"), "utf-8");
      const anchoredIdx = after.indexOf("### Anchored decisions");
      const closeIdx = after.indexOf("<!-- /COMPRESSED-SUMMARY -->");
      const anchoredSection = after.slice(anchoredIdx, closeIdx);
      assert.ok(anchoredSection.includes("D-002"), "D-002 listed under anchored");
      assert.ok(anchoredSection.includes("src/foo.mjs:42"), "anchor ref preserved verbatim");
    });

    it("dryRun returns metrics without writing", async () => {
      const maybeCompressDecisions = await loadHelper();
      const dir = getTempDir();
      const planDir = join(dir, "plans", "plan_2099-01-01_deadbeef");
      const entries = [1, 2, 3, 4, 5].map((n) => makeEntry(n));
      const content = buildDecisionsMd(entries, 320);
      writeDecisionsFile(planDir, content);
      const r = maybeCompressDecisions(planDir, { dryRun: true });
      assert.equal(r.compressed, true);
      const after = readFileSync(join(planDir, "decisions.md"), "utf-8");
      assert.equal(after, content, "dryRun must not write");
    });

    it("missing file returns reason=missing", async () => {
      const maybeCompressDecisions = await loadHelper();
      const dir = getTempDir();
      const planDir = join(dir, "plans", "plan_does_not_exist");
      const r = maybeCompressDecisions(planDir);
      assert.equal(r.compressed, false);
      assert.equal(r.reason, "missing");
    });

    it("file with <2 entries returns too-few-entries even if over threshold", async () => {
      const maybeCompressDecisions = await loadHelper();
      const dir = getTempDir();
      const planDir = join(dir, "plans", "plan_2099-01-01_deadbeef");
      const content = buildDecisionsMd([makeEntry(1)], 400);
      writeDecisionsFile(planDir, content);
      const r = maybeCompressDecisions(planDir);
      assert.equal(r.compressed, false);
      assert.equal(r.reason, "too-few-entries");
    });

    // F2 — fingerprint-based idempotency catches add+delete drift that count alone missed.
    it("F2: add+delete with same entry count → fingerprint mismatch → re-compress + summary reflects new IDs", async () => {
      const maybeCompressDecisions = await loadHelper();
      const dir = getTempDir();
      const planDir = join(dir, "plans", "plan_2099-01-01_deadbeef");
      // 6 entries, padded over threshold
      const entries = [1, 2, 3, 4, 5, 6].map((n) => makeEntry(n));
      writeDecisionsFile(planDir, buildDecisionsMd(entries, 320));
      const r1 = maybeCompressDecisions(planDir);
      assert.equal(r1.compressed, true, "first compress should succeed");

      let body = readFileSync(join(planDir, "decisions.md"), "utf-8");
      assert.ok(/<!-- entries-fingerprint: [0-9a-f]{12} -->/.test(body), "fingerprint marker emitted");

      // Capture pass-1 fingerprint
      const fp1 = body.match(/<!-- entries-fingerprint: ([0-9a-f]{12}) -->/)[1];

      // Mutate raw: remove D-001 entry block (header+body+blank line), append D-007.
      body = body.replace(/## D-001 \| EXPLORE → PLAN \| 2026-05-15\n[\s\S]*?\n(?=## D-|\n<!-- |$)/, "");
      const d7 = makeEntry(7, { decision: "SECRET NEW DECISION not in pass-1 summary" });
      body += `\n## ${d7.id} | ${d7.phase} | ${d7.date}\n${d7.body}\n`;
      writeFileSync(join(planDir, "decisions.md"), body);

      const r2 = maybeCompressDecisions(planDir);
      assert.equal(r2.compressed, true, `F2: same count (6) but different IDs must trigger re-compress, got ${JSON.stringify(r2)}`);

      const after = readFileSync(join(planDir, "decisions.md"), "utf-8");
      const fp2 = after.match(/<!-- entries-fingerprint: ([0-9a-f]{12}) -->/)[1];
      assert.notEqual(fp2, fp1, "fingerprint must change when IDs change");

      // Summary block must reflect new entry set: D-007 in, D-001 out.
      const blockStart = after.indexOf("<!-- COMPRESSED-SUMMARY -->");
      const blockEnd = after.indexOf("<!-- /COMPRESSED-SUMMARY -->");
      const block = after.slice(blockStart, blockEnd);
      assert.ok(block.includes("**D-007**"), "summary must list new D-007");
      assert.ok(!block.includes("**D-001**"), "summary must not reference deleted D-001");
    });

    // F2 — back-compat: legacy block with entries-at-compress but no fingerprint still no-ops on unchanged count.
    it("F2 back-compat: legacy block (count-only, no fingerprint) is treated as no-new-entries on unchanged count", async () => {
      const maybeCompressDecisions = await loadHelper();
      const dir = getTempDir();
      const planDir = join(dir, "plans", "plan_2099-01-01_deadbeef");
      const entries = [1, 2, 3, 4, 5].map((n) => makeEntry(n));
      writeDecisionsFile(planDir, buildDecisionsMd(entries, 320));
      maybeCompressDecisions(planDir); // creates fingerprint-bearing block
      // Strip fingerprint line to simulate a legacy compressed file.
      let body = readFileSync(join(planDir, "decisions.md"), "utf-8");
      body = body.replace(/<!-- entries-fingerprint: [0-9a-f]{12} -->\n/, "");
      writeFileSync(join(planDir, "decisions.md"), body);

      const r = maybeCompressDecisions(planDir);
      assert.equal(r.compressed, false, "legacy block + unchanged count → no-op");
      assert.equal(r.reason, "no-new-entries");
    });
  });

  // =========================================================================
  // maybeCompressChangelog (v2.18.0+ intra-plan compression — changelog.md)
  // =========================================================================
  describe("maybeCompressChangelog", () => {
    const CHANGELOG_HEADER = [
      "# Changelog",
      "*Append-only per-edit ledger. One line per file edit. Owner: ip-executor (writes). Reader: ip-reviewer at REFLECT.*",
      "*Format: `UTC | iter-N/step-M | commit | path | OP(+N,-M) | radius:TIER(score) | D-NNN-or-dash | reason`*",
      "*See references/blast-radius.md for radius scoring. Decision-ref optional — `-` means no `# DECISION` anchor governs this edit.*"
    ];

    /** Write a changelog.md with the standard 4-line header + the given body lines. */
    function writeChangelog(planDir, bodyLines) {
      mkdirSync(planDir, { recursive: true });
      const content = [...CHANGELOG_HEADER, ...bodyLines].join("\n") + "\n";
      writeFileSync(join(planDir, "changelog.md"), content);
    }

    function readChangelog(planDir) {
      return readFileSync(join(planDir, "changelog.md"), "utf-8");
    }

    /**
     * Build an elidable entry line (LOW radius, `-` decision-ref, non-REVERT).
     * Defaults are tuned to be elidable; override tier/op/decisionRef per case.
     */
    function entryLine({
      ts = "2026-05-15T12:00:00Z",
      iterStep = "iter-1/step-3",
      commit = "abc1234",
      path = "src/foo.mjs",
      op = "EDIT(+5,-2)",
      tier = "LOW",
      score = 0,
      decisionRef = "-",
      reason = "tweak"
    } = {}) {
      return `${ts} | ${iterStep} | ${commit} | ${path} | ${op} | radius:${tier}(${score}) | ${decisionRef} | ${reason}`;
    }

    async function loadHelper() {
      const mod = await import(`file://${BOOTSTRAP}`);
      return mod.maybeCompressChangelog;
    }

    function padFiller(n) {
      // Generates n harmless filler lines that are not classified as entries
      // (no pipe separators) so we can exceed the line threshold without
      // affecting elide-group detection.
      const out = [];
      for (let i = 0; i < n; i++) out.push(`<!-- pad ${i} -->`);
      return out;
    }

    it("Test 1: under threshold (50 lines) returns under-threshold", async () => {
      const maybeCompressChangelog = await loadHelper();
      const dir = getTempDir();
      const planDir = join(dir, "plans", "plan_x");
      const body = [];
      for (let i = 0; i < 40; i++) body.push(entryLine({ iterStep: `iter-1/step-${i}` }));
      writeChangelog(planDir, body);
      const before = readChangelog(planDir);
      const r = maybeCompressChangelog(planDir);
      assert.equal(r.compressed, false);
      assert.equal(r.reason, "under-threshold");
      assert.equal(readChangelog(planDir), before, "file untouched");
    });

    it("Test 2: over threshold with 0 elidable lines returns no-elidable-groups", async () => {
      const maybeCompressChangelog = await loadHelper();
      const dir = getTempDir();
      const planDir = join(dir, "plans", "plan_x");
      // 250 entry lines, all HIGH or D-NNN-anchored (preserve-verbatim).
      const body = [];
      for (let i = 0; i < 125; i++) body.push(entryLine({ iterStep: `iter-1/step-${i}`, tier: "HIGH", score: 7 }));
      for (let i = 0; i < 125; i++) body.push(entryLine({ iterStep: `iter-2/step-${i}`, decisionRef: "D-001" }));
      writeChangelog(planDir, body);
      const before = readChangelog(planDir);
      const r = maybeCompressChangelog(planDir);
      assert.equal(r.compressed, false);
      assert.equal(r.reason, "no-elidable-groups");
      assert.equal(readChangelog(planDir), before, "file untouched");
    });

    it("Test 3: over threshold with one 12-line elidable group → compressed=true, elidedCount=1", async () => {
      const maybeCompressChangelog = await loadHelper();
      const dir = getTempDir();
      const planDir = join(dir, "plans", "plan_x");
      const body = [];
      // Pad to push line count over threshold without creating elidable runs
      body.push(...padFiller(220));
      // 12 elidable lines as a single contiguous group
      for (let i = 0; i < 12; i++) body.push(entryLine({ iterStep: `iter-1/step-${i + 3}` }));
      writeChangelog(planDir, body);

      const r = maybeCompressChangelog(planDir);
      assert.equal(r.compressed, true, `got ${JSON.stringify(r)}`);
      assert.equal(r.elidedCount, 1);
      const after = readChangelog(planDir);
      // Exactly one inline summary line referencing 12 edits.
      const summaryMatches = (after.match(/^- \(compressed: 12 low-decision-impact edits/gm) || []);
      assert.equal(summaryMatches.length, 1, "exactly one inline summary line");
      // None of the original 12 elided lines remain.
      assert.ok(!after.includes("iter-1/step-3 | abc1234 | src/foo.mjs | EDIT"), "original elided lines gone");
      // Header preserved verbatim.
      assert.ok(after.startsWith(CHANGELOG_HEADER[0] + "\n"), "header line 1 preserved");
      assert.ok(after.includes(CHANGELOG_HEADER[3]), "header line 4 preserved");
      // Top-of-file metadata block present.
      assert.ok(after.includes("<!-- COMPRESSED-SUMMARY -->"), "open marker");
      assert.ok(after.includes("<!-- /COMPRESSED-SUMMARY -->"), "close marker");
      assert.ok(after.includes("<!-- entries-at-compress: 12 -->"), "entry count metadata");
      assert.ok(after.includes("<!-- elided-groups: 1, elided-lines: 12 -->"), "group/line totals");
    });

    it("Test 4: two non-adjacent elidable groups separated by HIGH line → both elided", async () => {
      const maybeCompressChangelog = await loadHelper();
      const dir = getTempDir();
      const planDir = join(dir, "plans", "plan_x");
      const body = [];
      body.push(...padFiller(210));
      // Group A: 6 elidable lines
      for (let i = 0; i < 6; i++) body.push(entryLine({ iterStep: `iter-1/step-A${i}`, path: `src/a${i}.mjs` }));
      // Sentinel HIGH line in between
      body.push(entryLine({ iterStep: "iter-1/step-mid", path: "src/mid.mjs", tier: "HIGH", score: 8, reason: "load-bearing" }));
      // Group B: 7 elidable lines
      for (let i = 0; i < 7; i++) body.push(entryLine({ iterStep: `iter-1/step-B${i}`, path: `src/b${i}.mjs` }));
      writeChangelog(planDir, body);

      const r = maybeCompressChangelog(planDir);
      assert.equal(r.compressed, true);
      assert.equal(r.elidedCount, 2, "both groups elided independently");
      const after = readChangelog(planDir);
      // HIGH line preserved verbatim in original position
      assert.ok(after.includes("src/mid.mjs"), "HIGH sentinel survives");
      assert.ok(after.includes("radius:HIGH(8)"), "tier preserved");
      // Two inline summary lines
      const summaries = after.match(/^- \(compressed:/gm) || [];
      assert.equal(summaries.length, 2, "two inline summaries");
      // Order: group A summary appears BEFORE HIGH line; group B summary appears AFTER.
      const aSummaryIdx = after.indexOf("- (compressed: 6 low-decision-impact edits");
      const highIdx = after.indexOf("src/mid.mjs");
      const bSummaryIdx = after.indexOf("- (compressed: 7 low-decision-impact edits");
      assert.ok(aSummaryIdx > 0 && highIdx > aSummaryIdx && bSummaryIdx > highIdx,
        `chronological order: A-summary(${aSummaryIdx}) < HIGH(${highIdx}) < B-summary(${bSummaryIdx})`);
    });

    it("Test 5: idempotency — second call returns no-new-entries", async () => {
      const maybeCompressChangelog = await loadHelper();
      const dir = getTempDir();
      const planDir = join(dir, "plans", "plan_x");
      const body = [];
      body.push(...padFiller(210));
      for (let i = 0; i < 10; i++) body.push(entryLine({ iterStep: `iter-1/step-${i}` }));
      writeChangelog(planDir, body);
      const r1 = maybeCompressChangelog(planDir);
      assert.equal(r1.compressed, true);
      const afterFirst = readChangelog(planDir);
      const r2 = maybeCompressChangelog(planDir);
      assert.equal(r2.compressed, false);
      assert.equal(r2.reason, "no-new-entries");
      assert.equal(readChangelog(planDir), afterFirst, "file untouched by second pass");
    });

    it("Test 6: re-compression with 20 new LOW lines appended → metadata block replaced, new group elided, prior inline summary preserved", async () => {
      const maybeCompressChangelog = await loadHelper();
      const dir = getTempDir();
      const planDir = join(dir, "plans", "plan_x");
      const body = [];
      body.push(...padFiller(210));
      for (let i = 0; i < 8; i++) body.push(entryLine({ iterStep: `iter-1/step-${i}` }));
      writeChangelog(planDir, body);
      maybeCompressChangelog(planDir);
      // Confirm initial inline summary exists
      let after1 = readChangelog(planDir);
      assert.ok(after1.includes("- (compressed: 8 low-decision-impact edits"), "first-pass summary present");

      // Append 20 new LOW elidable lines
      const newLines = [];
      for (let i = 0; i < 20; i++) newLines.push(entryLine({ iterStep: `iter-2/step-${i}`, path: `src/new${i}.mjs` }));
      const appended = after1 + newLines.join("\n") + "\n";
      writeFileSync(join(planDir, "changelog.md"), appended);

      const r = maybeCompressChangelog(planDir);
      assert.equal(r.compressed, true, `got ${JSON.stringify(r)}`);
      const after2 = readChangelog(planDir);

      // Exactly one metadata block (open marker count = 1)
      const openMarkers = (after2.match(/<!-- COMPRESSED-SUMMARY -->/g) || []);
      assert.equal(openMarkers.length, 1, "metadata block replaced, not duplicated");
      // Prior inline summary preserved (already-elided record survives)
      assert.ok(after2.includes("- (compressed: 8 low-decision-impact edits"),
        "first-pass inline summary preserved verbatim");
      // New 20-line group elided
      assert.ok(after2.includes("- (compressed: 20 low-decision-impact edits"),
        "new group elided this pass");
      // entries-at-compress counts BOTH live entries AND entry-equivalents
      // from surviving inline summaries (8 from first pass + 20 new = 28).
      // This is what makes idempotency work across re-compression passes.
      assert.ok(after2.includes("<!-- entries-at-compress: 28 -->"),
        "entry count is 28 (8 prior-summary equiv + 20 new)");
      // None of the 20 new raw lines survive
      assert.ok(!after2.includes("src/new0.mjs"), "first new entry elided");
      assert.ok(!after2.includes("src/new19.mjs"), "last new entry elided");
    });

    it("Test 7: preserve-verbatim rules — HIGH, REVERT, D-NNN ref all survive", async () => {
      const maybeCompressChangelog = await loadHelper();
      const dir = getTempDir();
      const planDir = join(dir, "plans", "plan_x");
      const body = [];
      body.push(...padFiller(200));
      // 3 elidable, then sentinel HIGH, then 3 elidable, then REVERT, then 3 elidable, then D-NNN-anchored, then 6 elidable (only this run >=5)
      for (let i = 0; i < 3; i++) body.push(entryLine({ iterStep: `iter-1/step-pre${i}` }));
      body.push(entryLine({ iterStep: "iter-1/step-H", path: "src/high.mjs", tier: "HIGH", score: 9, reason: "core-rewrite" }));
      for (let i = 0; i < 3; i++) body.push(entryLine({ iterStep: `iter-1/step-mid${i}` }));
      body.push(entryLine({ iterStep: "iter-1/step-R", path: "src/foo.mjs", op: "REVERT(src/foo.mjs)", reason: "revert botched edit" }));
      for (let i = 0; i < 3; i++) body.push(entryLine({ iterStep: `iter-1/step-mid2-${i}` }));
      body.push(entryLine({ iterStep: "iter-1/step-A", path: "src/anchored.mjs", decisionRef: "D-007", reason: "anchored impl" }));
      // 6-line elidable run (only run >=5, so it WILL be elided)
      for (let i = 0; i < 6; i++) body.push(entryLine({ iterStep: `iter-1/step-tail${i}` }));
      writeChangelog(planDir, body);

      const r = maybeCompressChangelog(planDir);
      assert.equal(r.compressed, true, `got ${JSON.stringify(r)}`);
      const after = readChangelog(planDir);
      // Preserve-verbatim survivors
      assert.ok(after.includes("src/high.mjs"), "HIGH line survives");
      assert.ok(after.includes("radius:HIGH(9)"), "HIGH tier preserved");
      assert.ok(after.includes("REVERT(src/foo.mjs)"), "REVERT op survives");
      assert.ok(after.includes("revert botched edit"), "REVERT line reason intact");
      assert.ok(after.includes("D-007"), "anchored line survives");
      assert.ok(after.includes("src/anchored.mjs"), "anchored line path intact");
      // The two 3-line groups did NOT meet the min-group threshold, so they
      // are preserved verbatim too.
      assert.ok(after.includes("iter-1/step-pre0"), "3-line group below threshold preserved");
      assert.ok(after.includes("iter-1/step-mid2-2"), "3-line group below threshold preserved");
      // Tail 6-line group IS elided (one inline summary).
      const summaries = after.match(/^- \(compressed: 6 low-decision-impact edits/gm) || [];
      assert.equal(summaries.length, 1, "exactly the 6-line tail group elided");
      // The raw entry line for tail0 is gone (the substring may still appear
      // inside the inline summary's iter-range citation; we check for the
      // entry's path+op signature instead).
      assert.ok(!/iter-1\/step-tail0 \| abc1234 \| src\/foo\.mjs \| EDIT/.test(after),
        "raw tail entry line gone");
    });

    it("Test 8: dryRun returns metrics without writing", async () => {
      const maybeCompressChangelog = await loadHelper();
      const dir = getTempDir();
      const planDir = join(dir, "plans", "plan_x");
      const body = [];
      body.push(...padFiller(210));
      for (let i = 0; i < 10; i++) body.push(entryLine({ iterStep: `iter-1/step-${i}` }));
      writeChangelog(planDir, body);
      const before = readChangelog(planDir);
      const r = maybeCompressChangelog(planDir, { dryRun: true });
      assert.equal(r.compressed, true);
      assert.equal(r.elidedCount, 1);
      assert.ok(r.afterLines < r.beforeLines, "metrics reflect compression");
      assert.equal(readChangelog(planDir), before, "dryRun did not write");
    });

    // F3 — pipe in reason field must not corrupt classification.
    it("F3: reason containing ` | ` is absorbed into reason field, classifies as entry", async () => {
      const mod = await import(`file://${BOOTSTRAP}`);
      const { splitChangelogFields } = mod;
      const line = "2026-05-15T10:00:00Z | iter-1/step-1 | abc1234 | src/foo.mjs | EDIT(+5,-2) | radius:LOW(1) | - | fix race: a | b condition";
      const fields = splitChangelogFields(line);
      assert.equal(fields.length, 8, `expected 8 fields, got ${fields.length}: ${JSON.stringify(fields)}`);
      assert.equal(fields[0], "2026-05-15T10:00:00Z");
      assert.equal(fields[3], "src/foo.mjs");
      assert.equal(fields[6], "-");
      assert.equal(fields[7], "fix race: a | b condition", "trailing ` | ` absorbed into reason");
    });

    it("F3: multi-pipe reason `a | b | c` fully preserved in field 8", async () => {
      const mod = await import(`file://${BOOTSTRAP}`);
      const { splitChangelogFields } = mod;
      const line = "2026-05-15T10:00:00Z | iter-1/step-1 | abc1234 | src/foo.mjs | EDIT(+5,-2) | radius:LOW(1) | - | a | b | c";
      const fields = splitChangelogFields(line);
      assert.equal(fields.length, 8);
      assert.equal(fields[7], "a | b | c");
    });

    // LEGACY-PATH FREEZE (step 12). The markdown compressor's output is pinned to exact bytes, so
    // any future edit to bootstrap.mjs that perturbs it fails LOUDLY here rather than silently
    // rewriting the ledger of every pre-v2.33.0 plan dir (A7: no forced migration).
    it("LEGACY FREEZE: markdown compression output is byte-for-byte the pre-XML result", async () => {
      const maybeCompressChangelog = await loadHelper();
      const dir = getTempDir();
      const planDir = join(dir, "plans", "plan_x");
      mkdirSync(planDir, { recursive: true });
      const e = (i, o = {}) =>
        `2026-07-14T0${i}:00:00Z | iter-1/step-${i} | abc1234 | src/f${i}.mjs | ${o.op || "EDIT(+5,-2)"} | radius:${o.tier || "LOW"}(1) | ${o.dref || "-"} | r${i}`;
      const body = [e(0, { tier: "HIGH" }), e(1), e(2), e(3), e(4), e(5), e(6), e(7, { dref: "D-001" }), e(8), e(9)];
      writeFileSync(join(planDir, "changelog.md"), ["# Changelog", "*hdr2*", "*hdr3*", "*hdr4*", "", ...body].join("\n") + "\n");

      const r = maybeCompressChangelog(planDir, { threshold: 10 });
      assert.deepEqual(r, { compressed: true, beforeLines: 16, afterLines: 14, elidedCount: 1, reason: "compressed" });

      // Golden bytes, captured from the v2.32.0 compressor BEFORE the XML path existed.
      const GOLDEN =
        "# Changelog\n*hdr2*\n*hdr3*\n*hdr4*\n" +
        "<!-- COMPRESSED-SUMMARY -->\n<!-- entries-at-compress: 10 -->\n" +
        "<!-- elided-groups: 1, elided-lines: 6 -->\n<!-- /COMPRESSED-SUMMARY -->\n" +
        "2026-07-14T00:00:00Z | iter-1/step-0 | abc1234 | src/f0.mjs | EDIT(+5,-2) | radius:HIGH(1) | - | r0\n" +
        "- (compressed: 6 low-decision-impact edits, iter-1/step-1..iter-1/step-6, files: 6)\n" +
        "2026-07-14T07:00:00Z | iter-1/step-7 | abc1234 | src/f7.mjs | EDIT(+5,-2) | radius:LOW(1) | D-001 | r7\n" +
        "2026-07-14T08:00:00Z | iter-1/step-8 | abc1234 | src/f8.mjs | EDIT(+5,-2) | radius:LOW(1) | - | r8\n" +
        "2026-07-14T09:00:00Z | iter-1/step-9 | abc1234 | src/f9.mjs | EDIT(+5,-2) | radius:LOW(1) | - | r9\n";
      assert.equal(readChangelog(planDir), GOLDEN, "legacy compressor output must not drift");
    });

    it("return shape (markdown) is exactly {compressed,beforeLines,afterLines,elidedCount,reason}", async () => {
      const maybeCompressChangelog = await loadHelper();
      const dir = getTempDir();
      const planDir = join(dir, "plans", "plan_x");
      writeChangelog(planDir, [entryLine()]);
      const r = maybeCompressChangelog(planDir);
      assert.deepEqual(
        Object.keys(r).sort(),
        ["afterLines", "beforeLines", "compressed", "elidedCount", "reason"],
        "ip-orchestrator's PLAN gate JSON-stringifies this — the shape is a contract"
      );
    });
  });

  describe("bootstrap.mjs as a library", () => {
    // The PLAN gate imports bootstrap.mjs dynamically. If the isEntryPoint guard ever broke, that
    // import would run the CLI (printing usage / exiting) on EVERY plan.
    it("dynamic import of bootstrap.mjs does not run the CLI (isEntryPoint guard holds)", async () => {
      const probe = [
        `const m = await import(${JSON.stringify(`file://${BOOTSTRAP}`)});`,
        `console.log(JSON.stringify({`,
        `  compressFn: typeof m.maybeCompressChangelog,`,
        `  decisionsFn: typeof m.maybeCompressDecisions,`,
        `}));`,
      ].join("\n");
      const res = spawnSync("node", ["--input-type=module", "-e", probe], {
        cwd: getTempDir(), encoding: "utf-8", timeout: 15000,
      });
      assert.equal(res.status, 0, `import must not exit non-zero. stderr: ${res.stderr}`);
      assert.equal(res.stdout.trim(), '{"compressFn":"function","decisionsFn":"function"}',
        "the CLI must print nothing — stdout carries only the probe's own JSON");
      assert.ok(!/Usage:|Initialized plans\//.test(res.stdout), "no CLI output leaked");
    });
  });

  // OBS-003 / D-004 — concurrent `bootstrap.mjs new` race
  describe("D-004: concurrent-new lockfile (OBS-003)", () => {
    it("5 parallel `new` produces exactly 1 plan dir + 1 pointer; losers ELOCKED-or-EACTIVE", async () => {
      const dir = getTempDir();
      // Launch 5 truly-parallel processes via async spawn (NOT spawnSync — sync
      // would serialize the test and make all but the first hit EACTIVE).
      const { spawn } = await import("child_process");
      const realProcs = [];
      for (let i = 0; i < 5; i++) {
        realProcs.push(new Promise((resolve) => {
          const p = spawn("node", [BOOTSTRAP, "new", `goal-${i}`], { cwd: dir });
          let stdout = "", stderr = "";
          p.stdout.on("data", (b) => stdout += b);
          p.stderr.on("data", (b) => stderr += b);
          p.on("close", (code) => resolve({ stdout, stderr, code }));
        }));
      }
      const results = await Promise.all(realProcs);

      const dirs = readdirSync(join(dir, "plans")).filter((n) => /^plan[-_]/.test(n));
      const pointer = (() => {
        try { return readFileSync(join(dir, "plans", ".current_plan"), "utf-8").trim(); } catch { return null; }
      })();
      const lockExists = existsSync(join(dir, "plans", ".lock"));

      const dump = results.map((r, i) =>
        `[${i}] code=${r.code} stdout=${r.stdout.slice(0,80)} stderr=${r.stderr.slice(0,80)}`).join("\n");

      assert.equal(dirs.length, 1, `expected exactly 1 plan dir, got ${dirs.length}\n${dump}`);
      assert.ok(pointer, `pointer file must exist after winner commits\n${dump}`);
      assert.equal(pointer, dirs[0], `pointer must point to the only plan dir\n${dump}`);
      assert.ok(!lockExists, `lock file must be cleaned up after winner releases\n${dump}`);

      const winners = results.filter((r) => r.code === 0);
      const losers = results.filter((r) => r.code === 1);
      assert.equal(winners.length, 1, `expected exactly 1 winner, got ${winners.length}\n${dump}`);
      assert.equal(losers.length, 4, `expected 4 losers, got ${losers.length}\n${dump}`);
      // Losers may either fail on the lock (ELOCKED) OR find the plan already
      // exists after the winner released (EACTIVE). Both are correct outcomes.
      for (const loser of losers) {
        assert.ok(/in progress|active plan/i.test(loser.stderr),
          `loser must report locked/active, got: ${loser.stderr.slice(0,200)}`);
      }
    });

  });

  // plan_2026-05-30_eb9b4fee/D-003 — concurrent `bootstrap.mjs close` race.
  // cmdClose must hold the same lock as cmdNew, or two closes double-merge into
  // the consolidated files / INDEX.md (the appendToIndex dedup guard is itself
  // TOCTOU-vulnerable: both read `existing` before either writes).
  describe("D-003: concurrent-close lockfile", () => {
    it("5 parallel `close` produces exactly 1 success, clean pointer/lock, no duplicate merge", async () => {
      const dir = getTempDir();
      // Create a plan to close.
      run(dir, "new", "concurrent close goal");
      const planName = readFileSync(join(dir, "plans", ".current_plan"), "utf-8").trim();

      const { spawn } = await import("child_process");
      const realProcs = [];
      for (let i = 0; i < 5; i++) {
        realProcs.push(new Promise((resolve) => {
          const p = spawn("node", [BOOTSTRAP, "close"], { cwd: dir });
          let stdout = "", stderr = "";
          p.stdout.on("data", (b) => stdout += b);
          p.stderr.on("data", (b) => stderr += b);
          p.on("close", (code) => resolve({ stdout, stderr, code }));
        }));
      }
      const results = await Promise.all(realProcs);
      const dump = results.map((r, i) =>
        `[${i}] code=${r.code} stdout=${r.stdout.slice(0,80)} stderr=${r.stderr.slice(0,80)}`).join("\n");

      const pointerGone = !existsSync(join(dir, "plans", ".current_plan"));
      const lockGone = !existsSync(join(dir, "plans", ".lock"));
      assert.ok(pointerGone, `pointer must be removed after close\n${dump}`);
      assert.ok(lockGone, `lock file must be cleaned after winner releases\n${dump}`);

      const winners = results.filter((r) => r.code === 0);
      assert.equal(winners.length, 1, `expected exactly 1 winning close, got ${winners.length}\n${dump}`);
      // Losers acquire the lock after the winner released, find no active plan.
      for (const loser of results.filter((r) => r.code !== 0)) {
        assert.ok(/No active plan|in progress/i.test(loser.stderr),
          `loser must report no-active-plan or locked, got: ${loser.stderr.slice(0,200)}`);
      }

      // No double-merge: INDEX.md lists the plan exactly once.
      const index = readFileSync(join(dir, "plans", "INDEX.md"), "utf-8");
      const idxCount = (index.split(`| ${planName} |`).length - 1);
      assert.equal(idxCount, 1, `INDEX.md must list the plan exactly once, got ${idxCount}\n${index}`);

      // Consolidated files have exactly one section for the plan.
      for (const f of ["FINDINGS.md", "DECISIONS.md"]) {
        const c = readFileSync(join(dir, "plans", f), "utf-8");
        const secCount = c.split(`## ${planName}`).length - 1;
        assert.equal(secCount, 1, `${f} must have exactly one section for the plan, got ${secCount}\n${c}`);
      }
    });
  });

  // OBS-008 / D-008 — stripCrossPlanNote must only strip the boilerplate in
  // the preamble (first 10 lines), not body content that happens to quote it.
  describe("D-008: stripCrossPlanNote anchored regex (OBS-008)", () => {
    it("preamble note on line 2 is stripped (with its blank-line padding)", async () => {
      const mod = await import(`file://${BOOTSTRAP}`);
      const { stripCrossPlanNote } = mod;
      const content = "# Findings\n*Cross-plan context: see plans/FINDINGS.md, plans/DECISIONS.md, and plans/LESSONS.md*\n## Index\nreal content";
      const result = stripCrossPlanNote(content);
      assert.ok(!result.includes("*Cross-plan context:"), `preamble note must be stripped, got: ${JSON.stringify(result)}`);
      assert.ok(result.includes("real content"), "body content must survive");
    });

    it("body quote of boilerplate is PRESERVED (not stripped)", async () => {
      const mod = await import(`file://${BOOTSTRAP}`);
      const { stripCrossPlanNote } = mod;
      const content = "# Findings\n## Index\nThe boilerplate is *Cross-plan context: see plans/FINDINGS.md, (etc)*\nmore content";
      const result = stripCrossPlanNote(content);
      assert.ok(result.includes("boilerplate is"), `body quote must be preserved, got: ${JSON.stringify(result)}`);
      assert.ok(result.includes("Cross-plan context"), "body text must be untouched");
    });

    it("preamble stripped AND body quote preserved when both exist", async () => {
      const mod = await import(`file://${BOOTSTRAP}`);
      const { stripCrossPlanNote } = mod;
      const content = "# Findings\n*Cross-plan context: see plans/FINDINGS.md, plans/DECISIONS.md*\n## Body\n*Cross-plan context: see plans/FINDINGS.md (referenced in F-001)*\nmore";
      const result = stripCrossPlanNote(content);
      // Preamble note (line 2) should be gone; body note (line 4) should remain.
      const matches = (result.match(/\*Cross-plan context:/g) || []).length;
      assert.equal(matches, 1, `exactly one occurrence (body) should remain, got ${matches}:\n${result}`);
      assert.ok(result.includes("referenced in F-001"), "body quote text must be preserved");
    });
  });

  describe("D-004 stale lock reclaim (continued)", () => {
    it("stale lock (PID 999999, not alive) is reclaimed silently", () => {
      const dir = getTempDir();
      mkdirSync(join(dir, "plans"), { recursive: true });
      writeFileSync(join(dir, "plans", ".lock"), "999999");
      const r = run(dir, "new", "goal after stale lock");
      assert.equal(r.exitCode, 0, `expected success reclaiming stale lock, got ${r.exitCode}\n${r.stdout}\n${r.stderr}`);
      assert.ok(existsSync(join(dir, "plans", ".current_plan")), "pointer must be written");
      assert.ok(!existsSync(join(dir, "plans", ".lock")), "stale lock must be cleaned");
    });
  });
});

// H3 — shared.mjs:extractField is used by both bootstrap.mjs (goal extraction)
// and validate-plan.mjs (iteration parsing) but had zero direct tests.
describe("shared.mjs: extractField", () => {
  async function load() {
    const mod = await import(`file://${SHARED}`);
    return mod.extractField;
  }

  it("returns null for null/empty content", async () => {
    const extractField = await load();
    assert.equal(extractField(null, /x/), null);
    assert.equal(extractField("", /x/), null);
    assert.equal(extractField(undefined, /x/), null);
  });

  it("returns null when the pattern does not match", async () => {
    const extractField = await load();
    assert.equal(extractField("no match here", /## Goal\s*\n(.+)/), null);
  });

  it("returns the first capture group on match", async () => {
    const extractField = await load();
    assert.equal(extractField("## Iteration: 3", /Iteration:\s*(\d+)/), "3");
  });

  it("trims surrounding whitespace from the captured group", async () => {
    const extractField = await load();
    assert.equal(extractField("Goal:    spaced value   \n", /Goal:(.+)/), "spaced value");
  });

  it("captures multi-line goal blocks via lazy group", async () => {
    const extractField = await load();
    const content = "# Plan\n## Goal\n  Do the thing\n## Next\n";
    assert.equal(extractField(content, /\n## Goal\s*\n([\s\S]+?)(?=\n## |$)/), "Do the thing");
  });
});

// P1 — `retire <plan-id>` resolves the anchor-graveyard ERROR (OBS-004): stamp
// [STALE] on a removed plan's qualified DECISION anchors so validate-plan
// downgrades the orphan from ERROR (blocks REFLECT→CLOSE) to WARN.
describe("bootstrap.mjs retire", () => {
  let tempDirs = [];
  function getTempDir() { const d = makeTempDir(); tempDirs.push(d); return d; }
  afterEach(() => { for (const d of tempDirs) removeTempDir(d); tempDirs = []; });

  const OTHER = "plan_2026-03-01_cccccccc";

  function seedAnchor(dir) {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "main.js"),
      `// DECISION ${OTHER}/D-001: keep retry budget at 3\nfunction f(){ return 3; }\n`);
  }

  it("stamps [STALE] on a qualified anchor and removes the plan dir", () => {
    const dir = getTempDir();
    run(dir, "new", "active work");
    seedAnchor(dir);
    mkdirSync(join(dir, "plans", OTHER), { recursive: true }); // the plan existed once
    const r = run(dir, "retire", OTHER);
    assert.equal(r.exitCode, 0, `retire should succeed, got:\n${r.stdout}\n${r.stderr}`);
    const src = readFileSync(join(dir, "src", "main.js"), "utf-8");
    assert.match(src, /D-001 \[STALE\]/, `anchor should be marked [STALE], got:\n${src}`);
    assert.ok(!existsSync(join(dir, "plans", OTHER)), "plan dir should be removed");
  });

  it("works when the plan dir is already gone (stamps anchors only)", () => {
    const dir = getTempDir();
    run(dir, "new", "active work");
    seedAnchor(dir);
    const r = run(dir, "retire", OTHER);
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /not present/, `should note dir absent, got:\n${r.stdout}`);
    assert.match(readFileSync(join(dir, "src", "main.js"), "utf-8"), /D-001 \[STALE\]/);
  });

  it("is idempotent — re-running does not double-stamp", () => {
    const dir = getTempDir();
    run(dir, "new", "active work");
    seedAnchor(dir);
    run(dir, "retire", OTHER);
    run(dir, "retire", OTHER);
    const src = readFileSync(join(dir, "src", "main.js"), "utf-8");
    assert.ok(!/\[STALE\]\s+\[STALE\]/.test(src), `must not double-stamp, got:\n${src}`);
    assert.equal((src.match(/\[STALE\]/g) || []).length, 1, "exactly one [STALE] marker");
  });

  // `.md` joined ANCHOR_SOURCE_EXTS in 2.32.0. retire must stamp exactly what the
  // validator scans: the `<!-- DECISION … -->` form, and nothing else.
  it("stamps [STALE] on an md HTML-comment anchor, idempotently", () => {
    const dir = getTempDir();
    run(dir, "new", "active work");
    mkdirSync(join(dir, "docs"), { recursive: true });
    const md = join(dir, "docs", "note.md");
    writeFileSync(md, `# Notes\n\n<!-- DECISION ${OTHER}/D-001: keep retry budget at 3 -->\n`);
    const r = run(dir, "retire", OTHER);
    assert.equal(r.exitCode, 0, `retire should succeed, got:\n${r.stdout}\n${r.stderr}`);
    const after = readFileSync(md, "utf-8");
    assert.match(after, /<!-- DECISION plan_2026-03-01_cccccccc\/D-001 \[STALE\]: keep retry budget at 3 -->/,
      `md HTML anchor should be marked [STALE], got:\n${after}`);
    run(dir, "retire", OTHER); // re-run must not double-stamp
    const again = readFileSync(md, "utf-8");
    assert.equal((again.match(/\[STALE\]/g) || []).length, 1, `exactly one [STALE] marker, got:\n${again}`);
  });

  // E6 — retire performs an irreversible source mutation. A style-agnostic matcher
  // would rewrite documentation prose and doc examples that are not anchors.
  it("does not rewrite bare-prose DECISION references in md", () => {
    const dir = getTempDir();
    run(dir, "new", "active work");
    mkdirSync(join(dir, "docs"), { recursive: true });
    const md = join(dir, "docs", "prose.md");
    const before = `# Notes\n\n**DECISION ${OTHER}/D-001** was recorded textually.\n\nSee \`# DECISION ${OTHER}/D-002\` for the fenced example.\n`;
    writeFileSync(md, before);
    const r = run(dir, "retire", OTHER);
    assert.equal(r.exitCode, 0, `retire should succeed, got:\n${r.stdout}\n${r.stderr}`);
    assert.equal(readFileSync(md, "utf-8"), before, "md prose must be byte-identical after retire");
    assert.match(r.stdout, /Anchors marked \[STALE\]: 0 across 0 file\(s\)/, `nothing should be stamped, got:\n${r.stdout}`);
  });

  // W2 (iter 2): a single md comment holding two anchors from two plans. Each
  // `retire <plan>` must stamp only its own anchor inside the shared span (the
  // deleted anchorHtmlRe's `<!--\s*DECISION` adjacency missed the 2nd), and be
  // idempotent. This is the retire half of the multi-anchor validator test.
  it("stamps each anchor in a shared md comment independently (multi-anchor)", () => {
    const dir = getTempDir();
    run(dir, "new", "active work");
    const A = "plan_2099-01-01_aaaaaaaa";
    const B = "plan_2099-01-01_bbbbbbbb";
    mkdirSync(join(dir, "docs"), { recursive: true });
    const md = join(dir, "docs", "multi.md");
    writeFileSync(md, `# Notes\n\n<!-- DECISION ${A}/D-001 first, DECISION ${B}/D-002 second -->\n`);
    const r1 = run(dir, "retire", A);
    assert.equal(r1.exitCode, 0, `retire A should succeed, got:\n${r1.stdout}\n${r1.stderr}`);
    assert.match(r1.stdout, /Anchors marked \[STALE\]: 1 across 1 file\(s\)/, `only A stamped, got:\n${r1.stdout}`);
    let after = readFileSync(md, "utf-8");
    assert.match(after, /DECISION plan_2099-01-01_aaaaaaaa\/D-001 \[STALE\]/, `A must be [STALE], got:\n${after}`);
    assert.ok(!/D-002 \[STALE\]/.test(after), `B must NOT be stamped by retire A, got:\n${after}`);
    const r2 = run(dir, "retire", B);
    assert.match(r2.stdout, /Anchors marked \[STALE\]: 1 across 1 file\(s\)/, `only B stamped, got:\n${r2.stdout}`);
    after = readFileSync(md, "utf-8");
    assert.match(after, /DECISION plan_2099-01-01_bbbbbbbb\/D-002 \[STALE\]/, `B must be [STALE], got:\n${after}`);
    // Re-run both: idempotent, exactly two [STALE] markers total.
    run(dir, "retire", A);
    run(dir, "retire", B);
    after = readFileSync(md, "utf-8");
    assert.equal((after.match(/\[STALE\]/g) || []).length, 2, `exactly two [STALE] markers, got:\n${after}`);
  });

  // W2a (iter 2): an UNCLOSED `<!-- DECISION …` (no `-->`) is a malformed comment.
  // The validator (span-scoped) reports nothing; retire (span-scoped) stamps
  // nothing. The two agree on the same malformed input — the bootstrap.mjs
  // "retire stamps exactly what the validator scans" contract. The pre-fix
  // anchorHtmlRe had no `-->` requirement and irreversibly mutated this case.
  it("unclosed md comment: validator and retire agree on NOTHING (agreement)", () => {
    const dir = getTempDir();
    run(dir, "new", "active work");
    const Z = "plan_2099-01-01_cccccccc";
    mkdirSync(join(dir, "docs"), { recursive: true });
    const md = join(dir, "docs", "unclosed.md");
    const before = `# Notes\n\n<!-- DECISION ${Z}/D-005 unclosed, no terminator\n\nmore text\n`;
    writeFileSync(md, before);
    // Validator half: zero anchor findings for the unclosed comment.
    const VALIDATE = resolve(import.meta.dirname, "validate-plan.mjs");
    let vout;
    try {
      vout = execFileSync("node", [VALIDATE], { cwd: dir, encoding: "utf-8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) { vout = (err.stdout || "") + (err.stderr || ""); }
    const findings = vout.split("\n").filter((l) => /\[anchor-[a-z-]+\]:/.test(l));
    assert.deepEqual(findings, [], `validator must report no anchor for an unclosed comment, got:\n${findings.join("\n")}`);
    // Retire half: nothing stamped, file byte-identical.
    const r = run(dir, "retire", Z);
    assert.match(r.stdout, /Anchors marked \[STALE\]: 0 across 0 file\(s\)/, `retire must stamp nothing, got:\n${r.stdout}`);
    assert.equal(readFileSync(md, "utf-8"), before, "unclosed comment must be byte-identical after retire");
  });

  it("refuses to retire the active plan", () => {
    const dir = getTempDir();
    run(dir, "new", "active work");
    const active = getPointer(dir);
    const r = runFull(dir, "retire", active);
    assert.notEqual(r.exitCode, 0, "should refuse active plan");
    assert.match(r.stderr, /ACTIVE plan/, `expected ACTIVE-plan error, got:\n${r.stderr}`);
  });

  it("rejects a malformed plan-id", () => {
    const dir = getTempDir();
    run(dir, "new", "active work");
    const r = runFull(dir, "retire", "not-a-plan");
    assert.notEqual(r.exitCode, 0);
    assert.match(r.stderr, /not a valid plan-id/);
  });

  // #12 — error path: retire with NO plan-id arg. cmdRetire guards `!planId`
  // first → exit 1 + usage message (bootstrap.mjs:1657-1660).
  it("errors with usage when no plan-id is given", () => {
    const dir = getTempDir();
    run(dir, "new", "active work");
    const r = runFull(dir, "retire");
    assert.equal(r.exitCode, 1, `retire with no arg should exit 1, got ${r.exitCode}\n${r.stderr}`);
    assert.match(r.stderr, /usage: node bootstrap\.mjs retire <plan-id>/,
      `expected retire usage error, got:\n${r.stderr}`);
  });

  // ---- Defect #6 (iter-1/step-6): decision ids were hard-capped at exactly 3
  // digits (`D-\d{3}`), so a D-1000+ anchor was INVISIBLE to retire's stamper —
  // it would stay un-[STALE]d and keep the orphan ERROR that jams REFLECT→CLOSE
  // for an unrelated plan. Widened to `\d{3,}` (padding minimum, not a cap).
  it("stamps [STALE] on a 4-digit decision id (D-1000)", () => {
    const dir = getTempDir();
    run(dir, "new", "active work");
    mkdirSync(join(dir, "src"), { recursive: true });
    const js = join(dir, "src", "big.js");
    writeFileSync(js, `// DECISION ${OTHER}/D-1000: id space past 999\nfunction f(){ return 1; }\n`);
    const r = run(dir, "retire", OTHER);
    assert.equal(r.exitCode, 0, `retire should succeed, got:\n${r.stdout}\n${r.stderr}`);
    const after = readFileSync(js, "utf-8");
    assert.match(after, /D-1000 \[STALE\]/, `D-1000 anchor should be marked [STALE], got:\n${after}`);
    // Idempotency at 4 digits is NOT free: without the `(?!\d)` boundary the greedy
    // `\d{3,}` backtracks to `D-100` (whose next char is `0`, so the `[STALE]`
    // negative lookahead passes) and re-stamps the anchor into `D-100 [STALE]0 [STALE]`
    // — an irreversible corruption of the source file. Pin both halves.
    run(dir, "retire", OTHER);
    const again = readFileSync(js, "utf-8");
    assert.equal((again.match(/\[STALE\]/g) || []).length, 1,
      `exactly one [STALE] marker after re-run, got:\n${again}`);
    assert.match(again, /D-1000 \[STALE\]/, `id must stay D-1000, got:\n${again}`);
    assert.ok(!/D-100 \[STALE\]/.test(again), `must not backtrack-stamp a truncated id, got:\n${again}`);
  });

  // The 3-digit zero-padding MINIMUM survives the widening: `D-1` is not a legal
  // decision id and must not be stamped (widening the cap must not become "any
  // number of digits" — that would make `D-1` and `D-001` two distinct ids).
  it("does not stamp an under-padded decision id (D-1)", () => {
    const dir = getTempDir();
    run(dir, "new", "active work");
    mkdirSync(join(dir, "src"), { recursive: true });
    const js = join(dir, "src", "short.js");
    const before = `// DECISION ${OTHER}/D-1: under-padded, not a legal id\nfunction f(){ return 1; }\n`;
    writeFileSync(js, before);
    const r = run(dir, "retire", OTHER);
    assert.equal(r.exitCode, 0);
    assert.equal(readFileSync(js, "utf-8"), before, "D-1 must be left byte-identical (not a legal anchor)");
    assert.match(r.stdout, /Anchors marked \[STALE\]: 0 across 0 file\(s\)/,
      `nothing should be stamped, got:\n${r.stdout}`);
  });

  // Defect #4 (iter-1/step-6): PLAN_ID_RE now comes from shared.mjs — the SAME
  // regex validate-plan.mjs uses. Pin the grammar bootstrap enforces on `retire`
  // so a future divergence (e.g. re-loosening the hex tail) fails here.
  it("enforces the shared plan-id grammar: 8-hex tail required", () => {
    const dir = getTempDir();
    run(dir, "new", "active work");
    // Valid shape (8 hex) — passes the id check; the dir simply isn't present.
    const ok = run(dir, "retire", "plan_2026-03-01_0123abcd");
    assert.equal(ok.exitCode, 0, `valid 8-hex plan-id should pass the grammar check, got:\n${ok.stderr}`);
    // Malformed shapes — each must be rejected by the shared regex.
    for (const bad of [
      "plan_2026-03-01_cccccc",     // 6 hex — too short
      "plan_2026-03-01_ccccccccc",  // 9 hex — too long
      "plan_2026-03-01_zzzzzzzz",   // not hex
      "plan_2026-3-1_cccccccc",     // unpadded date
    ]) {
      const r = runFull(dir, "retire", bad);
      assert.notEqual(r.exitCode, 0, `"${bad}" should be rejected as a plan-id`);
      assert.match(r.stderr, /not a valid plan-id/, `"${bad}" should hit the plan-id guard`);
    }
  });
});

// P2 — `reset-attempts` clears a stale Fix Attempts counter (OBS-016) so the
// pre-step leash gate cannot HARD-block the next EXECUTE step after a PIVOT.
describe("bootstrap.mjs reset-attempts", () => {
  let tempDirs = [];
  function getTempDir() { const d = makeTempDir(); tempDirs.push(d); return d; }
  afterEach(() => { for (const d of tempDirs) removeTempDir(d); tempDirs = []; });

  it("rewrites the Fix Attempts section to the placeholder", () => {
    const dir = getTempDir();
    run(dir, "new", "leash work");
    const planDir = getPointer(dir);
    const statePath = join(dir, "plans", planDir, "state.md");
    const jammed = readFileSync(statePath, "utf-8")
      .replace("# Current State: EXPLORE", "# Current State: EXECUTE")
      .replace(/## Fix Attempts \(resets per plan step\)\n- \(none yet\)/,
        "## Fix Attempts (resets per plan step)\n- Step 1, attempt 1: tried X — failed\n- Step 1, attempt 2: tried Y — failed");
    writeFileSync(statePath, jammed);
    const r = run(dir, "reset-attempts");
    assert.equal(r.exitCode, 0, `reset-attempts should succeed, got:\n${r.stdout}\n${r.stderr}`);
    const after = readFileSync(statePath, "utf-8");
    assert.match(after, /## Fix Attempts \(resets per plan step\)\n- \(none yet for current step\)\n## Change Manifest/,
      `Fix Attempts must be reset to placeholder, got:\n${after}`);
    assert.ok(!after.includes("tried X"), "stale attempt entries must be gone");
  });

  it("errors when there is no active plan", () => {
    const dir = getTempDir();
    const r = runFull(dir, "reset-attempts");
    assert.notEqual(r.exitCode, 0);
    assert.match(r.stderr, /No active plan/);
  });

  // #12 — error path: active plan exists but state.md has NO `## Fix Attempts`
  // heading. cmdResetAttempts does `state.indexOf("## Fix Attempts")` and exits
  // 1 with an explicit message when absent (bootstrap.mjs:1737-1741) — it is NOT
  // a silent no-op.
  it("errors when state.md has no '## Fix Attempts' section", () => {
    const dir = getTempDir();
    run(dir, "new", "leash work");
    const planDir = getPointer(dir);
    const statePath = join(dir, "plans", planDir, "state.md");
    // Strip the entire `## Fix Attempts` section (heading + body up to the next ## heading).
    const stripped = readFileSync(statePath, "utf-8")
      .replace(/## Fix Attempts \(resets per plan step\)\n- \(none yet\)\n/, "");
    writeFileSync(statePath, stripped);
    assert.ok(!stripped.includes("## Fix Attempts"), "fixture must have removed the heading");
    const r = runFull(dir, "reset-attempts");
    assert.equal(r.exitCode, 1, `missing Fix Attempts section should exit 1, got ${r.exitCode}\n${r.stderr}`);
    assert.match(r.stderr, /no '## Fix Attempts' section found/,
      `expected missing-section error, got:\n${r.stderr}`);
  });
});

// ---------------------------------------------------------------------------
// D-010 (iter-2 CRITICAL 3) — retire's `.md` anchor stamper now scopes anchorRe with
// shared.mjs's `htmlCommentSpans`, the SAME primitive validate-plan.mjs's `.md` anchor
// scanner uses. The two are bound by the "the validator sees exactly what retire stamps"
// contract, so they moved together. retire is a WRITE path over SOURCE files: a
// divergence here is not a wrong report, it is a wrong edit.
// ---------------------------------------------------------------------------
describe("retire: md anchor stamping is code-span aware (D-010)", () => {
  const tempDirs = [];
  function getTempDir() { const d = makeTempDir(); tempDirs.push(d); return d; }
  afterEach(() => { while (tempDirs.length) removeTempDir(tempDirs.pop()); });
  const GONE = "plan_2099-05-05_abcdabcd";

  it("does not stamp an anchor-shaped example inside a FENCED code block", () => {
    // Prose that documents the anchor format is not an anchor. Before D-010 the
    // stamper's `/<!--[\s\S]*?-->/g` treated a fenced example as a real comment span.
    const dir = getTempDir();
    run(dir, "new", "active work");
    mkdirSync(join(dir, "docs"), { recursive: true });
    const md = join(dir, "docs", "guide.md");
    const before = "# Anchor format\n\n```md\n<!-- DECISION " + GONE + "/D-001: an EXAMPLE, not an anchor -->\n```\n";
    writeFileSync(md, before);
    const r = run(dir, "retire", GONE);
    assert.equal(r.exitCode, 0, `retire should succeed, got:\n${r.stdout}\n${r.stderr}`);
    assert.equal(readFileSync(md, "utf-8"), before, "a fenced example must be byte-identical after retire");
    assert.match(r.stdout, /Anchors marked \[STALE\]: 0 across 0 file\(s\)/, `nothing should be stamped, got:\n${r.stdout}`);
  });

  it("does not let a backticked `<!--` in prose open a phantom span that stamps a later doc example", () => {
    const dir = getTempDir();
    run(dir, "new", "active work");
    mkdirSync(join(dir, "docs"), { recursive: true });
    const md = join(dir, "docs", "prose.md");
    const before = "# Notes\n\nAn anchor opens with `<!--` and closes with `-->`.\n\nDECISION " + GONE + "/D-001 written as bare prose is not an anchor.\n";
    writeFileSync(md, before);
    const r = run(dir, "retire", GONE);
    assert.equal(r.exitCode, 0);
    assert.equal(readFileSync(md, "utf-8"), before, "prose must be byte-identical after retire");
  });

  it("still stamps a REAL comment anchor that sits next to code spans, idempotently over 3 runs", () => {
    // The over-masking guard (Pre-Mortem #2) on the WRITE path: masking code spans must
    // not make a real comment invisible to the stamper.
    const dir = getTempDir();
    run(dir, "new", "active work");
    mkdirSync(join(dir, "docs"), { recursive: true });
    const md = join(dir, "docs", "note.md");
    writeFileSync(md, "# Notes\n\nWe write `<!--` when documenting.\n\n<!-- DECISION " + GONE + "/D-001: a real anchor -->\n\nAnd `-->` closes it.\n");
    const r = run(dir, "retire", GONE);
    assert.equal(r.exitCode, 0, `retire should succeed, got:\n${r.stdout}\n${r.stderr}`);
    const after = readFileSync(md, "utf-8");
    assert.match(after, /<!-- DECISION plan_2099-05-05_abcdabcd\/D-001 \[STALE\]: a real anchor -->/,
      `the real anchor must be stamped, got:\n${after}`);
    assert.match(after, /We write `<!--` when documenting\./, "the prose code span must be untouched");
    // Idempotent + byte-identical across repeated runs.
    run(dir, "retire", GONE);
    const second = readFileSync(md, "utf-8");
    run(dir, "retire", GONE);
    const third = readFileSync(md, "utf-8");
    assert.equal(second, after, "run 2 must be byte-identical to run 1");
    assert.equal(third, after, "run 3 must be byte-identical to run 1");
    assert.equal((third.match(/\[STALE\]/g) || []).length, 1, `exactly one [STALE] marker, got:\n${third}`);
  });
});

// ---------------------------------------------------------------------------
// iter-3 CRITICAL B (D-012) — retire must NEVER edit a documentation example.
//
// RED-RUN EVIDENCE (recorded against 79ef8a8 / v2.34.0, the pre-fix code, on a `.md`
// file whose `<!-- DECISION … -->` example sat in a 4-SPACE INDENTED code block and
// carried a REAL 8-hex plan id):
//
//   $ md5sum red-doc.md   → 73cc7c3ea310f0f6ab1a3c652756f4b3
//   $ node bootstrap.mjs retire plan_2026-01-01_deadbeef
//     Retired plan_2026-01-01_deadbeef.
//       Anchors marked [STALE]: 1 across 1 file(s).
//   $ md5sum red-doc.md   → b02ad9b99585bcc92c84cdc14b5d0f4b     ← MUTATED
//   $ diff
//   <     <!-- DECISION plan_2026-01-01_deadbeef/D-001 — example only -->
//   >     <!-- DECISION plan_2026-01-01_deadbeef/D-001 [STALE] — example only -->
//
// That is a WRONG EDIT TO A SOURCE FILE — precisely what the D-010 anchor in this
// stamper claims the shared primitive prevents. `maskLiteralRegions` covered fenced
// blocks and inline backtick runs but not CommonMark INDENTED code blocks, so the
// example was a live comment to both the validator and retire: they agreed, on the
// wrong answer. These tests pin the byte-identity, and (crucially) the inverse — that
// a REAL anchor is still stamped, so the fix under-masks rather than going blind.
// ---------------------------------------------------------------------------
describe("retire: never edits a doc example in an indented code block (CRITICAL B / D-012)", () => {
  const tempDirs = [];
  function getTempDir() { const d = makeTempDir(); tempDirs.push(d); return d; }
  afterEach(() => { while (tempDirs.length) removeTempDir(tempDirs.pop()); });
  const GONE = "plan_2026-01-01_deadbeef"; // a REAL 8-hex plan id, not a placeholder

  /** Content hash — the byte-identity assertion the plan (K4) requires. */
  const md5 = (s) => createHash("md5").update(s).digest("hex");

  it("leaves a 4-space indented DECISION example BYTE-IDENTICAL, even with a real plan id", () => {
    const dir = getTempDir();
    run(dir, "new", "active work");
    mkdirSync(join(dir, "docs"), { recursive: true });
    const md = join(dir, "docs", "guide.md");
    const before =
      "# Anchor format\n\nExample (indented = documentation, NOT a live anchor):\n\n" +
      "    <!-- DECISION " + GONE + "/D-001 — example only -->\n\n" +
      "The fenced sibling was always ignored:\n\n```\n<!-- DECISION " + GONE + "/D-002 — example only -->\n```\n";
    writeFileSync(md, before);
    const hashBefore = md5(before);

    const r = run(dir, "retire", GONE);
    assert.equal(r.exitCode, 0, `retire should succeed, got:\n${r.stdout}\n${r.stderr}`);
    const after = readFileSync(md, "utf-8");
    assert.equal(md5(after), hashBefore, `retire MUTATED a doc example:\n${after}`);
    assert.equal(after, before, "the doc must be byte-identical after retire");
    assert.match(r.stdout, /Anchors marked \[STALE\]: 0 across 0 file\(s\)/,
      `nothing should be stamped, got:\n${r.stdout}`);
  });

  it("still stamps a REAL flush-left anchor in the SAME file as an indented example (under-mask, not blind)", () => {
    // The Pre-Mortem #2 guard on the WRITE path. Masking indented blocks must not make a
    // real comment invisible — if this test ever goes quiet, retire has stopped stamping
    // and a stale anchor would jam the next plan's REFLECT→CLOSE gate forever.
    const dir = getTempDir();
    run(dir, "new", "active work");
    mkdirSync(join(dir, "docs"), { recursive: true });
    const md = join(dir, "docs", "mixed.md");
    writeFileSync(md,
      "# Notes\n\nExample:\n\n    <!-- DECISION " + GONE + "/D-001 — example only -->\n\n" +
      "<!-- DECISION " + GONE + "/D-002 — a REAL anchor -->\n");
    const r = run(dir, "retire", GONE);
    assert.equal(r.exitCode, 0, `got:\n${r.stdout}\n${r.stderr}`);
    const after = readFileSync(md, "utf-8");
    assert.match(after, /<!-- DECISION plan_2026-01-01_deadbeef\/D-002 \[STALE\] — a REAL anchor -->/,
      `the real anchor must still be stamped, got:\n${after}`);
    assert.match(after, /^ {4}<!-- DECISION plan_2026-01-01_deadbeef\/D-001 — example only -->$/m,
      `the indented example must be untouched, got:\n${after}`);
    assert.match(r.stdout, /Anchors marked \[STALE\]: 1 across 1 file\(s\)/, `got:\n${r.stdout}`);
  });

  it("leaves a DECISION example below an UNTERMINATED fence stampable (the fence masks nothing)", () => {
    // The mirror harm named in review WARNING 3: pre-fix, an unclosed fence masked to EOF,
    // so a REAL anchor below it was invisible to retire and could never be stamped.
    const dir = getTempDir();
    run(dir, "new", "active work");
    mkdirSync(join(dir, "docs"), { recursive: true });
    const md = join(dir, "docs", "fence.md");
    writeFileSync(md, "# Notes\n\n```\nan unclosed fence\n\n<!-- DECISION " + GONE + "/D-001 — a REAL anchor -->\n");
    const r = run(dir, "retire", GONE);
    assert.equal(r.exitCode, 0, `got:\n${r.stdout}\n${r.stderr}`);
    assert.match(readFileSync(md, "utf-8"), /\/D-001 \[STALE\] — a REAL anchor -->/,
      "an anchor below an unterminated fence is REAL and must be stamped");
  });
});

// ===========================================================================
// Dual-grammar recognition in the four bootstrap sites that used to hardcode
// the literal "plan_" (v2.36.0, plan_2026-07-14_317362c4 step 2).
//
// These four sites fail SILENTLY against a new-format dir — no error, they
// simply stop matching: the sliding window never trims (plans/FINDINGS.md
// grows unbounded), the INDEX.md date column goes blank, `list` stops listing,
// the orphan scan goes blind. Each test below drives a NEW-format id through
// the site and asserts the legacy behavior is unchanged alongside it.
// ===========================================================================
describe("bootstrap.mjs: plan-id grammar union at the four enumeration/scan sites", () => {
  const tempDirs = [];
  function getTempDir() { const d = makeTempDir(); tempDirs.push(d); return d; }
  afterEach(() => { while (tempDirs.length) removeTempDir(tempDirs.pop()); });

  const NEW_A = "plan-2026-01-05T101112-eeeeeeee"; // newest
  const NEW_B = "plan-2026-01-03T090000-cccccccc";
  const LEG_A = "plan_2026-01-04_dddddddd";
  const LEG_B = "plan_2026-01-02_bbbbbbbb";
  const LEG_C = "plan_2026-01-01_aaaaaaaa";        // oldest — must be trimmed

  it("sliding-window trim keeps the 4 newest sections across a MIX of both grammars", () => {
    const dir = getTempDir();
    mkdirSync(join(dir, "plans"), { recursive: true });
    // Consolidated files are newest-first by protocol invariant. 5 sections in,
    // 4 out. Pre-fix (`/\n## plan_/`) the two `## plan-…` sections were invisible,
    // so only 3 positions were found, `positions.length <= 4` held, and the file
    // was NEVER trimmed.
    const synthetic = "# Consolidated Findings\n*Archive.*\n\n" +
      [NEW_A, LEG_A, NEW_B, LEG_B, LEG_C]
        .map((id) => `## ${id}\n### Index\n- from ${id}\n`)
        .join("\n");
    writeFileSync(join(dir, "plans", "FINDINGS.md"), synthetic);
    run(dir, "new", "trigger trim");
    const planDir = getPointer(dir);
    // Empty findings.md → prependToConsolidated is a no-op, so we observe trim in isolation.
    writeFileSync(join(dir, "plans", planDir, "findings.md"), "# Findings\n");
    run(dir, "close");
    const merged = readFileSync(join(dir, "plans", "FINDINGS.md"), "utf-8");
    const sections = merged.match(/(^|\n)## plan[-_]/g) || [];
    assert.equal(sections.length, 4,
      `expected exactly 4 plan sections after trim, got ${sections.length}; content=${JSON.stringify(merged.slice(0, 300))}`);
    for (const kept of [NEW_A, LEG_A, NEW_B, LEG_B]) {
      assert.ok(merged.includes(kept), `section ${kept} must be retained`);
    }
    assert.ok(!merged.includes(LEG_C), "oldest section must be trimmed by the sliding window");
  });

  it("INDEX.md date column is populated for a NEW-format plan id", () => {
    const dir = getTempDir();
    run(dir, "new", "New-format index date");
    const legacy = getPointer(dir);
    renameSync(join(dir, "plans", legacy), join(dir, "plans", NEW_A));
    writeFileSync(join(dir, "plans", ".current_plan"), `${NEW_A}\n`);
    run(dir, "close");
    const index = readFileSync(join(dir, "plans", "INDEX.md"), "utf-8");
    const row = index.split("\n").find((l) => l.includes(`| ${NEW_A} |`));
    assert.ok(row, `INDEX.md must carry a row for ${NEW_A}, got:\n${index}`);
    assert.ok(row.includes("2026-01-05"),
      `date column must read 2026-01-05 for ${NEW_A}, got: ${row}`);
    assert.ok(!row.includes("unknown"), `date column must not be "unknown", got: ${row}`);
  });

  it("INDEX.md date column still works for a LEGACY plan id", () => {
    const dir = getTempDir();
    // `new` mints the NEW format now (step 3), so a legacy dir has to be staged by hand —
    // which is exactly the on-disk situation every pre-v2.36.0 project is in.
    run(dir, "new", "Legacy index date");
    const minted = getPointer(dir);
    renameSync(join(dir, "plans", minted), join(dir, "plans", LEG_A));
    writeFileSync(join(dir, "plans", ".current_plan"), `${LEG_A}\n`);
    run(dir, "close");
    const index = readFileSync(join(dir, "plans", "INDEX.md"), "utf-8");
    const row = index.split("\n").find((l) => l.includes(`| ${LEG_A} |`));
    assert.ok(row, `INDEX.md must carry a row for ${LEG_A}, got:\n${index}`);
    assert.ok(row.includes("2026-01-04"), `date column must read 2026-01-04, got: ${row}`);
    assert.ok(!row.includes("unknown"), `date column must not be "unknown", got: ${row}`);
  });

  it("list enumerates BOTH a legacy and a new-format plan directory", () => {
    const dir = getTempDir();
    // The minted dir is NEW-format (step 3); the legacy one is staged by hand, as it
    // would already be on disk in any project bootstrapped before v2.36.0.
    run(dir, "new", "Minted plan");
    const minted = getPointer(dir);
    run(dir, "close");
    mkdirSync(join(dir, "plans", LEG_A), { recursive: true });
    const r = run(dir, "list");
    assert.equal(r.exitCode, 0, `list must exit 0, got:\n${r.stdout}${r.stderr}`);
    assert.match(minted, /^plan-\d{4}-\d{2}-\d{2}T\d{6}-[0-9a-f]{8}$/, "minted dir must be new-format");
    assert.ok(r.stdout.includes(minted), `list must show the new-format dir, got:\n${r.stdout}`);
    assert.ok(r.stdout.includes(LEG_A), `list must show the legacy dir, got:\n${r.stdout}`);
    assert.ok(r.stdout.includes("(2 total)"), `list must count 2 plans, got:\n${r.stdout}`);
  });

  it("orphan scan sees a NEW-format directory when the pointer is stale", () => {
    const dir = getTempDir();
    mkdirSync(join(dir, "plans", NEW_A), { recursive: true });
    // Pointer names a syntactically valid but NON-EXISTENT dir → readPointer() → null,
    // pointer file present → orphan scan runs and must enumerate the new-format dir.
    writeFileSync(join(dir, "plans", ".current_plan"), "plan-2026-01-01T000000-ffffffff\n");
    const r = runFull(dir, "new", "after orphan");
    assert.equal(r.exitCode, 0, `new must still succeed, got:\n${r.stdout}${r.stderr}`);
    assert.ok(r.stderr.includes("WARNING"), `orphan warning expected, got:\n${r.stderr}`);
    assert.ok(r.stderr.includes(NEW_A),
      `orphan scan must name the new-format directory ${NEW_A}, got:\n${r.stderr}`);
  });
});

// ===========================================================================
// GENERATION cutover: `new` mints `plan-YYYY-MM-DDTHHMMSS-XXXXXXXX`, UTC and
// colon-free (v2.36.0, plan_2026-07-14_317362c4 step 3, D-001).
//
// Read paths accept BOTH grammars (step 1/2 above); only generation is
// new-only. These tests pin the WRITE side: shape, timezone, colon-freedom,
// the pointer, the pre-mkdir guard, and coexistence with legacy dirs on disk.
// ===========================================================================
describe("bootstrap.mjs: new-format plan-id generation", () => {
  const tempDirs = [];
  function getTempDir() { const d = makeTempDir(); tempDirs.push(d); return d; }
  afterEach(() => { while (tempDirs.length) removeTempDir(tempDirs.pop()); });

  const NEW_RE = /^plan-\d{4}-\d{2}-\d{2}T\d{6}-[0-9a-f]{8}$/;

  it("mints a dir matching plan-YYYY-MM-DDTHHMMSS-XXXXXXXX and points .current_plan at it", () => {
    const dir = getTempDir();
    const r = run(dir, "new", "generation shape");
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    const planDir = getPointer(dir);
    assert.match(planDir, NEW_RE, "generated dir name must match the new write grammar");
    assert.ok(existsSync(join(dir, "plans", planDir)), "the directory named by the pointer must exist");
    const dirs = readdirSync(join(dir, "plans")).filter((n) => /^plan[-_]/.test(n));
    assert.deepEqual(dirs, [planDir], "pointer must name the one dir that was created");
  });

  it("contains NO colon — a colon is illegal in a Win32/NTFS filename (D-001)", () => {
    const dir = getTempDir();
    run(dir, "new", "colon-free");
    const planDir = getPointer(dir);
    assert.ok(!planDir.includes(":"),
      `plan-dir name must be colon-free or mkdir fails on Windows (NTFS reads ":" as an Alternate Data Stream); got: ${planDir}`);
    // Belt: nothing else Win32 forbids in a filename either.
    for (const ch of ['<', '>', '"', '/', '\\', '|', '?', '*']) {
      assert.ok(!planDir.includes(ch), `plan-dir name must not contain ${ch}; got: ${planDir}`);
    }
  });

  it("matches the strict WRITE grammar and the READ union, and is NOT legacy", async () => {
    const { PLAN_ID_RE, ANY_PLAN_ID_RE, LEGACY_PLAN_ID_RE } = await import(`file://${SHARED}`);
    const dir = getTempDir();
    run(dir, "new", "grammar cross-check");
    const planDir = getPointer(dir);
    assert.ok(PLAN_ID_RE.test(planDir), `must match PLAN_ID_RE, got: ${planDir}`);
    assert.ok(ANY_PLAN_ID_RE.test(planDir), `must match ANY_PLAN_ID_RE, got: ${planDir}`);
    assert.ok(!LEGACY_PLAN_ID_RE.test(planDir), `must NOT match LEGACY_PLAN_ID_RE, got: ${planDir}`);
  });

  it("timestamps in UTC, not local time", () => {
    const before = new Date();
    const dir = getTempDir();
    run(dir, "new", "utc stamp");
    const after = new Date();
    const planDir = getPointer(dir);
    const m = /^plan-(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})-[0-9a-f]{8}$/.exec(planDir);
    assert.ok(m, `unparseable plan dir: ${planDir}`);
    const stamped = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    // Truncation to whole seconds can put the stamp up to 999ms before `before`.
    assert.ok(stamped >= before.getTime() - 1000 && stamped <= after.getTime(),
      `stamp ${planDir} must be UTC-now (in [${before.toISOString()}, ${after.toISOString()}]); a local-time stamp fails this in every non-UTC zone`);
    // Independent of the window check: the stamp must equal today's UTC date, not the local one.
    assert.equal(`${m[1]}-${m[2]}-${m[3]}`, after.toISOString().slice(0, 10), "date segment must be the UTC date");
  });

  it("state.md/decisions.md preamble carries the generated new-format id", () => {
    const dir = getTempDir();
    run(dir, "new", "preamble id");
    const planDir = getPointer(dir);
    const decisions = readPlanFile(dir, planDir, "decisions.md");
    assert.ok(decisions.includes(`*Plan: ${planDir}*`),
      `decisions.md preamble must name the new-format id, got:\n${decisions.slice(0, 200)}`);
  });

  it("a legacy dir on disk coexists with a freshly minted one: list, status and validate see BOTH", () => {
    const dir = getTempDir();
    const LEGACY = "plan_2026-01-01_deadbeef";
    run(dir, "new", "coexistence");
    const minted = getPointer(dir);
    assert.match(minted, NEW_RE);
    // Stage a legacy plan dir alongside — the pre-v2.36.0 state of every real project.
    mkdirSync(join(dir, "plans", LEGACY), { recursive: true });
    writeFileSync(join(dir, "plans", LEGACY, "state.md"), "# Current State: CLOSE\n## Iteration: 1\n");

    const list = run(dir, "list");
    assert.equal(list.exitCode, 0, `list must exit 0, got:\n${list.stdout}${list.stderr}`);
    assert.ok(list.stdout.includes(minted), `list must show the new dir, got:\n${list.stdout}`);
    assert.ok(list.stdout.includes(LEGACY), `list must show the legacy dir, got:\n${list.stdout}`);

    const status = run(dir, "status");
    assert.equal(status.exitCode, 0, `status must exit 0, got:\n${status.stderr}`);
    assert.ok(status.stdout.includes(minted),
      `status must resolve the new-format active plan, got:\n${status.stdout}`);
  });

  it("`new` inside a plans/ dir holding a legacy plan still succeeds (no grammar collision)", () => {
    const dir = getTempDir();
    mkdirSync(join(dir, "plans", "plan_2026-01-01_deadbeef"), { recursive: true });
    const r = runFull(dir, "new", "beside legacy");
    assert.equal(r.exitCode, 0, `new must succeed, got:\n${r.stdout}${r.stderr}`);
    assert.match(getPointer(dir), NEW_RE);
  });

  it("the pre-mkdir guard exists: a name failing PLAN_ID_RE is never written to disk", () => {
    // The guard is unreachable from the CLI by construction (that is the point of it), so
    // pin it at the source level: the generated name is asserted against the WRITE grammar
    // BEFORE the `mkdirSync`, and the failure path throws instead of creating anything.
    const src = readFileSync(BOOTSTRAP, "utf-8");
    const iGuard = src.indexOf("if (!PLAN_ID_RE.test(planDirName))");
    assert.ok(iGuard > 0, "cmdNewInner must assert the generated id against PLAN_ID_RE");
    const iMkdir = src.indexOf('mkdirSync(join(planDir, "checkpoints")');
    assert.ok(iMkdir > 0, "cmdNewInner must still create the plan dir");
    assert.ok(iGuard < iMkdir, "the PLAN_ID_RE assertion must run BEFORE any mkdir touches disk");
    assert.ok(src.slice(iGuard, iMkdir).includes('e.code = "EBADPLANID"'),
      "the guard must throw a structured EBADPLANID error (process.exit would leak the lock)");
    // And the wrapper must recognize that code, or the lock leaks and the message is a stack trace.
    assert.ok(src.includes('err.code === "EBADPLANID"'),
      "cmdNew must handle EBADPLANID: release the lock, print the message, exit 1");
  });
});

// ===========================================================================
// Skill-version stamp (D-004): resolveSkillVersion() + the state.md/decisions.md stamp
// ===========================================================================

describe("bootstrap.mjs — skill version stamp", () => {
  const VALIDATE = resolve(import.meta.dirname, "validate-plan.mjs");
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

  /** The real VERSION file content of this repo (the dev-layout expectation). */
  const REAL_VERSION = readFileSync(resolve(import.meta.dirname, "..", "..", "VERSION"), "utf-8").trim();

  /**
   * Build a simulated INSTALLED package layout: <pkg>/scripts/{bootstrap,shared}.mjs and
   * (optionally) <pkg>/VERSION — i.e. VERSION exactly ONE level above the script, which is
   * where `make build` / `make sync-skill` put it. In the dev tree it is TWO levels above
   * (src/scripts/ -> repo root). Returns the path to the installed bootstrap.mjs.
   *
   * This is the end-to-end proof of the installed-first probe: the copied script is run as a
   * real subprocess from the fake package, so nothing about the repo's own VERSION can leak in.
   */
  function makeInstalledPkg({ version }) {
    const pkg = join(getTempDir(), "iterative-planner");
    mkdirSync(join(pkg, "scripts"), { recursive: true });
    copyFileSync(BOOTSTRAP, join(pkg, "scripts", "bootstrap.mjs"));
    copyFileSync(SHARED, join(pkg, "scripts", "shared.mjs"));
    if (version !== null) writeFileSync(join(pkg, "VERSION"), version);
    return join(pkg, "scripts", "bootstrap.mjs");
  }

  /** Run an arbitrary bootstrap.mjs copy in a project cwd. */
  function runScript(script, cwd, ...args) {
    const r = spawnSync("node", [script, ...args], {
      cwd, encoding: "utf-8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout: r.stdout || "", stderr: r.stderr || "", exitCode: r.status ?? 1 };
  }

  function stampsOf(cwd) {
    const plan = getPointer(cwd);
    return {
      state: readPlanFile(cwd, plan, "state.md"),
      decisions: readPlanFile(cwd, plan, "decisions.md"),
    };
  }

  it("DEV layout: a fresh plan stamps the repo's real VERSION into state.md and decisions.md", () => {
    const dir = getTempDir();
    const r = runFull(dir, "new", "version stamp");
    assert.equal(r.exitCode, 0, `new must succeed, got:\n${r.stdout}${r.stderr}`);
    const { state, decisions } = stampsOf(dir);
    const expected = `*Skill: iterative-planner v${REAL_VERSION}*`;
    assert.ok(state.includes(expected), `state.md must carry ${expected}, got:\n${state}`);
    assert.ok(decisions.includes(expected), `decisions.md must carry ${expected}, got:\n${decisions}`);
  });

  it("the stamp sits on its OWN line — never folded into the H1 or the *Plan:* preamble", () => {
    const dir = getTempDir();
    runFull(dir, "new", "own line");
    const { state, decisions } = stampsOf(dir);
    const sLines = state.split("\n");
    const dLines = decisions.split("\n");
    // state.md: H1 first, stamp second, `## Iteration:` still present and unmangled.
    assert.equal(sLines[0], "# Current State: EXPLORE");
    assert.match(sLines[1], /^\*Skill: iterative-planner v\S+\*$/);
    assert.ok(state.includes("## Iteration: 0"));
    // decisions.md: H1, *Plan: <id>* (untouched — validate-plan.mjs matches it positionally),
    // then the stamp on its own line.
    assert.equal(dLines[0], "# Decision Log");
    assert.equal(dLines[1], `*Plan: ${getPointer(dir)}*`);
    assert.match(dLines[2], /^\*Skill: iterative-planner v\S+\*$/);
  });

  it("INSTALLED layout: VERSION one level above scripts/ resolves (the `..` probe, not `../..`)", () => {
    const script = makeInstalledPkg({ version: "9.9.9\n" });
    const proj = getTempDir();
    const r = runScript(script, proj, "new", "installed layout");
    assert.equal(r.exitCode, 0, `new must succeed in the installed layout, got:\n${r.stdout}${r.stderr}`);
    const { state, decisions } = stampsOf(proj);
    assert.ok(state.includes("*Skill: iterative-planner v9.9.9*"),
      `installed-layout VERSION must win the probe, got:\n${state}`);
    assert.ok(decisions.includes("*Skill: iterative-planner v9.9.9*"));
  });

  it("VERSION absent: bootstrap still exits 0 and stamps `unknown` (never crashes)", () => {
    // The highest-consequence failure mode in this plan: an uncaught ENOENT here would kill
    // `bootstrap.mjs new` on every fresh install, and the entire skill would be dead.
    const script = makeInstalledPkg({ version: null });
    const proj = getTempDir();
    const r = runScript(script, proj, "new", "no version file");
    assert.equal(r.exitCode, 0, `new must survive a missing VERSION, got:\n${r.stdout}${r.stderr}`);
    assert.ok(!/ENOENT/.test(r.stderr), `no ENOENT may escape, got stderr:\n${r.stderr}`);
    const { state, decisions } = stampsOf(proj);
    assert.ok(state.includes("*Skill: iterative-planner vunknown*"), `got:\n${state}`);
    assert.ok(decisions.includes("*Skill: iterative-planner vunknown*"), `got:\n${decisions}`);
  });

  it("VERSION garbage: unparseable content degrades to `unknown`, no crash", () => {
    for (const garbage of ["not-a-version\n", "", "2.35\n", "v2.35.0\n"]) {
      const script = makeInstalledPkg({ version: garbage });
      const proj = getTempDir();
      const r = runScript(script, proj, "new", "garbage version");
      assert.equal(r.exitCode, 0, `new must survive VERSION=${JSON.stringify(garbage)}, got:\n${r.stderr}`);
      const { state } = stampsOf(proj);
      assert.ok(state.includes("*Skill: iterative-planner vunknown*"),
        `VERSION=${JSON.stringify(garbage)} must degrade to unknown, got:\n${state}`);
    }
  });

  it("a stamped plan still validates with 0 errors (the stamp breaks no positional regex)", () => {
    const dir = getTempDir();
    runFull(dir, "new", "stamped and valid");
    const r = spawnSync("node", [VALIDATE], {
      cwd: dir, encoding: "utf-8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"],
    });
    const out = (r.stdout || "") + (r.stderr || "");
    assert.ok(!/^ERROR/m.test(out), `stamped plan must produce no ERRORs, got:\n${out}`);
  });
});

// ---------------------------------------------------------------------------
// PLAN_TEMPLATES + renderTemplate — the extracted plan-file skeletons.
//
// Golden-bytes: these tests pin every `bootstrap new` call site to its template. If someone
// re-inlines a literal, or edits a template without the call site agreeing, the byte compare
// below fails. Precedent: the maybeCompressChangelog byte-freeze test above.
//
// The in-process `import` is deliberate and depends on the isEntryPoint guard holding (see
// "bootstrap.mjs as a library" above). Keep that test.
// ---------------------------------------------------------------------------
describe("bootstrap.mjs — PLAN_TEMPLATES + renderTemplate", () => {
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

  const REAL_VERSION = readFileSync(resolve(import.meta.dirname, "..", "..", "VERSION"), "utf-8").trim();
  const CROSS_PLAN_NOTE = "\n*Cross-plan context: see plans/FINDINGS.md, plans/DECISIONS.md, and plans/LESSONS.md*\n";

  /** The 7 per-plan slugs (written into {plan-dir}/) and the 5 plans/-root slugs. */
  const PER_PLAN = ["state", "plan", "decisions", "findings", "progress", "verification", "changelog"];
  const ROOT_FILES = {
    "findings-consolidated": "FINDINGS.md",
    "decisions-consolidated": "DECISIONS.md",
    lessons: "LESSONS.md",
    system: "SYSTEM.md",
    index: "INDEX.md",
  };

  /** Import the module under test in-process (pure exports only — no CLI, per isEntryPoint). */
  async function loadBootstrap() {
    return import(`file://${BOOTSTRAP}`);
  }

  /** Pull the ISO timestamp bootstrap stamped into state.md, so the golden uses that run's own value. */
  function timestampOf(stateMd) {
    const m = stateMd.match(/## Last Transition: INIT → EXPLORE \((\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\)/);
    assert.ok(m, "state.md must carry an INIT → EXPLORE timestamp");
    return m[1];
  }

  it("exports exactly 12 templates, named for emit-template.mjs's slugs", async () => {
    const { PLAN_TEMPLATES } = await loadBootstrap();
    const keys = Object.keys(PLAN_TEMPLATES);
    assert.equal(keys.length, 12, `expected 12 templates, got ${keys.length}: ${keys.join(", ")}`);
    assert.deepEqual(
      [...keys].sort(),
      [...PER_PLAN, ...Object.keys(ROOT_FILES)].sort(),
      "template keys must be exactly the 12 slugs bootstrap writes"
    );
  });

  it("every template is a raw string — no leftover ${...} interpolation survived the extraction", async () => {
    const { PLAN_TEMPLATES } = await loadBootstrap();
    for (const [slug, body] of Object.entries(PLAN_TEMPLATES)) {
      assert.equal(typeof body, "string", `${slug} must be a raw string, not a function`);
      assert.ok(!/\$\{/.test(body), `${slug} still contains a \${...} interpolation site`);
    }
  });

  it("golden bytes: the 7 per-plan files equal renderTemplate(PLAN_TEMPLATES[slug], that run's values)", async () => {
    const { PLAN_TEMPLATES, renderTemplate } = await loadBootstrap();
    const dir = getTempDir();
    const goal = "golden capture";
    run(dir, "new", goal);
    const planDir = getPointer(dir);
    const stateMd = readPlanFile(dir, planDir, "state.md");

    // First-ever plan in a virgin project: no consolidated files existed when the note was computed.
    const values = {
      VERSION: REAL_VERSION,
      PLAN_ID: planDir,
      GOAL: goal,
      TIMESTAMP: timestampOf(stateMd),
      CROSS_PLAN_NOTE: "",
    };
    for (const slug of PER_PLAN) {
      const onDisk = readPlanFile(dir, planDir, `${slug}.md`);
      assert.equal(onDisk, renderTemplate(PLAN_TEMPLATES[slug], values),
        `${slug}.md on disk must be byte-identical to its rendered template`);
    }
  });

  it("golden bytes: the 5 plans/-root files equal their templates (no tokens, no values)", async () => {
    const { PLAN_TEMPLATES, renderTemplate } = await loadBootstrap();
    const dir = getTempDir();
    run(dir, "new", "golden capture");
    for (const [slug, filename] of Object.entries(ROOT_FILES)) {
      const onDisk = readFileSync(join(dir, "plans", filename), "utf-8");
      assert.equal(onDisk, renderTemplate(PLAN_TEMPLATES[slug], {}),
        `plans/${filename} must be byte-identical to PLAN_TEMPLATES.${slug}`);
    }
  });

  it("golden bytes: a later plan (consolidated files exist) renders the CROSS_PLAN_NOTE branch", async () => {
    const { PLAN_TEMPLATES, renderTemplate } = await loadBootstrap();
    const dir = getTempDir();
    run(dir, "new", "seed");   // creates plans/FINDINGS.md etc.
    run(dir, "close");
    const goal = "second plan";
    run(dir, "new", goal);
    const planDir = getPointer(dir);
    const stateMd = readPlanFile(dir, planDir, "state.md");
    const values = {
      VERSION: REAL_VERSION,
      PLAN_ID: planDir,
      GOAL: goal,
      TIMESTAMP: timestampOf(stateMd),
      CROSS_PLAN_NOTE,
    };
    for (const slug of PER_PLAN) {
      const onDisk = readPlanFile(dir, planDir, `${slug}.md`);
      assert.equal(onDisk, renderTemplate(PLAN_TEMPLATES[slug], values),
        `${slug}.md must be byte-identical with the cross-plan note branch rendered`);
    }
    assert.ok(readPlanFile(dir, planDir, "decisions.md").includes("*Cross-plan context:"),
      "the note branch must actually be exercised — otherwise this test proves nothing");
  });

  it("both CROSS_PLAN_NOTE branches render: empty note collapses the line, present note inserts it", async () => {
    const { PLAN_TEMPLATES, renderTemplate } = await loadBootstrap();
    const empty = renderTemplate(PLAN_TEMPLATES.findings, { CROSS_PLAN_NOTE: "" });
    const noted = renderTemplate(PLAN_TEMPLATES.findings, { CROSS_PLAN_NOTE });
    assert.ok(!empty.includes("Cross-plan context"), "empty branch must carry no note");
    assert.ok(noted.includes("*Cross-plan context: see plans/FINDINGS.md"), "note branch must carry the note");
    // The note is the ONLY difference — both branches share the rest of the skeleton byte-for-byte.
    assert.equal(noted.replace(CROSS_PLAN_NOTE, ""), empty,
      "removing the note from the noted branch must reproduce the empty branch exactly");
  });

  it("renderTemplate substitutes in a SINGLE pass — a value containing {{TOKEN}} is not re-scanned", async () => {
    const { renderTemplate } = await loadBootstrap();
    // `goal` is unsanitized user text. A loop-until-stable implementation would re-enter this
    // value and rewrite the {{VERSION}} inside it. A single left-to-right pass must not.
    const out = renderTemplate("goal={{GOAL}} v={{VERSION}}", {
      GOAL: "ship {{VERSION}} today",
      VERSION: "2.37.0",
    });
    assert.equal(out, "goal=ship {{VERSION}} today v=2.37.0",
      "the {{VERSION}} inside the substituted GOAL must survive verbatim");
  });

  it("renderTemplate THROWS on an unknown token (never silently leaves or blanks it)", async () => {
    const { renderTemplate } = await loadBootstrap();
    assert.throws(
      () => renderTemplate("# x\n{{BOGUS}}\n", { VERSION: "2.37.0" }),
      /\{\{BOGUS\}\} has no value supplied/,
      "an unrecognized placeholder must be a loud failure, not a half-written file"
    );
  });

  it("renderTemplate THROWS when a known token has no value supplied", async () => {
    const { renderTemplate, PLAN_TEMPLATES } = await loadBootstrap();
    assert.throws(
      () => renderTemplate(PLAN_TEMPLATES.state, { VERSION: "2.37.0" }), // TIMESTAMP missing
      /\{\{TIMESTAMP\}\} has no value supplied/,
      "a missing value must throw so cmdNewInner's catch rolls the plan dir back"
    );
  });
});
