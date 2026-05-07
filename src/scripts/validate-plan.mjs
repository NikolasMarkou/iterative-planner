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

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, extname, relative } from "path";

const cwd = process.cwd();
const plansDir = join(cwd, "plans");
const pointerFile = join(plansDir, ".current_plan");

// ---------------------------------------------------------------------------
// v2.14.0 — Plan-qualified DECISION anchors
// ---------------------------------------------------------------------------
// In-code anchors of the form `# DECISION plan_YYYY-MM-DD_XXXXXXXX/D-NNN`
// carry the originating plan's directory name as a prefix. This makes anchors
// globally unambiguous and resolvable even after plans/DECISIONS.md sliding-
// window trim drops the originating plan section.
//
// Pre-v2.14.0 bare `D-NNN` anchors are accepted (WARN [anchor-unqualified]) as
// a migration nudge. New plans (state.md INIT timestamp ≥ ANCHOR_REFS_REQUIRED_SINCE)
// are held to the strict requirement: matching Anchor-Refs in decisions.md +
// preamble line in decisions.md/summary.md.

// Cutover for strict enforcement. Plans whose state.md INIT timestamp is on or
// after this instant are subject to ERROR (rather than WARN) for missing
// Anchor-Refs and missing plan-id preamble.
//
// Set to 09:00:00Z on v2.14.0 release day, after the v2.13.0 closing plan
// (plan_2026-05-07_9560e49b INIT at 08:07Z) and before the v2.14.0 plan
// (plan_2026-05-07_7556fb98 INIT at 09:17Z). Pre-cutover closed plans remain
// WARN-only on missing schema fields they couldn't have known about.
const ANCHOR_REFS_REQUIRED_SINCE = "2026-05-07T09:00:00Z";

// Plan-id format: `plan_YYYY-MM-DD_<hex>` (from bootstrap.mjs randomBytes(4).hex
// — 8 hex chars; we permit any positive-length lowercase-hex tail for forward
// compatibility).
const PLAN_ID_PATTERN = "plan_\\d{4}-\\d{2}-\\d{2}_[0-9a-f]+";
const PLAN_ID_RE = new RegExp(`^${PLAN_ID_PATTERN}$`);

