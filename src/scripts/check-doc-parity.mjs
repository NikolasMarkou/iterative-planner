#!/usr/bin/env node
// Requires Node.js 18+
//
// check-doc-parity — executable gate enforcing README.md <-> src/SKILL.md
// "File Ownership" table parity. The two tables drifted (README was missing 6
// rows present in SKILL.md) with no automated check. This script parses the
// File Ownership table out of each doc and asserts (1) every path-key present
// in SKILL.md also appears in README.md and vice versa, and (2) for every key
// present in BOTH docs, the column-2 owner-cell text matches exactly after
// whitespace normalization ONLY (trim + collapse internal whitespace runs —
// no other normalization, no fuzzy matching). The readers column (col 3) is
// deliberately out of scope (see plan-2026-07-21-38d0cd87 decisions.md D-001).
// Anti-vacuity: either side parsing fewer than EXPECTED_MIN_KEYS keys is a
// loud `FAIL [doc-parity-floor]`, never a vacuous PASS.
//
// Scope: the File Ownership table ONLY. Pure `comparison()` is reused by the
// CLI wrapper and the test suite; the CLI runs only under the isEntryPoint
// guard so importing this module is side-effect-free.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The floor (anti-vacuity), mirroring EXPECTED_SLUGS in
// check-template-parity.mjs. A renamed "File Ownership" heading, a
// BOM-prefixed heading line, or a <details> wrapper without a real heading
// all make the parser find NO table — zero keys on both sides used to compare
// nothing and print PASS. A side parsing fewer keys than this floor is a loud
// `FAIL [doc-parity-floor]` naming the side and count. Real count today: 16
// keys per side. Bump deliberately when the real count changes. Enforced in
// the CLI (isEntryPoint) only — importers and the pure comparison() are
// unchanged.
export const EXPECTED_MIN_KEYS = 10;

/**
 * Normalize a table-cell's text for comparison: trim + collapse internal
 * whitespace runs to a single space. This is the ONLY normalization applied —
 * exact match otherwise (no case folding, no punctuation/markdown stripping,
 * no fuzzy matching).
 */
