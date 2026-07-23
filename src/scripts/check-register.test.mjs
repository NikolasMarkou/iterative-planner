// Requires Node.js 18+
// Tests for check-register.mjs — jargon-density ratchet gate.
//
// Importing the pure functions from the .mjs is side-effect-free: the CLI body
// runs only under the isEntryPoint guard. These unit tests import
// jargonMarkers / wordCount / density / compareToBaseline directly and never
// spawn — proving module load has no side effects.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  jargonMarkers,
  wordCount,
  density,
  compareToBaseline,
  EXPECTED_MIN_FILES,
  MIN_WORDS,
} from "./check-register.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const script = join(here, "check-register.mjs");

// The exact fixed doc list the gate scans: 3 root docs + every .md in
// src/agents + src/references. Must match the real repo's scan set so no
// spurious [register-floor] "no committed ceiling" / "missing" fires.
const AGENTS = [
  "ip-archivist",
  "ip-executor",
  "ip-explorer",
  "ip-orchestrator",
  "ip-plan-writer",
  "ip-reviewer",
  "ip-verifier",
];
const REFS = [
  "blast-radius",
  "code-hygiene",
  "complexity-control",
  "convergence-metrics",
  "decision-anchoring",
  "file-formats",
  "planning-rigor",
  "python-software",
  "root-cause-analysis",
];
const RELPATHS = [
  "CLAUDE.md",
  "README.md",
  "src/SKILL.md",
  ...AGENTS.map((a) => `src/agents/${a}.md`),
  ...REFS.map((r) => `src/references/${r}.md`),
];

// Plain, marker-free prose well above MIN_WORDS: density 0.
const FILLER =
  "This document holds ordinary readable prose written in plain words so the " +
  "scanner finds a healthy body of text with no special markers at all. It " +
  "keeps the tone calm and clear for every reader who opens the file today or " +
  "tomorrow, and it stays gentle and simple throughout the whole page.";

// 40 bracket-tags → 40 words, 40 markers → density 1000/1k, far above any
// sane ceiling (and >= MIN_WORDS so it drifts without tripping near-empty).
const HIGH_JARGON = Array.from({ length: 40 }, () => "[foo-bar]").join(" ");

// Default per-file ceiling: generous (real docs peak ~16.5) so marker-free
// filler passes freely and only a DELIBERATE high-jargon override drifts.
const DEFAULT_CEILING = 50;

/**
 * Build a temp fixture root with the complete valid 19-doc layout the gate
 * scans, plus a matching register-baseline.json. `overrides` lets one test
 * mutate the fixture before spawning:
 *   content:      { [relpath]: string }  override a doc's body
 *   omit:         [relpath, ...]         skip writing a doc (delete it)
 *   baseline:     object                 replace the whole baseline map
 *   baselineText: string                 write raw bytes as the baseline (corrupt)
 *   noBaseline:   boolean                write no baseline file at all
 * Caller removes the returned root in a finally block.
 */
function makeFixtureRoot(overrides = {}) {
  const { content = {}, omit = [], baseline, baselineText, noBaseline } =
    overrides;
  const root = mkdtempSync(join(tmpdir(), "creg-fixture-"));
  mkdirSync(join(root, "src", "agents"), { recursive: true });
  mkdirSync(join(root, "src", "references"), { recursive: true });
  mkdirSync(join(root, "src", "scripts"), { recursive: true });
  for (const rel of RELPATHS) {
    if (omit.includes(rel)) continue;
    writeFileSync(join(root, rel), rel in content ? content[rel] : FILLER);
  }
  if (!noBaseline) {
    const baselinePath = join(root, "src", "scripts", "register-baseline.json");
    if (baselineText !== undefined) {
      writeFileSync(baselinePath, baselineText);
    } else {
      const bl =
        baseline ??
        Object.fromEntries(RELPATHS.map((r) => [r, DEFAULT_CEILING]));
      writeFileSync(baselinePath, JSON.stringify(bl, null, 2));
    }
  }
  return root;
}

/** Spawn the REAL CLI against a fixture root via the opt-in env override. */
function runCliAgainst(root) {
  return spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, IP_CHECK_REGISTER_ROOT: root },
  });
}

// --- PURE-FUNCTION UNIT TESTS (import only, no spawn) ---

test("jargonMarkers counts brackets, coded refs, and 3+-segment compounds", () => {
  // 2-segment bracket tags (bracket-only, not compounds) + 3 coded refs +
  // 2 bare 3+-segment compounds.
  const s =
    "[alpha-one] [beta-two] PC-STEP D-003 U7 first-second-third one-two-three-four";
  const m = jargonMarkers(s);
  assert.equal(m.bracket, 2, "two 2-segment bracket tags");
  assert.equal(m.coded, 3, "PC-STEP, D-003, U7");
  assert.equal(m.compound, 2, "first-second-third, one-two-three-four");
  assert.equal(m.total, 7);
});

test("jargonMarkers: 2-token hyphenate is not a compound; [doc-parity-floor] counts as a bracket ONLY (its inner slug is not re-counted as a compound); audit-then-summary is a compound", () => {
  const m = jargonMarkers("read-only [doc-parity-floor] audit-then-summary");
  assert.equal(m.bracket, 1, "[doc-parity-floor] is one bracket tag");
  // The bracket-tag span is stripped before the compound regex runs, so the
  // inner slug doc-parity-floor is NOT re-counted as a compound (no double-count).
  // Only bare audit-then-summary (3 segments) is a compound; read-only (2 tokens) is NOT.
  assert.equal(m.compound, 1, "audit-then-summary only — doc-parity-floor is inside a bracket tag and is NOT re-counted as a compound");
  assert.equal(m.coded, 0);
  // Isolated proof a 2-token hyphenate contributes zero compounds.
  assert.equal(jargonMarkers("read-only plain words here").compound, 0);
});

