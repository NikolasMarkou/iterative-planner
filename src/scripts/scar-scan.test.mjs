// Requires Node.js 18+
// Tests for scar-scan.mjs — the partitioned hygiene sweep (a report, not a gate).
//
// Importing the pure functions from the .mjs is side-effect-free: the CLI body
// runs only under the isEntryPoint guard. The first test proves that rather than
// assuming it, because every other test in this file imports the module.
//
// TWO THINGS THIS SUITE EXISTS TO CATCH, ahead of everything else:
//   1. A FALSE ALL-CLEAR. The scanner's worst possible output is an empty
//      findings block produced by a scan that never really ran. Four tests drive
//      the [scan-unavailable] branch — missing validator, unparseable output,
//      wrong exit status, killing signal — and each asserts stdout is ZERO BYTES,
//      including under --json. A consumer must never be handed something it can
//      read as a clean repo.
//   2. A PARTITION THAT DOES NOT DISCRIMINATE. This repo carries a large
//      inherited anchor backlog. If every finding were labelled INHERITED the
//      report would be vacuous; if the backlog flipped to INTRODUCED it would
//      read as a permanent false regression. The live-repo test asserts both
//      halves: the real backlog classifies inherited, and an item bearing the
//      ACTIVE plan-id classifies introduced.
//
// Fixtures are temp roots reached through the two opt-in env overrides
// (IP_SCAR_SCAN_ROOT, IP_SCAR_SCAN_VALIDATOR) that the CLI reads inside its
// entry-point guard. Every fixture is removed in a finally block.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ANCHOR_CHECKS,
  CATEGORIES,
  CODE_EXTS,
  EXIT_OK,
  EXIT_UNTRUSTWORTHY,
  EXPECTED_MIN_CATEGORIES,
  INHERITED_PRINT_LIMIT,
  LEFTOVER_KINDS,
  SKIP_DIRS,
  VALIDATOR_TIMEOUT_MS,
  changelogPaths,
  classifyPlanArtifacts,
  classifyProvenance,
  collectCodeFiles,
  commitTagPrefix,
  findOrphanedTestFiles,
  findStaleCommitFields,
  formatReport,
  parseComplexityBudget,
  parseValidatorOutput,
  reconcileComplexityBudget,
  resolvePlanDir,
  runScan,
  runValidator,
  scanForbiddenLeftovers,
} from "./scar-scan.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const script = join(here, "scar-scan.mjs");
const realValidator = join(here, "validate-plan.mjs");

// The closed plan directory D-008 measured. It is gitignored, so it exists in
// THIS working tree and is absent from a fresh clone — the tests that read it
// skip with an explicit reason rather than passing silently on nothing.
const CLOSED_PLAN = "plan-2026-09-04T124202-72910089";
const closedPlanAbs = join(repoRoot, "plans", CLOSED_PLAN);

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const FIXTURE_PLAN_ID = "plan-2026-01-02T030405-abcdef01";

const FIXTURE_PLAN_MD = [
  "# Plan v1",
  "",
  "## Complexity Budget",
  "",
  "- **Files added: 1/3 max** (as of step 1)",
  "- **New abstractions: 1/2 max**",
  "",
].join("\n");

/** One well-formed 8-field entry naming a file that does NOT exist in the tree. */
const FIXTURE_CHANGELOG = [
  "# Changelog",
  "*Append-only per-edit ledger. One line per file edit.*",
  "2026-01-02T03:04:05Z | iter-1/step-1 | abc1234 | src/untouched.mjs | EDIT(+1,-0) | radius:LOW(1) | - | seed entry",
  "",
].join("\n");

/** One marker-comment leftover, so category D is provably non-vacuous. */
const FIXTURE_CODE = [
  "export const sample = 1;",
  "// TODO: a real marker comment for category D to find",
  "",
].join("\n");

/** A validator stub whose output carries the `Summary:` proof-of-run line. */
const STUB_PROOF =
  'console.log("Summary: 0 error(s), 0 warning(s), 0 info(s)");\n';

/**
 * Build a temp fixture root laid out the way the CLI expects: a plans/ pointer,
 * one plan directory with the files categories B/C/E read, and one source file
 * for category D. `.stubs/` is dot-prefixed on purpose — collectCodeFiles skips
 * dot-directories, so a stub validator never shows up as a swept source file.
 *
 * Contract: (overrides) -> { root, planId, planDir }. Caller removes `root`.
 *   planId    override the plan directory name
 *   planFiles { [name]: body } inside the plan directory
 *   files     { [repo-rel path]: body } elsewhere in the tree
 *   noPointer write no plans/.current_plan
 */
function makeFixtureRoot({
  planId = FIXTURE_PLAN_ID,
  planFiles = {},
  files = {},
  noPointer = false,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "scar-fixture-"));
  const planDir = join(root, "plans", planId);
  mkdirSync(planDir, { recursive: true });
  mkdirSync(join(root, ".stubs"), { recursive: true });
  if (!noPointer) {
    writeFileSync(join(root, "plans", ".current_plan"), `${planId}\n`);
  }
  const planDefaults = {
    "plan.md": FIXTURE_PLAN_MD,
    "changelog.md": FIXTURE_CHANGELOG,
    "state.md": "# Current State: EXECUTE\n",
    "progress.md": "# Progress\n",
    "decisions.md": "# Decision Log\n",
  };
  for (const [name, body] of Object.entries({ ...planDefaults, ...planFiles })) {
    const abs = join(planDir, name);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  for (const [rel, body] of Object.entries({ "src/sample.mjs": FIXTURE_CODE, ...files })) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return { root, planId, planDir };
}

/** Write an executable validator stub inside a fixture root; return its path. */
function writeStub(root, name, body) {
  const abs = join(root, ".stubs", name);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  return abs;
}

/** Spawn the REAL CLI against a fixture root via the two opt-in env overrides. */
function runCliAgainst(root, args = [], validatorPath = realValidator) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      IP_SCAR_SCAN_ROOT: root,
      IP_SCAR_SCAN_VALIDATOR: validatorPath,
    },
  });
}

/** Is `dir` inside a git work tree? Guards the deliberately non-git fixture. */
function insideGitWorkTree(dir) {
  const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return r.status === 0 && (r.stdout ?? "").trim() === "true";
}

const itemsOf = (report, category, list) =>
  report[list].filter((i) => i.category === category);

// ---------------------------------------------------------------------------
// Module hygiene
// ---------------------------------------------------------------------------