function normalizeCell(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

/**
 * Parse the File Ownership table out of a markdown doc and return
 * `{ keys, owners }`:
 *   - `keys`: Set of column-1 path-keys (backtick-wrapped tokens).
 *   - `owners`: Map<key, ownerCellText> — column-2 owner-cell text,
 *     whitespace-normalized (see normalizeCell). Merged-cell rows: each
 *     backtick token in the cell inherits the row's owner cell.
 * Handles:
 *   - merged cells: README joins `plans/LESSONS.md, plans/SYSTEM.md` in one cell
 *     -> every backtick token in the cell is added.
 *   - plain-text suffixes: `findings.md` (index) -> only the backtick token is
 *     taken; the "(index)" text is ignored.
 * Table boundary: starts after the heading line containing "File Ownership"
 * (case-insensitive), stops at the next `## `/`### ` section or end of file.
 */
export function parseOwnershipTable(markdownText) {
  const keys = new Set();
  const owners = new Map();
  const lines = (markdownText || "").split("\n");
  let inTable = false;
  for (const line of lines) {
    if (!inTable) {
      if (/file ownership/i.test(line) && /^#{1,6}\s/.test(line)) {
        inTable = true;
      }
      continue;
    }
    // Stop at the next section heading.
    if (/^#{2,3}\s/.test(line)) break;
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    // First column cell = text between the first and second pipe.
    const cells = trimmed.split("|");
    const firstCell = cells.length > 1 ? cells[1] : "";
    // Skip header row (| File | ...) and separator row (|---|, |:---|).
    const cellNorm = firstCell.trim().toLowerCase();
    if (cellNorm === "file") continue;
    if (/^:?-{3,}:?$/.test(firstCell.trim())) continue;
    // Second column cell = owner cell (whole row's owner for merged cells).
    const ownerCell = normalizeCell(cells.length > 2 ? cells[2] : "");
    // Extract ALL backtick-wrapped tokens (a cell may hold more than one).
    const re = /`([^`]+)`/g;
    let m;
    while ((m = re.exec(firstCell)) !== null) {
      const tok = m[1].trim();
      if (tok) {
        keys.add(tok);
        if (!owners.has(tok)) owners.set(tok, ownerCell);
      }
    }
  }
  return { keys, owners };
}

/**
 * Back-compat wrapper: return only the set of column-1 path-keys.
 * Delegates to parseOwnershipTable so existing importers are untouched.
 */
export function parseOwnershipKeys(markdownText) {
  return parseOwnershipTable(markdownText).keys;
}

/**
 * Pure comparison: returns path-keys present in SKILL but absent from README
 * (`missing`), path-keys present in README but absent from SKILL (`extra`),
 * and — for keys present in BOTH — owner cells whose whitespace-normalized
 * text differs (`ownerMismatches`: [{ key, skill, readme }]).
 */
export function comparison(skillText, readmeText) {
  const skill = parseOwnershipTable(skillText);
  const readme = parseOwnershipTable(readmeText);
  const missing = [...skill.keys].filter((k) => !readme.keys.has(k));
  const extra = [...readme.keys].filter((k) => !skill.keys.has(k));
  const ownerMismatches = [];
  for (const k of skill.keys) {
    if (!readme.keys.has(k)) continue;
    const s = skill.owners.get(k) ?? "";
    const r = readme.owners.get(k) ?? "";
    if (s !== r) ownerMismatches.push({ key: k, skill: s, readme: r });
  }
  return { missing, extra, ownerMismatches };
}

const isEntryPoint = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  // DECISION plan-2026-07-21T092933-3295714d/D-003: repoRoot override is an
  // opt-in env var read HERE only (inside isEntryPoint) so tests can spawn the
  // REAL CLI FAIL branches against fixture roots. Do NOT hoist this read to
  // module scope, add an argv flag, or reintroduce a wrapper reimplementation:
  // importers and the default (env-unset) CLI must stay byte-identical. See
  // decisions.md D-003.
  const repoRoot =
    process.env.IP_CHECK_DOC_PARITY_ROOT ??
    join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const skillText = readFileSync(join(repoRoot, "src", "SKILL.md"), "utf8");
  const readmeText = readFileSync(join(repoRoot, "README.md"), "utf8");
  const { missing, extra, ownerMismatches } = comparison(skillText, readmeText);
  // Anti-vacuity floor: parse each side independently so the failure names
  // WHICH doc's table went missing (parity alone cannot — two sides both
  // parsing 0 keys agree perfectly and used to PASS).
  const floorFailures = [];
  for (const [side, text] of [["SKILL.md", skillText], ["README.md", readmeText]]) {
    const n = parseOwnershipTable(text).keys.size;
    if (n < EXPECTED_MIN_KEYS) floorFailures.push({ side, n });
  }
  if (
    missing.length === 0 && extra.length === 0 &&
    ownerMismatches.length === 0 && floorFailures.length === 0
  ) {
    const n = parseOwnershipKeys(skillText).size;
    console.log(
      `check-doc-parity: PASS (README File Ownership table mirrors SKILL.md — ${n} keys, owner cells match)`,
    );
    process.exit(0);
  }
  if (missing.length > 0) {
    console.error(
      `check-doc-parity: FAIL — README File Ownership table is missing ${missing.length} row(s) present in SKILL.md:`,
    );
    for (const k of missing) console.error(k);
  }
  if (extra.length > 0) {
    console.error(
      `check-doc-parity: FAIL — README File Ownership table has ${extra.length} row(s) not present in SKILL.md:`,
    );
    for (const k of extra) console.error(k);
  }
  if (ownerMismatches.length > 0) {
    console.error(
      `check-doc-parity: FAIL [doc-parity-owner] — owner cell differs for ${ownerMismatches.length} key(s) (exact match after whitespace normalization):`,
    );
    for (const { key, skill, readme } of ownerMismatches) {
      console.error(`\`${key}\``);
      console.error(`  SKILL.md:  ${skill}`);
      console.error(`  README.md: ${readme}`);
    }
  }
  if (floorFailures.length > 0) {
    for (const { side, n } of floorFailures) {
      console.error(
        `check-doc-parity: FAIL [doc-parity-floor] — ${side} side parsed ${n} key(s), below EXPECTED_MIN_KEYS = ${EXPECTED_MIN_KEYS} (File Ownership heading renamed/missing, BOM-prefixed, or table not found?)`,
      );
    }
  }
  process.exit(1);
}
