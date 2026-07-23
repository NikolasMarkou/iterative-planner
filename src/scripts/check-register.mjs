#!/usr/bin/env node
// Requires Node.js 18+
//
// check-register — executable gate that ratchets JARGON DENSITY down (never up)
// across the register-carrying shipped docs (CLAUDE.md, README.md, src/SKILL.md,
// src/agents/*.md, src/references/*.md). It measures a purely LEXICAL marker
// density per 1000 words — bracket-tags `[kebab-tag]`, coded refs
// (`PC-*` / `D-\d\d` / `[A-Z]-\d{3}` / `[UFWNS]\d`), and 3+-segment compounds —
// and compares each file against a committed per-file ceiling in
// `register-baseline.json`. Density may FALL or HOLD freely; a RISE requires
// deliberately bumping the review-visible baseline artifact, exactly like
// bumping TEST_COUNT. This keeps the gate a count-invariant ratchet, never a
// FUZZY per-line content-judgment blocker.
//
// Two non-fuzzy numeric FAIL conditions only:
//   [register-drift] — a file's measured density > its committed ceiling.
//   [register-floor] — anti-vacuity: a baseline-listed file missing/unreadable,
//                      a scanned doc below MIN_WORDS, a scanned doc with no
//                      committed ceiling, or fewer docs scanned than
//                      EXPECTED_MIN_FILES.
//
// Pure functions (jargonMarkers / wordCount / density / compareToBaseline) are
// exported ABOVE the isEntryPoint guard so importing this module is
// side-effect-free; the CLI runs only under the guard.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Anti-vacuity floor: the real scanned-doc count today (3 fixed docs +
// src/agents/*.md + src/references/*.md). A broken glob or a deleted docs dir
// that makes the scanner resolve FEWER docs than this must FAIL loud
// ([register-floor]), never vacuously PASS on an empty scan. Bump deliberately
// when the real doc count changes.
export const EXPECTED_MIN_FILES = 19;

// A scanned doc below this word count has been gutted/truncated — a floor fail,
// not a silently-passing near-empty file.
export const MIN_WORDS = 30;

/** Round to 2 decimals. */
function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Count the three lexical jargon-marker classes in `text`.
 * @param {string} text
 * @returns {{ bracket: number, coded: number, compound: number, total: number }}
 */
export function jargonMarkers(text) {
  const t = text || "";
  const bracketRe = /\[[a-z][a-z0-9]*(?:-[a-z0-9]+)+\]/g;
  const bracket = (t.match(bracketRe) || []).length;
  const coded = (t.match(/\b(?:PC-[A-Z]+|D-\d{2,3}|[A-Z]-\d{3}|[UFWNS]\d)\b/g) || [])
    .length;
  // DECISION plan-2026-07-23T191907-b8d237ed/D-001: strip bracket-tag spans BEFORE the
  // compound regex — do NOT range-dedupe overlapping matches or add a shared
  // dedupe helper. A 3+-segment bracket tag's inner slug (e.g. [doc-parity-floor])
  // would otherwise be double-counted by both bracket AND compound. bracket↔compound
  // is the ONLY overlap (coded is uppercase, disjoint), so a single-pair range-dedupe
  // abstraction is unearned. Replace with a SPACE (not "") to keep token boundaries so
  // adjacent tokens don't fuse into a false compound. Keeps the gate count-invariant /
  // non-fuzzy (D-001, LESSONS [I:5]). See decisions.md D-001.
  const noBrackets = t.replace(bracketRe, " ");
  const compound = (noBrackets.match(/\b[a-z]+-[a-z]+-[a-z]+(?:-[a-z]+)*\b/g) || [])
    .length;
  return { bracket, coded, compound, total: bracket + coded + compound };
}

/** Whitespace-delimited word count. */
export function wordCount(text) {
  return ((text || "").match(/\S+/g) || []).length;
}

/**
 * Raw (unrounded) jargon-marker density per 1000 words. Kept available for
 * callers that want full precision (e.g. baseline generation headroom math).
 * @param {string} text
 * @returns {number}
 */
export function rawDensity(text) {
  const words = wordCount(text);
  return words ? (jargonMarkers(text).total / words) * 1000 : 0;
}

/**
 * Jargon-marker density per 1000 words, rounded to 2 decimals.
 * @param {string} text
 * @returns {number}
 */
export function density(text) {
  return round2(rawDensity(text));
}

