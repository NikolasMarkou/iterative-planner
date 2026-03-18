#!/usr/bin/env node
// Bootstrap and manage plan directories under plans/ in the current working directory (project root).
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
// Creates plans/plan_YYYY-MM-DD_XXXXXXXX/ (date + 8-char hex seed) in cwd.
// Writes plans/.current_plan with the directory name for discovery.
// Requires Node.js 18+ (guaranteed by Claude Code).

import { mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, unlinkSync, existsSync, rmSync, copyFileSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";

const cwd = process.cwd();
const plansDir = join(cwd, "plans");
const pointerFile = join(plansDir, ".current_plan");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureGitignore() {
  const gitignorePath = join(cwd, ".gitignore");
  const patterns = ["plans/"];
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
    if (name && existsSync(join(plansDir, name))) return name;
    return null;
  } catch {
    return null;
  }
}

function readPlanFile(planDirName, filename) {
  try {
    return readFileSync(join(plansDir, planDirName, filename), "utf-8");
  } catch {
    return null;
  }
}

function extractField(content, pattern) {
  if (!content) return null;
  const match = content.match(pattern);
  return match ? match[1].trim() : null;
}

function ensureConsolidatedFiles() {
  const findingsPath = join(plansDir, "FINDINGS.md");
  const decisionsPath = join(plansDir, "DECISIONS.md");
  const lessonsPath = join(plansDir, "LESSONS.md");
  if (!existsSync(findingsPath)) {
    writeFileSync(findingsPath, `# Consolidated Findings
*Cross-plan findings archive. Entries merged from per-plan findings.md on close. Newest first.*
`);
  }
  if (!existsSync(decisionsPath)) {
    writeFileSync(decisionsPath, `# Consolidated Decisions
*Cross-plan decision archive. Entries merged from per-plan decisions.md on close. Newest first.*
`);
  }
  if (!existsSync(lessonsPath)) {
    writeFileSync(lessonsPath, `# Lessons Learned
*Cross-plan lessons. Updated and consolidated on close. Max 200 lines — rewrite, don't append forever.*
*Read before any PLAN state. This is institutional memory.*
`);
  }
  const indexPath = join(plansDir, "INDEX.md");
  if (!existsSync(indexPath)) {
    writeFileSync(indexPath, `# Plan Index
*Topic-to-directory mapping. Updated on close. Survives sliding window trim.*

| Plan | Date | Goal | Key Topics |
|------|------|------|------------|
`);
  }
}

function prependToConsolidated(filePath, planDirName, newSection) {
  // Insert new section after the header (H1 + boilerplate + compressed summary if present),
  // before existing plan sections. Newest plans appear first.
  let existing = "";
  try { existing = readFileSync(filePath, "utf-8"); } catch { /* file may not exist */ }

  // Dedup guard: skip if this plan was already merged
  if (existing.includes(`\n## ${planDirName}\n`)) return;

  // Skip past compressed summary block if present
  const closeMarker = existing.indexOf(COMPRESSED_SUMMARY_CLOSE);
  const searchFrom = closeMarker >= 0
    ? existing.indexOf("\n", closeMarker + COMPRESSED_SUMMARY_CLOSE.length)
    : 0;

  // Find first ## plan section after the header (and after compressed summary)
  const firstH2 = searchFrom >= 0 ? existing.indexOf("\n## ", searchFrom) : -1;
  let header, body;
  if (firstH2 >= 0) {
    header = existing.slice(0, firstH2).trimEnd();
    body = existing.slice(firstH2);
  } else {
    header = existing.trimEnd();
    body = "";
  }
  const merged = header + `\n\n## ${planDirName}\n${newSection}\n` + body;
  writeFileSync(filePath + ".tmp", merged);
  renameSync(filePath + ".tmp", filePath);
}

