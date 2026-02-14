#!/usr/bin/env node
// Bootstrap the plan directory under .claude/ in the current working directory (project root).
// Usage: node bootstrap.mjs "Your goal description here"
//
// Creates .claude/.plan_YYYY-MM-DD_XXXXXXXX/ (date + 8-char hex seed) in cwd.
// Writes .claude/.current_plan with the directory name for discovery.
// Requires Node.js 18+ (guaranteed by Claude Code).

import { mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";

const goal = process.argv[2] || "No goal specified";
const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

const cwd = process.cwd();
const claudeDir = join(cwd, ".claude");
const pointerFile = join(claudeDir, ".current_plan");

// Ensure .claude/ exists
mkdirSync(claudeDir, { recursive: true });

// Check for an active plan via pointer file
let existingPlanDir = null;
try {
  existingPlanDir = readFileSync(pointerFile, "utf-8").trim();
} catch { /* no pointer file — fine */ }

if (existingPlanDir) {
  console.error(`ERROR: Active plan directory already exists: .claude/${existingPlanDir}`);
  console.error(`To resume, read .claude/${existingPlanDir}/state.md`);
  console.error(`To start fresh, delete .claude/${existingPlanDir}/ and .claude/.current_plan first.`);
  process.exit(1);
}

const dateStr = new Date().toISOString().slice(0, 10);
const hexStr = randomBytes(4).toString("hex");
const planDirName = `.plan_${dateStr}_${hexStr}`;
const planDir = join(claudeDir, planDirName);

mkdirSync(join(planDir, "checkpoints"), { recursive: true });
mkdirSync(join(planDir, "findings"), { recursive: true });

writeFileSync(
  join(planDir, "state.md"),
  `# Current State: EXPLORE
## Iteration: 0
## Current Plan Step: N/A
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

## Context
*Pending EXPLORE phase. Findings will inform the approach.*

## Files To Modify
*To be determined after EXPLORE. List every file that will be touched.*

## Steps
*To be determined after EXPLORE.*

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

// Write the pointer file so the protocol can discover this plan directory
writeFileSync(pointerFile, planDirName);

console.log(`Initialized .claude/${planDirName}/`);
console.log(`  Pointer: .claude/.current_plan → ${planDirName}`);
console.log(`  Goal: ${goal}`);
console.log(`  State: EXPLORE (iteration 0)`);
console.log(`  Next: Read code, ask questions, write findings.`);
