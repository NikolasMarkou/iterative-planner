#!/usr/bin/env node
// Requires Node.js 18+
//
// check-register — executable gate that ratchets JARGON down (never up) across
// the register-carrying shipped docs (CLAUDE.md, README.md, src/SKILL.md,
// src/agents/*.md, src/references/*.md). It measures a purely LEXICAL marker
// count — bracket-tags `[kebab-tag]`, coded refs
// (`PC-*` / `D-\d\d` / `[A-Z]-\d{3}` / `[UFWNS]\d`), and 3+-segment compounds —
// plus that count as a density per 1000 words, and compares both against the
// committed per-file entry in `register-baseline.json`. This keeps the gate a
// count-invariant ratchet, never a FUZZY per-line content-judgment blocker.
//
// THE RULE, in one line: a file fails only when BOTH its density AND its raw
// marker count rise above the committed pair.
//
// DECISION plan-2026-09-01T100120-4f591469/D-027: the conjunction is the whole
// point — do NOT simplify this back to a density-only comparison. Density is
// markers per 1000 WORDS, so DELETING plain prose raises it without adding any
// jargon at all: the density-only form failed a doc for having 12 ordinary
// sentences removed, which is exactly the simplification SKILL.md § Register
// Discipline tells agents to prefer. Requiring the raw count to rise too makes
// a pure deletion structurally incapable of failing, because you cannot raise a
// count by removing text. See decisions.md D-027.
//
// DECISION plan-2026-09-01T100120-4f591469/D-021: entries are EXACT measured
// values, not allowances. Do NOT restore per-file headroom "so ordinary edits
// don't turn the build red" — headroom is precisely what made this a loose
// ceiling instead of a ratchet for 24 releases. The first baseline (v2.36.0)
// added a uniform allowance to each measurement, leaving 17%-100% slack on
// every file. Re-measured at HEAD in v2.61.0; all 19 ceilings fell. Adding one
// marker to a doc turns the build red, and that is the intent — the reply is to
// write the sentence plainly, or, when the marker is genuinely earned, to raise
// that ONE entry by name (`--regenerate --raise <file>`) in the same commit,
// where a reviewer can see it. The pin test
// in check-register.test.mjs asserts every committed entry EQUALS its file's
// live measurement, so the baseline can never silently sit above reality.
// See decisions.md D-021.
//
// Baseline shape — one object per scanned doc:
//   { "CLAUDE.md": { "ceiling": 9.06, "markers": 118 }, ... }
// `ceiling` is the density at the commit that wrote the entry; `markers` is the
// raw marker count at that same commit. A bare number (the pre-v2.62 shape) is
// a floor FAIL, not a silently-accepted half-entry.
//
// Regenerating: `node <repo>/src/scripts/check-register.mjs --regenerate`
// rewrites the baseline from the live docs. It lowers or holds any ceiling
// freely and REFUSES to raise one unless that file is named:
// `--regenerate --raise CLAUDE.md` (repeatable). That refusal is the point —
// a raise is a deliberate, review-visible edit, like bumping TEST_COUNT, not
// something a whole-baseline rewrite does on your behalf. Every other
// invocation form only reads.
//
// Three non-fuzzy FAIL conditions only:
//   [register-drift] — a file whose density > ceiling AND markers > committed
//                      markers.
//   [register-floor] — anti-vacuity: a baseline-listed file missing/unreadable,
//                      a scanned doc below MIN_WORDS, a scanned doc with no
//                      committed entry, a malformed entry, or fewer docs
//                      scanned than EXPECTED_MIN_FILES.
//   [register-raise] — a `--regenerate` that would raise a ceiling the caller
//                      did not name with `--raise`.
//
// Pure functions (jargonMarkers / wordCount / density / compareToBaseline) and
// the I/O helpers (buildScanList / measureAll) are exported ABOVE the
// isEntryPoint guard so importing this module is side-effect-free; the CLI runs
// only under the guard.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Anti-vacuity floor: the real scanned-doc count today (3 fixed docs +
// src/agents/*.md + src/references/*.md). A broken glob or a deleted docs dir
// that makes the scanner resolve FEWER docs than this must FAIL loud
// ([register-floor]), never vacuously PASS on an empty scan. Bump deliberately
// when the real doc count changes; the `pin:` test in check-register.test.mjs
// asserts this constant EQUALS the live scanned count (and that the baseline
// has exactly that many keys), so a drifted constant fails rather than passing
// on slack.
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
 * The exact list of relpaths the gate scans: 3 fixed root docs + every .md
 * under src/agents and src/references, forward-slashed (baseline keys are
 * forward-slashed, so keys match on every platform) and sorted for
 * deterministic output. Exported so the CLI, the regenerator, and the `pin:`
 * test all ask ONE function what the scan set is — a replicated scan list is a
 * second definition that can drift from the gate it claims to pin.
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function buildScanList(repoRoot) {
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
  return [
    "CLAUDE.md",
    "README.md",
    "src/SKILL.md",
    ...listMd(join(repoRoot, "src", "agents"), "src/agents"),
    ...listMd(join(repoRoot, "src", "references"), "src/references"),
  ].sort();
}