/**
 * Pure comparison of already-read per-file measurements against the committed
 * baseline ceilings. Does NO I/O.
 * @param {{[relpath: string]: { words: number, density: number }}} measurements
 * @param {{[relpath: string]: number}} baseline  per-file density ceiling
 * @returns {{ drift: {file: string, density: number, ceiling: number}[],
 *             floor: {file: string|null, reason: string}[] }}
 *   drift — a scanned file whose measured density exceeds its ceiling.
 *   floor — anti-vacuity failures: a baseline key with no measurement
 *           ("missing"); a scanned file below MIN_WORDS ("near-empty: W words");
 *           a scanned file with no committed ceiling ("no committed ceiling —
 *           add to register-baseline.json"); fewer resolved files than
 *           EXPECTED_MIN_FILES ("only K docs scanned, expected >= ...").
 */
export function compareToBaseline(measurements, baseline) {
  const drift = [];
  const floor = [];
  // A baseline-listed file that produced no measurement is missing/unreadable.
  for (const key of Object.keys(baseline)) {
    if (!(key in measurements)) {
      floor.push({ file: key, reason: "missing" });
    }
  }
  for (const [file, m] of Object.entries(measurements)) {
    if (m.words < MIN_WORDS) {
      floor.push({ file, reason: `near-empty: ${m.words} words` });
    }
    if (!(file in baseline)) {
      floor.push({
        file,
        reason: "no committed ceiling — add to register-baseline.json",
      });
      continue; // no ceiling to compare drift against
    }
    if (m.density > baseline[file]) {
      drift.push({ file, density: m.density, ceiling: baseline[file] });
    }
  }
  const scanned = Object.keys(measurements).length;
  if (scanned < EXPECTED_MIN_FILES) {
    floor.push({
      file: null,
      reason: `only ${scanned} docs scanned, expected >= ${EXPECTED_MIN_FILES}`,
    });
  }
  return { drift, floor };
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
    process.env.IP_CHECK_REGISTER_ROOT ??
    join(dirname(fileURLToPath(import.meta.url)), "..", "..");

  // Build the scan list: 3 fixed docs + every .md in src/agents + src/references.
  // Relpaths use forward slashes (baseline keys are forward-slashed) so keys
  // match on every platform. Sort for deterministic output.
  const listMd = (absDir, prefix) => {
    try {
      return readdirSync(absDir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => `${prefix}/${f}`);
    } catch {
      // Missing docs dir → contributes no files → the anti-vacuity floor fires.
      return [];
    }
  };
  const scanList = [
    "CLAUDE.md",
    "README.md",
    "src/SKILL.md",
    ...listMd(join(repoRoot, "src", "agents"), "src/agents"),
    ...listMd(join(repoRoot, "src", "references"), "src/references"),
  ].sort();

  const measurements = {};
  for (const rel of scanList) {
    try {
      const text = readFileSync(join(repoRoot, rel), "utf8");
      measurements[rel] = { words: wordCount(text), density: density(text) };
    } catch {
      // Unreadable/missing scanned file → left out; the floor catches it if it
      // is a baseline key.
    }
  }

  // A missing/unparseable committed baseline is a FAIL, not a skip.
  let baseline;
  try {
    baseline = JSON.parse(
      readFileSync(join(repoRoot, "src/scripts/register-baseline.json"), "utf8"),
    );
  } catch (err) {
    console.error(
      `check-register: FAIL [register-floor] — register-baseline.json unreadable/unparseable (${err.code ?? err.message}); a missing committed baseline is a FAIL, not a skip`,
    );
    process.exit(1);
  }

  const { drift, floor } = compareToBaseline(measurements, baseline);

  if (drift.length === 0 && floor.length === 0) {
    const scanned = Object.keys(measurements).length;
    const peak = Object.entries(measurements).sort(
      (a, b) => b[1].density - a[1].density,
    )[0];
    if (peak) {
      console.log(
        `check-register: peak density ${peak[1].density}/1k (${peak[0]})`,
      );
    }
    console.log(
      `check-register: PASS (${scanned} docs at/below committed ceilings)`,
    );
    process.exit(0);
  }

  for (const d of drift) {
    console.error(
      `check-register: FAIL [register-drift] — ${d.file} density ${d.density}/1k exceeds ceiling ${d.ceiling}/1k (density may fall/hold freely; a rise requires deliberately bumping register-baseline.json — the review-visible override)`,
    );
  }
  for (const f of floor) {
    console.error(
      `check-register: FAIL [register-floor] — ${f.file ? `${f.file}: ` : ""}${f.reason}`,
    );
  }
  process.exit(1);
}
