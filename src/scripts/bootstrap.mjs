#!/usr/bin/env node
// Bootstrap and manage plan directories under .claude/ in the current working directory (project root).
//
// Usage:
//   node bootstrap.mjs "goal"                  Create a new plan (backward-compatible)
//   node bootstrap.mjs new "goal"              Create a new plan
//   node bootstrap.mjs new --force "goal"      Close active plan and create a new one
//   node bootstrap.mjs resume                  Output current plan state for re-entry
//   node bootstrap.mjs status                  One-line state summary
//   node bootstrap.mjs close                   Close active plan (preserves directory)
//   node bootstrap.mjs list                    Show all plan directories (active and closed)
//
// Creates .claude/.plan_YYYY-MM-DD_XXXXXXXX/ (date + 8-char hex seed) in cwd.
// Writes .claude/.current_plan with the directory name for discovery.
// Requires Node.js 18+ (guaranteed by Claude Code).

import { mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, unlinkSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";

const cwd = process.cwd();
const claudeDir = join(cwd, ".claude");
const pointerFile = join(claudeDir, ".current_plan");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureGitignore() {
  const gitignorePath = join(cwd, ".gitignore");
  const patterns = [".claude/.plan_*", ".claude/.current_plan"];
  let content = "";
  try {
    content = readFileSync(gitignorePath, "utf-8");
  } catch {
    // No .gitignore yet — will create
  }
  const missing = patterns.filter((p) => !content.split("\n").some((line) => line.trim() === p));
  if (missing.length === 0) return;
  const suffix = (content && !content.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n";
  const updated = content + suffix;
  writeFileSync(gitignorePath + ".tmp", updated);
  renameSync(gitignorePath + ".tmp", gitignorePath);
}

function readPointer() {
  try {
    const name = readFileSync(pointerFile, "utf-8").trim();
    if (name && existsSync(join(claudeDir, name))) return name;
    return null;
  } catch {
    return null;
  }
}

function readPlanFile(planDirName, filename) {
  try {
    return readFileSync(join(claudeDir, planDirName, filename), "utf-8");
  } catch {
    return null;
  }
}

function extractField(content, pattern) {
  if (!content) return null;
  const match = content.match(pattern);
  return match ? match[1].trim() : null;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdNew(goal, force) {
  mkdirSync(claudeDir, { recursive: true });

  // Warn about orphaned plan directories (no pointer, but directories exist)
  try {
    const activeName = readPointer();
    const allPlans = readdirSync(claudeDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith(".plan_"))
      .map((d) => d.name);
    const orphans = allPlans.filter((name) => name !== activeName);
    if (orphans.length > 0 && !activeName) {
      console.error(`WARNING: Found ${orphans.length} plan director${orphans.length === 1 ? "y" : "ies"} with no active pointer:`);
      for (const o of orphans) console.error(`  .claude/${o}`);
      console.error(`  These may be from a previous crash. Use 'list' to inspect.`);
    }
  } catch { /* .claude/ may be empty or not scannable */ }

  const existing = readPointer();
  if (existing && !force) {
    console.error(`ERROR: Active plan directory already exists: .claude/${existing}`);
    console.error(`  To resume:      node ${process.argv[1]} resume`);
    console.error(`  To view status:  node ${process.argv[1]} status`);
    console.error(`  To close it:     node ${process.argv[1]} close`);
    console.error(`  To force new:    node ${process.argv[1]} new --force "goal"`);
    process.exit(1);
  }
  if (existing && force) {
    cmdClose({ silent: true });
  }

  const now = new Date();
  const timestamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const dateStr = now.toISOString().slice(0, 10);
  const hexStr = randomBytes(4).toString("hex");
  const planDirName = `.plan_${dateStr}_${hexStr}`;
  const planDir = join(claudeDir, planDirName);

  try {
    mkdirSync(join(planDir, "checkpoints"), { recursive: true });
    mkdirSync(join(planDir, "findings"), { recursive: true });

    writeFileSync(
      join(planDir, "state.md"),
      `# Current State: EXPLORE
## Iteration: 0
## Current Plan Step: N/A
## Pre-Step Checklist (reset before each EXECUTE step)
- [ ] Re-read state.md (this file)
- [ ] Re-read plan.md
- [ ] Re-read progress.md
- [ ] Re-read decisions.md (if fix attempt)
- [ ] Checkpoint created (if risky step or irreversible op)
## Fix Attempts (resets per plan step)
- (none yet)
## Change Manifest (current iteration)
- (no changes yet)
## Last Transition: INIT → EXPLORE (${timestamp})
## Transition History:
- INIT → EXPLORE (task started)
`
    );

    writeFileSync(
      join(planDir, "plan.md"),
      `# Plan v0

## Goal
${goal}

## Problem Statement
*To be defined during PLAN. (1) Expected behavior, (2) invariants, (3) edge cases.*

## Context
*Pending EXPLORE phase. Findings will inform the approach.*

## Files To Modify
*To be determined after EXPLORE. List every file that will be touched.*

## Steps
*To be determined after EXPLORE.*

## Failure Modes
*To be determined during PLAN. For each dependency/integration: what if slow, garbage, down?*

## Risks
*To be determined after EXPLORE.*

## Success Criteria
*To be defined before first EXECUTE.*

## Complexity Budget
- Files added: 0/3 max
- New abstractions (classes/modules/interfaces): 0/2 max
- Lines added vs removed: +0/-0 (target: net negative or neutral)
`
    );

    writeFileSync(
      join(planDir, "decisions.md"),
      `# Decision Log
*Append-only. Never edit past entries.*
`
    );

    writeFileSync(
      join(planDir, "findings.md"),
      `# Findings
*Summary and index of all findings. Detailed files go in findings/ directory.*

## Index
*To be populated during EXPLORE.*

## Key Constraints
*To be populated during EXPLORE.*
`
    );

    writeFileSync(
      join(planDir, "progress.md"),
      `# Progress

## Completed
*Nothing yet.*

## In Progress
- [ ] EXPLORE: Initial context gathering

## Remaining
*To be populated from plan.md after PLAN phase.*

## Blocked
*Nothing currently.*
`
    );

    writeFileSync(pointerFile + ".tmp", planDirName);
    renameSync(pointerFile + ".tmp", pointerFile);
  } catch (err) {
    try { rmSync(planDir, { recursive: true, force: true }); } catch (e) { console.error(`WARNING: Failed to clean up partial plan directory: ${planDir}`); }
    try { if (existsSync(pointerFile + ".tmp")) unlinkSync(pointerFile + ".tmp"); } catch (e) { console.error("WARNING: Failed to clean up temp pointer file."); }
    try { if (existsSync(pointerFile)) unlinkSync(pointerFile); } catch (e) { console.error("WARNING: Failed to clean up pointer file."); }
    console.error(`ERROR: Failed to create plan directory: ${err.message}`);
    process.exit(1);
  }

  try {
    ensureGitignore();
  } catch (err) {
    console.error(`WARNING: Plan created but .gitignore update failed: ${err.message}`);
    console.error(`  Manually add .claude/.plan_* and .claude/.current_plan to .gitignore.`);
  }

  console.log(`Initialized .claude/${planDirName}/`);
  console.log(`  Pointer: .claude/.current_plan → ${planDirName}`);
  console.log(`  Goal: ${goal}`);
  console.log(`  State: EXPLORE (iteration 0)`);
  console.log(`  Next: Read code, ask questions, write findings.`);
}

function cmdResume() {
  const planDirName = readPointer();
  if (!planDirName) {
    console.error("ERROR: No active plan. Use `new` to create one.");
    process.exit(1);
  }

  const state = readPlanFile(planDirName, "state.md");
  const plan = readPlanFile(planDirName, "plan.md");
  const progress = readPlanFile(planDirName, "progress.md");
  const decisions = readPlanFile(planDirName, "decisions.md");

  const currentState = extractField(state, /^# Current State:\s*(.+)$/m) || "UNKNOWN";
  const iteration = extractField(state, /^## Iteration:\s*(.+)$/m) || "?";
  const step = extractField(state, /^## Current Plan Step:\s*(.+)$/m) || "N/A";
  const lastTransition = extractField(state, /^## Last Transition:\s*(.+)$/m) || "?";
  const goal = extractField(plan, /\n## Goal\s*\n([\s\S]+?)(?=\n## |$)/) || "No goal found";

  console.log(`Resuming .claude/${planDirName}/`);
  console.log(`  State:      ${currentState}`);
  console.log(`  Iteration:  ${iteration}`);
  console.log(`  Step:       ${step}`);
  console.log(`  Goal:       ${goal.split("\n")[0]}`);
  console.log(`  Last:       ${lastTransition}`);
  console.log();

  // Print progress summary
  if (progress) {
    const completed = (progress.match(/^- \[x\].+$/gm) || []).length;
    const remaining = (progress.match(/^- \[ \].+$/gm) || []).length;
    console.log(`  Progress:   ${completed} done, ${remaining} remaining`);
  }

  // Print decision count
  if (decisions) {
    const decisionCount = (decisions.match(/^## D-\d+/gm) || []).length;
    if (decisionCount > 0) {
      console.log(`  Decisions:  ${decisionCount} logged`);
    }
  }

  // Print checkpoint listing
  const checkpointDir = join(claudeDir, planDirName, "checkpoints");
  let checkpointFiles = [];
  try {
    checkpointFiles = readdirSync(checkpointDir).filter((f) => f.endsWith(".md")).sort();
  } catch { /* checkpoints dir may not exist */ }
  if (checkpointFiles.length > 0) {
    console.log();
    console.log(`  Checkpoints (${checkpointFiles.length}):`);
    for (const cp of checkpointFiles) {
      console.log(`    ${cp} → .claude/${planDirName}/checkpoints/${cp}`);
    }
  } else {
    console.log();
    console.log(`  Checkpoints: none`);
  }

  console.log();
  console.log(`  Recovery files:`);
  console.log(`    state.md     → .claude/${planDirName}/state.md`);
  console.log(`    plan.md      → .claude/${planDirName}/plan.md`);
  console.log(`    decisions.md → .claude/${planDirName}/decisions.md`);
  console.log(`    progress.md  → .claude/${planDirName}/progress.md`);
  console.log(`    findings.md  → .claude/${planDirName}/findings.md`);
}

function cmdStatus() {
  const planDirName = readPointer();
  if (!planDirName) {
    console.log("No active plan.");
    process.exit(0);
  }

  const state = readPlanFile(planDirName, "state.md");
  const plan = readPlanFile(planDirName, "plan.md");

  const currentState = extractField(state, /^# Current State:\s*(.+)$/m) || "UNKNOWN";
  const iteration = extractField(state, /^## Iteration:\s*(.+)$/m) || "?";
  const step = extractField(state, /^## Current Plan Step:\s*(.+)$/m) || "N/A";
  const goal = extractField(plan, /\n## Goal\s*\n([\s\S]+?)(?=\n## |$)/) || "?";

  console.log(`[${currentState}] iter=${iteration} step=${step} | ${goal.split("\n")[0].slice(0, 60)} | .claude/${planDirName}`);
}

function cmdClose(opts = {}) {
  const planDirName = readPointer();
  if (!planDirName) {
    if (!opts.silent) {
      console.error("ERROR: No active plan to close.");
      process.exit(1);
    }
    return;
  }

  try { unlinkSync(pointerFile); } catch { /* already removed — TOCTOU safe */ }

  if (!opts.silent) {
    console.log(`Closed plan: .claude/${planDirName}`);
    console.log(`  Pointer .claude/.current_plan removed.`);
    console.log(`  Plan directory preserved at .claude/${planDirName}/`);
    console.log(`  Decision log and findings remain available for reference.`);
    console.log(`  Note: This is an administrative close. The protocol CLOSE state`);
    console.log(`  (summary.md, decision audit) should be completed by the agent first.`);
  } else {
    console.log(`  Closed previous plan: .claude/${planDirName}`);
  }
}

function cmdList() {
  if (!existsSync(claudeDir)) {
    console.log("No .claude/ directory found.");
    process.exit(0);
  }

  const activeName = readPointer();
  const entries = readdirSync(claudeDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith(".plan_"))
    .map((d) => d.name)
    .sort();

  if (entries.length === 0) {
    console.log("No plan directories found.");
    process.exit(0);
  }

  console.log(`Plan directories in .claude/ (${entries.length} total):`);
  for (const name of entries) {
    const marker = name === activeName ? " ← active" : "";
    const state = readPlanFile(name, "state.md");
    const plan = readPlanFile(name, "plan.md");
    const currentState = extractField(state, /^# Current State:\s*(.+)$/m) || "?";
    const goal = extractField(plan, /\n## Goal\s*\n([\s\S]+?)(?=\n## |$)/) || "?";
    const goalOneLine = goal.split("\n")[0].slice(0, 60);
    console.log(`  ${name}  [${currentState}] ${goalOneLine}${marker}`);
  }
}

function printUsage() {
  console.log(`Usage: node bootstrap.mjs <command> [options]

Commands:
  new "goal"              Create a new plan directory
  new --force "goal"      Close active plan and create a new one
  resume                  Output current plan state for re-entry
  status                  One-line state summary
  close                   Close active plan (preserves directory)
  list                    Show all plan directories (active and closed)

Backward-compatible:
  node bootstrap.mjs "goal"   Same as: node bootstrap.mjs new "goal"`);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const subcommands = new Set(["new", "resume", "status", "close", "list", "help"]);

if (args.length === 0) {
  printUsage();
  process.exit(0);
}

const cmd = args[0];

if (!subcommands.has(cmd)) {
  if (cmd.startsWith("-")) {
    console.error(`ERROR: Unknown flag "${cmd}". Use "help" for usage.`);
    process.exit(1);
  }
  // Backward compat: treat args as goal for `new`
  cmdNew(args.join(" ") || "No goal specified", false);
} else if (cmd === "new") {
  const force = args.includes("--force");
  const goalArgs = args.slice(1).filter((a) => a !== "--force");
  const goal = goalArgs.join(" ") || "No goal specified";
  cmdNew(goal, force);
} else if (cmd === "resume") {
  cmdResume();
} else if (cmd === "status") {
  cmdStatus();
} else if (cmd === "close") {
  cmdClose();
} else if (cmd === "list") {
  cmdList();
} else if (cmd === "help") {
  printUsage();
}