/**
 * Read and measure every doc in `scanList` (default: buildScanList(repoRoot)).
 * Unreadable/missing files are simply left out of the result; the floor catches
 * them when they are baseline keys.
 * @param {string} repoRoot
 * @param {string[]} [scanList]
 * @returns {{[relpath: string]: { words: number, density: number, markers: number }}}
 */
export function measureAll(repoRoot, scanList = buildScanList(repoRoot)) {
  const measurements = {};
  for (const rel of scanList) {
    try {
      const text = readFileSync(join(repoRoot, rel), "utf8");
      measurements[rel] = {
        words: wordCount(text),
        density: density(text),
        markers: jargonMarkers(text).total,
      };
    } catch {
      // Left out on purpose — see doc comment.
    }
  }
  return measurements;
}

/**
 * Serialize measurements to the committed baseline shape (sorted keys, 2-space
 * indent, trailing newline) — the exact bytes `--regenerate` writes.
 * @param {{[relpath: string]: { density: number, markers: number }}} measurements
 * @returns {string}
 */
export function serializeBaseline(measurements) {
  const out = {};
  for (const rel of Object.keys(measurements).sort()) {
    out[rel] = {
      ceiling: measurements[rel].density,
      markers: measurements[rel].markers,
    };
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

/**
 * Coerce one committed baseline value to `{ ceiling, markers }`, or null when
 * it is not a well-formed entry (including the pre-v2.62 bare number).
 * @param {unknown} value
 * @returns {{ ceiling: number, markers: number } | null}
 */
export function normalizeBaselineEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { ceiling, markers } = value;
  if (typeof ceiling !== "number" || !Number.isFinite(ceiling)) return null;
  if (typeof markers !== "number" || !Number.isInteger(markers)) return null;
  return { ceiling, markers };
}

/**
 * Which files' ceilings would RISE if `measurements` were written over
 * `baseline`. Does NO I/O. This is the input to `--regenerate`'s raise guard.
 *
 * Interface contract: returns one record per rising file, sorted by relpath —
 * `{ file, from, to, fromMarkers, toMarkers }`, where `from`/`to` are the
 * committed and live DENSITIES. A file with no well-formed committed entry is
 * NOT a rise (there is no ceiling to raise: a brand-new doc, or a regenerate
 * from an empty baseline, must not need a flag). A ceiling that falls or holds
 * is never reported, whatever the marker count does — deletion immunity is the
 * hard invariant here (D-027), so this function is deliberately one-sided.
 * Never throws; a missing/odd `baseline` yields `[]`.
 *
 * @param {{[relpath: string]: { density: number, markers: number }}} measurements
 * @param {{[relpath: string]: unknown}} baseline
 * @returns {{file: string, from: number, to: number, fromMarkers: number, toMarkers: number}[]}
 */
export function ceilingRises(measurements, baseline) {
  const rises = [];
  for (const [file, m] of Object.entries(measurements || {})) {
    const entry = normalizeBaselineEntry(baseline?.[file]);
    if (!entry) continue;
    if (m.density > entry.ceiling) {
      rises.push({
        file,
        from: entry.ceiling,
        to: m.density,
        fromMarkers: entry.markers,
        toMarkers: m.markers,
      });
    }
  }
  return rises.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/**
 * Normalize a `--raise` argument to a baseline key: forward slashes, no
 * leading `./`. Baseline keys are forward-slashed, so `--raise src\agents\x.md`
 * on Windows still matches.
 * @param {string} value
 * @returns {string}
 */
export function normalizeRaiseArg(value) {
  return String(value).replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Pure comparison of already-read per-file measurements against the committed
 * baseline entries. Does NO I/O.
 * @param {{[relpath: string]: { words: number, density: number, markers: number }}} measurements
 * @param {{[relpath: string]: { ceiling: number, markers: number }}} baseline
 * @returns {{ drift: {file: string, density: number, ceiling: number,
 *                     markers: number, baseMarkers: number}[],
 *             floor: {file: string|null, reason: string}[] }}
 *   drift — a scanned file whose density exceeds its ceiling AND whose raw
 *           marker count exceeds its committed count. Both, never one: a pure
 *           text deletion raises density while the count holds, and that is
 *           simplification, not drift (D-027).
 *   floor — anti-vacuity failures: a baseline key with no measurement
 *           ("missing"); a scanned file below MIN_WORDS ("near-empty: W words");
 *           a scanned file with no committed entry; a malformed entry; fewer
 *           resolved files than EXPECTED_MIN_FILES.
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
        reason: "no committed entry — add to register-baseline.json",
      });
      continue; // nothing to compare drift against
    }
    const entry = normalizeBaselineEntry(baseline[file]);
    if (!entry) {
      floor.push({
        file,
        reason:
          'malformed entry — expected {"ceiling": <density>, "markers": <count>}',
      });
      continue;
    }
    if (m.density > entry.ceiling && m.markers > entry.markers) {
      drift.push({
        file,
        density: m.density,
        ceiling: entry.ceiling,
        markers: m.markers,
        baseMarkers: entry.markers,
      });
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

  const measurements = measureAll(repoRoot);
  const baselinePath = join(repoRoot, "src/scripts/register-baseline.json");

  // DECISION plan-2026-09-01T100120-4f591469/D-028: --regenerate exists so the
  // "the baseline IS the live measurement" claim is reproducible by anyone, and
  // it REFUSES to write from a scan below EXPECTED_MIN_FILES — do NOT drop that
  // guard for convenience, or a gutted scan could be laundered into a fresh
  // baseline that then passes the floor it just failed. The equality itself is
  // asserted by the second `pin:` test in check-register.test.mjs, not by this
  // gate: without it a ceiling set ABOVE live density passed every check.
  // See decisions.md D-028.
  // DECISION plan-2026-09-01T100120-4f591469/D-035: --regenerate LOWERS or
  // HOLDS a ceiling freely and REFUSES to raise one that was not named with
  // --raise. Do NOT relax this to "warn and write anyway", and do not drop the
  // flag because it is inconvenient on a doc-heavy commit. The conjunction gate
  // above cannot see an equal swap — add three new tags, delete three old
  // marker-bearing lines and 40 plain lines, and the count holds while density
  // rises 11.27 -> 15.78, so the gate passes. The only thing that then turns
  // red is the pin test, and its one repair is a regenerate; an unguarded
  // regenerate is therefore the laundering path itself, whatever the drift rule
  // says. Guarding the ratchet's write instead of the metric is what makes a
  // raise greppable in the commit that earns it. Guarding a raise of the raw
  // MARKER count too was considered and left out on purpose: drift needs the
  // density above the ceiling, so the ceiling is the binding number, and a
  // marker rise under a falling density is the dilution case D-027 already
  // disclosed as accepted. See decisions.md D-035.
  const argv = process.argv.slice(2);
  const wantsRegenerate = argv.includes("--regenerate");
  const raiseNames = new Set();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--raise") continue;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      console.error(
        "check-register: FAIL [register-raise] — --raise needs a file path, e.g. --raise CLAUDE.md",
      );
      process.exit(1);
    }
    raiseNames.add(normalizeRaiseArg(value));
    i++;
  }
  if (raiseNames.size > 0 && !wantsRegenerate) {
    console.error(
      "check-register: FAIL [register-raise] — --raise only means something with --regenerate; the read-only gate never writes a ceiling",
    );
    process.exit(1);
  }

  if (wantsRegenerate) {
    const scanned = Object.keys(measurements).length;
    if (scanned < EXPECTED_MIN_FILES) {
      console.error(
        `check-register: FAIL [register-floor] — refusing to regenerate from only ${scanned} docs, expected >= ${EXPECTED_MIN_FILES}`,
      );
      process.exit(1);
    }
    // An unreadable/absent committed baseline has no ceilings to raise, so the
    // guard has nothing to say about it; the floor check above already refuses
    // a gutted scan.
    let committed = {};
    try {
      committed = JSON.parse(readFileSync(baselinePath, "utf8"));
    } catch {
      committed = {};
    }
    const rises = ceilingRises(measurements, committed);
    const unnamed = rises.filter((r) => !raiseNames.has(r.file));
    if (unnamed.length > 0) {
      console.error(
        `check-register: FAIL [register-raise] — refusing to raise ${unnamed.length} ceiling(s) you did not name:`,
      );
      for (const r of unnamed) {
        console.error(
          `  ${r.file}: ceiling ${r.from} -> ${r.to} (markers ${r.fromMarkers} -> ${r.toMarkers})`,
        );
      }
      console.error(
        "Lowering or holding a ceiling needs no flag. Raising one is a deliberate, review-visible act, the same discipline as bumping TEST_COUNT — say so on the command line and the baseline is left untouched until you do:",
      );
      console.error(
        `  node src/scripts/check-register.mjs --regenerate ${unnamed
          .map((r) => `--raise ${r.file}`)
          .join(" ")}`,
      );
      process.exit(1);
    }
    writeFileSync(baselinePath, serializeBaseline(measurements), "utf8");
    console.log(
      `check-register: regenerated register-baseline.json from ${scanned} docs — read the diff before committing it; that diff IS the review`,
    );
    for (const r of rises) {
      console.log(
        `check-register: RAISED ${r.file} ceiling ${r.from} -> ${r.to} (markers ${r.fromMarkers} -> ${r.toMarkers}) — named with --raise`,
      );
    }
    const unused = [...raiseNames].filter(
      (n) => !rises.some((r) => r.file === n),
    );
    if (unused.length > 0) {
      console.error(
        `check-register: note — --raise named ${unused.join(", ")}, whose ceiling does not rise; check the path`,
      );
    }
    process.exit(0);
  }

  // A missing/unparseable committed baseline is a FAIL, not a skip.
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
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
      `check-register: PASS (${scanned} docs at/below committed entries)`,
    );
    // Two things this PASS does NOT mean, said here because the gate used to
    // let an author find them out from a red build instead.
    console.log(
      "check-register: PASS is the gate only. Any edit that moves a file's word or marker count still needs `--regenerate` in the same commit, or the suite's pin test goes red.",
    );
    console.log(
      "check-register: and this gate cannot see an equal swap — new jargon in, the same number of marker-bearing lines out, so the count holds while density rises. That shape passes HERE, fails the pin test, and can only reach green through `--regenerate --raise <file>`.",
    );
    process.exit(0);
  }

  for (const d of drift) {
    console.error(
      `check-register: FAIL [register-drift] — ${d.file} density ${d.density}/1k exceeds ceiling ${d.ceiling}/1k AND marker count rose ${d.baseMarkers} -> ${d.markers} (both must rise, so deleting prose alone can never fail this; you added jargon). Write it plainly, or, if the jargon is earned, raise that one entry by name: node src/scripts/check-register.mjs --regenerate --raise ${d.file}`,
    );
  }
  for (const f of floor) {
    console.error(
      `check-register: FAIL [register-floor] — ${f.file ? `${f.file}: ` : ""}${f.reason}`,
    );
  }
  process.exit(1);
}
