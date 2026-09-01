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
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  jargonMarkers,
  wordCount,
  density,
  compareToBaseline,
  buildScanList,
  measureAll,
  serializeBaseline,
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

// Default per-file entry: a generous ceiling (real docs peak ~16.5) paired with
// a zero marker count, so marker-free filler passes freely and only a
// DELIBERATE high-jargon override trips BOTH halves of the conjunction.
const DEFAULT_ENTRY = { ceiling: 50, markers: 0 };

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
        Object.fromEntries(RELPATHS.map((r) => [r, { ...DEFAULT_ENTRY }]));
      writeFileSync(baselinePath, JSON.stringify(bl, null, 2));
    }
  }
  return root;
}

/** Spawn the REAL CLI against a fixture root via the opt-in env override. */
function runCliAgainst(root, args = []) {
  return spawnSync(process.execPath, [script, ...args], {
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

test("compareToBaseline: drift needs BOTH density and marker count above the committed pair", () => {
  const base = { "x.md": { ceiling: 10, markers: 5 } };
  const over = compareToBaseline(
    { "x.md": { words: 100, density: 12.3, markers: 6 } },
    base,
  );
  assert.equal(over.drift.length, 1);
  assert.deepEqual(over.drift[0], {
    file: "x.md",
    density: 12.3,
    ceiling: 10,
    markers: 6,
    baseMarkers: 5,
  });

  // density === ceiling is at/below (strict >): no drift.
  const at = compareToBaseline(
    { "x.md": { words: 100, density: 10, markers: 6 } },
    base,
  );
  assert.equal(at.drift.length, 0);

  // W7 / D-027: density rose but the marker count did NOT — the signature of a
  // pure prose deletion. Must not drift.
  const deleted = compareToBaseline(
    { "x.md": { words: 40, density: 125, markers: 5 } },
    base,
  );
  assert.deepEqual(deleted.drift, []);

  // Markers rose but density fell (a lot of plain prose came with them): the
  // register did not get denser, so no drift.
  const diluted = compareToBaseline(
    { "x.md": { words: 5000, density: 8, markers: 40 } },
    base,
  );
  assert.deepEqual(diluted.drift, []);
});

test("compareToBaseline: a bare-number entry (the pre-v2.62 shape) is a floor fail, not a half-honoured ceiling", () => {
  const r = compareToBaseline(
    { "x.md": { words: 100, density: 99, markers: 99 } },
    { "x.md": 10 },
  );
  assert.deepEqual(r.drift, [], "a malformed entry must not be compared");
  assert.ok(
    r.floor.some((f) => f.file === "x.md" && /malformed entry/.test(f.reason)),
    `expected a malformed-entry floor, got ${JSON.stringify(r.floor)}`,
  );
  // Same for a half-entry (ceiling present, markers missing) and a non-integer
  // marker count.
  for (const bad of [{ ceiling: 10 }, { ceiling: 10, markers: 1.5 }, null, [10, 5]]) {
    const rr = compareToBaseline(
      { "x.md": { words: 100, density: 99, markers: 99 } },
      { "x.md": bad },
    );
    assert.ok(
      rr.floor.some((f) => f.file === "x.md" && /malformed entry/.test(f.reason)),
      `expected malformed for ${JSON.stringify(bad)}`,
    );
  }
});

test("compareToBaseline: floor variants (missing, no-ceiling, near-empty, min-files)", () => {
  const entry = { ceiling: 5, markers: 1 };
  const r = compareToBaseline(
    {
      "present.md": { words: 100, density: 1, markers: 0 },
      "extra.md": { words: 100, density: 1, markers: 0 },
      "tiny.md": { words: 5, density: 0, markers: 0 },
    },
    { "present.md": entry, "absent.md": entry, "tiny.md": entry },
  );
  // baseline key with no measurement.
  assert.ok(
    r.floor.some((f) => f.file === "absent.md" && f.reason === "missing"),
    "absent.md missing",
  );
  // measured file with no committed entry.
  assert.ok(
    r.floor.some(
      (f) => f.file === "extra.md" && /no committed entry/.test(f.reason),
    ),
    "extra.md no committed entry",
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

test("pin: EXPECTED_MIN_FILES equals the live scanned doc count in the real repo", () => {
  // The floor is EXACT, not headroom-tolerant (the check-doc-parity.mjs /
  // check-template-parity.mjs idiom). The scan set comes from the gate's own
  // buildScanList — a replicated scan list here would be a second definition
  // that can drift from the thing it claims to pin. Cross-checked against a
  // raw directory count so this cannot become "the function agrees with
  // itself": 3 fixed root docs + every .md under src/agents + src/references.
  const listMd = (absDir) =>
    readdirSync(absDir).filter((f) => f.endsWith(".md"));
  const live = buildScanList(repoRoot).length;
  assert.strictEqual(
    live,
    3 +
      listMd(join(repoRoot, "src", "agents")).length +
      listMd(join(repoRoot, "src", "references")).length,
    "buildScanList must resolve exactly the 3 fixed docs plus every agent/reference .md",
  );
  assert.strictEqual(
    EXPECTED_MIN_FILES,
    live,
    `EXPECTED_MIN_FILES (${EXPECTED_MIN_FILES}) != live scanned doc count (${live}). ` +
      "Adding or removing a shipped agent/reference doc is a deliberate change: update the " +
      "constant and its comment in check-register.mjs in the same commit, and give the new doc a " +
      "committed ceiling in register-baseline.json. Do NOT make the gate derive its floor at " +
      "runtime — a self-derived floor ratifies whatever is on disk, which is the vacuity the " +
      "floor exists to prevent.",
  );
  // The baseline must cover exactly the scanned set: a ceiling with no doc is a
  // stale key, a doc with no ceiling is an ungated doc.
  const baseline = JSON.parse(
    readFileSync(join(repoRoot, "src/scripts/register-baseline.json"), "utf8"),
  );
  assert.strictEqual(
    Object.keys(baseline).length,
    live,
    "register-baseline.json key count must equal the live scanned doc count",
  );
});

test("pin: every committed baseline entry EQUALS its file's live measurement (a ceiling above live density fails here)", () => {
  // W8. Without this the ratchet's tightness was a one-time data state guarded
  // by nothing: a ceiling silently set ABOVE its file's density — the exact
  // defect step 10 existed to remove — passed every gate, because the gate only
  // asks "density <= ceiling". Equality is the assertion that makes the
  // baseline a RECORD of reality rather than an allowance over it. The reply to
  // a failure here is `--regenerate` plus reading the diff, in the same commit.
  const baseline = JSON.parse(
    readFileSync(join(repoRoot, "src/scripts/register-baseline.json"), "utf8"),
  );
  const live = measureAll(repoRoot);
  const wrong = [];
  for (const [rel, m] of Object.entries(live)) {
    const entry = baseline[rel];
    if (!entry || typeof entry !== "object") {
      wrong.push(`${rel}: no well-formed entry`);
      continue;
    }
    if (entry.ceiling !== m.density) {
      wrong.push(
        `${rel}: ceiling ${entry.ceiling} != live density ${m.density}` +
          (entry.ceiling > m.density ? " (ceiling sits ABOVE live — slack)" : ""),
      );
    }
    if (entry.markers !== m.markers) {
      wrong.push(`${rel}: markers ${entry.markers} != live markers ${m.markers}`);
    }
  }
  assert.deepEqual(
    wrong,
    [],
    `register-baseline.json is not the live measurement:\n  ${wrong.join("\n  ")}\n` +
      "Run `node src/scripts/check-register.mjs --regenerate` and commit the diff.",
  );
});

test("--regenerate reproduces the committed baseline byte for byte (criterion 9's stated pass condition, executable)", () => {
  // W8. Step 10 claimed "regenerate baseline -> git diff --stat empty" as its
  // pass condition while the script had no regenerate mode at all, so nobody
  // reading the repo could run it. This runs it — against a COPY of the real
  // docs, so the committed file is never mutated by a test.
  const root = mkdtempSync(join(tmpdir(), "creg-regen-"));
  try {
    for (const rel of buildScanList(repoRoot)) {
      const dest = join(root, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, readFileSync(join(repoRoot, rel)));
    }
    mkdirSync(join(root, "src", "scripts"), { recursive: true });
    writeFileSync(join(root, "src/scripts/register-baseline.json"), "{}\n");
    const res = runCliAgainst(root, ["--regenerate"]);
    assert.equal(
      res.status,
      0,
      `expected exit 0; stdout=${res.stdout} stderr=${res.stderr}`,
    );
    assert.match(res.stdout, /regenerated register-baseline\.json/);
    assert.strictEqual(
      readFileSync(join(root, "src/scripts/register-baseline.json"), "utf8"),
      readFileSync(
        join(repoRoot, "src/scripts/register-baseline.json"),
        "utf8",
      ),
      "regenerating from the live docs must reproduce the committed baseline exactly",
    );
    // And the serializer the CLI used is the exported one, on the same inputs.
    assert.strictEqual(
      serializeBaseline(measureAll(repoRoot)),
      readFileSync(join(root, "src/scripts/register-baseline.json"), "utf8"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--regenerate refuses to write from a gutted scan (it cannot be used to launder a floor failure)", () => {
  const root = makeFixtureRoot({ omit: ["src/agents/ip-verifier.md"] });
  try {
    const before = readFileSync(
      join(root, "src/scripts/register-baseline.json"),
      "utf8",
    );
    const res = runCliAgainst(root, ["--regenerate"]);
    assert.equal(res.status, 1, `expected exit 1; stderr=${res.stderr}`);
    assert.match(res.stderr, /\[register-floor\]/);
    assert.match(res.stderr, /refusing to regenerate/);
    assert.strictEqual(
      readFileSync(join(root, "src/scripts/register-baseline.json"), "utf8"),
      before,
      "a refused regenerate must leave the baseline untouched",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- W7 / D-027: WHICH EDITS THE RATCHET MAY AND MAY NOT PUNISH ------------
// Corpus shape taken from the reviewer's own reproduction (deleting 12 plain
// prose lines from src/agents/ip-orchestrator.md), not invented here.

// A doc carrying real markers plus a long plain-prose body, and its exact
// committed entry — the state of every file in the real baseline.
const W7_MARKERS = "[alpha-one] [beta-two] PC-STEP D-003 first-second-third";
const W7_PROSE = Array.from(
  { length: 12 },
  (_, i) =>
    `Line ${i} of ordinary readable prose written in plain words with no special markers of any kind at all.`,
).join("\n");
const W7_DOC = `${W7_MARKERS}\n${W7_PROSE}\n`;
const W7_ENTRY = { ceiling: density(W7_DOC), markers: jargonMarkers(W7_DOC).total };

/** Fixture where ip-orchestrator.md holds W7_DOC (pinned at its exact entry). */
function w7Root(body) {
  const baseline = Object.fromEntries(
    RELPATHS.map((r) => [
      r,
      r === "src/agents/ip-orchestrator.md" ? W7_ENTRY : { ...DEFAULT_ENTRY },
    ]),
  );
  return makeFixtureRoot({
    content: { "src/agents/ip-orchestrator.md": body },
    baseline,
  });
}

test("W7: DELETING plain prose raises density but must NOT fail — the ratchet may not punish simplification", () => {
  const shortened = `${W7_MARKERS}\n${W7_PROSE.split("\n").slice(6).join("\n")}\n`;
  // Precondition, asserted so this test cannot pass for the wrong reason: the
  // deletion really does push density above the committed ceiling.
  assert.ok(
    density(shortened) > W7_ENTRY.ceiling,
    `expected the deletion to raise density above ${W7_ENTRY.ceiling}, got ${density(shortened)}`,
  );
  assert.strictEqual(jargonMarkers(shortened).total, W7_ENTRY.markers);
  const root = w7Root(shortened);
  try {
    const res = runCliAgainst(root);
    assert.equal(
      res.status,
      0,
      `a pure prose deletion must PASS; stdout=${res.stdout} stderr=${res.stderr}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W7: ADDING one jargon marker still FAILS [register-drift] — D-021's intent is not regressed", () => {
  const root = w7Root(`${W7_DOC}One more audit-then-summary-and-verdict marker.\n`);
  try {
    const res = runCliAgainst(root);
    assert.equal(res.status, 1, `expected exit 1; stdout=${res.stdout}`);
    assert.match(res.stderr, /\[register-drift\]/);
    assert.match(res.stderr, /ip-orchestrator\.md/);
    assert.match(res.stderr, /marker count rose/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W7: ADDING plain prose still passes (density falls)", () => {
  const root = w7Root(`${W7_DOC}${W7_PROSE}\n`);
  try {
    const res = runCliAgainst(root);
    assert.equal(
      res.status,
      0,
      `expected exit 0; stdout=${res.stdout} stderr=${res.stderr}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W7: the drift message no longer claims density may fall freely — it states the two-sided rule", () => {
  const root = w7Root(`${W7_DOC}One more audit-then-summary-and-verdict marker.\n`);
  try {
    const res = runCliAgainst(root);
    assert.doesNotMatch(
      res.stderr,
      /density may fall\/hold freely/,
      "the old message contradicted the gate's own behaviour on deletions",
    );
    assert.match(res.stderr, /both must rise/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
