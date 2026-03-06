#!/usr/bin/env node
// Validate protocol compliance of an iterative-planner plan directory.
//
// Usage:
//   node validate-plan.mjs                   Validate active plan
//   node validate-plan.mjs <plan-dir-name>   Validate specific plan directory
//
// Checks: state transitions, mandatory plan sections, cross-file consistency.
// Read-only — reports issues but changes nothing.
// Requires Node.js 18+.

import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";

const cwd = process.cwd();
const plansDir = join(cwd, "plans");
const pointerFile = join(plansDir, ".current_plan");

// ---------------------------------------------------------------------------
// Valid state transitions (from SKILL.md)
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS = new Set([
  "INIT→EXPLORE",
  "EXPLORE→PLAN",
  "PLAN→EXPLORE",
  "PLAN→PLAN",
  "PLAN→EXECUTE",
  "EXECUTE→REFLECT",
  "REFLECT→CLOSE",
  "REFLECT→RE-PLAN",
  "REFLECT→EXPLORE",
  "RE-PLAN→PLAN",
  // Bootstrap-generated transitions
  "EXPLORE→CLOSE",   // bootstrap close from EXPLORE
  "PLAN→CLOSE",      // bootstrap close from PLAN
  "EXECUTE→CLOSE",   // bootstrap close from EXECUTE
  "REFLECT→CLOSE",   // already covered above
  "RE-PLAN→CLOSE",   // bootstrap close from RE-PLAN
  "UNKNOWN→CLOSE",   // bootstrap close fallback
]);

// Mandatory sections in plan.md (header text → considered populated if non-placeholder)
const PLAN_SECTIONS = [
  "Goal",
  "Problem Statement",
  "Files To Modify",
  "Steps",
  "Assumptions",
  "Failure Modes",
  "Pre-Mortem & Falsification Signals",
  "Success Criteria",
  "Verification Strategy",
  "Complexity Budget",
];