test("importing scar-scan.mjs is side-effect-free: the CLI runs only under the entry-point guard", () => {
  // Every other test here imports the module. If module load ran the sweep, the
  // suite would spawn a validator per worker and this file's own assertions
  // would be racing a CLI. Proven, not assumed.
  const res = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(script)}); process.stdout.write("loaded");`],
    { cwd: repoRoot, encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(res.status, 0, `import must not fail; stderr=${res.stderr}`);
  assert.strictEqual(
    res.stdout,
    "loaded",
    "module load wrote to stdout — the CLI body escaped its isEntryPoint guard; " +
      "keep every console.log inside `if (isEntryPoint)`",
  );
});

// ---------------------------------------------------------------------------
// The floor pin
// ---------------------------------------------------------------------------

test("pin: EXPECTED_MIN_CATEGORIES equals the live CATEGORIES count", () => {
  assert.strictEqual(
    EXPECTED_MIN_CATEGORIES,
    CATEGORIES.length,
    `EXPECTED_MIN_CATEGORIES (${EXPECTED_MIN_CATEGORIES}) != live CATEGORIES length (${CATEGORIES.length}). ` +
      "The floor is EXACT, not headroom-tolerant (the EXPECTED_MIN_KEYS / EXPECTED_MIN_FILES / " +
      "EXPECTED_SLUGS idiom): headroom here means literally 'that many sweep categories may vanish " +
      "while the tool still claims to have swept'. Adding or removing a category is a deliberate " +
      "change — move the constant AND its 'Real count today' comment in scar-scan.mjs in the same " +
      "commit. Do NOT make the floor derive itself from CATEGORIES.length at runtime: a self-derived " +
      "floor ratifies whatever is on disk, which is the vacuity the floor exists to prevent.",
  );
});

test("pin: CATEGORIES is the single enumeration — unique ids, unique keys, and the git-dependent pair is B and E", () => {
  const ids = CATEGORIES.map((c) => c.id);
  assert.deepEqual(ids, ["A", "B", "C", "D", "E"], "category ids are positional and cited by id in prose");
  assert.strictEqual(new Set(CATEGORIES.map((c) => c.key)).size, CATEGORIES.length, "keys must be unique");
  assert.deepEqual(
    CATEGORIES.filter((c) => c.needsGit).map((c) => c.id),
    ["B", "E"],
    "only B (commit resolution) and E (real diff) need git; if this changes, the non-git degradation test below must change with it",
  );
  for (const c of CATEGORIES) {
    assert.ok(c.title && typeof c.title === "string", `${c.id} needs a human title for the report`);
  }
});

// ---------------------------------------------------------------------------
// Category A — orphaned decision anchors (delegated)
// ---------------------------------------------------------------------------

const VALIDATOR_OUT = [
  "Validating plans/plan-2026-01-02T030405-abcdef01",
  "  ERROR [anchor-unknown-plan]: src/a.mjs:12 anchor plan-2026-01-01T000000-deadbeef/D-003 names no known plan",
  "  WARN  [anchor-badprefix]: src/b.mjs:7 anchor plan_2026-01-02_cafebabe/D-001 uses a legacy prefix",
  "  WARN  [changelog-malformed]: line 4 is not an entry",
  "  INFO  [convergence]: score 0.8",
  "Summary: 1 error(s), 2 warning(s), 1 info(s)",
].join("\n");

test("category A positive: parseValidatorOutput extracts severity, file:line, plan-id, and strips the duplicated location from the evidence", () => {
  const { proofOfRun, anchors } = parseValidatorOutput(VALIDATOR_OUT);
  assert.equal(proofOfRun, true, "the `Summary:` line is positive proof the upstream really ran");
  assert.equal(anchors.length, 2, `expected 2 anchor findings, got ${JSON.stringify(anchors)}`);
  assert.deepEqual(
    { ...anchors[0] },
    {
      category: "A",
      kind: "anchor-unknown-plan",
      severity: "ERROR",
      file: "src/a.mjs",
      line: 12,
      planId: "plan-2026-01-01T000000-deadbeef",
      stale: false,
      evidence: "anchor plan-2026-01-01T000000-deadbeef/D-003 names no known plan",
      remediation: null,
    },
    "the location is parsed into file/line and REMOVED from evidence so a report line does not name its own location twice",
  );
  assert.equal(anchors[1].severity, "WARN", "a WARN-severity anchor check is still a finding, not a filtered-out line");
  assert.equal(anchors[1].planId, "plan_2026-01-02_cafebabe", "the legacy underscore plan-id shape must still resolve");
});

test("category A negative: non-anchor issue lines and ordinary prose contribute nothing — ANCHOR_CHECKS is the filter", () => {
  const { anchors } = parseValidatorOutput(VALIDATOR_OUT);
  for (const a of anchors) {
    assert.ok(ANCHOR_CHECKS.has(a.kind), `${a.kind} is not in ANCHOR_CHECKS but was reported as an anchor finding`);
  }
  const noise = [
    "  WARN  [changelog-malformed]: line 4 is not an entry",
    "  ERROR [transition]: EXPLORE -> CLOSE is not a valid transition",
    "This sentence mentions anchor-unknown-plan in prose and must not parse.",
    "Summary: 1 error(s), 1 warning(s), 0 info(s)",
  ].join("\n");
  assert.deepEqual(parseValidatorOutput(noise).anchors, [], "only ANCHOR_CHECKS members are category-A findings");
  assert.equal(parseValidatorOutput(noise).proofOfRun, true);
});

test("category A: proof-of-run accepts either the Summary or the PASS line, and its ABSENCE is never a clean repo", () => {
  const pass = "Validating plans/x\nPASS: plans/x — no issues found";
  assert.equal(parseValidatorOutput(pass).proofOfRun, true, "a clean validator run proves it ran via the PASS line");

  const drifted = [
    "Validating plans/x",
    "  ERROR [anchor-unknown-plan]: src/a.mjs:12 anchor plan-2026-01-01T000000-deadbeef/D-003 names no known plan",
    "Totals: 1 error",
  ].join("\n");
  const r = parseValidatorOutput(drifted);
  assert.equal(
    r.proofOfRun,
    false,
    "an output with neither proof line means the report format DRIFTED; the caller must turn this into " +
      "[scan-unavailable]. Do not relax this into 'no matches means clean' — that is the false all-clear.",
  );
  assert.equal(parseValidatorOutput("").proofOfRun, false, "empty output is not proof");
  assert.equal(parseValidatorOutput(undefined).proofOfRun, false, "undefined must not throw");
  assert.deepEqual(parseValidatorOutput(undefined).anchors, []);
});

test("category A: a bare (unqualified) anchor names no plan, and a [STALE] anchor is flagged", () => {
  const out = [
    "  WARN  [anchor-unqualified]: src/c.mjs:3 bare D-004 anchor carries no plan-id prefix",
    "  WARN  [anchor-orphan]: src/d.mjs:9 anchor plan-2026-03-03T010101-11112222/D-002 is marked [STALE]",
    "Summary: 0 error(s), 2 warning(s), 0 info(s)",
  ].join("\n");
  const { anchors } = parseValidatorOutput(out);
  assert.equal(anchors[0].planId, null, "a bare D-NNN anchor names no plan — classifyProvenance must call it INHERITED, never fall back to the file test");
  assert.equal(anchors[0].stale, false);
  assert.equal(anchors[1].stale, true, "the [STALE] marker must survive into the finding");
});

test("category A: runValidator reports a MISSING upstream as unavailable rather than an empty run", () => {
  const missing = join(tmpdir(), "definitely-not-here-validate-plan.mjs");
  const r = runValidator({ scriptPath: missing, planDirName: FIXTURE_PLAN_ID, cwd: repoRoot });
  assert.equal(r.ok, false, "a missing validator must never yield ok:true with empty stdout");
  assert.match(r.reason, /not found/);
  assert.ok(r.reason.includes(missing), `the reason must name the path it looked at; got ${r.reason}`);
});

test("category A: runValidator treats exit 0 and exit 1 as REAL runs, and any other status as unavailable", () => {
  const { root } = makeFixtureRoot();
  try {
    const clean = writeStub(root, "clean.mjs", 'console.log("PASS: plans/x — no issues found");\n');
    const errors = writeStub(root, "errors.mjs", `${STUB_PROOF}process.exit(1);\n`);
    const crash = writeStub(root, "crash.mjs", `${STUB_PROOF}process.exit(3);\n`);

    const a = runValidator({ scriptPath: clean, planDirName: FIXTURE_PLAN_ID, cwd: root });
    assert.equal(a.ok, true, `exit 0 is a clean run; reason=${a.reason}`);
    const b = runValidator({ scriptPath: errors, planDirName: FIXTURE_PLAN_ID, cwd: root });
    assert.equal(b.ok, true, "exit 1 means the validator FOUND errors — that is exactly the run we want, not a failure");
    const c = runValidator({ scriptPath: crash, planDirName: FIXTURE_PLAN_ID, cwd: root });
    assert.equal(c.ok, false, "exit 3 (crash, or the leash gate's 2) means the validator did not do this job");
    assert.match(c.reason, /exited 3/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("category A: a validator killed by a signal is unavailable, and the reason names the subprocess budget", () => {
  const { root } = makeFixtureRoot();
  try {
    const killed = writeStub(root, "killed.mjs", 'process.kill(process.pid, "SIGKILL");\n');
    const r = runValidator({ scriptPath: killed, planDirName: FIXTURE_PLAN_ID, cwd: root });
    assert.equal(r.ok, false, "a killed subprocess produced no trustworthy output");
    assert.match(r.reason, /killed by SIG/);
    assert.ok(
      r.reason.includes(String(VALIDATOR_TIMEOUT_MS)),
      `the reason must state the budget so a reader can tell a timeout kill from an external one; got ${r.reason}`,
    );
    assert.ok(VALIDATOR_TIMEOUT_MS > 0, "the budget must be a real timeout, not 0 (which disables it)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Category B — stale `uncommitted` changelog commit fields
// ---------------------------------------------------------------------------

test("category B positive: an 8-field entry whose COMMIT field reads `uncommitted` is found, with its line number", () => {
  const text = [
    "# Changelog",
    "2026-01-02T03:04:05Z | iter-1/step-1 | abc1234 | src/a.mjs | EDIT(+1,-0) | radius:LOW(1) | - | landed",
    "2026-01-02T03:06:05Z | iter-1/step-2 | uncommitted | src/b.mjs | EDIT(+2,-1) | radius:MED(5) | D-002 | still open",
    "2026-01-02T03:09:05Z | iter-1/step-2.1 | uncommitted | src/c.mjs | CREATE(+9) | radius:LOW(1) | - | completion fix",
  ].join("\n");
  assert.deepEqual(findStaleCommitFields(text), [
    { lineNo: 3, step: "iter-1/step-2", path: "src/b.mjs", reason: "still open" },
    { lineNo: 4, step: "iter-1/step-2.1", path: "src/c.mjs", reason: "completion fix" },
  ]);
});

test("category B negative: the word `uncommitted` in a REASON field is not a stale commit field (the EXPLORE baseline's grep bug)", () => {
  // This is the whole reason the check splits fields instead of grepping. The
  // measured baseline for this plan counted 4 by running `grep -c uncommitted`;
  // two of those four were append-only CORRECTION entries whose reason text
  // merely contains the word. Re-introducing a grep here re-introduces that bug.
  const text = [
    "# Changelog",
    "*Field order: `UTC | iter-N/step-M[.K] | commit | path | op | radius | D-NNN-or-dash | reason`*",
    "2026-01-02T03:04:05Z | iter-1/step-1 | 40ee60d | src/a.mjs | EDIT(+0,-0) | radius:LOW(1) | - | correction: line 6 above still read \"uncommitted\" after this step's real commit landed",
    "not an entry line at all",
    "too | few | fields | here",
    "2026-01-02T03:04:05Z | completion-fix | uncommitted | src/d.mjs | EDIT(+1,-0) | radius:LOW(1) | - | bad step grammar",
  ].join("\n");
  assert.deepEqual(
    findStaleCommitFields(text),
    [],
    "a reason mentioning the word, a header, a short line, and a line failing STEP_RE are all NOT stale commit fields",
  );
  assert.deepEqual(findStaleCommitFields(""), []);
  assert.deepEqual(findStaleCommitFields(null), [], "a missing changelog must not throw");
});

test("category B on the real closed-plan corpus: exactly 2 stale fields, at lines 6 and 10 (D-008's correction, executable)", (t) => {
  if (!existsSync(closedPlanAbs)) {
    t.skip(
      `${CLOSED_PLAN} is absent — plan directories are gitignored, so this measurement is unavailable in a ` +
        "fresh clone. Skipped with a reason rather than passed silently on nothing.",
    );
    return;
  }
  const text = readFileSync(join(closedPlanAbs, "changelog.md"), "utf8");
  const stale = findStaleCommitFields(text);
  assert.deepEqual(
    stale.map((s) => s.lineNo),
    [6, 10],
    "D-008: the true count in this corpus is 2, not the 4 the EXPLORE baseline's `grep -c uncommitted` reported. " +
      "Lines 14 and 15 are append-only CORRECTION entries whose reason text contains the word. A test that " +
      "counts 4 here is reproducing the grep bug, not measuring the corpus.",
  );
  assert.deepEqual(stale.map((s) => s.step), ["iter-1/step-2", "iter-1/step-6"]);
});

test("category B end-to-end: --plan-dir at the closed plan reports both stale fields, and the frame is the SWEPT plan", (t) => {
  if (!existsSync(closedPlanAbs)) {
    t.skip(`${CLOSED_PLAN} is absent (gitignored) — end-to-end measurement unavailable in a fresh clone.`);
    return;
  }
  const report = runScan({
    root: repoRoot,
    planDirArg: `plans/${CLOSED_PLAN}`,
    validatorPath: realValidator,
  });
  assert.ok(!report.unavailable, `expected a real scan; got unavailable: ${report.unavailable}`);
  const b = [...itemsOf(report, "B", "inherited"), ...itemsOf(report, "B", "introduced")];
  assert.equal(b.length, 2, `expected exactly 2 category-B findings, got ${JSON.stringify(b.map((i) => i.line))}`);
  assert.deepEqual(b.map((i) => i.line), [6, 10]);
  for (const i of b) {
    assert.match(i.evidence, /still reads `uncommitted`/);
    assert.match(i.remediation, /rewrite the commit field to [0-9a-f]{7,}/, "git corroborated the hash, so the fix names it");
    // The reference frame of the partition is the plan being SWEPT, not the one
    // in plans/.current_plan: --plan-dir re-points the whole scan, and a
    // finding inside the swept plan's own directory is that plan's by
    // construction (see classifyProvenance's contract). decisions.md D-008
    // describes these two as INHERITED, which is true relative to the ACTIVE
    // plan — the assertion for that frame is the next one down.
    assert.equal(i.provenance, "introduced", "swept-plan frame: the finding lives in the swept plan's own directory");
  }
  // D-008's actual invariant, in the frame it was written about: relative to a
  // DIFFERENT active plan, this closed plan's residue is not that plan's regression.
  for (const i of b) {
    const { provenance } = classifyProvenance(i, {
      paths: new Set(),
      planId: FIXTURE_PLAN_ID,
      planDirRel: `plans/${FIXTURE_PLAN_ID}`,
    });
    assert.equal(
      provenance,
      "inherited",
      "relative to any other active plan, a closed plan's stale commit fields are inherited backlog and must never be minted as a fix",
    );
  }
});

// ---------------------------------------------------------------------------
// Category C — orphan plan-directory artifacts
// ---------------------------------------------------------------------------

test("category C positive: an empty findings shell, a numeric collision suffix, and an uncited checkpoint", () => {
  const items = classifyPlanArtifacts({
    findings: [
      { name: "hollow.md", content: "# Topic\n\nonly two lines\n" },
      { name: "topic-2.md", content: "# T\n1\n2\n3\n4\n" },
    ],
    checkpoints: [{ name: "cp-004-iter2.md" }],
    referenceText: "state.md and progress.md say nothing about that checkpoint",
  });
  assert.deepEqual(
    items.map((i) => [i.kind, i.file]),
    [
      ["empty-findings-file", "findings/hollow.md"],
      ["collision-suffix", "findings/topic-2.md"],
      ["unreferenced-checkpoint", "checkpoints/cp-004-iter2.md"],
    ],
  );
  for (const i of items) {
    assert.equal(i.category, "C");
    assert.ok(i.remediation, `${i.kind} must carry a remediation — a finding with no suggested action is a complaint`);
  }
});

test("category C negative: a populated artifact, a CITED checkpoint, and the mandatory cp-000 are all clean", () => {
  const items = classifyPlanArtifacts({
    findings: [{ name: "real.md", content: "# Topic\n\n## Summary\nA populated artifact with real lines.\n" }],
    checkpoints: [{ name: "cp-000-iter1.md" }, { name: "cp-003-iter1.md" }],
    referenceText: "Checkpoint created: cp-003-iter1 before the risky three-file edit.",
  });
  assert.deepEqual(
    items,
    [],
    "cp-000-iter1 is the MANDATORY nuclear-fallback checkpoint every plan must create whether or not anything " +
      "ever cites it, so an uncited cp-000 is protocol compliance and must never be reported as residue",
  );
  assert.deepEqual(classifyPlanArtifacts({}), [], "an empty listing must not throw");
});

test("category C: the unreferenced-checkpoint rule is scoped OFF for the ACTIVE plan and stays ON for a closed one", () => {
  const listing = { checkpoints: [{ name: "cp-001-iter1.md" }], referenceText: "nothing cites it yet" };
  assert.deepEqual(
    classifyPlanArtifacts({ ...listing, planIsActive: true }),
    [],
    "decisions.md D-012: a checkpoint the run NOW IN PROGRESS created minutes ago is the protocol working, not " +
      "residue — the plan file that will cite it may not be written yet",
  );
  const closed = classifyPlanArtifacts({ ...listing, planIsActive: false });
  assert.deepEqual(
    closed.map((i) => [i.kind, i.file]),
    [["unreferenced-checkpoint", "checkpoints/cp-001-iter1.md"]],
    "NARROWED, NOT DELETED: a dangling checkpoint in a CLOSED plan is still real residue and must still be reported",
  );
  assert.deepEqual(
    classifyPlanArtifacts({
      findings: [{ name: "hollow.md", content: "# T\n" }],
      checkpoints: [{ name: "cp-002-iter1.md" }],
      planIsActive: true,
    }).map((i) => i.kind),
    ["empty-findings-file"],
    "the active-plan scope suppresses the CHECKPOINT rule only — the findings rules still fire",
  );
});

test("category C negative: a PROTOCOL-assigned `-iter-N` / `-passN` name is not a collision suffix", () => {
  const populated = "# T\n\n## Summary\nfour real lines here\nand another\n";
  const items = classifyPlanArtifacts({
    findings: [
      { name: "review-iter-2.md", content: populated },
      { name: "review-iter-3-pass2.md", content: populated },
      { name: "hygiene-iter-2.md", content: populated },
      { name: "auth-system-2.md", content: populated },
    ],
  });
  assert.deepEqual(
    items.map((i) => i.file),
    ["findings/auth-system-2.md"],
    "ip-reviewer.md names its artifacts `review-iter-N[-passM].md` and ip-boyscout.md names its own " +
      "`hygiene-iter-N.md`: those numbers are ASSIGNED BY THE PROTOCOL, not minted by a slug collision, " +
      "so flagging them makes the tool report its own output as residue from iteration 2 onward. " +
      "The collision shape that must still be caught is an explorer topic slug (`auth-system-2.md`).",
  );
  assert.equal(items[0].kind, "collision-suffix");
});

// ---------------------------------------------------------------------------
// Category D — the Forbidden Leftovers code sweep
// ---------------------------------------------------------------------------

const LEFTOVER_SOURCE = [
  'import { readFileSync, writeFileSync } from "node:fs";',
  'import unusedThing from "./gone.mjs";',
  "// TODO: a marker comment that opens a comment",
  "  # FIXME: the hash-comment family too",
  'const body = readFileSync("p");',
  "debugger;",
  'console.debug("left over from a failed attempt");',
  "// const dead = compute();",
  'writeFileSync("q", body);',
  "",
].join("\n");

test("category D positive: marker comments, debug statements, commented-out code, and a dead import", () => {
  const found = scanForbiddenLeftovers("src/x.mjs", LEFTOVER_SOURCE);
  assert.deepEqual(
    found.map((i) => [i.kind, i.line]),
    [
      ["marker-comment", 3],
      ["marker-comment", 4],
      ["debug-statement", 6],
      ["debug-statement", 7],
      ["commented-out-code", 8],
      ["dead-import", 2],
    ],
  );
  for (const i of found) {
    assert.equal(i.category, "D");
    assert.equal(i.file, "src/x.mjs");
    assert.ok(i.evidence && i.remediation, `${i.kind} must carry evidence and a remediation`);
  }
});

test("category D negative: mid-line mentions, console.log, and a USED import are all left alone", () => {
  const clean = [
    'const note = "a TODO mentioned mid-line is prose, not a leftover";',
    'console.log("every gate here is a CLI whose whole output channel is console.log");',
    'import { join as pathJoin } from "node:path";',
    'export const p = pathJoin("a", "b");',
    "const chained = value.then(() => console.debug(1));",
    "",
  ].join("\n");
  assert.deepEqual(
    scanForbiddenLeftovers("src/clean.mjs", clean),
    [],
    "the rules are line-start anchored on purpose: a rule that fires on correct lines is a rule that gets ignored. " +
      "console.log is deliberately not a debug statement here, and an aliased `as` binding counts as used.",
  );
  assert.deepEqual(scanForbiddenLeftovers("src/empty.mjs", ""), []);
  assert.deepEqual(scanForbiddenLeftovers("src/nothing.mjs", null), [], "a null body must not throw");
});

test("category D negative: the dead-import rule runs only on JS-family files", () => {
  const py = scanForbiddenLeftovers("scripts/x.py", LEFTOVER_SOURCE);
  assert.deepEqual(
    py.map((i) => i.kind).filter((k) => k === "dead-import"),
    [],
    "an ES import statement in a .py file is not a JS import; the rule is gated on the JS extension set",
  );
  assert.ok(py.some((i) => i.kind === "marker-comment"), "the line-based rules still run on non-JS files");
});

test("category D: an orphaned test file is one whose SUBJECT is gone; a test beside its subject is clean", () => {
  const present = new Set(["a/b.mjs", "a/b.test.mjs", "c/d.spec.ts"]);
  const items = findOrphanedTestFiles([...present], (p) => present.has(p));
  assert.deepEqual(
    items.map((i) => [i.file, i.evidence]),
    [["c/d.spec.ts", "no subject file c/d.ts"]],
    "a/b.test.mjs sits beside a/b.mjs and is clean; c/d.spec.ts has no c/d.ts",
  );
  assert.deepEqual(
    findOrphanedTestFiles(["tests/test_thing.py"], () => false),
    [],
    "python's test_x.py names no unambiguous subject and is deliberately left alone",
  );
});

test("category D: collectCodeFiles walks code extensions only, skipping SKIP_DIRS and dot-directories", () => {
  const { root } = makeFixtureRoot({
    files: {
      "src/a.mjs": "export const a = 1;\n",
      "src/nested/b.py": "b = 1\n",
      "src/notes.md": "# not code\n",
      "node_modules/c.mjs": "export const c = 1;\n",
      "dist/d.mjs": "export const d = 1;\n",
      ".hidden/e.mjs": "export const e = 1;\n",
    },
  });
  try {
    assert.ok(SKIP_DIRS.has("node_modules") && SKIP_DIRS.has("dist") && SKIP_DIRS.has("plans"));
    assert.ok(CODE_EXTS.has(".mjs") && CODE_EXTS.has(".py"), "the sweep must cover both comment families");
    assert.ok(!CODE_EXTS.has(".md"), "markdown is prose, not swept code");
    assert.deepEqual(
      collectCodeFiles(root),
      ["src/a.mjs", "src/nested/b.py", "src/sample.mjs"],
      "repo-relative, sorted; plans/ is skipped so a plan's own artifacts are never swept as source",
    );
    assert.deepEqual(collectCodeFiles(join(root, "no-such-dir")), [], "an unreadable directory contributes nothing rather than aborting the sweep");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pin: the kinds category D can actually emit are exactly LEFTOVER_KINDS", () => {
  const emitted = new Set([
    ...scanForbiddenLeftovers("src/x.mjs", LEFTOVER_SOURCE).map((i) => i.kind),
    ...findOrphanedTestFiles(["c/d.spec.ts"], () => false).map((i) => i.kind),
  ]);
  assert.deepEqual(
    [...emitted].sort(),
    [...LEFTOVER_KINDS].sort(),
    "LEFTOVER_KINDS is the exported claim about what this sweep mechanizes, and the report prints its length. " +
      "If a kind is added or dropped, move the array and this corpus together — a claim of 5 kinds backed by 4 " +
      "working rules is the vacuity this pin exists to prevent.",
  );
});

// ---------------------------------------------------------------------------
// Category E — Complexity Budget reconciliation
// ---------------------------------------------------------------------------

test("category E positive: the budget is read from its OWN section, and an over-cap diff is a finding", () => {
  const planText = [
    "# Plan v1",
    "",
    "## Complexity Budget",
    "",
    "- **Files added: 4/3 max** (as of step 9)",
    "- **New abstractions: 1/2 max**",
    "",
    "## Some Later Section",
    "- **Files added: 99/99 max** — a number quoted in prose, outside the budget section",
  ].join("\n");
  const budget = parseComplexityBudget(planText);
  assert.deepEqual(budget, { filesAdded: 4, filesAddedMax: 3, abstractions: 1, abstractionsMax: 2 });

  const items = reconcileComplexityBudget(budget, 4);
  assert.equal(items.length, 1, "4 measured against a cap of 3 is over budget");
  assert.equal(items[0].category, "E");
  assert.equal(items[0].kind, "complexity-budget-exceeded");
  assert.match(items[0].evidence, /caps files added at 3.*adds 4/);
});

test("category E negative: at or under the cap, an unmeasurable diff, and a plan with no budget section are all silent", () => {
  const budget = { filesAdded: 1, filesAddedMax: 3, abstractions: 1, abstractionsMax: 2 };
  assert.deepEqual(reconcileComplexityBudget(budget, 3), [], "AT the cap is not over it");
  assert.deepEqual(reconcileComplexityBudget(budget, 1), []);
  assert.deepEqual(
    reconcileComplexityBudget(budget, null),
    [],
    "git could not measure the diff — reporting a violation from a measurement that does not exist would be an invented finding",
  );
  assert.deepEqual(
    parseComplexityBudget("# Plan v1\n\n## Goal\nno budget section here\n"),
    { filesAdded: null, filesAddedMax: null, abstractions: null, abstractionsMax: null },
  );
  assert.deepEqual(reconcileComplexityBudget(parseComplexityBudget(""), 99), [], "an all-null budget states no cap to exceed");
});

// ---------------------------------------------------------------------------
// The partition
// ---------------------------------------------------------------------------

test("changelogPaths reads paths from well-formed entry lines only", () => {
  const text = [
    "# Changelog",
    "*Field order: `UTC | iter-N/step-M[.K] | commit | path | op | radius | D-NNN-or-dash | reason`*",
    "2026-01-02T03:04:05Z | iter-1/step-1 | abc1234 | src/a.mjs | EDIT(+1,-0) | radius:LOW(1) | - | one",
    "2026-01-02T03:05:05Z | iter-2/step-3.1 | def5678 | src/b.mjs | CREATE(+9) | radius:MED(4) | D-002 | two",
    "2026-01-02T03:06:05Z | not-a-step | abc1234 | src/never.mjs | EDIT(+1,-0) | radius:LOW(1) | - | bad grammar",
  ].join("\n");
  assert.deepEqual([...changelogPaths(text)].sort(), ["src/a.mjs", "src/b.mjs"]);
  assert.equal(changelogPaths("").size, 0);
  assert.equal(changelogPaths(null).size, 0, "a missing changelog must not throw");
});

test("partition: an ANCHOR is classified by PLAN-ID alone, never by whether the file appears in the changelog", () => {
  const active = "plan-2026-09-09T082122-64c4de78";
  const ctx = { paths: new Set(["src/touched.mjs"]), planId: active, planDirRel: `plans/${active}` };

  const mine = classifyProvenance(
    { category: "A", kind: "anchor-orphan", planId: active, file: "src/untouched.mjs" },
    ctx,
  );
  assert.equal(mine.provenance, "introduced", "an anchor naming the ACTIVE plan is this plan's, wherever it sits");
  assert.match(mine.why, new RegExp(active));

  const theirs = classifyProvenance(
    { category: "A", kind: "anchor-unknown-plan", planId: "plan-2026-01-01T000000-deadbeef", file: "src/touched.mjs" },
    ctx,
  );
  assert.equal(
    theirs.provenance,
    "inherited",
    "THE failure this rule prevents: a file-membership test would flip a dead plan's anchor to INTRODUCED the " +
      "moment an unrelated plan touched that file, and the report would read as a permanent false regression",
  );

  // decisions.md D-012. An anchor whose plan-id does not RESOLVE cannot equal the active
  // plan-id, so the rule's second clause can never hold. The predecessor fell through to
  // the file test and reported three pre-existing [anchor-badprefix] anchors as INTRODUCED
  // for the sole reason that this plan had edited their file: file membership is proximity,
  // not attribution.
  for (const kind of ["anchor-unqualified", "anchor-badprefix"]) {
    const unresolvable = classifyProvenance({ category: "A", kind, planId: null, file: "src/touched.mjs" }, ctx);
    assert.equal(
      unresolvable.provenance,
      "inherited",
      `${kind}: an anchor with no resolvable plan-id must be INHERITED even though its file IS in the changelog`,
    );
  }
});

test("partition: plan-directory artifacts are this plan's by construction; other files go by changelog membership", () => {
  const active = "plan-2026-09-09T082122-64c4de78";
  const ctx = { paths: new Set(["src/touched.mjs"]), planId: active, planDirRel: `plans/${active}` };
  assert.equal(
    classifyProvenance({ category: "C", kind: "empty-findings-file", file: `plans/${active}/findings/x.md` }, ctx).provenance,
    "introduced",
  );
  assert.equal(classifyProvenance({ category: "D", kind: "marker-comment", file: "src/touched.mjs" }, ctx).provenance, "introduced");
  assert.equal(classifyProvenance({ category: "D", kind: "marker-comment", file: "src/elsewhere.mjs" }, ctx).provenance, "inherited");
  assert.equal(
    classifyProvenance({ category: "D", kind: "marker-comment", file: null }, ctx).provenance,
    "inherited",
    "a finding with no file cannot be attributed, and an unattributable item must never be minted as a fix",
  );
});

test("commitTagPrefix drops the time segment, normalizes the legacy shape, and refuses a non-plan-id", () => {
  assert.equal(commitTagPrefix("plan-2026-09-09T082122-64c4de78"), "plan-2026-09-09-64c4de78");
  assert.equal(commitTagPrefix("plan_2026-05-07_7556fb98"), "plan-2026-05-07-7556fb98");
  assert.equal(commitTagPrefix("not-a-plan-id"), null, "returning null lets the caller degrade instead of grepping git history for a malformed string");
  assert.equal(commitTagPrefix(""), null);
  assert.equal(commitTagPrefix(null), null);
});

test("resolvePlanDir: the pointer, an explicit --plan-dir, and every way it can honestly fail", () => {
  const { root, planId } = makeFixtureRoot();
  try {
    const viaPointer = resolvePlanDir({ root });
    assert.equal(viaPointer.planId, planId);
    assert.equal(viaPointer.planDirRel, `plans/${planId}`);

    const viaArg = resolvePlanDir({ root, planDirArg: `plans/${planId}` });
    assert.equal(viaArg.planId, planId, "an explicit --plan-dir accepts a path and uses its basename");

    assert.match(resolvePlanDir({ root, planDirArg: "not-a-plan-id" }).reason, /is not a valid plan-id/);
    assert.match(
      resolvePlanDir({ root, planDirArg: "plan-2030-01-01T000000-ffffffff" }).reason,
      /does not exist/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const { root: bare } = makeFixtureRoot({ noPointer: true });
  try {
    const r = resolvePlanDir({ root: bare });
    assert.equal(r.planDirAbs, null);
    assert.match(r.reason, /no plans\/\.current_plan pointer/);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const syntheticReport = (overrides = {}) => ({
  planId: "plan-2026-01-02T030405-abcdef01",
  planDir: "plans/plan-2026-01-02T030405-abcdef01",
  categories: CATEGORIES.map((c) => ({
    id: c.id,
    key: c.key,
    title: c.title,
    status: "ran",
    note: "note",
    findings: 0,
  })),
  introduced: [],
  inherited: [],
  ...overrides,
});

test("formatReport: a DEGRADED category is named as such and is never allowed to look clean", () => {
  const degraded = syntheticReport({
    categories: CATEGORIES.map((c) => ({
      id: c.id,
      key: c.key,
      title: c.title,
      status: c.needsGit ? "unavailable" : "ran",
      note: c.needsGit ? "git unavailable" : "note",
      findings: 0,
    })),
  });
  const text = formatReport(degraded).join("\n");
  assert.match(text, /DEGRADED: B, E/);
  assert.match(text, /a degraded category is NOT a clean category/);
  assert.doesNotMatch(text, /All categories ran/);

  assert.match(formatReport(syntheticReport()).join("\n"), /All categories ran\. No category degraded\./);
});

test("formatReport: the INTRODUCED list is never truncated; the INHERITED list is capped with an explicit remainder", () => {
  const inherited = Array.from({ length: INHERITED_PRINT_LIMIT + 2 }, (_, i) => ({
    category: "A",
    kind: "anchor-unknown-plan",
    file: `src/f${i}.mjs`,
    line: i + 1,
    evidence: `orphan ${i}`,
    remediation: `retire plan-${i}`,
    provenance: "inherited",
    why: "not this plan",
  }));
  const introduced = Array.from({ length: INHERITED_PRINT_LIMIT + 2 }, (_, i) => ({
    category: "D",
    kind: "marker-comment",
    file: `src/g${i}.mjs`,
    line: i + 1,
    evidence: `marker ${i}`,
    remediation: "resolve it",
    provenance: "introduced",
    why: "in this plan's changelog",
  }));
  const text = formatReport(syntheticReport({ inherited, introduced })).join("\n");

  for (const i of introduced) {
    assert.ok(text.includes(i.file), `${i.file} is INTRODUCED — the actionable half is never truncated`);
  }
  assert.ok(text.includes("src/f0.mjs") && !text.includes("src/f11.mjs"), "the inherited list stops at the print limit");
  assert.match(text, /\.\.\. and 2 more \(use --json for the full list\)/);
  assert.match(text, /NOT this plan's regression/);
  assert.match(text, /\.\.\. and 7 more suggested commands/);
});

// ---------------------------------------------------------------------------
// CLI exit paths
// ---------------------------------------------------------------------------

test("CLI: a clean run exits 0 whatever it FINDS — the scanner reports, it does not gate", () => {
  const { root } = makeFixtureRoot();
  try {
    const stub = writeStub(root, "proof.mjs", STUB_PROOF);
    const res = runCliAgainst(root, [], stub);
    assert.equal(res.status, EXIT_OK, `expected exit ${EXIT_OK}; stdout=${res.stdout} stderr=${res.stderr}`);
    // Non-vacuity: the fixture really does carry a finding, so exit 0 is not
    // "clean tree", it is "findings never fail a build". Do not add this script
    // to `make validate`.
    assert.match(res.stdout, /\[D\/marker-comment\] src\/sample\.mjs:2/);
    assert.match(res.stdout, /## Inherited \(1\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI: --self-check exits 0, counts the categories that REALLY ran, and confirms the floor is pinned", () => {
  const { root } = makeFixtureRoot();
  try {
    const stub = writeStub(root, "proof.mjs", STUB_PROOF);
    const res = runCliAgainst(root, ["--self-check"], stub);
    assert.equal(res.status, EXIT_OK, `expected exit ${EXIT_OK}; stderr=${res.stderr}`);
    // The numerator is COMPUTED from the per-category statuses, so it depends on whether
    // this fixture root has git; what is invariant is that the count never exceeds the
    // number that ran, and that a shortfall is named rather than rounded up to 5/5.
    const ran = insideGitWorkTree(root) ? 5 : 3;
    assert.match(res.stdout, new RegExp(`${ran}/${EXPECTED_MIN_CATEGORIES} categories ran`));
    assert.match(res.stdout, ran === 5 ? /no category degraded\./ : /DEGRADED: B \(unavailable\), E \(unavailable\)/);
    assert.match(
      res.stdout,
      new RegExp(`floor pinned: EXPECTED_MIN_CATEGORIES == CATEGORIES\\.length == ${EXPECTED_MIN_CATEGORIES}`),
    );
    assert.doesNotMatch(res.stdout, /FLOOR DRIFT/);
    for (const c of CATEGORIES) {
      assert.ok(res.stdout.includes(c.key), `--self-check must name every category; ${c.key} was absent`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI: --help exits 0 and states the exit-code contract", () => {
  const { root } = makeFixtureRoot();
  try {
    const res = runCliAgainst(root, ["--help"]);
    assert.equal(res.status, EXIT_OK);
    assert.match(res.stdout, /scan-unavailable/);
    assert.match(res.stdout, /NOTHING is written to stdout/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- FALSIFICATION: the three ways the upstream can die, and the one output
// --- that must never appear on any of them.

/**
 * Assert an untrustworthy scan: exit 1, the slug on stderr, an explicit denial
 * that this is an all-clear, and ZERO BYTES on stdout. The byte length is the
 * assertion that matters: an empty JSON body would satisfy a "no findings
 * printed" check while still handing a consumer `{"introduced": []}`.
 */
function assertScanUnavailable(res, why) {
  assert.equal(res.status, EXIT_UNTRUSTWORTHY, `${why}: expected exit ${EXIT_UNTRUSTWORTHY}; stdout=${res.stdout} stderr=${res.stderr}`);
  assert.match(res.stderr, /scan-unavailable/, `${why}: stderr must carry the slug`);
  assert.match(res.stderr, /this is NOT an all-clear/, `${why}: the failure must say what it is not`);
  assert.strictEqual(
    res.stdout.length,
    0,
    `${why}: stdout must be ZERO BYTES, got ${res.stdout.length} (${JSON.stringify(res.stdout.slice(0, 200))}). ` +
      "A false all-clear is the worst output this tool can produce: a consumer that reads an empty findings " +
      "body cannot tell an untrustworthy scan from a clean repo. Do NOT 'improve' this by emitting a partial body.",
  );
}

test("falsification: a MISSING upstream validator exits 1 [scan-unavailable] with zero bytes of stdout, in both output modes", () => {
  const { root } = makeFixtureRoot();
  try {
    const missing = join(root, ".stubs", "not-here.mjs");
    assertScanUnavailable(runCliAgainst(root, [], missing), "plain mode");
    assertScanUnavailable(runCliAgainst(root, ["--json"], missing), "--json mode");
    assertScanUnavailable(runCliAgainst(root, ["--self-check"], missing), "--self-check mode");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("falsification: an upstream that prints NO proof-of-run line exits 1 [scan-unavailable] — format drift is loud, not silent", () => {
  const { root } = makeFixtureRoot();
  try {
    const drifted = writeStub(
      root,
      "drifted.mjs",
      'console.log("Validating plans/x");\nconsole.log("Totals: 0 errors");\n',
    );
    const res = runCliAgainst(root, ["--json"], drifted);
    assertScanUnavailable(res, "no proof-of-run line");
    assert.match(res.stderr, /no proof-of-run line/);
    assert.match(res.stderr, /format may have drifted/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("falsification: an upstream exiting 3 exits 1 [scan-unavailable], even though its output carried a proof line", () => {
  const { root } = makeFixtureRoot();
  try {
    // The proof line is present. The status is not 0 or 1. Trusting the text of
    // a process that crashed is exactly how a partial run becomes an all-clear.
    const crash = writeStub(root, "crash.mjs", `${STUB_PROOF}process.exit(3);\n`);
    const res = runCliAgainst(root, [], crash);
    assertScanUnavailable(res, "upstream exited 3");
    assert.match(res.stderr, /exited 3 \(expected 0 or 1\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- DEGRADATION: no git.

test("degradation: with no git, B and E report `unavailable` while A, C and D still run — and the banner says so", (t) => {
  const { root } = makeFixtureRoot();
  try {
    if (insideGitWorkTree(root)) {
      t.skip(`${tmpdir()} is inside a git work tree on this machine, so the no-git degradation cannot be staged here.`);
      return;
    }
    const stub = writeStub(root, "proof.mjs", STUB_PROOF);
    const res = runCliAgainst(root, ["--json"], stub);
    assert.equal(res.status, EXIT_OK, `degradation is not failure; stderr=${res.stderr}`);
    const report = JSON.parse(res.stdout);
    assert.equal(report.gitAvailable, false);
    assert.deepEqual(
      Object.fromEntries(report.categories.map((c) => [c.id, c.status])),
      { A: "ran", B: "unavailable", C: "ran", D: "ran", E: "unavailable" },
      "only the two git-dependent categories degrade; the other three must keep working",
    );
    for (const id of ["B", "E"]) {
      const c = report.categories.find((x) => x.id === id);
      assert.match(c.note, /git unavailable/, `${id} must SAY why it degraded`);
      assert.notEqual(c.status, "ran", "a degraded category must never be reported with the same status as a clean one");
    }
    // ...and the human-readable banner carries the same warning, so a reader who
    // never opens the JSON cannot mistake a partial sweep for a complete one.
    const plain = runCliAgainst(root, [], stub);
    assert.match(plain.stdout, /DEGRADED: B, E/);
    assert.match(plain.stdout, /a degraded category is NOT a clean category/);
    assert.doesNotMatch(plain.stdout, /All categories ran/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the [scan-floor] guards categories REPORTED, not categories RAN — a degraded run stays an honest exit 0", (t) => {
  const { root } = makeFixtureRoot();
  try {
    if (insideGitWorkTree(root)) {
      t.skip(`${tmpdir()} is inside a git work tree on this machine, so the degraded run cannot be staged here.`);
      return;
    }
    const stub = writeStub(root, "proof.mjs", STUB_PROOF);
    const json = JSON.parse(runCliAgainst(root, ["--json"], stub).stdout);
    assert.equal(json.categoriesRan, 3, "categoriesRan must be COMPUTED from the statuses, never the constant CATEGORIES.length");
    assert.equal(
      json.categoriesReported,
      EXPECTED_MIN_CATEGORIES,
      "a category that degrades at runtime STILL reports a status row; only a category deleted from the " +
        "sweep body lowers this number, and that is the vacuity the floor exists to catch",
    );

    // The consequence, asserted rather than assumed: had the floor been pointed at
    // categoriesRan, every git-less run would exit 1 [scan-floor] and the honest partial
    // report this tool exists to produce would become a hard failure instead.
    const selfCheck = runCliAgainst(root, ["--self-check"], stub);
    assert.equal(selfCheck.status, EXIT_OK, `a degraded run is not an untrustworthy scan; stderr=${selfCheck.stderr}`);
    assert.doesNotMatch(selfCheck.stderr, /scan-floor/);
    assert.match(selfCheck.stdout, /3\/5 categories ran/);
    assert.doesNotMatch(selfCheck.stdout, /5\/5 categories ran/);
    assert.match(
      selfCheck.stdout,
      /2 DEGRADED: B \(unavailable\), E \(unavailable\) — a degraded category is NOT a clean category\./,
      "--self-check must NAME the degraded categories. Printing `5/5 categories ran` from a constant while " +
        "B and E are unavailable is the false all-clear this whole module argues against, in miniature.",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("degradation: with no plan directory at all, A/B/C/E report `degraded` and the code sweep still runs", () => {
  const { root } = makeFixtureRoot({ noPointer: true });
  try {
    const res = runCliAgainst(root, ["--json"]);
    assert.equal(res.status, EXIT_OK, `a missing pointer is not an untrustworthy scan; stderr=${res.stderr}`);
    const report = JSON.parse(res.stdout);
    assert.equal(report.planId, null);
    const byId = Object.fromEntries(report.categories.map((c) => [c.id, c.status]));
    assert.equal(byId.D, "ran", "category D is git-free and plan-free by design — it must survive both degradations");
    for (const id of ["A", "B", "C", "E"]) {
      assert.equal(byId[id], "degraded", `${id} needs a plan directory`);
    }
    assert.match(
      report.categories.find((c) => c.id === "A").note,
      /no plans\/\.current_plan pointer/,
      "with no plan there is nothing to delegate to — that is DEGRADED, not [scan-unavailable]; the upstream is fine",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- The partition, end to end on a fixture.

test("partition end-to-end: the SAME leftover flips inherited -> introduced when this plan's changelog names its file", () => {
  const named = [
    "# Changelog",
    "2026-01-02T03:04:05Z | iter-1/step-1 | abc1234 | src/sample.mjs | EDIT(+2,-0) | radius:LOW(1) | - | this plan touched it",
    "",
  ].join("\n");
  const { root } = makeFixtureRoot({ planFiles: { "changelog.md": named } });
  try {
    const stub = writeStub(root, "proof.mjs", STUB_PROOF);
    const report = JSON.parse(runCliAgainst(root, ["--json"], stub).stdout);
    assert.equal(report.counts.introduced, 1, "the file is named by this plan's changelog, so its leftover is this plan's");
    assert.equal(report.counts.inherited, 0);
    assert.equal(report.introduced[0].file, "src/sample.mjs");
    assert.match(report.introduced[0].why, /appears in this plan's changelog\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The live repository — Pre-Mortem scenario 2's STOP-IF
// ---------------------------------------------------------------------------

test("live repo: the real inherited anchor backlog classifies INHERITED, and NOTHING of category A classifies introduced", (t) => {
  const report = runScan({ root: repoRoot, validatorPath: realValidator });
  assert.ok(!report.unavailable, `the real validator must be runnable from the repo; got: ${report.unavailable}`);
  const categoryA = report.categories.find((c) => c.id === "A");
  if (categoryA.status !== "ran") {
    t.skip(
      `category A is ${categoryA.status} (${categoryA.note}) — plan directories are gitignored, so the anchor ` +
        "corpus this measurement needs does not exist in a fresh clone. Skipped with a reason, never passed silently.",
    );
    return;
  }

  const inheritedA = itemsOf(report, "A", "inherited");
  const introducedA = itemsOf(report, "A", "introduced");

  assert.ok(
    inheritedA.length >= 64,
    `expected at least 64 INHERITED category-A items, got ${inheritedA.length}. This floor is the repo's measured ` +
      "orphan-anchor backlog (75 at the time of writing: 64 [anchor-unknown-plan] errors plus 11 " +
      "[anchor-badprefix] warnings). It is a floor, not an equality, because the number moves whenever a plan " +
      "closes or `bootstrap.mjs retire` runs. If the backlog was genuinely remediated, LOWER this number in the " +
      "same commit that remediates it — do not delete the assertion.",
  );
  assert.deepEqual(
    introducedA.map((i) => `${i.file}:${i.line} ${i.planId}`),
    [],
    "Pre-Mortem scenario 2's STOP-IF. Not one of the repo's inherited anchors may be attributed to the active " +
      "plan: a report that blames a plan for a backlog it did not create reads as a permanent false regression, " +
      "readers learn to ignore the section, and a genuinely new orphan hides in it forever.",
  );
  for (const i of inheritedA) {
    assert.notEqual(i.planId, report.planId, "an inherited anchor must not name the active plan");
    assert.ok(i.remediation, "every inherited item carries a suggested STANDALONE command — reported, never auto-remediated");
  }
  assert.ok(
    inheritedA.some((i) => /bootstrap\.mjs retire /.test(i.remediation)),
    "the dead-plan-id backlog's suggested fix is `bootstrap.mjs retire <plan-id>`, run deliberately and on its own",
  );
});