function stripHeader(content) {
  // Strip everything before the first ## heading (the actual user content).
  // This avoids fragile exact-match regexes on boilerplate text that the agent may edit.
  const firstH2 = content.search(/^## /m);
  return firstH2 >= 0 ? content.slice(firstH2) : "";
}

function stripCrossPlanNote(content) {
  // Match both old format ("...and plans/DECISIONS.md") and new format ("...plans/DECISIONS.md, and plans/LESSONS.md")
  return content.replace(/\n?\*Cross-plan context: see plans\/FINDINGS\.md[^*]*\*\n?/g, "\n");
}

const CONSOLIDATED_COMPRESS_THRESHOLD = 500;
const MAX_CONSOLIDATED_PLANS = 8;
const COMPRESSED_SUMMARY_OPEN = "<!-- COMPRESSED-SUMMARY -->";
const COMPRESSED_SUMMARY_CLOSE = "<!-- /COMPRESSED-SUMMARY -->";

function checkConsolidatedSize(filePath, label) {
  // After merge, warn the agent if a consolidated file exceeds the compression threshold.
  // The agent (not this script) performs the actual summarization per SKILL.md protocol.
  try {
    const content = readFileSync(filePath, "utf-8");
    const lineCount = content.split("\n").length;
    if (lineCount > CONSOLIDATED_COMPRESS_THRESHOLD) {
      const hasSummary = content.includes(COMPRESSED_SUMMARY_OPEN);
      if (hasSummary) {
        console.log(`  ACTION NEEDED: ${label} is ${lineCount} lines (>${CONSOLIDATED_COMPRESS_THRESHOLD}). Update existing compressed summary.`);
      } else {
        console.log(`  ACTION NEEDED: ${label} is ${lineCount} lines (>${CONSOLIDATED_COMPRESS_THRESHOLD}). Create compressed summary — see protocol.`);
      }
    }
  } catch { /* file may not exist */ }
}

function trimConsolidatedWindow(filePath) {
  // Keep only the MAX_CONSOLIDATED_PLANS most recent plan sections.
  // Old data is still in per-plan directories — no information lost.
  let content;
  try { content = readFileSync(filePath, "utf-8"); } catch { return; }
  // Find all ## plan_ section positions
  const positions = [];
  const re = /\n## plan_/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    positions.push(match.index);
  }
  if (positions.length <= MAX_CONSOLIDATED_PLANS) return;
  // Truncate after the Nth section (keep first N, they're the newest)
  const cutoff = positions[MAX_CONSOLIDATED_PLANS];
  const trimmed = content.slice(0, cutoff).trimEnd() + "\n";
  writeFileSync(filePath + ".tmp", trimmed);
  renameSync(filePath + ".tmp", filePath);
}

