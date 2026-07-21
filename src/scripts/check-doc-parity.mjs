#!/usr/bin/env node
// Requires Node.js 18+
//
// check-doc-parity — executable gate enforcing README.md <-> src/SKILL.md
// "File Ownership" table parity. The two tables drifted (README was missing 6
// rows present in SKILL.md) with no automated check. This script parses the
// File Ownership table out of each doc and asserts every path-key present in
// SKILL.md also appears in README.md.
//
// Scope: the File Ownership table ONLY. Pure `comparison()` is reused by the
// CLI wrapper and the test suite; the CLI runs only under the isEntryPoint
// guard so importing this module is side-effect-free.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Parse the File Ownership table out of a markdown doc and return the set of
 * column-1 path-keys (backtick-wrapped tokens). Handles:
 *   - merged cells: README joins `plans/LESSONS.md, plans/SYSTEM.md` in one cell
 *     -> every backtick token in the cell is added.
 *   - plain-text suffixes: `findings.md` (index) -> only the backtick token is
 *     taken; the "(index)" text is ignored.
 * Table boundary: starts after the heading line containing "File Ownership"
 * (case-insensitive), stops at the next `## `/`### ` section or end of file.
 */
export function parseOwnershipKeys(markdownText) {
  const keys = new Set();
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
    // Extract ALL backtick-wrapped tokens (a cell may hold more than one).
    const re = /`([^`]+)`/g;
    let m;
    while ((m = re.exec(firstCell)) !== null) {
      const tok = m[1].trim();
      if (tok) keys.add(tok);
    }
  }
  return keys;
}

/**
 * Pure comparison: returns path-keys present in SKILL but absent from README
 * (`missing`) and path-keys present in README but absent from SKILL (`extra`).
 */
export function comparison(skillText, readmeText) {
  const skillKeys = parseOwnershipKeys(skillText);
  const readmeKeys = parseOwnershipKeys(readmeText);
  const missing = [...skillKeys].filter((k) => !readmeKeys.has(k));
  const extra = [...readmeKeys].filter((k) => !skillKeys.has(k));
  return { missing, extra };
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
  const { missing, extra } = comparison(skillText, readmeText);
  if (missing.length === 0 && extra.length === 0) {
    const n = parseOwnershipKeys(skillText).size;
    console.log(
      `check-doc-parity: PASS (README File Ownership table mirrors SKILL.md — ${n} keys)`,
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
  process.exit(1);
}