test("wordCount + density: density = markers / words * 1000, rounded to 2dp", () => {
  // 7 markers (from test 1's payload) + 4 plain words = 11 words.
  const s =
    "[alpha-one] [beta-two] PC-STEP D-003 U7 first-second-third one-two-three-four plain words go here";
  assert.equal(wordCount(s), 11);
  assert.equal(jargonMarkers(s).total, 7);
  // 7 / 11 * 1000 = 636.3636... -> 636.36
  assert.equal(density(s), 636.36);
});

test("compareToBaseline: density above ceiling drifts; at/below does not", () => {
  const over = compareToBaseline(
    { "x.md": { words: 100, density: 12.3 } },
    { "x.md": 10 },
  );
  assert.equal(over.drift.length, 1);
  assert.deepEqual(over.drift[0], { file: "x.md", density: 12.3, ceiling: 10 });

  // density === ceiling is at/below (strict >): no drift.
  const at = compareToBaseline(
    { "x.md": { words: 100, density: 10 } },
    { "x.md": 10 },
  );
  assert.equal(at.drift.length, 0);
});

test("compareToBaseline: floor variants (missing, no-ceiling, near-empty, min-files)", () => {
  const r = compareToBaseline(
    {
      "present.md": { words: 100, density: 1 },
      "extra.md": { words: 100, density: 1 },
      "tiny.md": { words: 5, density: 0 },
    },
    { "present.md": 5, "absent.md": 5, "tiny.md": 5 },
  );
  // baseline key with no measurement.
  assert.ok(
    r.floor.some((f) => f.file === "absent.md" && f.reason === "missing"),
    "absent.md missing",
  );
  // measured file with no committed ceiling.
  assert.ok(
    r.floor.some(
      (f) => f.file === "extra.md" && /no committed ceiling/.test(f.reason),
    ),
    "extra.md no committed ceiling",
  );
  // measured file below MIN_WORDS.
  assert.ok(
    r.floor.some(
      (f) => f.file === "tiny.md" && /near-empty: 5 words/.test(f.reason),
    ),
    "tiny.md near-empty",
  );
  // fewer scanned than EXPECTED_MIN_FILES.
  assert.ok(
    r.floor.some(
      (f) =>
        f.file === null &&
        new RegExp(`only 3 docs scanned, expected >= ${EXPECTED_MIN_FILES}`).test(
          f.reason,
        ),
    ),
    "min-files floor",
  );
  // Sanity: MIN_WORDS is the exported threshold the near-empty branch uses.
  assert.ok(5 < MIN_WORDS);
});

// --- REAL-CLI SPAWN TESTS (exit code + stderr slug) ---

test("real CLI PASS: complete clean fixture (19 low-density docs) -> exit 0", () => {
  const root = makeFixtureRoot();
  try {
    const res = runCliAgainst(root);
    assert.equal(
      res.status,
      0,
      `expected exit 0; stdout=${res.stdout} stderr=${res.stderr}`,
    );
    assert.match(res.stdout, /check-register: PASS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real repo: the committed repo passes its own register gate -> exit 0", () => {
  const res = spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30_000,
    env: process.env,
  });
  assert.equal(
    res.status,
    0,
    `expected exit 0; stdout=${res.stdout} stderr=${res.stderr}`,
  );
});

test("real CLI FAIL [register-drift]: a doc rewritten above its ceiling -> exit 1 + slug + file", () => {
  const root = makeFixtureRoot({ content: { "CLAUDE.md": HIGH_JARGON } });
  try {
    const res = runCliAgainst(root);
    assert.equal(
      res.status,
      1,
      `expected exit 1; stdout=${res.stdout} stderr=${res.stderr}`,
    );
    assert.match(res.stderr, /\[register-drift\]/);
    assert.match(res.stderr, /CLAUDE\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real CLI FAIL [register-floor]: a baseline-listed doc deleted -> exit 1 + missing", () => {
  const root = makeFixtureRoot({ omit: ["src/agents/ip-verifier.md"] });
  try {
    const res = runCliAgainst(root);
    assert.equal(
      res.status,
      1,
      `expected exit 1; stdout=${res.stdout} stderr=${res.stderr}`,
    );
    assert.match(res.stderr, /\[register-floor\]/);
    assert.match(res.stderr, /missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real CLI FAIL [register-floor]: unparseable baseline -> exit 1 + baseline unreadable/unparseable", () => {
  const root = makeFixtureRoot({ baselineText: "{ this is not valid json" });
  try {
    const res = runCliAgainst(root);
    assert.equal(
      res.status,
      1,
      `expected exit 1; stdout=${res.stdout} stderr=${res.stderr}`,
    );
    assert.match(res.stderr, /\[register-floor\]/);
    assert.match(res.stderr, /baseline/);
    assert.match(res.stderr, /unparseable|unreadable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real CLI FAIL [register-floor]: a doc below MIN_WORDS -> exit 1 + near-empty", () => {
  const root = makeFixtureRoot({ content: { "README.md": "too short here" } });
  try {
    const res = runCliAgainst(root);
    assert.equal(
      res.status,
      1,
      `expected exit 1; stdout=${res.stdout} stderr=${res.stderr}`,
    );
    assert.match(res.stderr, /\[register-floor\]/);
    assert.match(res.stderr, /near-empty/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
