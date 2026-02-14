#!/usr/bin/env node
// Bootstrap the .plan/ directory in the current working directory (project root).
// Usage: node bootstrap.mjs "Your goal description here"
//
// This script MUST be run from the project root. It creates .plan/ in cwd.
// Requires Node.js 18+ (guaranteed by Claude Code).

import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const goal = process.argv[2] || "No goal specified";
const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const planDir = join(process.cwd(), ".plan");

if (existsSync(planDir)) {
  console.error(`ERROR: ${planDir} already exists.`);
  console.error("To resume an existing plan, read .plan/state.md");
  console.error("To start fresh, delete .plan/ first.");
  process.exit(1);
}

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

console.log(`Initialized ${planDir}/`);
console.log(`  Goal: ${goal}`);
console.log(`  State: EXPLORE (iteration 0)`);
console.log(`  Next: Read code, ask questions, write findings.`);
