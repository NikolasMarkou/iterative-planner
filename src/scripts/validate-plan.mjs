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
function parseDecisionsEntries(content) {
  if (!content) return { entries: [], badHeaders: [] };
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
  return { entries, badHeaders };
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
// Hash, slash, block, and SQL double-dash. We capture the D-NNN id and
// optional [STALE] marker.
const ANCHOR_PATTERNS = [
  /(^|\s)#\s+DECISION\s+D-(\d{3})(\s+\[STALE\])?(?::|\s|$)/,
  /(^|\s)\/\/\s+DECISION\s+D-(\d{3})(\s+\[STALE\])?(?::|\s|$)/,
  /\/\*\s*DECISION\s+D-(\d{3})(\s+\[STALE\])?[\s\S]*?\*\//,
  /(^|\s)--\s+DECISION\s+D-(\d{3})(\s+\[STALE\])?(?::|\s|$)/,
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
// { file, line, id, stale }.
function findAnchorsInFile(file, projectRoot) {
  let text;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  const ext = extname(file);
  const out = [];

  // Per-line scan for hash, slash, double-dash markers.
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    // Hash style.
    if ([".py", ".rb", ".sh", ".bash", ".zsh", ".yml", ".yaml", ".toml", ".r", ".pl", ".pm", ".tf"].includes(ext)) {
      m = /(?:^|\s)#\s+DECISION\s+D-(\d{3})(\s+\[STALE\])?(?::|\s|$)/.exec(line);
      if (m) out.push({ file, line: i + 1, id: parseInt(m[1], 10), stale: !!m[2] });
    }
    // Slash style.
    if ([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".go", ".rs", ".c", ".h", ".cpp", ".hpp", ".cc", ".java", ".swift", ".kt", ".scala", ".cs", ".php"].includes(ext)) {
      m = /(?:^|\s)\/\/\s+DECISION\s+D-(\d{3})(\s+\[STALE\])?(?::|\s|$)/.exec(line);
      if (m) out.push({ file, line: i + 1, id: parseInt(m[1], 10), stale: !!m[2] });
    }
    // SQL double-dash.
    if (ext === ".sql") {
      m = /(?:^|\s)--\s+DECISION\s+D-(\d{3})(\s+\[STALE\])?(?::|\s|$)/.exec(line);
      if (m) out.push({ file, line: i + 1, id: parseInt(m[1], 10), stale: !!m[2] });
    }
  }

  // Block comment scan (multi-line) — applies to /* */ in C-family + CSS.
  // We extract each block and search inside.
  const blockRe = /\/\*([\s\S]*?)\*\//g;
  let bm;
  while ((bm = blockRe.exec(text)) !== null) {
    const body = bm[1];
    const dm = /DECISION\s+D-(\d{3})(\s+\[STALE\])?/.exec(body);
    if (dm) {
      // Compute 1-based line number of the block opener.
      const lineNum = text.slice(0, bm.index).split("\n").length;
      out.push({ file, line: lineNum, id: parseInt(dm[1], 10), stale: !!dm[2] });
    }
  }

  return out;
}

function collectKnownDecisionIds(planDir) {
  // Active plan decisions.md (per-plan IDs) + plans/DECISIONS.md
  // (cross-plan archive — IDs are scoped per plan section, but we accept any
  // D-NNN that appears as a "### D-NNN" or "## D-NNN" heading there).
  const ids = new Set();
  const planDecisions = readFile(join(planDir, "decisions.md"));
  if (planDecisions) {
    const { entries } = parseDecisionsEntries(planDecisions);
    for (const e of entries) ids.add(e.id);
  }
  const consolidated = readFile(join(plansDir, "DECISIONS.md"));
  if (consolidated) {
    const headerRe = /^#{2,3} D-(\d{3})\b/gm;
    let m;
    while ((m = headerRe.exec(consolidated)) !== null) {
      ids.add(parseInt(m[1], 10));
    }
  }
  return ids;
}

function checkReverseAnchors(planDir, issues, projectRoot) {
  const knownIds = collectKnownDecisionIds(planDir);
  let files;
  try {
    files = walkSourceFiles(projectRoot);
  } catch {
    return;
  }

  for (const file of files) {
    const anchors = findAnchorsInFile(file, projectRoot);
    for (const a of anchors) {
      if (!knownIds.has(a.id)) {
        const rel = relative(projectRoot, a.file);
        const idStr = `D-${String(a.id).padStart(3, "0")}`;
        // STALE orphans → WARN (per decision-anchoring.md spec); plain → ERROR.
        const severity = a.stale ? "WARN" : "ERROR";
        issues.push({
          severity,
          check: "reverse-anchor",
          message: `${rel}:${a.line} orphan anchor ${idStr}${a.stale ? " [STALE]" : ""} (no matching entry in decisions.md or plans/DECISIONS.md)`,
        });
      }
    }
  }
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

// 3.2d — decisions.md entries missing Anchor-Refs when corresponding code has
// a matching anchor.
function checkAnchorRefsCrossLink(planDir, issues, projectRoot) {
  const content = readFile(join(planDir, "decisions.md"));
  if (!content) return;
  const { entries } = parseDecisionsEntries(content);
  if (entries.length === 0) return;

  // Build set of D-NNN ids that have anchors in source.
  const anchoredIds = new Set();
  let files;
  try {
    files = walkSourceFiles(projectRoot);
  } catch {
    return;
  }
  for (const f of files) {
    const anchors = findAnchorsInFile(f, projectRoot);
    for (const a of anchors) anchoredIds.add(a.id);
  }

  const anchorRefsRe = /\*\*Anchor-Refs\*\*:/m;
  for (const e of entries) {
    if (!anchoredIds.has(e.id)) continue;
    if (!anchorRefsRe.test(e.body)) {
      issues.push({
        severity: "WARN",
        check: "anchor-refs",
        message: `decisions.md ${e.idStr} has matching code anchor but no **Anchor-Refs**: line`,
      });
    }
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
  checkReverseAnchors(planDir, issues, cwd);
  checkVerificationEvidence(planDir, issues);
  checkFindingsTopicSections(planDir, issues);
  checkExplorationConfidence(planDir, issues);
  checkAnchorRefsCrossLink(planDir, issues, cwd);

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
  - Reverse anchor scan (orphan # DECISION D-NNN in source)
  - Evidence column quality (WARN on weak/empty/single-word)
  - findings/{topic}.md required sections (WARN)
  - state.md Exploration Confidence on EXPLORE → PLAN (WARN)
  - decisions.md Anchor-Refs cross-link (WARN)

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