test("live repo: a SYNTHETIC anchor bearing the active plan-id classifies INTRODUCED — the partition discriminates, it does not just label everything inherited", (t) => {
  // The other half of scenario 2's STOP-IF. Without this, a classifier hard-wired
  // to return "inherited" would pass the test above with full marks.
  const plan = resolvePlanDir({ root: repoRoot });
  if (!plan.planDirAbs) {
    t.skip(`no active plan (${plan.reason}) — plan directories are gitignored, so there is no active plan-id in a fresh clone.`);
    return;
  }
  const synthetic = {
    category: "A",
    kind: "anchor-orphan",
    planId: plan.planId,
    file: "src/scripts/scar-scan.mjs",
    line: 116,
  };
  const paths = changelogPaths(readFileSync(join(plan.planDirAbs, "changelog.md"), "utf8"));
  assert.ok(
    paths.has(synthetic.file),
    `${synthetic.file} must appear in this plan's changelog for this test to mean anything — it pins that the ` +
      "D-012 narrowing (no resolvable plan-id => inherited) did NOT collapse into 'always inherited'",
  );
  const { provenance, why } = classifyProvenance(synthetic, {
    paths,
    planId: plan.planId,
    planDirRel: plan.planDirRel,
  });
  assert.equal(
    provenance,
    "introduced",
    "an anchor naming the ACTIVE plan is the one shape the orchestrator may mint as an iter-N/step-M.K fix; " +
      "if this ever returns inherited, the tool reports a backlog it will never act on and nothing else",
  );
  assert.match(why, new RegExp(plan.planId));
});