function mergeToConsolidated(planDirName) {
  // Merge per-plan findings.md → plans/FINDINGS.md (newest first)
  const findingsContent = readPlanFile(planDirName, "findings.md");
  if (findingsContent) {
    let stripped = stripCrossPlanNote(stripHeader(findingsContent));
    // Demote ## → ###
    stripped = stripped.replace(/^## /gm, "### ");
    // Rewrite relative findings/ links to planDirName/findings/
    stripped = stripped.replace(/\(findings\//g, `(${planDirName}/findings/`);
    stripped = stripped.trim();
    if (stripped) {
      prependToConsolidated(join(plansDir, "FINDINGS.md"), planDirName, stripped);
    }
  }

  // Merge per-plan decisions.md → plans/DECISIONS.md (newest first)
  const decisionsContent = readPlanFile(planDirName, "decisions.md");
  if (decisionsContent) {
    let stripped = stripCrossPlanNote(stripHeader(decisionsContent));
    // Demote ## → ###
    stripped = stripped.replace(/^## /gm, "### ");
    stripped = stripped.trim();
    if (stripped) {
      prependToConsolidated(join(plansDir, "DECISIONS.md"), planDirName, stripped);
    }
  }
}

function appendToIndex(planDirName) {
  const indexPath = join(plansDir, "INDEX.md");
  ensureConsolidatedFiles(); // creates INDEX.md if missing
  let existing = "";
  try { existing = readFileSync(indexPath, "utf-8"); } catch { /* may not exist */ }

  // Dedup guard
  if (existing.includes(`| ${planDirName} |`)) return;

  // Extract goal and date from plan files
  const plan = readPlanFile(planDirName, "plan.md");
  const goal = extractField(plan, /\n## Goal\s*\n([\s\S]+?)(?=\n## |$)/) || "No goal";
  const goalOneLine = goal.split("\n")[0].slice(0, 60);
  const dateMatch = planDirName.match(/plan_(\d{4}-\d{2}-\d{2})/);
  const date = dateMatch ? dateMatch[1] : "unknown";

  // Extract key topics from findings.md index (first 3 topic slugs)
  const findings = readPlanFile(planDirName, "findings.md");
  let topics = "";
  if (findings) {
    const topicMatches = findings.match(/\[([^\]]+)\]/g);
    if (topicMatches) {
      topics = topicMatches.slice(0, 3).map((t) => t.replace(/[[\]]/g, "").toLowerCase()).join(", ");
    }
  }

  const safeGoal = goalOneLine.replace(/\|/g, "\\|");
  const row = `| ${planDirName} | ${date} | ${safeGoal} | ${topics} |\n`;
  const updated = existing.trimEnd() + "\n" + row;
  writeFileSync(indexPath + ".tmp", updated);
  renameSync(indexPath + ".tmp", indexPath);
}

function snapshotLessons(planDirName) {
  const lessonsPath = join(plansDir, "LESSONS.md");
  const snapshotPath = join(plansDir, planDirName, "lessons_snapshot.md");
  try {
    if (existsSync(lessonsPath)) {
      copyFileSync(lessonsPath, snapshotPath);
    }
  } catch { /* snapshot is best-effort */ }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdNew(goal, force) {
  mkdirSync(plansDir, { recursive: true });

  // Warn about orphaned plan directories (pointer file exists but is corrupted/stale)
  try {
    const activeName = readPointer();
    let pointerFileExists = false;
    try { readFileSync(pointerFile, "utf-8"); pointerFileExists = true; } catch { /* no pointer file */ }
    if (!activeName && pointerFileExists) {
      const allPlans = readdirSync(plansDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.startsWith("plan_"))
        .map((d) => d.name);
      if (allPlans.length > 0) {
        console.error(`WARNING: Pointer file exists but points to non-existent directory. Found ${allPlans.length} plan director${allPlans.length === 1 ? "y" : "ies"}:`);
        for (const o of allPlans) console.error(`  plans/${o}`);
        console.error(`  These may be from a previous crash. Use 'list' to inspect.`);
      }
    }
  } catch { /* plans/ may be empty or not scannable */ }

  const existing = readPointer();
  if (existing && !force) {
    console.error(`ERROR: Active plan directory already exists: plans/${existing}`);
    console.error(`  To resume:      node ${process.argv[1]} resume`);
    console.error(`  To view status:  node ${process.argv[1]} status`);
    console.error(`  To close it:     node ${process.argv[1]} close`);
    console.error(`  To force new:    node ${process.argv[1]} new --force "goal"`);
    process.exit(1);
  }
  if (existing && force) {
    cmdClose({ silent: true });
  }
  // Save old pointer name for recovery if --force was used and new plan creation fails
  const previousPlan = force ? existing : null;

  const now = new Date();
  const timestamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const dateStr = now.toISOString().slice(0, 10);
  const hexStr = randomBytes(4).toString("hex");
  const planDirName = `plan_${dateStr}_${hexStr}`;
  const planDir = join(plansDir, planDirName);

  // Check if consolidated files exist for cross-plan context seeding
  const hasConsolidated = existsSync(join(plansDir, "FINDINGS.md")) || existsSync(join(plansDir, "DECISIONS.md")) || existsSync(join(plansDir, "LESSONS.md"));
  const crossPlanNote = hasConsolidated ? "\n*Cross-plan context: see plans/FINDINGS.md, plans/DECISIONS.md, and plans/LESSONS.md*\n" : "";

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
*To be determined after EXPLORE. Annotate each with [RISK: low/medium/high] and [deps: N,M].*

## Assumptions
*To be populated during PLAN. Each: what you assume, which finding grounds it, which steps depend on it.*

## Failure Modes
*To be determined during PLAN. For each dependency/integration: what if slow, garbage, down?*

## Pre-Mortem & Falsification Signals
*To be determined during PLAN. Assume the plan failed — 2-3 scenarios with concrete STOP IF triggers.*

## Success Criteria
*To be defined before first EXECUTE.*

## Verification Strategy
*To be defined during PLAN. For each success criterion, define what check to run and what "pass" means.*

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
${crossPlanNote}`
    );

    writeFileSync(
      join(planDir, "findings.md"),
      `# Findings
*Summary and index of all findings. Detailed files go in findings/ directory.*
${crossPlanNote}
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

    writeFileSync(
      join(planDir, "verification.md"),
      `# Verification Results
*Populated during PLAN (template), updated during EXECUTE (per-step), completed during REFLECT (full pass).*
*Rewritten each iteration — not append-only.*

## Criteria Verification
| # | Criterion (from plan.md) | Method | Command/Action | Result | Evidence |
|---|--------------------------|--------|----------------|--------|----------|
| 1 | *To be populated during PLAN* | - | - | PENDING | - |

## Additional Checks
*Optional: lint, type checks, behavioral diffs, smoke tests.*

## Not Verified
| What | Why |
|------|-----|
| *To be populated during REFLECT* | - |

## Prediction Accuracy
*Compare plan.md predictions against actual results during REFLECT.*

| Predicted (from plan.md) | Actual | Delta |
|--------------------------|--------|-------|
| *To be populated during REFLECT* | - | - |

## Convergence Metrics
*EXTENDED — iteration 2+. First iteration: write "N/A — first iteration." See references/convergence-metrics.md.*

| Metric | Previous | Current | Delta |
|--------|----------|---------|-------|
| Pass rate | - | - | - |
| Scope (planned vs changed) | - | - | - |
| New issues found | - | - | - |
| **Convergence score** | - | - | - |

## Verdict
*To be completed during REFLECT.*
`
    );

    // Ensure consolidated files exist at plans/ root
    ensureConsolidatedFiles();

    writeFileSync(pointerFile + ".tmp", planDirName);
    renameSync(pointerFile + ".tmp", pointerFile);
  } catch (err) {
    try { rmSync(planDir, { recursive: true, force: true }); } catch (e) { console.error(`WARNING: Failed to clean up partial plan directory: ${planDir}`); }
    try { if (existsSync(pointerFile + ".tmp")) unlinkSync(pointerFile + ".tmp"); } catch (e) { console.error("WARNING: Failed to clean up temp pointer file."); }
    // If --force was used, restore the old pointer so the previous plan is not orphaned
    if (previousPlan) {
      try {
        writeFileSync(pointerFile, previousPlan);
        console.error(`WARNING: Restored pointer to previous plan: plans/${previousPlan}`);
      } catch (e) { console.error(`WARNING: Failed to restore pointer to previous plan: plans/${previousPlan}`); }
    } else {
      try { if (existsSync(pointerFile)) unlinkSync(pointerFile); } catch (e) { console.error("WARNING: Failed to clean up pointer file."); }
    }
    console.error(`ERROR: Failed to create plan directory: ${err.message}`);
    process.exit(1);
  }

  try {
    ensureGitignore();
  } catch (err) {
    console.error(`WARNING: Plan created but .gitignore update failed: ${err.message}`);
    console.error(`  Manually add plans/ to .gitignore.`);
  }

  console.log(`Initialized plans/${planDirName}/`);
  console.log(`  Pointer: plans/.current_plan → ${planDirName}`);
  console.log(`  Goal: ${goal}`);
  console.log(`  State: EXPLORE (iteration 0)`);
  console.log(`  Cross-plan context: plans/FINDINGS.md, plans/DECISIONS.md, plans/LESSONS.md`);
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

  console.log(`Resuming plans/${planDirName}/`);
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
  const checkpointDir = join(plansDir, planDirName, "checkpoints");
  let checkpointFiles = [];
  try {
    checkpointFiles = readdirSync(checkpointDir).filter((f) => f.endsWith(".md")).sort();
  } catch { /* checkpoints dir may not exist */ }
  if (checkpointFiles.length > 0) {
    console.log();
    console.log(`  Checkpoints (${checkpointFiles.length}):`);
    for (const cp of checkpointFiles) {
      console.log(`    ${cp} → plans/${planDirName}/checkpoints/${cp}`);
    }
  } else {
    console.log();
    console.log(`  Checkpoints: none`);
  }

  console.log();
  console.log(`  Recovery files:`);
  console.log(`    state.md     → plans/${planDirName}/state.md`);
  console.log(`    plan.md      → plans/${planDirName}/plan.md`);
  console.log(`    decisions.md → plans/${planDirName}/decisions.md`);
  console.log(`    progress.md  → plans/${planDirName}/progress.md`);
  console.log(`    findings.md  → plans/${planDirName}/findings.md`);
  console.log(`    verification.md → plans/${planDirName}/verification.md`);
  console.log();
  console.log(`  Consolidated context:`);
  console.log(`    plans/FINDINGS.md  — cross-plan findings archive`);
  console.log(`    plans/DECISIONS.md — cross-plan decision archive`);
  console.log(`    plans/LESSONS.md   — cross-plan lessons (read before PLAN)`);
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

  console.log(`[${currentState}] iter=${iteration} step=${step} | ${goal.split("\n")[0].slice(0, 60)} | plans/${planDirName}`);
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

  // Update state.md with CLOSE transition before removing pointer
  try {
    const statePath = join(plansDir, planDirName, "state.md");
    const stateContent = readFileSync(statePath, "utf-8");
    const prevState = stateContent.match(/^# Current State:\s*(.+)$/m)?.[1] || "UNKNOWN";
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const updated = stateContent
      .replace(/^# Current State:\s*.+$/m, "# Current State: CLOSE")
      .replace(/^## Last Transition:\s*.+$/m, `## Last Transition: ${prevState} → CLOSE (${timestamp})`)
      + `- ${prevState} → CLOSE (bootstrap close)\n`;
    writeFileSync(statePath, updated);
  } catch { /* state.md update is best-effort */ }

  // Merge per-plan findings/decisions to consolidated files before removing pointer
  try {
    ensureConsolidatedFiles();
    mergeToConsolidated(planDirName);
    // Sliding window: keep only the N most recent plan sections
    trimConsolidatedWindow(join(plansDir, "FINDINGS.md"));
    trimConsolidatedWindow(join(plansDir, "DECISIONS.md"));
    // Check if consolidated files need compression (rarely triggers with sliding window)
    checkConsolidatedSize(join(plansDir, "FINDINGS.md"), "plans/FINDINGS.md");
    checkConsolidatedSize(join(plansDir, "DECISIONS.md"), "plans/DECISIONS.md");
  } catch (err) {
    if (!opts.silent) {
      console.error(`WARNING: Merge to consolidated files failed: ${err.message}`);
      console.error(`  Per-plan files remain intact at plans/${planDirName}/`);
    }
  }

  // Update topic index and snapshot lessons before removing pointer
  try { appendToIndex(planDirName); } catch { /* index update is best-effort */ }
  try { snapshotLessons(planDirName); } catch { /* snapshot is best-effort */ }

  try { unlinkSync(pointerFile); } catch { /* already removed — TOCTOU safe */ }

  if (!opts.silent) {
    console.log(`Closed plan: plans/${planDirName}`);
    console.log(`  Pointer plans/.current_plan removed.`);
    console.log(`  Plan directory preserved at plans/${planDirName}/`);
    console.log(`  Findings/decisions merged to plans/FINDINGS.md and plans/DECISIONS.md.`);
    console.log(`  Update plans/LESSONS.md with significant lessons (max 200 lines).`);
    console.log(`  Note: This is an administrative close. The protocol CLOSE state`);
    console.log(`  (summary.md, decision audit) should be completed by the agent first.`);
  } else {
    console.log(`  Closed previous plan: plans/${planDirName}`);
  }
}

function cmdList() {
  if (!existsSync(plansDir)) {
    console.log("No plans/ directory found.");
    process.exit(0);
  }

  const activeName = readPointer();
  const entries = readdirSync(plansDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("plan_"))
    .map((d) => d.name)
    .sort();

  if (entries.length === 0) {
    console.log("No plan directories found.");
    process.exit(0);
  }

  console.log(`Plan directories in plans/ (${entries.length} total):`);
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