const PLACEHOLDER_PATTERNS = [
  /^\*to be (defined|determined|populated)/im,
  /^\*pending/im,
  /^\*nothing yet/im,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readFile(path) {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function extractField(content, pattern) {
  if (!content) return null;
  const match = content.match(pattern);
  return match ? match[1].trim() : null;
}

function isPlaceholder(text) {
  if (!text || !text.trim()) return true;
  return PLACEHOLDER_PATTERNS.some((p) => p.test(text.trim()));
}

function extractSection(content, heading) {
  if (!content) return null;
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^## ${escaped}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, "m");
  const match = content.match(re);
  return match ? match[1].trim() : null;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function checkStateTransitions(planDir, issues) {
  const state = readFile(join(planDir, "state.md"));
  if (!state) {
    issues.push({ severity: "ERROR", check: "state", message: "state.md not found or unreadable" });
    return;
  }

  const currentState = extractField(state, /^# Current State:\s*(.+)$/m);
  if (!currentState) {
    issues.push({ severity: "ERROR", check: "state", message: "Cannot parse current state from state.md" });
  }

  // Parse transition history
  const historyStart = state.indexOf("## Transition History:");
  if (historyStart < 0) {
    issues.push({ severity: "WARN", check: "state", message: "No transition history found in state.md" });
    return;
  }

  const historyBlock = state.slice(historyStart);
  const lines = historyBlock.split("\n").filter((l) => l.startsWith("- "));

  for (const line of lines) {
    // Format: "- STATE1 → STATE2 (reason)" — arrow can be → or ->
    const match = line.match(/^- (.+?)\s*[→\->]+\s*(\S+)/);
    if (!match) continue;

    const from = match[1].trim().replace(/-/g, "-").toUpperCase();
    const to = match[2].trim().replace(/-/g, "-").toUpperCase();
    // Normalize RE_PLAN and RE-PLAN
    const normFrom = from.replace(/RE[_-]PLAN/g, "RE-PLAN");
    const normTo = to.replace(/RE[_-]PLAN/g, "RE-PLAN");
    const key = `${normFrom}→${normTo}`;

    if (!VALID_TRANSITIONS.has(key)) {
      issues.push({ severity: "ERROR", check: "transition", message: `Invalid transition: ${key} (from: "${line.trim()}")` });
    }
  }
}

function checkPlanSections(planDir, issues) {
  const plan = readFile(join(planDir, "plan.md"));
  if (!plan) {
    issues.push({ severity: "ERROR", check: "plan", message: "plan.md not found or unreadable" });
    return;
  }

  const state = readFile(join(planDir, "state.md"));
  const currentState = extractField(state, /^# Current State:\s*(.+)$/m) || "";

  // Only check for non-placeholder content if past EXPLORE (plan should be filled during PLAN)
  const requireContent = ["EXECUTE", "REFLECT", "RE-PLAN", "CLOSE"].includes(currentState.toUpperCase());

  for (const section of PLAN_SECTIONS) {
    const content = extractSection(plan, section);
    if (content === null) {
      issues.push({ severity: "ERROR", check: "plan-section", message: `Missing section: ## ${section}` });
    } else if (requireContent && isPlaceholder(content)) {
      issues.push({ severity: "WARN", check: "plan-section", message: `Section "## ${section}" still has placeholder content` });
    }
  }
}

function checkFindings(planDir, issues) {
  const findings = readFile(join(planDir, "findings.md"));
  if (!findings) {
    issues.push({ severity: "WARN", check: "findings", message: "findings.md not found or unreadable" });
    return;
  }

  const state = readFile(join(planDir, "state.md"));
  const currentState = extractField(state, /^# Current State:\s*(.+)$/m) || "";

  // Count indexed findings (lines starting with "- [" or "- " under ## Index)
  const indexSection = extractSection(findings, "Index");
  if (indexSection) {
    const findingLinks = indexSection.split("\n").filter((l) => l.match(/^- \[/));
    const findingItems = indexSection.split("\n").filter((l) => l.match(/^- .+/));
    const count = Math.max(findingLinks.length, findingItems.length);

    if (count < 3 && !["EXPLORE", "CLOSE"].includes(currentState.toUpperCase())) {
      issues.push({ severity: "WARN", check: "findings", message: `Only ${count} indexed findings (minimum 3 required before PLAN)` });
    }
  }
}

function checkCrossFileConsistency(planDir, issues) {
  const state = readFile(join(planDir, "state.md"));
  const plan = readFile(join(planDir, "plan.md"));
  const progress = readFile(join(planDir, "progress.md"));

  if (!state || !plan || !progress) return;

  const currentState = extractField(state, /^# Current State:\s*(.+)$/m) || "";

  // Check iteration consistency
  const stateIter = extractField(state, /^## Iteration:\s*(.+)$/m);
  if (stateIter) {
    const planVersion = extractField(plan, /^# Plan v(\d+)/m);
    if (planVersion && stateIter !== "0" && parseInt(stateIter) !== parseInt(planVersion)) {
      issues.push({ severity: "WARN", check: "consistency", message: `state.md iteration (${stateIter}) != plan.md version (v${planVersion})` });
    }
  }

  // Check that verification.md exists and has content if in REFLECT or later
  if (["REFLECT", "CLOSE"].includes(currentState.toUpperCase())) {
    const verification = readFile(join(planDir, "verification.md"));
    if (!verification) {
      issues.push({ severity: "ERROR", check: "consistency", message: "verification.md missing during REFLECT/CLOSE" });
    }
  }

  // Check that decisions.md exists
  if (!existsSync(join(planDir, "decisions.md"))) {
    issues.push({ severity: "ERROR", check: "consistency", message: "decisions.md not found" });
  }
}

function checkConsolidatedFiles(issues) {
  const files = ["FINDINGS.md", "DECISIONS.md", "LESSONS.md"];
  for (const f of files) {
    if (!existsSync(join(plansDir, f))) {
      issues.push({ severity: "INFO", check: "consolidated", message: `plans/${f} not found (created on first plan)` });
    }
  }

  // Check INDEX.md
  if (!existsSync(join(plansDir, "INDEX.md"))) {
    issues.push({ severity: "INFO", check: "consolidated", message: "plans/INDEX.md not found (created on first new)" });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function validate(planDirName) {
  const planDir = join(plansDir, planDirName);

  if (!existsSync(planDir)) {
    console.error(`ERROR: Plan directory not found: plans/${planDirName}`);
    process.exit(1);
  }

  const issues = [];

  checkStateTransitions(planDir, issues);
  checkPlanSections(planDir, issues);
  checkFindings(planDir, issues);
  checkCrossFileConsistency(planDir, issues);
  checkConsolidatedFiles(issues);

  // Report
  const errors = issues.filter((i) => i.severity === "ERROR");
  const warns = issues.filter((i) => i.severity === "WARN");
  const infos = issues.filter((i) => i.severity === "INFO");

  if (issues.length === 0) {
    console.log(`PASS: plans/${planDirName} — no issues found`);
    process.exit(0);
  }

  console.log(`Validation: plans/${planDirName}`);
  for (const issue of errors) {
    console.log(`  ERROR [${issue.check}]: ${issue.message}`);
  }
  for (const issue of warns) {
    console.log(`  WARN  [${issue.check}]: ${issue.message}`);
  }
  for (const issue of infos) {
    console.log(`  INFO  [${issue.check}]: ${issue.message}`);
  }

  console.log(`\nSummary: ${errors.length} error(s), ${warns.length} warning(s), ${infos.length} info(s)`);
  process.exit(errors.length > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// CLI Dispatch
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: node validate-plan.mjs [plan-dir-name]

Validates protocol compliance of an iterative-planner plan directory.
If no plan directory is specified, validates the active plan.

Checks:
  - State transition validity
  - Mandatory plan.md sections
  - Findings count (≥3 before PLAN)
  - Cross-file consistency (state/plan/progress/verification)
  - Consolidated files existence

Exit codes:
  0 = pass (no errors, warnings are OK)
  1 = fail (errors found)`);
  process.exit(0);
}

let planDirName;
if (args.length > 0) {
  planDirName = args[0];
} else {
  try {
    planDirName = readFileSync(pointerFile, "utf-8").trim();
  } catch {
    console.error("ERROR: No active plan and no plan directory specified.");
    console.error("  Usage: node validate-plan.mjs <plan-dir-name>");
    process.exit(1);
  }
}

validate(planDirName);