// Read the INIT timestamp from state.md. Looks for any line matching
// `INIT (→|->) EXPLORE (TS)` where TS parses as an ISO date — checks the
// "Last Transition" line first, then falls back to scanning Transition
// History (the INIT entry persists there after the plan moves on).
// Returns Date | null. Malformed/missing → null (treat as pre-cutover, lenient).
function parseInitTimestamp(planDir) {
  const state = readFile(join(planDir, "state.md"));
  if (!state) return null;
  const re = /INIT\s*(?:→|->)\s*EXPLORE\s*\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(state)) !== null) {
    const raw = m[1].trim();
    const d = new Date(raw);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

// Returns true if INIT timestamp is on or after the v2.14.0 cutover.
// Null/malformed → false (pre-cutover, lenient WARN-not-ERROR).
function isPostCutover(planDir) {
  const ts = parseInitTimestamp(planDir);
  if (ts === null) return false;
  return ts.getTime() >= new Date(ANCHOR_REFS_REQUIRED_SINCE).getTime();
}

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
  "REFLECT→PIVOT",
  "REFLECT→EXPLORE",
  "PIVOT→PLAN",
  // Bootstrap-generated transitions
  "EXPLORE→CLOSE",   // bootstrap close from EXPLORE
  "PLAN→CLOSE",      // bootstrap close from PLAN
  "EXECUTE→CLOSE",   // bootstrap close from EXECUTE
  "REFLECT→CLOSE",   // already covered above
  "PIVOT→CLOSE",   // bootstrap close from PIVOT
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
  const headingRe = new RegExp(`^## ${escaped}[ \\t]*$`, "m");
  const headingMatch = headingRe.exec(content);
  if (!headingMatch) return null;
  const start = headingMatch.index + headingMatch[0].length;
  const nextHeading = content.indexOf("\n## ", start);
  const body = nextHeading >= 0 ? content.slice(start, nextHeading) : content.slice(start);
  return body.trim() || null;
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
    const match = line.match(/^- (.+?)\s+(?:→|->)\s+(\S+)/);
    if (!match) continue;

    const from = match[1].trim().replace(/[–—‐]/g, "-").toUpperCase();
    const to = match[2].trim().replace(/[–—‐]/g, "-").toUpperCase();
    // Normalize RE_PLAN, RE-PLAN, REPLAN to PIVOT
    const normFrom = from.replace(/RE[_-]?PLAN/g, "PIVOT");
    const normTo = to.replace(/RE[_-]?PLAN/g, "PIVOT");
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
  const requireContent = ["EXECUTE", "REFLECT", "PIVOT", "CLOSE"].includes(currentState.toUpperCase());

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
    const numberedItems = indexSection.split("\n").filter((l) => l.match(/^\d+\.\s+.+/));
    const count = Math.max(findingLinks.length, findingItems.length, numberedItems.length);

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

  // Check convergence metrics in verification.md for iteration 2+ REFLECT
  if (["REFLECT", "CLOSE"].includes(currentState.toUpperCase())) {
    const verification = readFile(join(planDir, "verification.md"));
    const stateIter = extractField(state, /^## Iteration:\s*(.+)$/m);
    if (verification && stateIter && parseInt(stateIter) >= 2) {
      if (!verification.includes("## Convergence Metrics") || !verification.includes("Convergence score")) {
        issues.push({ severity: "WARN", check: "convergence", message: "verification.md missing Convergence Metrics section for iteration 2+ (EXTENDED check — see references/convergence-metrics.md)" });
      } else {
        // Check if convergence metrics are still placeholder values (all dashes)
        const convergenceSection = extractSection(verification, "Convergence Metrics");
        if (convergenceSection) {
          const scoreRow = convergenceSection.split("\n").find((l) => l.includes("Convergence score"));
          if (scoreRow && /\|\s*-\s*\|\s*-\s*\|\s*-\s*\|/.test(scoreRow)) {
            issues.push({ severity: "WARN", check: "convergence", message: "verification.md Convergence Metrics still has placeholder values for iteration 2+ (EXTENDED check — see references/convergence-metrics.md)" });
          }
        }
      }
    }
  }

  // Check that summary.md exists at CLOSE
  if (currentState.toUpperCase() === "CLOSE") {
    if (!existsSync(join(planDir, "summary.md"))) {
      issues.push({ severity: "WARN", check: "consistency", message: "summary.md missing during CLOSE" });
    }
  }

  // Check that decisions.md exists
  if (!existsSync(join(planDir, "decisions.md"))) {
    issues.push({ severity: "ERROR", check: "consistency", message: "decisions.md not found" });
  }
}

function checkChangeManifest(planDir, issues) {
  const state = readFile(join(planDir, "state.md"));
  if (!state) return;

  const currentState = extractField(state, /^# Current State:\s*(.+)$/m) || "";
  if (!["EXECUTE", "REFLECT"].includes(currentState.toUpperCase())) return;

  if (!state.includes("## Change Manifest")) {
    issues.push({ severity: "WARN", check: "manifest", message: "state.md missing Change Manifest section during EXECUTE/REFLECT" });
  }
}

function checkIterationLimits(planDir, issues) {
  const state = readFile(join(planDir, "state.md"));
  if (!state) return;

  const iterStr = extractField(state, /^## Iteration:\s*(.+)$/m);
  if (!iterStr) return;

  const iter = parseInt(iterStr);
  if (iter >= 6) {
    issues.push({ severity: "ERROR", check: "iteration", message: `Iteration ${iter} exceeds hard limit (6+): must decompose into smaller tasks` });
  } else if (iter === 5) {
    issues.push({ severity: "WARN", check: "iteration", message: "Iteration 5: mandatory decomposition analysis required (2-3 sub-goals)" });
  }
}

function checkProgressStructure(planDir, issues) {
  const progress = readFile(join(planDir, "progress.md"));
  if (!progress) {
    issues.push({ severity: "WARN", check: "progress", message: "progress.md not found or unreadable" });
    return;
  }

  const requiredSections = ["Completed", "In Progress", "Remaining"];
  for (const section of requiredSections) {
    if (!progress.includes(`## ${section}`)) {
      issues.push({ severity: "WARN", check: "progress", message: `progress.md missing section: ## ${section}` });
    }
  }
}

function checkCheckpoints(planDir, issues) {
  const state = readFile(join(planDir, "state.md"));
  if (!state) return;

  const iterStr = extractField(state, /^## Iteration:\s*(.+)$/m);
  if (!iterStr) return;

  const iter = parseInt(iterStr);
  if (iter < 2) return;

  const cpDir = join(planDir, "checkpoints");
  if (!existsSync(cpDir)) {
    issues.push({ severity: "WARN", check: "checkpoints", message: `No checkpoints/ directory found at iteration ${iter} (expected checkpoint before risky changes)` });
    return;
  }

  try {
    const cpFiles = readdirSync(cpDir).filter((f) => f.endsWith(".md"));
    if (cpFiles.length === 0) {
      issues.push({ severity: "WARN", check: "checkpoints", message: `checkpoints/ directory is empty at iteration ${iter}` });
    }
  } catch { /* best-effort */ }
}

function checkComplexityBudget(planDir, issues) {
  const plan = readFile(join(planDir, "plan.md"));
  if (!plan) return;

  const state = readFile(join(planDir, "state.md"));
  const currentState = extractField(state, /^# Current State:\s*(.+)$/m) || "";
  if (!["EXECUTE", "REFLECT", "PIVOT", "CLOSE"].includes(currentState.toUpperCase())) return;

  const budgetSection = extractSection(plan, "Complexity Budget");
  if (!budgetSection) return;

  if (isPlaceholder(budgetSection)) {
    issues.push({ severity: "WARN", check: "complexity", message: "Complexity Budget section still has placeholder content during EXECUTE+" });
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
// Decisions.md schema checks (Step 3.1 + 3.2 — added in 2.13.0)
// ---------------------------------------------------------------------------

// Parse decisions.md into entries. Each entry: { id: number, idStr: "D-NNN",
// header: full header line, phase: PHASE token (uppercased for matching),
// date: YYYY-MM-DD string, body: text between this header and next.
// Skips headings inside HTML comment blocks (the schema example block).
//
// Returns { entries, badHeaders, preamblePlanId, preambleLine }:
//   preamblePlanId — value of the *Plan: <plan-id>* preamble line if present, else null
//   preambleLine — 1-based line number of the preamble (for diagnostics), or null
function parseDecisionsEntries(content) {
  if (!content) return { entries: [], badHeaders: [], preamblePlanId: null, preambleLine: null };

  // Extract preamble before stripping comments (preamble lives outside comments).
  // Look in the first 10 non-blank lines for `*Plan: <plan-id>*`.
  let preamblePlanId = null;
  let preambleLine = null;
  {
    const rawLines = content.split("\n");
    const preambleRe = new RegExp(`^\\*Plan:\\s*(${PLAN_ID_PATTERN})\\*\\s*$`);
    let nonBlankSeen = 0;
    for (let i = 0; i < rawLines.length && nonBlankSeen < 10; i++) {
      const t = rawLines[i].trim();
      if (t === "") continue;
      nonBlankSeen += 1;
      const pm = preambleRe.exec(t);
      if (pm) {
        preamblePlanId = pm[1];
        preambleLine = i + 1;
        break;
      }
    }
  }

  // Strip HTML comment blocks so the example schema in bootstrap.mjs (wrapped
  // in <!-- ... -->) does not register as an entry.
  const stripped = content.replace(/<!--[\s\S]*?-->/g, "");
  const lines = stripped.split("\n");
  const entries = [];
  const badHeaders = [];
  const headerRe = /^## D-(\d{3}) \| (.+) \| (\d{4}-\d{2}-\d{2})$/;
  // Any "## " heading that is not the top-level "# Decision Log" header.
  const anyH2Re = /^## (.+)$/;

  let current = null;
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h2 = anyH2Re.exec(line);
    if (h2) {
      // Close previous
      if (current) {
        current.body = lines.slice(bodyStart, i).join("\n");
        entries.push(current);
        current = null;
      }
      const m = headerRe.exec(line);
      if (m) {
        current = {
          id: parseInt(m[1], 10),
          idStr: `D-${m[1]}`,
          header: line,
          phase: m[2].trim().toUpperCase(),
          date: m[3],
          lineNum: i + 1,
          body: "",
        };
        bodyStart = i + 1;
      } else {
        // Non-conforming heading. Record it.
        badHeaders.push({ line, lineNum: i + 1 });
      }
    }
  }
  if (current) {
    current.body = lines.slice(bodyStart).join("\n");
    entries.push(current);
  }
  return { entries, badHeaders, preamblePlanId, preambleLine };
}

function checkDecisionsSchema(planDir, issues) {
  const path = join(planDir, "decisions.md");
  const content = readFile(path);
  if (!content) return;

  const { entries, badHeaders } = parseDecisionsEntries(content);

  // 3.1a — header format on every ## heading.
  for (const bh of badHeaders) {
    issues.push({
      severity: "ERROR",
      check: "decisions-schema",
      message: `decisions.md:${bh.lineNum} non-conforming entry header: "${bh.line}" (expected "## D-NNN | PHASE | YYYY-MM-DD")`,
    });
  }

  // 3.1b — sequential numbering [1, 2, 3, ...] starting from 1.
  if (entries.length > 0) {
    const ids = entries.map((e) => e.id);
    for (let i = 0; i < ids.length; i++) {
      const expected = i + 1;
      if (ids[i] !== expected) {
        issues.push({
          severity: "ERROR",
          check: "decisions-schema",
          message: `decisions.md D-NNN sequence broken at position ${i + 1}: expected D-${String(expected).padStart(3, "0")}, got D-${String(ids[i]).padStart(3, "0")}`,
        });
        break;
      }
    }
  }

  // 3.1c — Trade-off line presence in every entry.
  // 3.1d — Complexity Assessment block in PIVOT entries.
  const tradeoffRe = /^\*\*Trade-off\*\*:/m;
  for (const e of entries) {
    if (!tradeoffRe.test(e.body)) {
      issues.push({
        severity: "ERROR",
        check: "decisions-schema",
        message: `decisions.md ${e.idStr} (line ${e.lineNum}) missing **Trade-off**: line`,
      });
    }
    if (e.phase.includes("PIVOT")) {
      if (!/\*\*Complexity Assessment\*\*/.test(e.body)) {
        issues.push({
          severity: "ERROR",
          check: "decisions-schema",
          message: `decisions.md ${e.idStr} (line ${e.lineNum}) is a PIVOT entry but missing **Complexity Assessment** block`,
        });
      }
    }
  }
}

// 3.1e — Verdict 5 required bullets, in order.
function checkVerificationVerdict(planDir, issues) {
  const path = join(planDir, "verification.md");
  const content = readFile(path);
  if (!content) return;
  const verdict = extractSection(content, "Verdict");
  if (!verdict) return; // section presence is not enforced here; other checks own it.

  const requiredKeywords = [
    /criteria pass(?:ed|\s+count)/i,
    /regressions/i,
    /scope drift/i,
    /simplification blockers/i,
    /recommend(?:ed|ation)/i,
  ];
  const labels = [
    "Criteria passed",
    "Regressions",
    "Scope drift",
    "Simplification blockers",
    "Recommended transition",
  ];

  // Find positions of each keyword in the Verdict section.
  let lastPos = -1;
  let orderBroken = false;
  const missing = [];
  for (let i = 0; i < requiredKeywords.length; i++) {
    const re = requiredKeywords[i];
    const m = re.exec(verdict);
    if (!m) {
      missing.push(labels[i]);
      continue;
    }
    if (m.index < lastPos) orderBroken = true;
    lastPos = m.index;
  }

  if (missing.length > 0) {
    issues.push({
      severity: "ERROR",
      check: "verdict",
      message: `verification.md Verdict missing required bullet(s): ${missing.join(", ")}`,
    });
  } else if (orderBroken) {
    issues.push({
      severity: "ERROR",
      check: "verdict",
      message: "verification.md Verdict bullets present but not in required order (Criteria passed, Regressions, Scope drift, Simplification blockers, Recommended transition)",
    });
  }
}

// 3.1f — findings.md Index links resolve to existing files in findings/.
function checkFindingsIndexLinks(planDir, issues) {
  const path = join(planDir, "findings.md");
  const content = readFile(path);
  if (!content) return;
  const indexSection = extractSection(content, "Index");
  if (!indexSection) return;

  const linkRe = /\[[^\]]+\]\(([^)]+)\)/g;
  let m;
  while ((m = linkRe.exec(indexSection)) !== null) {
    const href = m[1].trim();
    if (/^https?:\/\//.test(href)) continue;
    if (href.startsWith("#")) continue;
    // Resolve relative to plan dir.
    const target = join(planDir, href);
    if (!existsSync(target)) {
      issues.push({
        severity: "ERROR",
        check: "findings-index",
        message: `findings.md Index link does not resolve: ${href}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Reverse anchor check (Step 3.1g — added in 2.13.0)
// ---------------------------------------------------------------------------

const ANCHOR_SOURCE_EXTS = new Set([
  ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".rb", ".go", ".rs",
  ".c", ".h", ".cpp", ".hpp", ".java", ".kt", ".sql",
]);

const SKIP_DIR_NAMES = new Set([
  "node_modules", ".git", "dist", "build", "plans",
  "target", "__pycache__", ".cache", "vendor", "out",
]);

// Anchor regexes from references/decision-anchoring.md Formal Grammar.
// Hash, slash, block, and SQL double-dash. Each captures:
//   group 1 — optional plan-id prefix (qualified anchors, v2.14.0+)
//   group 2 — D-NNN three-digit id
//   group 3 — optional " [STALE]" marker
// Plan-id prefix is captured non-greedily as PLAN_ID_PATTERN followed by "/".
const ANCHOR_PATTERNS = [
  new RegExp(`(?:^|\\s)#\\s+DECISION\\s+(?:(${PLAN_ID_PATTERN})\\/)?D-(\\d{3})(\\s+\\[STALE\\])?(?::|\\s|$)`),
  new RegExp(`(?:^|\\s)\\/\\/\\s+DECISION\\s+(?:(${PLAN_ID_PATTERN})\\/)?D-(\\d{3})(\\s+\\[STALE\\])?(?::|\\s|$)`),
  new RegExp(`\\/\\*\\s*DECISION\\s+(?:(${PLAN_ID_PATTERN})\\/)?D-(\\d{3})(\\s+\\[STALE\\])?[\\s\\S]*?\\*\\/`),
  new RegExp(`(?:^|\\s)--\\s+DECISION\\s+(?:(${PLAN_ID_PATTERN})\\/)?D-(\\d{3})(\\s+\\[STALE\\])?(?::|\\s|$)`),
];

function walkSourceFiles(root, files = [], depth = 0) {
  if (depth > 12) return files;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const ent of entries) {
    if (ent.name.startsWith(".") && ent.name !== ".") {
      // skip dotdirs/dotfiles by default (covers .git, .cache, etc.)
      if (ent.isDirectory()) continue;
    }
    const full = join(root, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIR_NAMES.has(ent.name)) continue;
      walkSourceFiles(full, files, depth + 1);
    } else if (ent.isFile()) {
      const ext = extname(ent.name);
      if (ANCHOR_SOURCE_EXTS.has(ext)) {
        files.push(full);
      }
    }
  }
  return files;
}

// Collect all anchor occurrences in a single source file. Returns array of
// { file, line, planName, id, qualified, stale }:
//   planName — string plan-id prefix if anchor is qualified, else null
//   id       — D-NNN integer (just the three-digit number)
//   qualified — true iff planName is non-null
//   stale    — true iff anchor carries the [STALE] marker
function findAnchorsInFile(file, projectRoot) {
  let text;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  const ext = extname(file);
  const out = [];

  // Build per-style regexes once. Capture groups: 1=planName(opt), 2=id, 3=stale(opt).
  const hashRe = new RegExp(`(?:^|\\s)#\\s+DECISION\\s+(?:(${PLAN_ID_PATTERN})\\/)?D-(\\d{3})(\\s+\\[STALE\\])?(?::|\\s|$)`);
  const slashRe = new RegExp(`(?:^|\\s)\\/\\/\\s+DECISION\\s+(?:(${PLAN_ID_PATTERN})\\/)?D-(\\d{3})(\\s+\\[STALE\\])?(?::|\\s|$)`);
  const sqlRe = new RegExp(`(?:^|\\s)--\\s+DECISION\\s+(?:(${PLAN_ID_PATTERN})\\/)?D-(\\d{3})(\\s+\\[STALE\\])?(?::|\\s|$)`);
  const blockInnerRe = new RegExp(`DECISION\\s+(?:(${PLAN_ID_PATTERN})\\/)?D-(\\d{3})(\\s+\\[STALE\\])?`);

  function pushMatch(m, lineNum) {
    out.push({
      file,
      line: lineNum,
      planName: m[1] || null,
      id: parseInt(m[2], 10),
      qualified: !!m[1],
      stale: !!m[3],
    });
  }

  // Per-line scan for hash, slash, double-dash markers.
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    // Hash style.
    if ([".py", ".rb", ".sh", ".bash", ".zsh", ".yml", ".yaml", ".toml", ".r", ".pl", ".pm", ".tf"].includes(ext)) {
      m = hashRe.exec(line);
      if (m) pushMatch(m, i + 1);
    }
    // Slash style.
    if ([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".go", ".rs", ".c", ".h", ".cpp", ".hpp", ".cc", ".java", ".swift", ".kt", ".scala", ".cs", ".php"].includes(ext)) {
      m = slashRe.exec(line);
      if (m) pushMatch(m, i + 1);
    }
    // SQL double-dash.
    if (ext === ".sql") {
      m = sqlRe.exec(line);
      if (m) pushMatch(m, i + 1);
    }
  }

  // Block comment scan (multi-line) — applies to /* */ in C-family + CSS.
  const blockRe = /\/\*([\s\S]*?)\*\//g;
  let bm;
  while ((bm = blockRe.exec(text)) !== null) {
    const body = bm[1];
    const dm = blockInnerRe.exec(body);
    if (dm) {
      const lineNum = text.slice(0, bm.index).split("\n").length;
      pushMatch(dm, lineNum);
    }
  }

  return out;
}

// Collect known decision IDs grouped by plan. Returns Map<planName, Set<id>>.
// The active plan is keyed by `activePlanName`. Cross-plan archive is parsed
// section-aware: each `## <plan-id>` heading begins a section; `### D-NNN`
// entries within belong to that plan.
function collectKnownDecisionIdsByPlan(planDir, activePlanName) {
  const map = new Map();

  function add(planName, id) {
    if (!planName) return;
    if (!map.has(planName)) map.set(planName, new Set());
    map.get(planName).add(id);
  }

  // Active plan's per-plan decisions.md.
  const planDecisions = readFile(join(planDir, "decisions.md"));
  if (planDecisions) {
    const { entries } = parseDecisionsEntries(planDecisions);
    for (const e of entries) add(activePlanName, e.id);
  }

  // Walk every per-plan decisions.md (covers archived plans whose sections
  // have been trimmed from plans/DECISIONS.md).
  try {
    const entries = readdirSync(plansDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (!PLAN_ID_RE.test(ent.name)) continue;
      if (ent.name === activePlanName) continue; // already loaded above
      const txt = readFile(join(plansDir, ent.name, "decisions.md"));
      if (!txt) continue;
      const { entries: pe } = parseDecisionsEntries(txt);
      for (const e of pe) add(ent.name, e.id);
    }
  } catch { /* plans/ may not be scannable */ }

  // Consolidated plans/DECISIONS.md, section-aware: track current `## <plan-id>`
  // wrapper, attribute every nested `### D-NNN` (or `## D-NNN` if not nested)
  // to that plan. Matches v2.13.0 sliding-window content shape.
  const consolidated = readFile(join(plansDir, "DECISIONS.md"));
  if (consolidated) {
    const lines = consolidated.split("\n");
    let currentPlan = null;
    const planSectionRe = new RegExp(`^##\\s+(${PLAN_ID_PATTERN})\\s*$`);
    const dashEntryRe = /^#{2,3}\s+D-(\d{3})\b/;
    for (const line of lines) {
      const ps = planSectionRe.exec(line);
      if (ps) { currentPlan = ps[1]; continue; }
      const de = dashEntryRe.exec(line);
      if (de && currentPlan) add(currentPlan, parseInt(de[1], 10));
    }
  }

  return map;
}

// Backward-compat shim: flat Set<number> view of all known IDs across all plans.
// Used only by checks that don't need plan-scoping (none after v2.14.0).
function collectKnownDecisionIds(planDir, activePlanName) {
  const flat = new Set();
  const byPlan = collectKnownDecisionIdsByPlan(planDir, activePlanName);
  for (const set of byPlan.values()) for (const id of set) flat.add(id);
  return flat;
}

function checkReverseAnchors(planDir, planDirName, issues, projectRoot) {
  const knownByPlan = collectKnownDecisionIdsByPlan(planDir, planDirName);
  let files;
  try {
    files = walkSourceFiles(projectRoot);
  } catch {
    return;
  }

  for (const file of files) {
    const anchors = findAnchorsInFile(file, projectRoot);
    for (const a of anchors) {
      const rel = relative(projectRoot, a.file);
      const idStr = `D-${String(a.id).padStart(3, "0")}`;
      const staleSuffix = a.stale ? " [STALE]" : "";
      const severityForOrphan = a.stale ? "WARN" : "ERROR";

      if (a.qualified) {
        // Qualified anchor: must resolve in the named plan's set.
        const set = knownByPlan.get(a.planName);
        const fullId = `${a.planName}/${idStr}`;
        if (!set) {
          issues.push({
            severity: severityForOrphan,
            check: "anchor-unknown-plan",
            message: `${rel}:${a.line} anchor references unknown plan ${a.planName} (${fullId}${staleSuffix}); no per-plan decisions.md and no matching section in plans/DECISIONS.md`,
          });
        } else if (!set.has(a.id)) {
          issues.push({
            severity: severityForOrphan,
            check: "anchor-orphan",
            message: `${rel}:${a.line} orphan anchor ${fullId}${staleSuffix} (plan exists but no ${idStr} entry in its decisions.md)`,
          });
        }
      } else {
        // Bare anchor (legacy form). Always WARN to nudge migration; then
        // attempt resolution against active plan only (existing behavior).
        issues.push({
          severity: "WARN",
          check: "anchor-unqualified",
          message: `${rel}:${a.line} bare anchor ${idStr}${staleSuffix} lacks plan-id prefix (expected \`${planDirName || "<plan-id>"}/${idStr}\`); see references/decision-anchoring.md`,
        });
        const activeSet = planDirName ? knownByPlan.get(planDirName) : null;
        if (!activeSet || !activeSet.has(a.id)) {
          issues.push({
            severity: severityForOrphan,
            check: "anchor-orphan",
            message: `${rel}:${a.line} orphan anchor ${idStr}${staleSuffix} (no matching entry in active plan's decisions.md)`,
          });
        }
      }
    }
  }
}

// v2.14.0 — plan-id preamble in decisions.md and summary.md.
// `*Plan: <plan-id>*` MUST appear within the first 10 non-blank lines.
// Strict (ERROR) for plans whose INIT timestamp ≥ ANCHOR_REFS_REQUIRED_SINCE;
// lenient (WARN) for legacy plans.
function checkPlanIdPreamble(planDir, planDirName, issues) {
  const strict = isPostCutover(planDir);
  const sev = strict ? "ERROR" : "WARN";

  function checkOne(filename) {
    const path = join(planDir, filename);
    const content = readFile(path);
    if (!content) return; // file may not exist (summary.md only at CLOSE)

    const { preamblePlanId } = parseDecisionsEntries(content);
    if (!preamblePlanId) {
      issues.push({
        severity: sev,
        check: "preamble-missing",
        message: `plan-id preamble line "*Plan: ${planDirName}*" not found in ${filename} (must appear within first 10 non-blank lines)`,
      });
      return;
    }
    if (planDirName && preamblePlanId !== planDirName) {
      issues.push({
        severity: "ERROR",
        check: "preamble-mismatch",
        message: `${filename} preamble plan-id "${preamblePlanId}" does not match plan directory name "${planDirName}"`,
      });
    }
  }

  checkOne("decisions.md");
  checkOne("summary.md");
}

// ---------------------------------------------------------------------------
// WARN-level checks (Step 3.2)
// ---------------------------------------------------------------------------

// 3.2a — Evidence column weak content.
function checkVerificationEvidence(planDir, issues) {
  const content = readFile(join(planDir, "verification.md"));
  if (!content) return;
  const section = extractSection(content, "Criteria Verification");
  if (!section) return;

  const lines = section.split("\n");
  const weakRe = /^(looks good|seems to work|lgtm|ok|fine|good)$/i;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith("|")) continue;
    // Skip header + separator rows.
    if (/^\|\s*-+\s*\|/.test(line)) continue;
    if (/^\|\s*#\s*\|/.test(line)) continue;
    // Split on | and trim.
    const cells = line.split("|").map((c) => c.trim());
    // Drop leading/trailing empty cells from outer pipes.
    if (cells.length > 0 && cells[0] === "") cells.shift();
    if (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
    if (cells.length < 6) continue; // schema: # | Criterion | Method | Cmd | Result | Evidence
    const evidence = cells[5];
    if (!evidence || evidence === "-") {
      issues.push({
        severity: "WARN",
        check: "evidence",
        message: `verification.md Criteria row "${cells[1] || "?"}" has empty Evidence cell`,
      });
      continue;
    }
    if (weakRe.test(evidence)) {
      issues.push({
        severity: "WARN",
        check: "evidence",
        message: `verification.md Criteria row "${cells[1] || "?"}" has weak Evidence: "${evidence}"`,
      });
      continue;
    }
    // Single-word check (no whitespace and not the placeholder "-").
    if (!/\s/.test(evidence) && evidence.length > 0 && evidence !== "-" && !/^\d+\/\d+/.test(evidence)) {
      issues.push({
        severity: "WARN",
        check: "evidence",
        message: `verification.md Criteria row "${cells[1] || "?"}" Evidence is single-word: "${evidence}"`,
      });
    }
  }
}

// 3.2b — findings/{topic}.md missing required sections.
function checkFindingsTopicSections(planDir, issues) {
  const dir = join(planDir, "findings");
  if (!existsSync(dir)) return;
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return;
  }
  // "Risks" any-prefix match (e.g. "Risks", "Risks & Unknowns", "Risks-Unknowns").
  const required = [
    { name: "Summary", re: /^##\s+Summary\b/m },
    { name: "Key Findings", re: /^##\s+Key Findings\b/m },
    { name: "Constraints", re: /^##\s+Constraints\b/m },
    { name: "Code Patterns", re: /^##\s+Code Patterns\b/m },
    { name: "Risks", re: /^##\s+Risks\b/m },
  ];
  for (const f of files) {
    const text = readFile(join(dir, f));
    if (!text) continue;
    const missing = required.filter((r) => !r.re.test(text)).map((r) => r.name);
    if (missing.length > 0) {
      issues.push({
        severity: "WARN",
        check: "findings-topic",
        message: `findings/${f} missing required section(s): ${missing.join(", ")}`,
      });
    }
  }
}

// 3.2c — state.md transition missing Exploration Confidence on EXPLORE → PLAN.
function checkExplorationConfidence(planDir, issues) {
  const state = readFile(join(planDir, "state.md"));
  if (!state) return;
  const historyStart = state.indexOf("## Transition History:");
  if (historyStart < 0) return;
  const historyBlock = state.slice(historyStart);
  const lines = historyBlock.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/EXPLORE\s+(?:→|->)\s+PLAN/.test(line)) continue;
    // Look at the next non-empty line; should contain "confidence:".
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j++;
    const next = lines[j] || "";
    if (!/confidence:/i.test(next)) {
      issues.push({
        severity: "WARN",
        check: "exploration-confidence",
        message: "state.md Transition History EXPLORE → PLAN line missing Exploration Confidence sub-line (expected 'confidence:' on next line)",
      });
    }
  }
}

// 3.2d / v2.14.0 — decisions.md entries missing Anchor-Refs when corresponding
// code has a matching anchor for THIS PLAN. Strict (ERROR) post-cutover,
// lenient (WARN) for pre-v2.14.0 plans.
function checkAnchorRefsRequired(planDir, planDirName, issues, projectRoot) {
  const content = readFile(join(planDir, "decisions.md"));
  if (!content) return;
  const { entries } = parseDecisionsEntries(content);
  if (entries.length === 0) return;

  // Build set of D-NNN ids that have anchors in source ATTRIBUTABLE to this
  // plan. Qualified anchors must match planDirName; bare anchors fall through
  // to the active plan as the implicit owner (legacy compat).
  const anchoredIds = new Set();
  let files;
  try {
    files = walkSourceFiles(projectRoot);
  } catch {
    return;
  }
  for (const f of files) {
    const anchors = findAnchorsInFile(f, projectRoot);
    for (const a of anchors) {
      if (a.qualified) {
        if (a.planName === planDirName) anchoredIds.add(a.id);
      } else {
        // Bare anchor: implicitly belongs to active plan.
        if (planDirName) anchoredIds.add(a.id);
      }
    }
  }

  const strict = isPostCutover(planDir);
  const sev = strict ? "ERROR" : "WARN";
  const checkName = strict ? "anchor-refs-missing" : "anchor-refs";

  const anchorRefsRe = /\*\*Anchor-Refs\*\*:/m;
  for (const e of entries) {
    if (!anchoredIds.has(e.id)) continue;
    if (!anchorRefsRe.test(e.body)) {
      issues.push({
        severity: sev,
        check: checkName,
        message: `decisions.md ${e.idStr} has matching code anchor but no **Anchor-Refs**: line`,
      });
    }
  }
}

// v2.14.0 — verify each `**Anchor-Refs**: \`path:line\`...` reference resolves:
// the file exists at projectRoot AND contains some DECISION anchor with this
// entry's id (qualified for this plan, or bare). WARN-only — line numbers
// drift, so we don't enforce exact line match.
function checkAnchorRefsValidity(planDir, planDirName, issues, projectRoot) {
  const content = readFile(join(planDir, "decisions.md"));
  if (!content) return;
  const { entries } = parseDecisionsEntries(content);
  if (entries.length === 0) return;

  const refLineRe = /^\*\*Anchor-Refs\*\*:\s*(.+)$/m;
  const refItemRe = /`([^`]+)`/g;

  for (const e of entries) {
    const ml = refLineRe.exec(e.body);
    if (!ml) continue;
    const refsLine = ml[1];
    const refs = [];
    let im;
    while ((im = refItemRe.exec(refsLine)) !== null) refs.push(im[1].trim());

    for (const ref of refs) {
      const colonIdx = ref.lastIndexOf(":");
      if (colonIdx < 1) continue; // malformed; skip silently
      const filePart = ref.slice(0, colonIdx);
      const target = join(projectRoot, filePart);
      if (!existsSync(target)) {
        issues.push({
          severity: "WARN",
          check: "anchor-refs-stale",
          message: `decisions.md ${e.idStr} **Anchor-Refs** points to missing file: ${ref}`,
        });
        continue;
      }
      // Verify some matching anchor exists for this id in the file.
      const anchors = findAnchorsInFile(target, projectRoot);
      const found = anchors.some((a) => {
        if (a.id !== e.id) return false;
        if (a.qualified && a.planName !== planDirName) return false;
        return true;
      });
      if (!found) {
        issues.push({
          severity: "WARN",
          check: "anchor-refs-stale",
          message: `decisions.md ${e.idStr} **Anchor-Refs** ${ref} but no matching DECISION anchor found in the file`,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// v2.15.0 — per-edit changelog (informational checks, WARN-only)
//
// File: {plan-dir}/changelog.md
// Format per line: UTC | iter-N/step-M | commit | path | OP(+N,-M) | radius:TIER(score) | D-NNN-or-dash | reason
// All issues are WARN — never block CLOSE.
function checkChangelogFormat(planDir, issues) {
  const path = join(planDir, "changelog.md");
  if (!existsSync(path)) return; // Optional file — older plans may lack it.
  const content = readFile(path);
  if (!content) return;

  const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
  const STEP = /^iter-\d+\/step-\d+$/;
  const COMMIT = /^([0-9a-f]{7,40}|uncommitted)$/;
  const OP = /^(CREATE\(\+\d+\)|EDIT\(\+\d+,-\d+\)|DELETE\(-\d+\)|RENAME\([^→]+→[^)]+\)|REVERT\([^)]+\))$/;
  const RADIUS = /^radius:(LOW|MED|HIGH)\(-?\d+\)|radius:UNKNOWN\([^)]+\)$/;
  const DREF = /^(D-\d{3}|-)$/;

  const lines = content.split("\n");
  let lineNo = 0;
  for (const raw of lines) {
    lineNo++;
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;        // header
    if (line.startsWith("*")) continue;        // italic header note
    if (line.startsWith("<!--")) continue;     // comment
    // Data line: split on " | " (literal pipe-with-spaces, as documented).
    const fields = line.split(" | ");
    if (fields.length !== 8) {
      issues.push({
        severity: "WARN",
        check: "changelog-malformed",
        message: `changelog.md:${lineNo}: expected 8 pipe-separated fields, got ${fields.length}`,
      });
      continue;
    }
    const [ts, step, commit, _path, op, radius, dref, reason] = fields;
    if (!TS.test(ts)) issues.push({ severity: "WARN", check: "changelog-malformed", message: `changelog.md:${lineNo}: bad timestamp "${ts}"` });
    if (!STEP.test(step)) issues.push({ severity: "WARN", check: "changelog-malformed", message: `changelog.md:${lineNo}: bad step "${step}"` });
    if (!COMMIT.test(commit)) issues.push({ severity: "WARN", check: "changelog-malformed", message: `changelog.md:${lineNo}: bad commit "${commit}"` });
    if (!_path || _path.includes("|")) issues.push({ severity: "WARN", check: "changelog-malformed", message: `changelog.md:${lineNo}: bad path field` });
    if (!OP.test(op)) issues.push({ severity: "WARN", check: "changelog-malformed", message: `changelog.md:${lineNo}: bad op "${op}"` });
    if (!RADIUS.test(radius)) issues.push({ severity: "WARN", check: "changelog-malformed", message: `changelog.md:${lineNo}: bad radius "${radius}"` });
    if (!DREF.test(dref)) issues.push({ severity: "WARN", check: "changelog-malformed", message: `changelog.md:${lineNo}: bad decision-ref "${dref}" (use D-NNN or -)` });
    if (!reason || !reason.trim()) issues.push({ severity: "WARN", check: "changelog-malformed", message: `changelog.md:${lineNo}: empty reason` });
  }
}

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
  checkChangeManifest(planDir, issues);
  checkIterationLimits(planDir, issues);
  checkProgressStructure(planDir, issues);
  checkCheckpoints(planDir, issues);
  checkComplexityBudget(planDir, issues);
  checkConsolidatedFiles(issues);

  // Step 3 additions (2.13.0): schema and anchor enforcement.
  checkDecisionsSchema(planDir, issues);
  checkVerificationVerdict(planDir, issues);
  checkFindingsIndexLinks(planDir, issues);
  checkReverseAnchors(planDir, planDirName, issues, cwd);
  checkVerificationEvidence(planDir, issues);
  checkFindingsTopicSections(planDir, issues);
  checkExplorationConfidence(planDir, issues);
  // v2.14.0 — plan-qualified anchors, plan-id preamble, gated Anchor-Refs.
  checkPlanIdPreamble(planDir, planDirName, issues);
  checkAnchorRefsRequired(planDir, planDirName, issues, cwd);
  checkAnchorRefsValidity(planDir, planDirName, issues, cwd);
  // v2.15.0 — per-edit changelog (informational; never blocks CLOSE).
  checkChangelogFormat(planDir, issues);

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
  - Change manifest presence during EXECUTE/REFLECT
  - Iteration limits (5 = decomposition, 6+ = hard stop)
  - Progress.md structure (Completed/In Progress/Remaining)
  - Checkpoint existence for iteration 2+
  - Complexity Budget population during EXECUTE+
  - Consolidated files existence
  - decisions.md entry header format (## D-NNN | PHASE | YYYY-MM-DD)
  - decisions.md D-NNN sequential numbering (no gaps, starts at D-001)
  - decisions.md **Trade-off**: line in every entry
  - decisions.md **Complexity Assessment** block in PIVOT entries
  - verification.md Verdict 5 required bullets (in order)
  - findings.md Index links resolve to existing files
  - Reverse anchor scan (orphan # DECISION <plan-id>/D-NNN in source)
  - Bare D-NNN anchor → WARN [anchor-unqualified] (v2.14.0 migration nudge)
  - Qualified anchor with unknown plan → ERROR [anchor-unknown-plan]
  - Evidence column quality (WARN on weak/empty/single-word)
  - findings/{topic}.md required sections (WARN)
  - state.md Exploration Confidence on EXPLORE → PLAN (WARN)
  - decisions.md / summary.md plan-id preamble (ERROR post-v2.14.0, WARN otherwise)
  - decisions.md Anchor-Refs required when matching anchor exists in source
    (ERROR post-v2.14.0, WARN otherwise; gated by state.md INIT timestamp)
  - decisions.md Anchor-Refs validity (WARN if file missing or anchor not found)

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
