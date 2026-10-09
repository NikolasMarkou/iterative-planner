// Requires Node.js 18+
// Tests for dashboard.mjs — the read-only HTML view of plans/ and its token-usage accounting.
//
// THREE THINGS THIS SUITE EXISTS TO CATCH, ahead of everything else:
//   1. WRONG NUMBERS. Usage is read from Claude Code's session logs, where a streamed reply is logged
//      once per content block under one message id, and a forked sub-agent's log repeats the parent's
//      launching message. Counting either twice inflates every total (on a real repo, skipping the
//      de-duplication more than doubled it). The fixture logs contain both shapes plus a half-written
//      last line, and the expected totals below are written out by hand, not computed by the code
//      under test.
//   2. A WRITE INTO THE REPO. The dashboard is a viewer: the repo tree, including plans/, must be
//      byte- and mtime-identical after a run.
//   3. UNTRUSTED CONTENT REACHING THE PAGE AS MARKUP. Plan files are agent-written; raw HTML in them
//      must render as text.
//
// Fixtures are temp roots (realpath'd, so the CLI's process.cwd() and the test agree on the
// Claude Code project slug); every fixture is removed in a finally block.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  attribute,
  createDashboard,
  defaultOut,
  fmtN,
  ingestLine,
  latestOfKind,
  mdToHtml,
  modelName,
  newestFirst,
  openCommand,
  pairReviews,
  attention,
  parseArgs,
  parseChangelog,
  parseDecisions,
  parsePlan,
  parseProgress,
  parseState,
  parseVerdict,
  parseVerification,
  phaseCode,
  projectSlug,
  readPointer,
  scanFile,
  sessionsOf,
  splitLabel,
  stepsOf,
  timeSeries,
  total,
  transcriptFiles,
  waitingOnYou,
} from "./dashboard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "dashboard.mjs");

// ---------- fixture ----------
const A = "plan-2026-01-10T090000-aaaaaaaa"; // closed: window 2026-01-10 09:00 → 12:00
const B = "plan-2026-01-11T080000-bbbbbbbb"; // live (pointer + EXECUTE): window 2026-01-11 08:00 → open
const C = "plan-2025-12-01T100000-cccccccc"; // archived: INDEX.md row + ledger sections only

const asst = (id, ts, [inp, out, cr, cw], model = "claude-opus-4-1-20250805") =>
  JSON.stringify({ type: "assistant", timestamp: ts, requestId: `req_${id}`, message: { id, model, usage: { input_tokens: inp, output_tokens: out, cache_read_input_tokens: cr, cache_creation_input_tokens: cw }, content: [] } });
const skillCall = JSON.stringify({ type: "user", timestamp: "2026-01-10T09:01:00Z", message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "iterative-planner" } }] } });

function makeFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dash-fixture-")));
  const repo = join(root, "repo"), out = join(root, "out", "dashboard.html"), projects = join(root, "claude", "projects");
  const w = (p, s) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
  const plans = join(repo, "plans");

  w(join(plans, A, "state.md"), [
    "# Current State: CLOSE", "## Iteration: 1", "## Current Plan Step: N/A",
    "## Last Transition: REFLECT → CLOSE (2026-01-10T12:00:00Z)",
    "## Transition History:", "- INIT → EXPLORE (task started)", "- EXPLORE → PLAN (2026-01-10T09:30:00Z)",
    "- PLAN → EXECUTE (2026-01-10T10:00:00Z)", "- EXECUTE → REFLECT (2026-01-10T11:00:00Z)", "- REFLECT → EXECUTE (fix, 2026-01-10T11:10:00Z)",
    "- EXECUTE → REFLECT (2026-01-10T11:30:00Z)", "- REFLECT → CLOSE (2026-01-10T12:00:00Z)", "",
  ].join("\n"));
  w(join(plans, A, "plan.md"), "# Plan v1: Phase 1 — Foundation (demo)\n\n## Goal\nBuild the base.\n\n## Steps\n1. [x] Create TokenService abstraction [RISK: low] [deps: none]\n2. [x] [IRREVERSIBLE] Migration script for existing sessions [RISK: high] [deps: 1]\n\n## Assumptions\n- none\n");
  w(join(plans, A, "summary.md"), "# Summary: Phase 1 — Foundation\n\n**Bottom line**: It shipped behind a flag.\n\n## Outcome\nDone.\n");
  w(join(plans, A, "decisions.md"), "# Decision Log\n<!-- Schema example\n## D-099 | PLAN | YYYY-MM-DD\n**Decision**: example only\n-->\n\n## D-001 | EXPLORE → PLAN | 2026-01-10\n**Context**: c\n**Decision**: Use a service.\n**Trade-off**: x at the cost of y\n**Reasoning**: r\n");
  w(join(plans, A, "verification.md"), "# Verification\n\n## Criteria Verification\n| # | Criterion (from plan.md) | Method | Command/Action | Result | Evidence |\n|---|---|---|---|---|---|\n| 1 | Tests pass | Automated | `npm test` | PASS | 4/4 passed |\n| 2 | Lint clean | Automated | `npm run lint` | FAIL | exit 1 |\n");
  w(join(plans, A, "changelog.md"), "# Changelog\n2026-01-10T10:10:00Z | iter-1/step-1 | abc1234 | src/a.js | EDIT(+1,-0) | radius:LOW(1) | - | add a | b | c\n");
  w(join(plans, A, "progress.md"), "# Progress\n\n## Completed\n- [x] all\n");
  w(join(plans, A, "findings", "review-iter-1.md"), "# Review\n\n<script>alert('pwned')</script>\n\n<img src=x onerror=alert(1)>\n\n[click](javascript:alert(1)) and [docs](https://example.com)\n");

  w(join(plans, B, "state.md"), "# Current State: EXECUTE\n## Iteration: 1\n## Current Plan Step: iter-1/step-2\n## Last Transition: PLAN → EXECUTE (2026-01-11T09:00:00Z)\n## Transition History:\n- INIT → EXPLORE (task started)\n- EXPLORE → PLAN (2026-01-11T08:30:00Z)\n- PLAN → EXECUTE (2026-01-11T09:00:00Z)\n");
  w(join(plans, B, "plan.md"), "# Plan v1: Phase 2 — Wiring\n\n## Goal\n1. Wire it.\n\n## Steps\n1. [x] **Wire the API** [RISK: medium] [deps: none] — DONE def5678\n2. [ ] Add integration tests ← CURRENT [RISK: medium] [deps: 1]\n");
  w(join(plans, B, "decisions.md"), "# Decision Log\n\n## D-001 | PLAN | 2026-01-11\n**Decision**: Wire it <b>boldly</b>.\n");
  w(join(plans, B, "progress.md"), "# Progress\n\n## In Progress\n- [ ] step 2\n");

  w(join(plans, ".current_plan"), `${B}\n`);
  w(join(plans, "INDEX.md"), `# Plan Index\n\n| Plan | Date | Goal | Key Topics |\n|------|------|------|------------|\n| ${C} | 2025-12-01 | Old cleanup work | cleanup |\n`);
  w(join(plans, "FINDINGS.md"), `# Consolidated Findings\n\n## ${C}\nFound old things.\n`);
  w(join(plans, "DECISIONS.md"), `# Consolidated Decisions\n\n## ${C}\n### D-001 | PLAN | 2025-12-01\n**Decision**: Keep it.\n`);
  w(join(plans, "LESSONS.md"), "# Lessons\n- be careful\n");

  // Session logs. Expected totals (tokens = input + output + cacheRead + cacheWrite), by hand:
  //   main m1 (A window)       10+100+1000+50 = 1160  — logged twice (out 5, then 100): max wins
  //   main m2 (between A and B) 1+7+200+0     =  208
  //   main m3 (B)               2+40+3000+100 = 3142
  //   executor e1+e2 (B)        531 + 631     = 1162  — "Execute step 1", so step 1 gets 1162
  //   fork: copy of m3 skipped; own f1 (B)    =  110
  //   other session o1 (no planner)           =   20
  //   A 1160 · B 4414 · between 208 · outside 20 · grand 5802 · 7 unique messages
  const proj = join(projects, projectSlug(repo));
  w(join(proj, "s1.jsonl"), [
    skillCall,
    asst("m1", "2026-01-10T10:30:00Z", [10, 5, 1000, 50]),
    asst("m1", "2026-01-10T10:30:00Z", [10, 100, 1000, 50]),
    asst("m2", "2026-01-10T13:00:00Z", [1, 7, 200, 0]),
    asst("m3", "2026-01-11T09:30:00Z", [2, 40, 3000, 100], "claude-sonnet-4-5"),
    JSON.stringify({ type: "assistant", timestamp: "2026-01-11T09:31:00Z", message: { id: "syn", model: "<synthetic>", usage: { input_tokens: 999, output_tokens: 999 } } }),
    "",
  ].join("\n"));
  w(join(proj, "s1", "subagents", "agent-x1.jsonl"), [asst("e1", "2026-01-11T09:40:00Z", [1, 20, 500, 10]), asst("e2", "2026-01-11T09:45:00Z", [1, 30, 600, 0]), ""].join("\n"));
  w(join(proj, "s1", "subagents", "agent-x1.meta.json"), JSON.stringify({ agentType: "ip-executor", description: "Execute step 1: wire the API" }));
  w(join(proj, "s1", "subagents", "agent-f1.jsonl"), [asst("m3", "2026-01-11T09:30:00Z", [2, 3, 3000, 100], "claude-sonnet-4-5"), asst("f1", "2026-01-11T09:50:00Z", [0, 10, 100, 0]), ""].join("\n"));
  w(join(proj, "s1", "subagents", "agent-f1.meta.json"), JSON.stringify({ agentType: "fork", description: "Side task" }));
  w(join(proj, "s2.jsonl"), [asst("o1", "2026-01-11T10:00:00Z", [5, 5, 5, 5]), ""].join("\n"));

  return { root, repo, out, projects, plans, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const NOW = () => Date.parse("2026-01-11T11:00:00Z");
const dashFor = (fx, extra = {}) => createDashboard({ repo: fx.repo, out: fx.out, projectsDir: fx.projects, worktrees: false, now: NOW, ...extra });
const readData = (fx) => JSON.parse(readFileSync(join(dirname(fx.out), "dashboard", "assets", "data.json"), "utf8"));
const readLive = (fx) => { const s = readFileSync(join(dirname(fx.out), "dashboard", "assets", "live.js"), "utf8"); return JSON.parse(s.slice(s.indexOf("{gen")).replace(/;$/, "").replace(/^\{gen:(\d+),v:/, '{"gen":$1,"v":')); };
function snapshot(dir) {
  const out = {};
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else { const st = statSync(p); out[relative(dir, p)] = `${st.size}|${st.mtimeMs}|${readFileSync(p, "utf8")}`; } } };
  walk(dir);
  return out;
}

// ---------- import + CLI ----------
test("importing the module runs nothing: no output, no files", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dash-import-")));
  try {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(SCRIPT).href)})`], { cwd: root, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "");
    assert.equal(existsSync(defaultOut(root)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CLI: --help exits 0, an unknown option exits 2, a normal run prints where it wrote", () => {
  const fx = makeFixture();
  try {
    assert.equal(spawnSync(process.execPath, [SCRIPT, "--help"], { encoding: "utf8" }).status, 0);
    const bad = spawnSync(process.execPath, [SCRIPT, "--bogus"], { encoding: "utf8" });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /unknown option: --bogus/);
    const r = spawnSync(process.execPath, [SCRIPT, "--out", fx.out], { cwd: fx.repo, encoding: "utf8", env: { ...process.env, CLAUDE_CONFIG_DIR: dirname(fx.projects) } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Dashboard: /);
    assert.ok(existsSync(fx.out));
    assert.equal(readData(fx).plans.find((p) => p.name === A).usage.msgs, 1, "CLAUDE_CONFIG_DIR is honoured for the logs");
  } finally { fx.cleanup(); }
});

test("parseArgs: flags, values, and errors", () => {
  assert.deepEqual(
    (({ watch, open, usage, interval, out, plan }) => ({ watch, open, usage, interval, out, plan }))(parseArgs(["--watch", "--open", "--no-usage", "--interval", "30", "--out", "x.html", "--plan", A])),
    { watch: true, open: true, usage: false, interval: 30, out: "x.html", plan: A });
  assert.equal(parseArgs([]).usage, true, "token usage is on by default");
  assert.equal(parseArgs(["--watch"]).usage, true);
  assert.match(parseArgs(["--out"]).error, /needs a value/);
  assert.match(parseArgs(["--interval", "0"]).error, /--interval/);
});

// ---------- plan-file parsing ----------
test("parsePlan: canonical step lines lose their annotations but keep risk, irreversible and current", () => {
  const { steps } = parsePlan("## Steps\n1. [x] Create TokenService abstraction [RISK: low] [deps: none]\n2. [ ] Wire TokenService into auth middleware  ← CURRENT [RISK: high — format coupling] [deps: 1]\n4. [ ] [IRREVERSIBLE] Migration script for existing sessions [RISK: high] [deps: 1]\n");
  assert.deepEqual(steps.map((s) => [s.key, s.done, s.title, s.risk, s.irreversible, s.current]), [
    ["1", true, "Create TokenService abstraction", "low", false, false],
    ["2", false, "Wire TokenService into auth middleware", "high", false, true],
    ["4", false, "Migration script for existing sessions", "high", true, false],
  ]);
});

test("parsePlan: a bold title wins and a DONE marker yields the commit", () => {
  const { steps } = parsePlan("## Steps\n1. [x] **Wire the API** [RISK: medium] [deps: none] — DONE def5678 (note)\n");
  assert.equal(steps[0].title, "Wire the API");
  assert.equal(steps[0].commit, "def5678");
});

test("parseState: phase, iteration, phase visits, and the last transition's time and detail", () => {
  const s = parseState("# Current State: REFLECT\n## Iteration: 2\n## Current Plan Step: iter-2/step-3\n## Last Transition: EXECUTE → REFLECT (pass 2 after fixes, 2026-01-02T03:04:05Z)\n## Transition History:\n- INIT → EXPLORE (start)\n- EXPLORE → PLAN (x)\n  - confidence: deep\n- PLAN → EXECUTE (x)\n- EXECUTE → REFLECT (x)\n- REFLECT → EXECUTE (x)\n- EXECUTE → REFLECT (x)\n- REFLECT: note without a transition\n");
  assert.equal(s.phase, "REFLECT");
  assert.equal(s.iteration, "2");
  assert.deepEqual([s.visits.EXPLORE, s.visits.PLAN, s.visits.EXECUTE, s.visits.REFLECT, s.visits.CLOSE], [1, 1, 2, 2, 0]);
  assert.equal(s.lastTs, Date.parse("2026-01-02T03:04:05Z"));
  assert.equal(s.lastDetail, "pass 2 after fixes");
  assert.deepEqual(s.hist[1].sub, ["confidence: deep"]);
});

test("parseDecisions: the commented schema example is ignored, a repeated id keeps its last entry, 4-digit ids parse", () => {
  const d = parseDecisions("<!--\n## D-099 | PLAN | YYYY-MM-DD\n**Decision**: example\n-->\n## D-001 | PLAN | 2026-01-01\n**Decision**: first\n## D-001 | PLAN | 2026-01-01\n**Decision**: second\n**Trade-off**: a at the cost of b\n## D-1000 | EXECUTE | 2026-01-02\n**Context**: ctx\n**Decision**: big\n");
  assert.deepEqual(d.map((x) => x.id), ["D-1000", "D-001"]);
  assert.equal(d[1].decision, "second");
  assert.equal(d[1].tradeoff, "a at the cost of b");
  assert.equal(d[0].context, "ctx");
});

test("parseChangelog: a reason containing ' | ' stays whole (shared 8-field splitter)", () => {
  const [e] = parseChangelog("2026-01-10T10:10:00Z | iter-1/step-1 | abc1234 | src/a.js | EDIT(+1,-0) | radius:LOW(1) | - | add a | b | c\n");
  assert.equal(e.step, "iter-1/step-1");
  assert.equal(e.file, "src/a.js");
  assert.equal(e.why, "add a | b | c");
});

test("parseVerification: one row per criterion with its result and evidence", () => {
  const rows = parseVerification("## Criteria Verification\n| # | Criterion (from plan.md) | Method | Command/Action | Result | Evidence |\n|---|---|---|---|---|---|\n| 1 | Tests pass | Automated | `npm test` | PASS | 4/4 passed |\n| 2 | Lint | Automated | `lint` | FAIL | exit 1 |\n## Additional Checks\n| 3 | not a criterion | x | y | PASS | z |\n");
  assert.deepEqual(rows.map((r) => [r.n, r.criterion, r.result, r.evidence]), [["1", "Tests pass", "PASS", "4/4 passed"], ["2", "Lint", "FAIL", "exit 1"]]);
});

test("splitLabel: a 'Phase N —' label splits into kicker, title and note; others pass through", () => {
  assert.deepEqual(splitLabel("Phase 2 — Regroup + quick wins (check-lists)"), { kicker: "Phase 2", title: "Regroup + quick wins", note: "check-lists" });
  assert.deepEqual(splitLabel("Fix the login bug"), { kicker: "", title: "Fix the login bug", note: "" });
  assert.equal(splitLabel("Plan v1: Phase 5 — Confirm Close").kicker, "Phase 5");
  assert.equal(phaseCode("Phase 2 — Wiring"), "2");
});

test("parseVerdict: token and prose verdicts, and missing Verdict is empty", () => {
  assert.deepEqual(parseVerdict("# Review\n\n## Verdict\nNEEDS_WORK\n\n## Findings\nx\n"), { label: "NEEDS WORK", tone: "bad" });
  assert.deepEqual(parseVerdict("## Verdict\nREADY_TO_CLOSE\n"), { label: "READY TO CLOSE", tone: "ok" });
  assert.equal(parseVerdict("# Review\nno verdict heading\n").tone, "na");
});

test("parseVerdict: every verdict word the agents write gets its tone, and free text is never read as a pass", () => {
  const ok = (label) => ({ label, tone: "ok" }), bad = (label) => ({ label, tone: "bad" }), na = (label) => ({ label, tone: "na" });
  const verdict = (body, after = "") => `# Findings\n\n## Verdict\n${body}\n${after}`;
  const rows = [
    // ip-reviewer.md
    ["READY_TO_CLOSE", ok("READY TO CLOSE")],
    ["NEEDS_WORK", bad("NEEDS WORK")],
    ["NEEDS_INVESTIGATION", bad("NEEDS INVESTIGATION")],
    // ip-boyscout.md
    ["CLEAN", ok("CLEAN")],
    ["REMEDIATE", bad("REMEDIATE")],
    ["REPORT_ONLY", na("REPORT_ONLY")],
    ["REPORT_ONLY - 76 inherited items exist and none is critical", na("REPORT_ONLY - 76 inherited items exist and none is\u2026")],
    ["SCAN_UNTRUSTWORTHY", bad("SCAN UNTRUSTWORTHY")],
    // the other words the table accepts
    ["READY", ok("READY")], ["PASS", ok("PASS")], ["OK", ok("OK")],
    // spelling: spaces for underscores, case, decoration, trailing reason
    ["NEEDS WORK", bad("NEEDS WORK")], ["READY TO CLOSE", ok("READY TO CLOSE")], ["needs_investigation", bad("NEEDS INVESTIGATION")],
    ["scan untrustworthy", bad("SCAN UNTRUSTWORTHY")],
    ["**CLEAN**", ok("CLEAN")], ["`NEEDS_WORK`", bad("NEEDS WORK")], ["> REMEDIATE", bad("REMEDIATE")],
    ["NEEDS_WORK: two criticals remain", bad("NEEDS WORK")],
    ["Overall: NEEDS_INVESTIGATION", bad("NEEDS INVESTIGATION")],
    // "not ready" contains READY and must not read as a pass
    ["Not ready to close: 2 criticals", bad("Not ready to close: 2 criticals")],
    ["Work is not yet ready", bad("Work is not yet ready")],
    ["unready", bad("unready")],
    // the unfilled template lists the choices and is no verdict
    ["READY_TO_CLOSE / NEEDS_WORK / NEEDS_INVESTIGATION", na("")],
    ["CLEAN / REMEDIATE / REPORT_ONLY / SCAN_UNTRUSTWORTHY", na("")],
    ["READY_TO_CLOSE/NEEDS_WORK", na("")],
    // the whole block is read, not only its first line
    ["Blockers remain.\nNEEDS_WORK", bad("NEEDS WORK")],
    ["The scan ran.\n\nCLEAN", ok("CLEAN")],
    ["Two items.\nSCAN_UNTRUSTWORTHY", bad("SCAN UNTRUSTWORTHY")],
    ["Blockers remain.\nOverall: NEEDS_WORK", bad("NEEDS WORK")],
    ["Overall: SCAN_UNTRUSTWORTHY", bad("SCAN UNTRUSTWORTHY")],
    ["READY_TO_CLOSE / NEEDS_WORK / NEEDS_INVESTIGATION\nNEEDS_INVESTIGATION", bad("NEEDS INVESTIGATION")],
    // a negation before the underscore or hyphen form is still "not ready"
    ["Not READY_TO_CLOSE: two criticals", bad("Not READY_TO_CLOSE: two criticals")],
    ["not ready_to_close", bad("not ready_to_close")],
    ["not ready-to-close", bad("not ready-to-close")],
    // a common word leads only when nothing but a separator or the end follows; a strong word later in the line wins
    ["Pass 2: NEEDS_WORK", bad("NEEDS WORK")],
    ["OK, so overall NEEDS_WORK", bad("NEEDS WORK")],
    ["Clean-up still needed. REMEDIATE", bad("REMEDIATE")],
    ["Ready? No. NEEDS_WORK", bad("NEEDS WORK")],
    ["Ready? No.", na("Ready? No.")],
    ["PASS: every check green", ok("PASS")], ["CLEAN - nothing found", ok("CLEAN")], ["OK (two notes)", ok("OK")], ["**READY**", ok("READY")],
    // a real verdict that quotes some of the choices is kept; only the line made of choices alone is the template
    ["NEEDS_WORK (was READY_TO_CLOSE / NEEDS_WORK last pass)", bad("NEEDS WORK")],
    ["`READY_TO_CLOSE` / `NEEDS_WORK`", na("")],
    // hyphens read like underscores
    ["NEEDS-WORK", bad("NEEDS WORK")], ["NEEDS-INVESTIGATION", bad("NEEDS INVESTIGATION")], ["READY-TO-CLOSE", ok("READY TO CLOSE")],
    ["scan-untrustworthy", bad("SCAN UNTRUSTWORTHY")],
    // free text and unknown words stay neutral; critical alone is bad
    ["Looks fine, all checks pass.", na("Looks fine, all checks pass.")],
    ["MAYBE", na("MAYBE")],
    ["Two critical items found", bad("Two critical items found")],
    ["", na("")],
  ];
  for (const [body, want] of rows) assert.deepEqual(parseVerdict(verdict(body)), want, JSON.stringify(body));
  // The block ends at the next heading: a later section's words are not the verdict.
  assert.deepEqual(parseVerdict(verdict("NEEDS_INVESTIGATION", "\n## Notes\nREADY_TO_CLOSE\n")), bad("NEEDS INVESTIGATION"));
  assert.deepEqual(parseVerdict(verdict("No opinion yet.", "\n## Notes\nNEEDS_WORK\nREMEDIATE\n")), na("No opinion yet."));
  assert.deepEqual(parseVerdict(verdict("", "\n## Notes\nNEEDS_WORK\n")), na(""), "an empty Verdict block does not borrow the next section");
  // A real file shape: sections before and after, the Verdict not on the first line of the file.
  const file = "# Review iter 1\n\n## Concerns\n- READY_TO_CLOSE is premature\n\n## Blind Spots\n- none\n\n## Verdict\nNeeds a second look.\nNEEDS_INVESTIGATION\n\n## Appendix\nREADY_TO_CLOSE\n";
  assert.deepEqual(parseVerdict(file), bad("NEEDS INVESTIGATION"));
  assert.deepEqual(parseVerdict("# Review\n\n## Concerns\nNEEDS_WORK\n"), na(""), "no Verdict heading, no verdict");
  // Heading shapes: the verdict on the heading line, a deeper heading, and the block ends at a heading of the same or a higher level.
  assert.deepEqual(parseVerdict("# Review\n\n## Verdict: NEEDS_WORK\n\n## Notes\nREADY_TO_CLOSE\n"), bad("NEEDS WORK"));
  assert.deepEqual(parseVerdict("# Review\n\n## Verdict: READY_TO_CLOSE / NEEDS_WORK\nNEEDS_INVESTIGATION\n"), bad("NEEDS INVESTIGATION"));
  assert.deepEqual(parseVerdict("# Review\n\n### Verdict\nNEEDS_WORK\n"), bad("NEEDS WORK"));
  assert.deepEqual(parseVerdict("# Review\n\n#### Verdict\nNo opinion yet.\n\n#### Notes\nNEEDS_WORK\n"), na("No opinion yet."));
  assert.deepEqual(parseVerdict("# Review\n\n### Verdict\nNo opinion yet.\n\n## Notes\nNEEDS_WORK\n"), na("No opinion yet."), "a higher-level heading ends a ### block");
  assert.deepEqual(parseVerdict("# Review\n\n## Verdicts\nNEEDS_WORK\n"), na(""), "only the Verdict heading counts");
  // A fenced example inside the block is not the verdict, whatever it contains.
  assert.deepEqual(parseVerdict(verdict("Example of a finished review:\n```\nREADY_TO_CLOSE\n```\nNEEDS_WORK")), bad("NEEDS WORK"));
  assert.deepEqual(parseVerdict(verdict("```md\n## Verdict\nREADY_TO_CLOSE\n```\nNEEDS_INVESTIGATION")), bad("NEEDS INVESTIGATION"));
  assert.deepEqual(parseVerdict(verdict("```\nREADY_TO_CLOSE\n```")), na(""), "a block holding only a fence has no verdict");
});

test("generate: NEEDS_INVESTIGATION and SCAN_UNTRUSTWORTHY show as bad and a template line shows as neutral", () => {
  const fx = makeFixture();
  try {
    setPlan(fx, B, "REFLECT", "1. [ ] Wire the API [RISK: low]");
    const dir = join(fx.plans, B, "findings");
    mkdirSync(dir, { recursive: true });
    const put = (name, verdict, sec) => { writeFileSync(join(dir, `${name}.md`), `# Findings\n\n## Verdict\n${verdict}\n`); utimesSync(join(dir, `${name}.md`), sec, sec); };
    put("review-iter-1", "NEEDS_INVESTIGATION", 1000);
    put("hygiene-iter-1", "SCAN_UNTRUSTWORTHY", 2000);
    dashFor(fx).generate();
    const bad = planPage(fx, B);
    assert.match(bad, /<span class="tag rv-bad"><i><\/i>NEEDS INVESTIGATION<\/span>/);
    assert.match(bad, /<span class="tag rv-bad"><i><\/i>SCAN UNTRUSTWORTHY<\/span>/);
    assert.match(bad, /<b>Review needs work<\/b>/);
    assert.match(bad, /<b>Hygiene wants a fix<\/b>/);
    put("review-iter-1-pass2", "READY_TO_CLOSE / NEEDS_WORK / NEEDS_INVESTIGATION", 3000);
    dashFor(fx).generate();
    const tpl = planPage(fx, B);
    assert.doesNotMatch(tpl, /tag rv-ok/, "the unfilled template line is not a green verdict");
    assert.doesNotMatch(tpl, /Review needs work/, "and a neutral newest pass does not nag");
  } finally { fx.cleanup(); }
});

test("attention: PLAN and Confirm Close wait on you; EXECUTE with agent work does not wait on a later owner-run remaining", () => {
  assert.equal(attention({ state: { phase: "CLOSE", hist: [] }, progress: { remaining: [], blocked: [], flags: [] }, verification: [], stepList: [], reviews: [] }).length, 0);
  const plan = attention({
    state: { phase: "PLAN", hist: [] },
    progress: { remaining: [], blocked: [], flags: [] },
    verification: [],
    stepList: [{ key: "1", done: false, title: "Draft", irreversible: false }],
    reviews: [],
  });
  assert.equal(plan[0].who, "you");
  assert.match(plan[0].title, /Approve/);
  const exec = attention({
    state: { phase: "EXECUTE", hist: [] },
    progress: { remaining: [{ done: false, text: "Steps 16–19 — owner-run cutover" }], blocked: [], flags: [] },
    verification: [],
    stepList: [
      { key: "1", done: false, title: "Wire the API", irreversible: false },
      { key: "16", done: false, title: "owner-run cutover", irreversible: false },
    ],
    reviews: [],
  });
  assert.equal(exec.some((x) => x.who === "you"), false, "a later owner-run remaining is not waiting while agents still have work");
  const reflect = attention({
    state: { phase: "REFLECT", hist: [] },
    progress: { remaining: [], blocked: [], flags: [] },
    verification: [{ result: "PENDING" }, { result: "PENDING" }],
    stepList: [{ key: "1", done: true, title: "done", irreversible: false }],
    reviews: [{ kind: "Review", tone: "ok", label: "READY TO CLOSE", name: "review-iter-1" }],
  });
  assert.ok(reflect.some((x) => x.title === "Confirm Close"));
  assert.ok(reflect.some((x) => x.title === "Checks still the PLAN template"));
});

// A step as parsePlan would hand it over; `n` is the step key.
const stp = (n, title, extra = {}) => ({ key: String(n), done: false, title, irreversible: false, ...extra });
const wm = (phase, stepList, extra = {}) => ({ state: { phase, hist: [] }, progress: { remaining: [], blocked: [], flags: [] }, verification: [], stepList, reviews: [], ...extra });

test("waitingOnYou: only PLAN, EXECUTE and REFLECT wait, and the owner owes the LEADING run of owner-run steps", () => {
  const ownerFirst = [stp(1, "Run the migration", { irreversible: true }), stp(2, "Prod cutover", { irreversible: true }), stp(3, "Wire the API"), stp(4, "Owner-run deploy")];
  const w = waitingOnYou(wm("EXECUTE", ownerFirst));
  assert.equal(w.kind, "owner-step");
  assert.deepEqual(w.steps.map((x) => x.key), ["1", "2"], "the run stops at the first agent step; step 4 is behind it");
  assert.equal(w.detail, "Run the migration");
  assert.equal(waitingOnYou(wm("EXECUTE", [stp(1, "Wire the API"), stp(2, "Run the migration", { irreversible: true })])), null, "an owner step behind an agent step is not waiting yet");
  assert.equal(waitingOnYou(wm("REFLECT", [stp(1, "Wire the API"), stp(2, "Run the migration", { irreversible: true })])), null, "agent first, owner later: nobody is asking the owner yet");
  assert.equal(waitingOnYou(wm("EXECUTE", [stp(1, "Wire the API")])), null);
  for (const phase of ["CLOSE", "EXPLORE", "PIVOT"]) {
    assert.equal(waitingOnYou(wm(phase, ownerFirst)), null, `${phase} never waits on the owner`);
  }
  assert.equal(waitingOnYou(wm("PLAN", [])).kind, "approve");
  assert.equal(waitingOnYou(wm("REFLECT", [stp(1, "done", { done: true })])).kind, "confirm-close");
  assert.equal(waitingOnYou(wm("REFLECT", [stp(1, "Fix it")])).kind, "confirm-close", "only agent steps left and no review problem");
  const bad = [{ kind: "Review", tone: "bad", label: "NEEDS WORK", name: "review-iter-1" }];
  assert.equal(waitingOnYou(wm("REFLECT", [stp(1, "Fix it")], { reviews: bad })), null, "a review that needs work with an agent step next is the agents' turn");
  assert.equal(waitingOnYou(wm("REFLECT", [], { reviews: bad })).kind, "confirm-close", "nothing left for the agents to fix");
  assert.equal(waitingOnYou(wm("REFLECT", [stp(1, "Run it", { irreversible: true })], { reviews: bad })).kind, "owner-step");
});

test("waitingOnYou: the owner words match whole words only, so CODEOWNERS and ownership are agent work", () => {
  assert.equal(waitingOnYou(wm("EXECUTE", [stp(1, "Update CODEOWNERS file")])), null);
  assert.equal(waitingOnYou(wm("EXECUTE", [stp(1, "Add ownership tests")])), null);
  assert.equal(waitingOnYou(wm("EXECUTE", [stp(1, "Owner-run deploy")])).kind, "owner-step");
  assert.equal(waitingOnYou(wm("EXECUTE", [stp(1, "Deploy (owner-paced)")])).kind, "owner-step");
  assert.equal(waitingOnYou(wm("EXECUTE", [stp(1, "Drop the table [IRREVERSIBLE]")])).kind, "owner-step");
  const rem = (text) => attention(wm("EXECUTE", [], { progress: { remaining: [{ done: false, text }], blocked: [], flags: [] } })).filter((x) => x.who === "you");
  assert.equal(rem("Update CODEOWNERS file").length, 0, "a Remaining line is matched by whole words too");
  assert.equal(rem("Add ownership tests").length, 0);
  assert.equal(rem("Update the handoffs doc").length, 0, "hand-off must stand alone as a word");
  assert.deepEqual(rem("Owner-run cutover").map((x) => x.title), ["Owner remaining"]);
  assert.deepEqual(rem("Hand-off to ops").map((x) => x.title), ["Owner remaining"]);
  assert.deepEqual(rem("Handoff to ops").map((x) => x.title), ["Owner remaining"]);
});

test("attention: an owner step that comes FIRST waits on you even with agent steps after it", () => {
  const ownerFirst = attention(wm("EXECUTE", [stp(1, "Run the migration", { irreversible: true }), stp(2, "Wire the API")]));
  assert.deepEqual(ownerFirst.filter((x) => x.who === "you").map((x) => [x.title, x.detail]), [["Step 1", "Run the migration"]]);
  const later = attention(wm("EXECUTE", [stp(1, "Wire the API"), stp(2, "Run the migration", { irreversible: true })]));
  assert.equal(later.some((x) => x.who === "you"), false);
  const two = attention(wm("EXECUTE", [stp(1, "Run the migration", { irreversible: true }), stp(2, "Prod cutover", { irreversible: true }), stp(3, "Wire the API")]));
  assert.deepEqual(two.filter((x) => x.who === "you").map((x) => x.title), ["Step 1", "Step 2"]);
  const dup = attention(wm("EXECUTE", [stp(1, "Run the migration", { irreversible: true })], { progress: { remaining: [{ done: false, text: "Step 1 — owner-run migration" }], blocked: [], flags: [] } }));
  assert.deepEqual(dup.filter((x) => x.who === "you").map((x) => x.title), ["Step 1"], "a Remaining line for a step already listed is not listed twice");
});

test("attention: nothing says 'you' in CLOSE, EXPLORE or PIVOT, hand-off flags included; EXECUTE and REFLECT still show them", () => {
  const flags = { remaining: [{ done: false, text: "Owner-run cutover" }], blocked: [], flags: ["Ship it"] };
  for (const phase of ["CLOSE", "EXPLORE", "PIVOT"]) {
    const a = attention(wm(phase, [stp(1, "Prod cutover", { irreversible: true })], { progress: flags }));
    assert.equal(a.some((x) => x.who === "you"), false, `${phase} has no 'you' item`);
  }
  for (const phase of ["EXECUTE", "REFLECT"]) {
    const a = attention(wm(phase, [], { progress: flags }));
    assert.deepEqual(a.filter((x) => x.who === "you").map((x) => x.title).sort(), phase === "REFLECT" ? ["Confirm Close", "Hand-off", "Owner remaining"] : ["Hand-off", "Owner remaining"], phase);
  }
});

const D = "plan-2026-01-12T080000-dddddddd"; // a second open plan, for the cross-plan box
function setPlan(fx, id, phase, steps, extra = {}) {
  const w = (p, text) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };
  w(join(fx.plans, id, "state.md"), `# Current State: ${phase}\n## Iteration: 1\n## Current Plan Step: iter-1/step-1\n## Last Transition: PLAN → EXECUTE (2026-01-12T09:00:00Z)\n## Transition History:\n- INIT → EXPLORE (task started)\n- PLAN → EXECUTE (2026-01-12T09:00:00Z)\n`);
  w(join(fx.plans, id, "plan.md"), `# Plan v1: ${extra.title ?? "Phase 9 — Cutover"}\n\n## Goal\n1. Cut over.\n\n## Steps\n${steps}\n`);
  if (extra.progress) w(join(fx.plans, id, "progress.md"), extra.progress);
}
const planPage = (fx, id) => readFileSync(join(dirname(fx.out), "dashboard", "p", `${id}.html`), "utf8");
const OWNER_FIRST = "1. [ ] [IRREVERSIBLE] Run the migration [RISK: high]\n2. [ ] Wire the API [RISK: low]\n3. [ ] [IRREVERSIBLE] Prod cutover [RISK: high]";
const TAG_WAIT = '<span class="tag">waiting on you</span>', TAG_IRR = '<span class="tag">irreversible</span>';

test("generate: an owner-first plan is waiting on you in the hero, the section, the tab link, the step tag and the other plan's box", () => {
  const fx = makeFixture();
  try {
    setPlan(fx, B, "EXECUTE", OWNER_FIRST);
    setPlan(fx, D, "EXECUTE", OWNER_FIRST);
    dashFor(fx).generate();
    const page = planPage(fx, D);
    assert.match(page, /<p class="now-h"><span>Waiting for you<\/span> — Run the migration/);
    assert.match(page, /<section class="wait" id="waiting">/);
    assert.match(page, /<a href="#waiting">Waiting on you<\/a>/);
    assert.match(page, /<b>Step 1<\/b>/);
    assert.equal(page.split(TAG_WAIT).length - 1, 1, "only step 1 is tagged 'waiting on you'");
    assert.equal(page.split(TAG_IRR).length - 1, 1, "step 3 sits behind an agent step and keeps the plain tag");
    const live = planPage(fx, B);
    assert.match(live, /Other open plans/, "the live plan's page lists the other plan that needs you");
    assert.match(live, /1 still need you/);
    assert.match(live, /<a href="#waiting">/);
  } finally { fx.cleanup(); }
});

test("generate: an owner step behind an agent step is not waiting: plain 'irreversible' tag, no hero claim, no section", () => {
  const fx = makeFixture();
  try {
    setPlan(fx, B, "EXECUTE", "1. [ ] Wire the API [RISK: low]\n2. [ ] [IRREVERSIBLE] Run the migration [RISK: high]");
    dashFor(fx).generate();
    const page = planPage(fx, B);
    assert.equal(page.includes(TAG_WAIT), false);
    assert.equal(page.split(TAG_IRR).length - 1, 1);
    assert.doesNotMatch(page, /Waiting for you/);
    assert.doesNotMatch(page, /id="waiting"/);
  } finally { fx.cleanup(); }
});

test("generate: CLOSE, EXPLORE and PIVOT plans with an unticked [IRREVERSIBLE] step claim nothing and are not owed", () => {
  for (const phase of ["CLOSE", "EXPLORE", "PIVOT"]) {
    const fx = makeFixture();
    try {
      setPlan(fx, D, phase, "1. [ ] [IRREVERSIBLE] Prod cutover [RISK: high]", { progress: "# Progress\n\n## Hand-off flags\n- Ship it\n" });
      dashFor(fx).generate();
      const page = planPage(fx, D);
      assert.doesNotMatch(page, /Waiting for you/, phase);
      assert.equal(page.includes(TAG_WAIT), false, phase);
      assert.doesNotMatch(page, /id="waiting"/, phase);
      assert.doesNotMatch(planPage(fx, B), /Other open plans/, `${phase}: the live plan's box does not list it`);
    } finally { fx.cleanup(); }
  }
});

test("generate: a PLAN-phase plan asks for approval in the hero and the section", () => {
  const fx = makeFixture();
  try {
    setPlan(fx, B, "PLAN", "1. [ ] Wire the API [RISK: low]");
    dashFor(fx).generate();
    const page = planPage(fx, B);
    assert.match(page, /<p class="now-h"><span>Waiting for you<\/span> — Approve this plan to start Execute\./);
    assert.match(page, /<b>Approve the plan<\/b>/);
  } finally { fx.cleanup(); }
});

test("generate: steps that merely contain 'owner' inside another word do not wait on you", () => {
  const fx = makeFixture();
  try {
    setPlan(fx, B, "EXECUTE", "1. [ ] Update CODEOWNERS file [RISK: low]\n2. [ ] Add ownership tests [RISK: low]");
    dashFor(fx).generate();
    const page = planPage(fx, B);
    assert.doesNotMatch(page, /Waiting for you/);
    assert.doesNotMatch(page, /id="waiting"/);
    setPlan(fx, B, "EXECUTE", "1. [ ] Owner-run deploy [RISK: low]\n2. [ ] Add ownership tests [RISK: low]");
    dashFor(fx).generate();
    assert.match(planPage(fx, B), /<p class="now-h"><span>Waiting for you<\/span> — Owner-run deploy/);
  } finally { fx.cleanup(); }
});

// A review or hygiene record as build() hands it over; `ms` is the file mtime, `name` the file name without .md.
const rv = (name, tone, ms, label = tone === "bad" ? "NEEDS WORK" : "READY TO CLOSE") => ({ kind: /^hygiene/.test(name) ? "Hygiene" : "Review", name, tone, label, ms });
const youTitles = (phase, steps, reviews) => attention(wm(phase, steps, { reviews })).map((x) => x.title);

test("parseProgress: an item that IS the placeholder is dropped; '(none' inside real text survives", () => {
  const p = parseProgress([
    "# Progress", "", "## In Progress", "- (none yet)", "- Handle (none) values in the parser", "",
    "## Remaining", "- [ ] (none)", "- [ ] (None yet)", "- [ ] Steps 3-4 owner-run cutover", "- [x] Step 2 done", "",
    "## Blocked", "- (none — nothing is blocked)", "- Waiting for a key (none issued yet)", "",
    "## Hand-off flags", "- (none yet)", "- Ship it", "",
  ].join("\n"));
  assert.deepEqual(p.inProgress, ["Handle (none) values in the parser"], "a real item that mentions (none) is kept");
  assert.deepEqual(p.remaining.map((r) => [r.done, r.text]), [[false, "Steps 3-4 owner-run cutover"], [true, "Step 2 done"]], "unticked and ticked placeholders are gone, real lines keep their tick");
  assert.deepEqual(p.blocked, ["Waiting for a key (none issued yet)"]);
  assert.deepEqual(p.flags, ["Ship it"]);
});

test("attention: a Remaining 'Steps 3-4' owner line stops counting once those steps are ticked", () => {
  const rem = (text) => ({ progress: { remaining: [{ done: false, text }], blocked: [], flags: [] } });
  const owner = (steps, text) => attention(wm("REFLECT", steps, rem(text))).filter((x) => x.title === "Owner remaining").length;
  const open = [stp(3, "Cut over"), stp(4, "Verify cutover")];
  const ticked = [stp(3, "Cut over", { done: true }), stp(4, "Verify cutover", { done: true })];
  assert.equal(owner(open, "Steps 3-4 owner-run cutover"), 1, "steps still open: the owner line counts");
  assert.equal(owner(ticked, "Steps 3-4 owner-run cutover"), 0, "every step in the range ticked: it no longer counts");
  assert.equal(owner(ticked, "Steps 3–4 owner-run cutover"), 0, "an en dash is a range too");
  assert.equal(owner([stp(3, "Cut over", { done: true }), stp(4, "Verify cutover")], "Steps 3-4 owner-run cutover"), 1, "one open step in the range keeps it");
  assert.equal(owner([stp(3, "Cut over", { done: true })], "Step 3 owner-run cutover"), 0, "a single step reads the same way");
  assert.equal(owner([stp(3, "Cut over", { done: true }), stp(5, "Later work")], "Step 3 owner-run cutover"), 0, "a single step does not look at the steps after it");
  assert.equal(owner([stp(3, "Cut over", { done: true }), stp("3.1", "Fix 3")], "Step 3 owner-run cutover"), 0, "a sub-step key does not reopen its parent");
  assert.equal(owner(ticked, "Owner-run cutover after the window"), 1, "a line with no step number always counts");
  assert.equal(owner([], "Steps 3-4 owner-run cutover"), 1, "no step list to check against: it counts");
});

const histWith = (...lines) => lines.map((text) => ({ text, sub: [] }));

test("attention: a skipped hygiene sweep is a note, only in REFLECT and only while no hygiene pass exists", () => {
  const hist = histWith("EXECUTE → REFLECT (2026-01-11T10:00:00Z)", "HYGIENE SKIP (docs only): no code changed");
  const notes = (phase, reviews = []) => attention(wm(phase, [stp(1, "Done", { done: true })], { state: { phase, hist }, reviews })).filter((x) => x.title === "Hygiene sweep skipped");
  const [n] = notes("REFLECT");
  assert.equal(n.who, "note");
  assert.equal(n.detail, "no code changed", "the HYGIENE SKIP prefix is stripped, the reason is kept");
  assert.equal(notes("REFLECT", [rv("hygiene-iter-1", "ok", 1000, "CLEAN")]).length, 0, "a sweep that did run replaces the note");
  assert.equal(notes("REFLECT", [rv("review-iter-1", "ok", 1000)]).length, 1, "a review is not a hygiene pass");
  assert.equal(notes("EXECUTE").length, 0);
  assert.equal(notes("CLOSE").length, 0);
  assert.equal(attention(wm("REFLECT", [stp(1, "Done", { done: true })])).some((x) => x.title === "Hygiene sweep skipped"), false, "no HYGIENE SKIP line, no note");
});

// A REFLECT plan page with the given Transition History lines and verification rows (result, evidence).
function reflectPage(fx, { hist = [], rows = [], findings = {} } = {}) {
  writeFileSync(join(fx.plans, B, "state.md"), [
    "# Current State: REFLECT", "## Iteration: 1", "## Current Plan Step: N/A",
    "## Last Transition: EXECUTE → REFLECT (2026-01-11T10:00:00Z)",
    "## Transition History:", "- INIT → EXPLORE (task started)", "- PLAN → EXECUTE (2026-01-11T09:00:00Z)",
    "- EXECUTE → REFLECT (2026-01-11T10:00:00Z)", ...hist.map((h) => `- ${h}`), "",
  ].join("\n"));
  for (const [name, text] of Object.entries(findings)) { mkdirSync(join(fx.plans, B, "findings"), { recursive: true }); writeFileSync(join(fx.plans, B, "findings", name), text); }
  if (rows.length) {
    writeFileSync(join(fx.plans, B, "verification.md"), `# Verification\n\n## Criteria Verification\n| # | Criterion (from plan.md) | Method | Command/Action | Result | Evidence |\n|---|---|---|---|---|---|\n${rows.map((r, i) => `| ${i + 1} | Criterion ${i + 1} | Automated | \`npm test\` | ${r} | ${r === "PASS" ? "ok" : ""} |`).join("\n")}\n`);
  }
  dashFor(fx).generate();
  return planPage(fx, B);
}

test("generate: a skipped hygiene sweep shows as a note and as a Skipped row, and a real hygiene pass replaces both", () => {
  const fx = makeFixture();
  try {
    const hist = ["HYGIENE SKIP (docs only): no code changed"];
    const skipped = reflectPage(fx, { hist });
    assert.match(skipped, /<li class="who-note"><span class="wait-who">Note<\/span><div><b>Hygiene sweep skipped<\/b><p>no code changed<\/p>/, "the attention note");
    assert.match(skipped, /<span class="rv-k">Hygiene<\/span><div class="pair-cols"><div><span class="muted">This reflect<\/span><span class="tag rv-na"><i><\/i>Skipped<\/span><p class="muted">no code changed<\/p>/, "the Skipped row in Review + hygiene");
    const swept = reflectPage(fx, { hist, findings: { "hygiene-iter-1.md": "# Hygiene\n\n## Verdict\nCLEAN\n" } });
    assert.ok(!/Hygiene sweep skipped/.test(swept));
    assert.ok(!/This reflect/.test(swept));
  } finally { fx.cleanup(); }
});

test("generate: all-PENDING checks in REFLECT say so in the Checks heading and footer, not only in the attention list", () => {
  const fx = makeFixture();
  try {
    const page = reflectPage(fx, { rows: ["PENDING", "PENDING"] });
    // The attention list says "Checks still the PLAN template" / "2 rows still PENDING"; these two strings exist only in the Checks section.
    assert.match(page, /2 still PENDING — PLAN template/, "the Checks heading");
    assert.match(page, /These rows are still the PLAN template\. The verifier has not filled them in\. verification\.md written/, "the Checks footer");
    assert.ok(!/it may predate the latest fixes/.test(page), "the template footer replaces the stale-file hint");
    const mixed = reflectPage(fx, { rows: ["PASS", "PENDING"] });
    assert.match(mixed, /1 of 2 pass · 1 pending/, "partly filled rows get the plain count");
    assert.ok(!/still PENDING — PLAN template/.test(mixed));
    assert.ok(!/These rows are still the PLAN template/.test(mixed));
    assert.ok(!/Checks still the PLAN template/.test(mixed), "and the attention row goes too");
  } finally { fx.cleanup(); }
});

test("generate: all-PENDING checks outside REFLECT are labelled by phase and carry no 'verifier has not filled' footer", () => {
  const fx = makeFixture();
  try {
    const rows = "| 1 | Criterion 1 | Automated | `npm test` | PENDING | |\n| 2 | Criterion 2 | Automated | `npm test` | PENDING | |\n";
    writeFileSync(join(fx.plans, B, "verification.md"), `# Verification\n\n## Criteria Verification\n| # | Criterion (from plan.md) | Method | Command/Action | Result | Evidence |\n|---|---|---|---|---|---|\n${rows}`);
    for (const [phase, label] of [["EXECUTE", /<span class="sh-x">2 pending<\/span>/], ["PLAN", /<span class="sh-x">PLAN template<\/span>/]]) {
      setPlan(fx, B, phase, "1. [ ] Wire the API [RISK: low]");
      dashFor(fx).generate();
      const page = planPage(fx, B);
      assert.match(page, label, phase);
      assert.ok(!/These rows are still the PLAN template/.test(page), phase);
    }
  } finally { fx.cleanup(); }
});

// Mark every file of a plan with one mtime, so "latest activity" is exactly what a test says it is.
function touchPlan(fx, id, ms) {
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else utimesSync(p, ms / 1000, ms / 1000); } };
  walk(join(fx.plans, id));
}
const chipOrder = (html) => [...html.matchAll(/<a class="open-chip [^"]*"[^>]*><b>([^<]*)<\/b>/g)].map((m) => m[1]);
const E = "plan-2026-01-13T080000-eeeeeeee", F = "plan-2026-01-14T080000-ffffffff", G = "plan-2026-01-15T080000-99999999";

test("generate: open chips sort by phase code, numbers as numbers and a letter after its number; plans without a code come last", () => {
  const fx = makeFixture();
  try {
    const step = "1. [ ] Wire the API [RISK: low]";
    setPlan(fx, B, "EXECUTE", step, { title: "Phase 2 — Wiring" });
    setPlan(fx, D, "EXECUTE", step, { title: "Phase 10 — Late" });
    setPlan(fx, E, "EXECUTE", step, { title: "Phase 2b — Follow-up" });
    setPlan(fx, F, "EXECUTE", step, { title: "Alpha cleanup" });
    setPlan(fx, G, "EXECUTE", step, { title: "Beta cleanup" });
    // Latest activity, newest first: D, F, G, E, B. That is the order the chips arrive in, so only the sort can fix it.
    [[D, 5], [F, 4], [G, 3], [E, 2], [B, 1]].forEach(([id, day]) => touchPlan(fx, id, Date.parse(`2026-01-0${day}T00:00:00Z`)));
    dashFor(fx).generate();
    const first = chipOrder(readFileSync(fx.out, "utf8"));
    assert.deepEqual(first.slice(0, 3), ["2", "2b", "10"], "2 before 2b before 10, not by activity and not as text");
    assert.deepEqual([...first.slice(3)].sort(), ["Alpha cleanup", "Beta cleanup"], "the two plans without a code share the tail");
    // Ties are deterministic: the same plans in the same state give the same order on every page and every run.
    dashFor(fx).generate();
    assert.deepEqual(chipOrder(readFileSync(fx.out, "utf8")), first);
    assert.deepEqual(chipOrder(planPage(fx, E)), first, "every page shows the same order");
  } finally { fx.cleanup(); }
});

test("latestOfKind: the newest pass of each kind, whatever order the records arrive in", () => {
  const a = rv("review-iter-1", "bad", 1000), b = rv("review-iter-1-pass2", "ok", 2000), h = rv("hygiene-iter-1", "bad", 3000);
  for (const list of [[a, b, h], [h, b, a], [b, h, a]]) {
    assert.equal(latestOfKind(list, "Review"), b, "a later mtime wins over an older bad pass");
    assert.equal(latestOfKind(list, "Hygiene"), h, "the other kind is not mixed in, even when it is newer");
  }
  assert.equal(latestOfKind([], "Review"), null);
  assert.equal(latestOfKind([h], "Review"), null);
});

test("newestFirst: equal mtimes fall back to the file name, higher iteration and higher pass first, numbers as numbers", () => {
  const names = ["review-iter-1", "review-iter-1-pass2", "review-iter-1-pass10", "review-iter-2", "review-iter-9", "review-iter-10"];
  const want = ["review-iter-10", "review-iter-9", "review-iter-2", "review-iter-1-pass10", "review-iter-1-pass2", "review-iter-1"];
  const ordered = (list) => list.map((name) => ({ name, ms: 500 })).sort(newestFirst).map((r) => r.name);
  assert.deepEqual(ordered(names), want);
  assert.deepEqual(ordered([...names].reverse()), want, "the result does not depend on the input order");
  assert.deepEqual([{ name: "review-iter-9", ms: 2 }, { name: "review-iter-1", ms: 3 }].sort(newestFirst).map((r) => r.name), ["review-iter-1", "review-iter-9"], "mtime beats the name");
  for (const list of [[rv("review-iter-1", "bad", 500), rv("review-iter-1-pass2", "ok", 500)], [rv("review-iter-1-pass2", "ok", 500), rv("review-iter-1", "bad", 500)]]) {
    assert.equal(latestOfKind(list, "Review").name, "review-iter-1-pass2", "on equal mtimes the later pass is the newest");
  }
});

test("attention: a review that needed work is answered by a later good pass; only the newest pass of each kind counts", () => {
  const todo = [stp(1, "Fix it")];
  const stale = [rv("review-iter-1", "bad", 1000), rv("review-iter-1-pass2", "ok", 2000)];
  for (const reviews of [stale, [...stale].reverse()]) {
    assert.equal(youTitles("REFLECT", todo, reviews).includes("Review needs work"), false, "no nag after a READY pass");
    assert.equal(waitingOnYou(wm("REFLECT", todo, { reviews }))?.kind, "confirm-close", "the newest pass is good, so nothing blocks Confirm Close");
  }
  assert.ok(youTitles("REFLECT", todo, [rv("review-iter-1", "ok", 1000), rv("review-iter-1-pass2", "bad", 2000)]).includes("Review needs work"), "a newest pass that needs work still nags");
  assert.equal(waitingOnYou(wm("REFLECT", todo, { reviews: [rv("review-iter-1", "ok", 1000), rv("review-iter-1-pass2", "bad", 2000)] })), null, "and it keeps the turn with the agents");
  const staleHy = [rv("hygiene-iter-1", "bad", 1000, "REMEDIATE"), rv("hygiene-iter-1-pass2", "ok", 2000, "CLEAN")];
  for (const reviews of [staleHy, [...staleHy].reverse()]) {
    assert.equal(youTitles("EXECUTE", todo, reviews).includes("Hygiene wants a fix"), false, "no nag after a CLEAN pass");
  }
  assert.ok(youTitles("EXECUTE", todo, [rv("hygiene-iter-1", "ok", 1000, "CLEAN"), rv("hygiene-iter-1-pass2", "bad", 2000, "REMEDIATE")]).includes("Hygiene wants a fix"));
  assert.ok(youTitles("EXECUTE", todo, [rv("hygiene-iter-1", "bad", 1000, "REMEDIATE"), rv("review-iter-1", "ok", 3000)]).includes("Hygiene wants a fix"), "a newer review does not clear hygiene");
  const tie = [rv("review-iter-1", "bad", 500), rv("review-iter-1-pass2", "ok", 500)];
  for (const reviews of [tie, [...tie].reverse()]) {
    assert.equal(youTitles("REFLECT", todo, reviews).includes("Review needs work"), false, "equal mtimes: the later pass by name decides");
  }
  const tieBad = [rv("review-iter-1", "ok", 500), rv("review-iter-1-pass2", "bad", 500)];
  for (const reviews of [tieBad, [...tieBad].reverse()]) {
    assert.ok(youTitles("REFLECT", todo, reviews).includes("Review needs work"), "equal mtimes: a bad later pass still nags");
  }
});

test("generate: a stale NEEDS_WORK or REMEDIATE no longer nags once a later pass is READY or CLEAN; a newest bad pass still does", () => {
  const fx = makeFixture();
  try {
    setPlan(fx, B, "REFLECT", "1. [ ] Wire the API [RISK: low]");
    const dir = join(fx.plans, B, "findings");
    const put = (name, verdict, sec) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${name}.md`), `# Findings\n\n## Verdict\n${verdict}\n`);
      utimesSync(join(dir, `${name}.md`), sec, sec);
    };
    put("review-iter-1", "NEEDS_WORK", 1000);
    put("review-iter-1-pass2", "READY_TO_CLOSE", 4000);
    put("hygiene-iter-1", "REMEDIATE", 1000);
    put("hygiene-iter-1-pass2", "CLEAN", 2000);
    dashFor(fx).generate();
    const page = planPage(fx, B);
    assert.doesNotMatch(page, /Review needs work/);
    assert.doesNotMatch(page, /Hygiene wants a fix/);
    assert.match(page, /<span class="sg-k">Latest review<\/span><div><a [^>]*>review-iter-1-pass2<\/a> <span class="tag rv-ok"><i><\/i>READY TO CLOSE<\/span>/, "the Latest review row says ready");
    put("review-iter-1-pass3", "NEEDS_WORK", 5000);
    put("hygiene-iter-1-pass3", "REMEDIATE", 6000);
    dashFor(fx).generate();
    const bad = planPage(fx, B);
    assert.match(bad, /<p class="now-h"><span>Review needs work<\/span>/, "the newest pass needs work, so the hero says so");
    assert.match(bad, /<b>Review needs work<\/b>/);
    assert.match(bad, /<b>Hygiene wants a fix<\/b>/);
  } finally { fx.cleanup(); }
});

test("generate: with equal mtimes the later pass is the Latest review and decides the nag", () => {
  const fx = makeFixture();
  try {
    setPlan(fx, B, "REFLECT", "1. [ ] Wire the API [RISK: low]");
    const dir = join(fx.plans, B, "findings");
    mkdirSync(dir, { recursive: true });
    // Many files at one mtime: the directory listing hands them over in whatever order the file system likes,
    // so only an explicit tie-break puts pass12 first. The newest pass is the one that is READY.
    const names = ["review-iter-1", ...Array.from({ length: 12 }, (_, i) => `review-iter-1-pass${i + 2}`)];
    for (const name of names) {
      writeFileSync(join(dir, `${name}.md`), `# Review\n\n## Verdict\n${name === "review-iter-1-pass13" ? "READY_TO_CLOSE" : "NEEDS_WORK"}\n`);
      utimesSync(join(dir, `${name}.md`), 3000, 3000);
    }
    dashFor(fx).generate();
    const page = planPage(fx, B);
    assert.match(page, /<span class="sg-k">Latest review<\/span><div><a [^>]*>review-iter-1-pass13<\/a>/);
    assert.doesNotMatch(page, /Review needs work/);
  } finally { fx.cleanup(); }
});

test("pairReviews: a review and a hygiene pass of the same iteration share one row, passes stay apart, newest row first", () => {
  const list = [rv("review-iter-1", "bad", 1000), rv("hygiene-iter-1", "ok", 1500, "CLEAN"), rv("review-iter-1-pass2", "ok", 4000), rv("hygiene-iter-2", "ok", 3000, "CLEAN")];
  const rows = pairReviews(list);
  assert.deepEqual(rows.map((g) => g.id), ["iter-1-pass2", "iter-2", "iter-1"]);
  assert.deepEqual(rows.map((g) => [g.review?.name ?? null, g.hygiene?.name ?? null]), [["review-iter-1-pass2", null], [null, "hygiene-iter-2"], ["review-iter-1", "hygiene-iter-1"]]);
  assert.equal(rows[2].ms, 1500, "a row is as new as the newest record in it");
  assert.deepEqual(pairReviews([rv("review-iter-1", "ok", 500), rv("review-iter-2", "ok", 500)]).map((g) => g.id), ["iter-2", "iter-1"], "equal mtimes order rows by name");
  const fx = makeFixture();
  try {
    setPlan(fx, B, "REFLECT", "1. [ ] Wire the API [RISK: low]");
    const dir = join(fx.plans, B, "findings");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "review-iter-1.md"), "# Review\n\n## Verdict\nREADY_TO_CLOSE\n");
    writeFileSync(join(dir, "hygiene-iter-1.md"), "# Hygiene\n\n## Verdict\nCLEAN\n");
    dashFor(fx).generate();
    const rows = [...planPage(fx, B).matchAll(/<li>\s*<span class="rv-k">([^<]*)<\/span>\s*<div class="pair-cols">([\s\S]*?)<\/div>\s*<\/div>\s*<\/li>/g)];
    assert.equal(rows.length, 1, "one row for the iteration, not one per file");
    assert.equal(rows[0][1], "iter-1");
    assert.match(rows[0][2], /review-iter-1<\/a>/);
    assert.match(rows[0][2], /hygiene-iter-1<\/a>/);
  } finally { fx.cleanup(); }
});

test("readPointer: trusts only an existing plan id, never a path", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dash-ptr-")));
  try {
    mkdirSync(join(root, A));
    writeFileSync(join(root, ".current_plan"), `${A}\n`);
    assert.equal(readPointer(root), A);
    writeFileSync(join(root, ".current_plan"), "../../etc");
    assert.equal(readPointer(root), null);
    writeFileSync(join(root, ".current_plan"), B);
    assert.equal(readPointer(root), null, "a well-formed id that does not exist is not trusted");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- markdown ----------
test("markdown: raw HTML and script render as text; only http(s) links become anchors", () => {
  const { html } = mdToHtml("<script>alert('x')</script>\n\n<img src=x onerror=alert(1)>\n\n[a](javascript:alert(1)) [b](https://example.com) `<b>code</b>`");
  assert.ok(!/<script|<img|onerror=alert\(1\)>/.test(html.replace(/&lt;[^]*?&gt;/g, "")), html);
  assert.match(html, /&lt;script&gt;alert\(&#39;x&#39;\)&lt;\/script&gt;/);
  assert.ok(!html.includes('href="javascript:'));
  assert.match(html, /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">b<\/a>/);
  assert.match(html, /<code>&lt;b&gt;code&lt;\/b&gt;<\/code>/);
});

test("markdown: tables keep a pipe inside a code span, decision headings get stable ids, lists nest", () => {
  const { html, toc } = mdToHtml("## D-001 | PLAN | 2026-01-01\n\n| a | b |\n|---|---|\n| `x | y` | z |\n\n- [x] done\n- [ ] open\n  - child\n\n3. three\n4. four\n\n```\n<b>raw</b>\n```\n");
  assert.match(html, /<h2 id="D-001">/);
  assert.equal(toc[0].id, "D-001");
  assert.match(html, /<td><code>x \| y<\/code><\/td><td>z<\/td>/);
  assert.match(html, /<ul class="tasks"><li><span class="cb on">/);
  assert.match(html, /<span class="cb"><\/span>open<ul><li>child<\/li><\/ul><\/li><\/ul>/);
  assert.match(html, /<\/ul>\n?<ol start="3"><li>three<\/li><li>four<\/li><\/ol>/, "numbers after bullets start their own list");
  assert.match(html, /<pre><code>&lt;b&gt;raw&lt;\/b&gt;<\/code><\/pre>/);
});

// ---------- formatting helpers ----------
test("helpers: model names, compact numbers, step keys in an executor's task", () => {
  assert.equal(modelName("claude-opus-4-1-20250805"), "Opus 4.1");
  assert.equal(modelName("claude-sonnet-4-5"), "Sonnet 4.5");
  assert.deepEqual([fmtN(950), fmtN(12345), fmtN(2_500_000), fmtN(1_234_000_000)], ["950", "12.3K", "2.5M", "1.23B"]);
  assert.deepEqual(stepsOf("Execute hygiene fixes 6.1 + 10.6"), ["6.1", "10.6"]);
  assert.deepEqual(stepsOf("Phase 2 step 9: hand-off"), ["9"]);
  assert.deepEqual(stepsOf("Explore: auth"), []);
});

test("timeSeries: never more than 96 columns, and empty buckets stay in place", () => {
  const h0 = Date.parse("2026-01-01T00:00:00Z");
  const { series, size } = timeSeries({ [h0]: 5, [h0 + 3 * 3.6e6]: 7 });
  assert.equal(size, 1);
  assert.deepEqual(series.map((x) => x[1]), [5, 0, 0, 7]);
  const long = timeSeries({ [h0]: 1, [h0 + 30 * 86400e3]: 1 });
  assert.ok(long.series.length <= 96, `${long.series.length} columns`);
  assert.equal(long.series.reduce((s, x) => s + x[1], 0), 2, "bucketing keeps every token");
});

// ---------- usage accounting ----------
test("ingestLine: a streamed message counts once with the largest value per field; synthetic and non-assistant lines are skipped", () => {
  const c = { msgs: {}, planner: false, first: 0, last: 0 };
  ingestLine(c, asst("m", "2026-01-01T00:00:00Z", [3, 5, 100, 0]));
  ingestLine(c, asst("m", "2026-01-01T00:00:00Z", [3, 80, 100, 7]));
  ingestLine(c, JSON.stringify({ type: "assistant", timestamp: "2026-01-01T00:00:00Z", message: { id: "s", model: "<synthetic>", usage: { output_tokens: 9 } } }));
  ingestLine(c, JSON.stringify({ type: "user", note: '"type":"assistant" "usage"' }));
  assert.deepEqual(Object.keys(c.msgs), ["m"]);
  assert.deepEqual(c.msgs.m.slice(2), [3, 80, 100, 7]);
  assert.equal(c.planner, false);
  ingestLine(c, skillCall);
  assert.equal(c.planner, true);
});

test("scanFile: reads only appended bytes, never a half-written last line, and rescans a truncated file", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dash-scan-")));
  try {
    const f = join(root, "s.jsonl"), cache = { files: {} }, t = { file: f, kind: "main", sid: "s" };
    writeFileSync(f, asst("a", "2026-01-01T00:00:00Z", [1, 1, 1, 1]) + "\n" + asst("b", "2026-01-01T00:01:00Z", [2, 2, 2, 2]).slice(0, 40));
    scanFile(cache, t);
    assert.deepEqual(Object.keys(cache.files[f].msgs), ["a"]);
    appendFileSync(f, asst("b", "2026-01-01T00:01:00Z", [2, 2, 2, 2]).slice(40) + "\n");
    scanFile(cache, t);
    assert.deepEqual(Object.keys(cache.files[f].msgs).sort(), ["a", "b"]);
    assert.equal(scanFile(cache, t), false, "nothing new → nothing read");
    writeFileSync(f, asst("c", "2026-01-01T00:02:00Z", [3, 3, 3, 3]) + "\n");
    scanFile(cache, t);
    assert.deepEqual(Object.keys(cache.files[f].msgs), ["c"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("attribute: fork copies count once (main copy wins), runs stay whole, and usage outside windows or outside the planner is kept apart", () => {
  const fx = makeFixture();
  try {
    const cache = { files: {} };
    const files = transcriptFiles(fx.projects, [fx.repo]);
    for (const f of files) scanFile(cache, f);
    const sessions = sessionsOf(cache, files);
    assert.deepEqual(sessions.map((s) => [s.sid, s.planner]).sort(), [["s1", true], ["s2", false]]);
    const windows = [
      { name: C, start: Date.parse("2025-12-01T10:00:00Z"), end: Date.parse("2026-01-10T09:00:00Z") - 1 },
      { name: A, start: Date.parse("2026-01-10T09:00:00Z"), end: Date.parse("2026-01-10T12:00:00Z") },
      { name: B, start: Date.parse("2026-01-11T08:00:00Z"), end: Infinity },
    ];
    const att = attribute(sessions, windows);
    assert.equal(total(att.byPlan.get(A)), 1160);
    assert.equal(total(att.byPlan.get(B)), 3142 + 1162 + 110);
    assert.equal(att.byPlan.get(B).out, 40 + 50 + 10, "m3's output comes from the main copy (40), not the fork's truncated copy (3)");
    assert.equal(total(att.between), 208);
    assert.equal(total(att.outside), 20);
    assert.equal(att.byPlan.get(C), undefined);
    const run = att.byPlan.get(B).runs.find((r) => r.role === "ip-executor");
    assert.equal(run.tok, 1162);
    assert.equal(run.lastCall, 631);
    assert.deepEqual(att.byPlan.get(B).bySteps, { 1: { tok: 1162, runs: 1 } });
    assert.equal(att.byPlan.get(B).byRole.fork.runs, 1);
  } finally { fx.cleanup(); }
});

// ---------- the generated site ----------
test("generate: writes the live page, every plan, every document, ledgers, the archived plan and the assets", () => {
  const fx = makeFixture();
  try {
    const d = dashFor(fx);
    d.generate();
    const site = join(dirname(fx.out), "dashboard");
    for (const p of [fx.out, join(site, "index.html"), join(site, "p", `${A}.html`), join(site, "p", `${B}.html`),
      join(site, "p", A, "findings", "review-iter-1.html"), join(site, "p", A, "decisions.html"),
      join(site, "ledger", "LESSONS.html"), join(site, "ledger", "INDEX.html"), join(site, "archived", `${C}.html`),
      join(site, "assets", "site.css"), join(site, "assets", "site.js"), join(site, "assets", "search.js"), join(site, "assets", "live.js"), join(site, "assets", "data.json")]) {
      assert.ok(existsSync(p), `missing ${relative(dirname(fx.out), p)}`);
    }
    const live = readFileSync(fx.out, "utf8");
    assert.match(live, /Executing step 2/, "the ← CURRENT step drives the headline");
    assert.match(live, /Wiring/);
    assert.match(readFileSync(join(site, "index.html"), "utf8"), /Old cleanup work/);
    const doc = readFileSync(join(site, "p", A, "decisions.html"), "utf8");
    assert.ok(doc.includes(`plans/${A}/decisions.md`) && !doc.includes(fx.repo), "documents show a repo-relative path, never a local absolute one");
  } finally { fx.cleanup(); }
});

test("generate: never writes into the repo — plans/ is byte- and mtime-identical afterwards", () => {
  const fx = makeFixture();
  try {
    const before = snapshot(fx.repo);
    const d = dashFor(fx);
    d.generate(); d.generate(); d.flush();
    assert.deepEqual(snapshot(fx.repo), before);
  } finally { fx.cleanup(); }
});

test("generate: no remote assets — every stylesheet and script is local", () => {
  const fx = makeFixture();
  try {
    dashFor(fx).generate();
    const site = join(dirname(fx.out), "dashboard");
    for (const page of [fx.out, join(site, "index.html"), join(site, "p", A, "decisions.html")]) {
      const html = readFileSync(page, "utf8");
      assert.ok(!/<(link|script)[^>]+(href|src)="(https?:)?\/\//.test(html), `${page} loads a remote asset`);
    }
    assert.ok(!/url\(\s*["']?(https?:)?\/\/|@import/.test(readFileSync(join(site, "assets", "site.css"), "utf8")));
  } finally { fx.cleanup(); }
});

test("generate: untrusted plan content renders as text on the document page and the plan page", () => {
  const fx = makeFixture();
  try {
    dashFor(fx).generate();
    const site = join(dirname(fx.out), "dashboard");
    const doc = readFileSync(join(site, "p", A, "findings", "review-iter-1.html"), "utf8");
    assert.ok(!doc.includes("<script>alert"), "a <script> from a plan file reached the page");
    assert.ok(!doc.includes("<img src=x"), "raw <img> from a plan file reached the page");
    assert.ok(!doc.includes('href="javascript:'));
    assert.match(doc, /&lt;script&gt;alert/);
    assert.ok(!readFileSync(join(site, "p", `${B}.html`), "utf8").includes("<b>boldly</b>"));
  } finally { fx.cleanup(); }
});

test("generate: the pointer picks the live plan even when another plan changed more recently", () => {
  const fx = makeFixture();
  try {
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(fx.plans, A, "state.md"), later, later);
    dashFor(fx).generate();
    const data = readData(fx);
    assert.equal(data.plans.find((p) => p.live)?.name, B);
    assert.match(readFileSync(fx.out, "utf8"), /Wiring/);
  } finally { fx.cleanup(); }
});

test("generate: open chips name every unclosed plan and mark the pointer", () => {
  const fx = makeFixture();
  try {
    dashFor(fx).generate();
    const html = readFileSync(fx.out, "utf8");
    assert.match(html, /class="openbar"/);
    assert.match(html, /<span class="open-ptr">ptr<\/span>/);
    assert.match(html, />2<\/b><em>Execute<\/em>/);
    assert.equal([...html.matchAll(/class="open-chip /g)].length, 1, "the closed plan is not a chip");
    assert.ok(!/<(link|script)[^>]+(href|src)="(https?:)?\/\//.test(html));
  } finally { fx.cleanup(); }
});

test("generate: an open plan gives every page the bar and the has-open class together", () => {
  const fx = makeFixture();
  try {
    dashFor(fx).generate();
    for (const html of [readFileSync(fx.out, "utf8"), planPage(fx, B)]) {
      assert.equal([...html.matchAll(/class="openbar"/g)].length, 1);
      assert.match(html, /<body [^>]*class="has-open"/);
    }
  } finally { fx.cleanup(); }
});

test("generate: a pointer with no open plan (CLOSE phase) renders no open bar and no has-open class", () => {
  const fx = makeFixture();
  try {
    setPlan(fx, B, "CLOSE", "1. [x] Wire the API [RISK: low]");
    assert.equal(readFileSync(join(fx.plans, ".current_plan"), "utf8").trim(), B, "the pointer is still there");
    dashFor(fx).generate();
    for (const html of [readFileSync(fx.out, "utf8"), planPage(fx, B), planPage(fx, A)]) {
      assert.ok(!/class="openbar"/.test(html), "no empty Open bar");
      assert.ok(!/has-open/.test(html), "so --open-h stays 0");
    }
  } finally { fx.cleanup(); }
});

test("site.css: the open bar is one row whose height is --open-h, and everything that sticks below it offsets by --open-h", () => {
  const fx = makeFixture();
  try {
    dashFor(fx).generate();
    const css = readFileSync(join(dirname(fx.out), "dashboard", "assets", "site.css"), "utf8");
    const rule = (sel) => { const m = css.match(new RegExp(`(?:^|[}\\n])${sel.replace(/[.]/g, "\\.")}\\{([^}]*)\\}`)); assert.ok(m, `rule ${sel}`); return m[1]; };
    // One row, so the scrollbar the CHANGELOG promises exists and the bar cannot outgrow --open-h.
    assert.match(rule(".open-chips"), /flex-wrap:nowrap/);
    assert.ok(!/flex-wrap:\s*wrap\b/.test(rule(".open-chips")), "wrapped chips would grow the bar past --open-h");
    assert.match(rule(".open-chips"), /overflow-x:auto/);
    assert.match(rule(".openbar"), /(^|;)height:var\(--open-h\)/);
    assert.match(rule(".openbar-in"), /(^|;)height:100%/);
    assert.ok(!/min-height/.test(rule(".openbar-in")), "a min-height lets the bar grow past --open-h");
    // The compact value applies only when the bar exists; otherwise the dock would leave a 36px gap.
    assert.match(css, /body\.is-compact\.has-open\{--open-h:36px\}/);
    assert.ok(!/body\.is-compact\{[^}]*--open-h/.test(css), "compact alone must not set --open-h");
    // Sticky offsets that sit under the bar.
    const toc = css.match(/\.toc\{position:sticky;top:([^;]+);max-height:([^;]+);/);
    assert.ok(toc, "the sticky .toc rule");
    assert.match(toc[1], /var\(--open-h\)/);
    assert.match(toc[2], /var\(--open-h\)/);
    assert.match(rule(".dock"), /top:calc\(var\(--bar-h\) \+ var\(--open-h\)\)/);
    assert.match(rule(".tabs"), /top:calc\(var\(--bar-h\) \+ var\(--open-h\) \+ var\(--dock-h\)\)/);
    // L6: the dock is its inner height plus its 1px bottom border, and that must equal --dock-h.
    const inner = +rule(".dock-in").match(/(?:^|;)height:(\d+)px/)[1];
    const dockH = +css.match(/body\.is-compact\{[^}]*--dock-h:(\d+)px/)[1];
    assert.match(rule(".dock"), /border-bottom:1px solid/);
    assert.equal(inner + 1, dockH);
  } finally { fx.cleanup(); }
});

test("generate: review+hygiene pairs and PLAN-template checks show on a REFLECT plan", () => {
  const fx = makeFixture();
  try {
    writeFileSync(join(fx.plans, B, "state.md"), [
      "# Current State: REFLECT", "## Iteration: 1", "## Current Plan Step: N/A",
      "## Last Transition: EXECUTE → REFLECT (2026-01-11T10:00:00Z)",
      "## Transition History:", "- INIT → EXPLORE (task started)", "- PLAN → EXECUTE (2026-01-11T09:00:00Z)",
      "- EXECUTE → REFLECT (2026-01-11T10:00:00Z)", "",
    ].join("\n"));
    mkdirSync(join(fx.plans, B, "findings"), { recursive: true });
    writeFileSync(join(fx.plans, B, "findings", "review-iter-1.md"), "# Review\n\n## Verdict\nREADY_TO_CLOSE\n");
    writeFileSync(join(fx.plans, B, "findings", "hygiene-iter-1.md"), "# Hygiene\n\n## Verdict\nCLEAN\n");
    writeFileSync(join(fx.plans, B, "verification.md"), "# Verification\n\n## Criteria Verification\n| # | Criterion (from plan.md) | Method | Command/Action | Result | Evidence |\n|---|---|---|---|---|---|\n| 1 | Tests pass | Automated | `npm test` | PENDING | |\n| 2 | Lint clean | Automated | `npm run lint` | PENDING | |\n");
    dashFor(fx).generate();
    const html = readFileSync(fx.out, "utf8");
    assert.match(html, /Review \+ hygiene/);
    assert.match(html, /READY TO CLOSE/);
    assert.match(html, /PLAN template/);
    assert.match(html, /Confirm Close/);
    assert.match(html, /Waiting for you/);
  } finally { fx.cleanup(); }
});

test("generate: data.json totals equal the hand-computed fixture totals, split by plan", () => {
  const fx = makeFixture();
  try {
    dashFor(fx).generate();
    const data = readData(fx);
    const tot = (u) => u.inp + u.out + u.cr + u.cw;
    const plan = (n) => data.plans.find((p) => p.name === n);
    assert.equal(tot(plan(A).usage), 1160);
    assert.equal(tot(plan(B).usage), 4414);
    assert.equal(tot(data.between), 208);
    assert.equal(tot(data.outside), 20);
    assert.equal(tot(data.archived.find((p) => p.name === C).usage), 0);
    const all = [...data.plans.map((p) => p.usage), ...data.archived.map((p) => p.usage), data.between, data.outside];
    assert.equal(all.reduce((s, u) => s + tot(u), 0), 5802);
    assert.equal(all.reduce((s, u) => s + u.msgs, 0), 7);
    assert.deepEqual(plan(A).checks, { pass: 1, total: 2 });
    assert.equal(plan(A).decisions, 1, "the commented schema example is not a decision");
    assert.deepEqual(plan(B).steps, { done: 1, total: 2 });
  } finally { fx.cleanup(); }
});

test("live manifest: every page carries its content hash, and the page body agrees", () => {
  const fx = makeFixture();
  try {
    dashFor(fx).generate();
    const { v } = readLive(fx);
    const key = "dashboard/p/" + B + ".html";
    assert.ok(Array.isArray(v[key]) && v[key].length === 2);
    const html = readFileSync(join(dirname(fx.out), key), "utf8");
    assert.match(html, new RegExp(`data-hash="${v[key][0]}" data-shash="${v[key][1]}"`));
    assert.ok(Object.keys(v).length >= 10);
  } finally { fx.cleanup(); }
});

test("live manifest: new usage changes a page's hash but not its structure hash; a plan edit changes both", () => {
  const fx = makeFixture();
  try {
    const d = dashFor(fx);
    d.generate();
    const key = "dashboard/p/" + B + ".html";
    const v1 = readLive(fx).v[key];
    appendFileSync(join(fx.projects, projectSlug(fx.repo), "s1.jsonl"), asst("m4", "2026-01-11T10:30:00Z", [1, 1, 50000, 0]) + "\n");
    d.generate();
    const v2 = readLive(fx).v[key];
    assert.notEqual(v2[0], v1[0]);
    assert.equal(v2[1], v1[1], "a usage-only change must not count as structural");
    appendFileSync(join(fx.plans, B, "state.md"), "- EXECUTE: step 2 started\n");
    d.generate();
    assert.notEqual(readLive(fx).v[key][1], v2[1]);
  } finally { fx.cleanup(); }
});

test("an unchanged second run reports no change and rewrites no page", () => {
  const fx = makeFixture();
  try {
    const d = dashFor(fx);
    assert.equal(d.generate(), true);
    const site = join(dirname(fx.out), "dashboard");
    const pages = [fx.out, join(site, "index.html"), join(site, "p", `${A}.html`), join(site, "p", A, "decisions.html"), join(site, "assets", "data.json")];
    const before = pages.map((p) => statSync(p).mtimeMs);
    assert.equal(d.generate(), false);
    assert.deepEqual(pages.map((p) => statSync(p).mtimeMs), before);
  } finally { fx.cleanup(); }
});

test("--no-usage: no logs are read, no usage cache is written, and the page says usage is off", () => {
  const fx = makeFixture();
  try {
    dashFor(fx, { projectsDir: null }).generate();
    assert.equal(existsSync(join(dirname(fx.out), "dashboard", "assets", "usage-cache.json")), false);
    assert.match(readFileSync(join(dirname(fx.out), "dashboard", "p", `${B}.html`), "utf8"), /Usage is turned off/);
    assert.equal(readData(fx).outside.msgs, 0);
  } finally { fx.cleanup(); }
});

test("a repo with no plans gets a page that says so instead of failing", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dash-empty-")));
  try {
    const out = join(root, "out", "dashboard.html");
    createDashboard({ repo: join(root, "repo"), out, projectsDir: null, worktrees: false, now: NOW }).generate();
    assert.match(readFileSync(out, "utf8"), /No plan directories/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- the default output folder and every write ----------
// With no --out the output goes to a folder in the OS temp dir, which other users can reach. These
// runs point TMPDIR/TEMP/TMP at a folder inside the fixture, so the real temp dir is never touched.
const POSIX = { skip: process.platform === "win32" };
const privateRoot = (fx) => join(fx.root, "tmp", `iterative-planner-dashboard-${process.getuid()}`);
function runDefault(fx) {
  const tmp = join(fx.root, "tmp");
  mkdirSync(tmp, { recursive: true });
  return spawnSync(process.execPath, [SCRIPT, "--no-usage"], { cwd: fx.repo, encoding: "utf8", env: { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp } });
}
const refusal = (root) => new RegExp(`^dashboard: refusing to use ${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: [^\n]+\\. Remove it, or pass --out <file\\.html> to write somewhere else\n$`);

test("defaultOut: the temp folder name carries the user id", POSIX, () => {
  const root = dirname(dirname(defaultOut("/some/repo")));
  assert.equal(basename(root), `iterative-planner-dashboard-${process.getuid()}`);
  assert.equal(dirname(root), tmpdir());
});

test("a default run writes only owner-only folders (0700) and files (0600) and leaves no temp files", POSIX, () => {
  const fx = makeFixture();
  try {
    const r = runDefault(fx), root = privateRoot(fx);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.split("\n")[0], `Dashboard: ${join(root, basename(dirname(defaultOut(fx.repo))), "dashboard.html")}`);
    const seen = { dirs: 0, files: 0 };
    const walk = (p) => {
      const st = lstatSync(p);
      if (st.isDirectory()) { seen.dirs++; assert.equal(st.mode & 0o777, 0o700, `${p} is a folder at mode ${(st.mode & 0o777).toString(8)}`); for (const e of readdirSync(p)) walk(join(p, e)); }
      else { seen.files++; assert.ok(st.isFile(), `${p} is not a regular file`); assert.equal(st.mode & 0o777, 0o600, `${p} is a file at mode ${(st.mode & 0o777).toString(8)}`); assert.doesNotMatch(p, /\.tmp$/); }
    };
    walk(root);
    assert.ok(seen.dirs >= 4 && seen.files >= 6, `walked ${seen.dirs} folders and ${seen.files} files`);
    assert.ok(existsSync(join(root, basename(dirname(defaultOut(fx.repo))), "dashboard", "assets", "site.css")));
  } finally { fx.cleanup(); }
});

test("a default folder that other users can reach (0755) is refused with one line and nothing written", POSIX, () => {
  const fx = makeFixture();
  try {
    const root = privateRoot(fx);
    mkdirSync(root, { recursive: true });
    chmodSync(root, 0o755);
    const r = runDefault(fx);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, refusal(root));
    assert.match(r.stderr, /\(mode 755\)/);
    assert.doesNotMatch(r.stderr, /^\s+at /m, "no stack trace");
    assert.deepEqual(readdirSync(root), []);
    assert.equal(statSync(root).mode & 0o777, 0o755, "refused, not chmod-ed");
  } finally { fx.cleanup(); }
});

test("a loosened default folder is refused before anything in it is read: a FIFO there cannot hang the run", POSIX, (t) => {
  const fx = makeFixture();
  try {
    const root = privateRoot(fx);
    assert.equal(runDefault(fx).status, 0);
    const page = join(root, basename(dirname(defaultOut(fx.repo))), "dashboard", "index.html");
    rmSync(page);
    const mk = spawnSync("mkfifo", [page]);
    if (mk.error || mk.status !== 0) { t.skip("mkfifo is not available"); return; }
    chmodSync(root, 0o755);
    const tmp = join(fx.root, "tmp");
    const r = spawnSync(process.execPath, [SCRIPT, "--no-usage"], { cwd: fx.repo, encoding: "utf8", timeout: 10000, env: { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp } });
    assert.equal(r.error, undefined, `the run hung on the FIFO and was killed (${r.error?.code}, ${r.signal})`);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, refusal(root));
    assert.doesNotMatch(r.stderr, /^\s+at /m, "no stack trace");
  } finally { fx.cleanup(); }
});

// --watch runs async, so these poll for each condition instead of sleeping, and always kill the child.
const until = async (cond, what, ms = 15000) => {
  for (const end = Date.now() + ms; !cond();) {
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${typeof what === "function" ? what() : what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
function startWatch(fx, args, env = {}) {
  const tmp = join(fx.root, "tmp");
  mkdirSync(tmp, { recursive: true });
  const child = spawn(process.execPath, [SCRIPT, "--watch", ...args], { cwd: fx.repo, env: { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp, ...env } });
  const run = { child, stdout: "", stderr: "", code: undefined };
  child.stdout.on("data", (d) => { run.stdout += d; });
  child.stderr.on("data", (d) => { run.stderr += d; });
  child.on("close", (code) => { run.code = code; });
  return run;
}
const stopWatch = (run) => { if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGKILL"); };

test("--watch: a folder loosened mid-watch stops the run with one line and exit 1, not a stack every tick", POSIX, async () => {
  const fx = makeFixture();
  const run = startWatch(fx, ["--interval", "1", "--no-usage"]);
  try {
    await until(() => run.stdout.includes("Dashboard: ") || run.code !== undefined, "the first run");
    assert.equal(run.code, undefined, run.stderr);
    const root = privateRoot(fx);
    chmodSync(root, 0o755);
    appendFileSync(join(fx.plans, B, "progress.md"), "- [ ] touched\n");
    await until(() => run.code !== undefined, () => `exit; stderr so far:\n${run.stderr.slice(0, 1500)}`);
    assert.equal(run.code, 1, run.stderr);
    assert.match(run.stderr, refusal(root));
    assert.doesNotMatch(run.stderr, /^\s+at /m, "no stack trace");
  } finally { stopWatch(run); fx.cleanup(); }
});

// The signal handler flushes the usage cache, which is written at most once a minute under --watch. So a
// tick must first read a new log line (cache dirty, not yet saved); then the folder is loosened and the run
// interrupted, well before the next tick is due.
test("--watch: Ctrl-C with unsaved usage and a loosened folder prints one line and exits 1, no crash dump", POSIX, async () => {
  const fx = makeFixture();
  const run = startWatch(fx, ["--interval", "2"], { CLAUDE_CONFIG_DIR: dirname(fx.projects) });
  try {
    await until(() => run.stdout.includes("Dashboard: ") || run.code !== undefined, "the first run");
    assert.equal(run.code, undefined, run.stderr);
    const site = join(privateRoot(fx), basename(dirname(defaultOut(fx.repo))), "dashboard", "assets");
    appendFileSync(join(fx.projects, projectSlug(fx.repo), "s1.jsonl"), `${asst("sig1", "2026-01-11T10:30:00Z", [1, 1, 1, 1], "claude-haiku-sigtest")}\n`);
    const mtime = (f) => { try { return statSync(join(site, f)).mtimeMs; } catch { return -1; } };
    // data.json carries the new model once a tick has read the line; live.js is that tick's last write.
    await until(() => run.code !== undefined || (readFileSync(join(site, "data.json"), "utf8").includes("claude-haiku-sigtest") && mtime("live.js") >= mtime("data.json")), "a tick to read the new log line");
    assert.equal(run.code, undefined, run.stderr);
    const root = privateRoot(fx);
    chmodSync(root, 0o755);
    run.child.kill("SIGINT");
    await until(() => run.code !== undefined, "exit after SIGINT");
    assert.equal(run.code, 1, run.stderr);
    assert.match(run.stderr, refusal(root));
    assert.doesNotMatch(run.stderr, /^\s+at /m, "no stack trace");
  } finally { stopWatch(run); fx.cleanup(); }
});

test("a default folder that is a symlink is refused, even to a folder we own, and its target stays empty", POSIX, () => {
  const fx = makeFixture();
  try {
    const root = privateRoot(fx), target = join(fx.root, "elsewhere");
    mkdirSync(target, { mode: 0o700 });
    mkdirSync(dirname(root), { recursive: true });
    symlinkSync(target, root);
    const r = runDefault(fx);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, refusal(root));
    assert.match(r.stderr, /: it is a symlink\./);
    assert.deepEqual(readdirSync(target), []);
  } finally { fx.cleanup(); }
});

test("with --out, a symlink planted at the temp name is not followed", POSIX, () => {
  const fx = makeFixture();
  try {
    const sentinel = join(fx.root, "sentinel.txt");
    writeFileSync(sentinel, "SENTINEL");
    mkdirSync(dirname(fx.out), { recursive: true });
    symlinkSync(sentinel, `${fx.out}.${process.pid}.tmp`);
    dashFor(fx, { projectsDir: null }).generate();
    assert.equal(readFileSync(sentinel, "utf8"), "SENTINEL");
    assert.match(readFileSync(fx.out, "utf8"), /<html/i);
    assert.ok(lstatSync(fx.out).isFile(), "the page itself is a regular file");
    const left = [];
    const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.tmp$/.test(e.name)) left.push(p); } };
    walk(dirname(fx.out));
    assert.deepEqual(left, []);
  } finally { fx.cleanup(); }
});

// ---------- --out must name a .html or .htm file ----------
// The site folder is the entry path minus its suffix, so any other --out made the two the same path
// and the run died with EISDIR. One rule (validateOut) guards the CLI and createDashboard.
function runOut(fx, out) {
  const tmp = join(fx.root, "tmp");
  mkdirSync(tmp, { recursive: true });
  return spawnSync(process.execPath, [SCRIPT, "--no-usage", "--out", out], { cwd: fx.repo, encoding: "utf8", env: { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp } });
}

test("parseArgs: --out is rejected unless it names a .html or .htm file", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dash-out-")));
  try {
    const folder = join(root, "d.html"), viaMissing = `${root}/nope/../d.html`; // nope/ does not exist
    mkdirSync(folder);
    // A name before the suffix made only of dots or spaces makes the site folder the current folder or its
    // parent: directly for "." and "..", and on Windows (which strips trailing dots and spaces) for the rest.
    for (const v of ["dash", "dash/", "dash\\", "x.txt", ".html", "out/.htm", "..html", "...html", "x/...htm", "x\\..html", "....html", ". .html", " ..html", "x/ . .htm", " .html", folder, viaMissing]) {
      const { error } = parseArgs(["--out", v]);
      assert.ok(error, `--out ${v} should be rejected`);
      assert.ok(error.includes(v), `the error names the value: ${error}`);
      assert.match(error, /\.html or \.htm file path/);
    }
    for (const v of [folder, viaMissing]) assert.match(parseArgs(["--out", v]).error, /, which is an existing folder\)$/);
    // The site folder (the value minus its suffix) must be new, or one a dashboard run wrote (it holds
    // assets/live.js); a file there is refused too, since every write into it would fail.
    writeFileSync(join(root, "f"), "FILE");
    mkdirSync(join(root, "docs"));
    mkdirSync(join(root, "o", "assets"), { recursive: true });
    writeFileSync(join(root, "o", "assets", "live.js"), "");
    assert.match(parseArgs(["--out", join(root, "f.html")]).error, /whose site folder "[^"]+[\\/]f" is an existing file\)$/);
    assert.match(parseArgs(["--out", join(root, "docs.HTM")]).error, /whose site folder "[^"]+[\\/]docs" already exists and holds no finished dashboard run \(no assets\/live\.js\); if an interrupted run left it, remove it, otherwise pick another name\)$/);
    if (process.platform !== "win32") { // creating a symlink may need privileges on Windows
      symlinkSync(join(root, "gone"), join(root, "dangling"));
      assert.match(parseArgs(["--out", join(root, "dangling.html")]).error, /whose site folder "[^"]+[\\/]dangling" is a broken symlink\)$/);
    }
    for (const v of ["X.HTML", "x.htm", "out/Dash.Html", "a..html", "a .html", join(root, "missing", "page.html"), join(root, "o.html")]) assert.equal(parseArgs(["--out", v]).error, null, `--out ${v} should be accepted`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CLI: an --out that is not a .html file exits 2 with the reason and writes nothing", () => {
  const fx = makeFixture();
  try {
    mkdirSync(join(fx.root, "tmp"));
    const before = readdirSync(fx.root).sort(), target = join(fx.root, "dash");
    const r = runOut(fx, target);
    assert.equal(r.status, 2, r.stderr);
    assert.ok(r.stderr.startsWith(`dashboard: --out must be a .html or .htm file path`), r.stderr);
    assert.ok(r.stderr.includes(`"${target}"`), r.stderr);
    assert.match(r.stderr, /\nUsage: /);
    assert.equal(r.stdout, "");
    assert.equal(existsSync(target), false);
    assert.deepEqual(readdirSync(fx.root).sort(), before);
    assert.deepEqual(readdirSync(join(fx.root, "tmp")), []);
  } finally { fx.cleanup(); }
});

test("CLI: --out ..html exits 2 and writes nothing in the current folder", () => {
  const fx = makeFixture();
  try {
    mkdirSync(join(fx.root, "tmp"));
    const before = readdirSync(fx.repo).sort();
    const r = runOut(fx, "..html");
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /"\.\.html", whose name before the suffix is only dots or spaces\)/);
    assert.deepEqual(readdirSync(fx.repo).sort(), before);
    assert.deepEqual(readdirSync(join(fx.root, "tmp")), []);
  } finally { fx.cleanup(); }
});

test("CLI: an --out whose site folder exists without a finished dashboard run exits 2 and leaves it alone", () => {
  const fx = makeFixture();
  try {
    const docs = join(fx.root, "docs"), out = join(fx.root, "docs.html");
    mkdirSync(join(docs, "assets"), { recursive: true });
    writeFileSync(join(docs, "index.html"), "MINE");
    // docs/assets/ is common, so it must not pass for the dashboard's own marker, assets/live.js.
    writeFileSync(join(docs, "assets", "style.css"), "MINE TOO");
    const r = runOut(fx, out);
    assert.equal(r.status, 2, r.stderr);
    assert.ok(r.stderr.startsWith(`dashboard: --out must be a .html or .htm file path, such as out/dashboard.html (got "${out}", whose site folder "${docs}" already exists and holds no finished dashboard run (no assets/live.js); if an interrupted run left it, remove it, otherwise pick another name)\n`), r.stderr);
    assert.throws(() => dashFor(fx, { out, projectsDir: null }), (e) => e.code === "EDASHBOARD" && e.message.includes(`"${docs}"`));
    assert.equal(readFileSync(join(docs, "index.html"), "utf8"), "MINE");
    assert.equal(readFileSync(join(docs, "assets", "style.css"), "utf8"), "MINE TOO");
    assert.deepEqual(readdirSync(docs).sort(), ["assets", "index.html"]);
    assert.deepEqual(readdirSync(join(docs, "assets")), ["style.css"]);
    assert.equal(existsSync(out), false);
    // A folder a previous run wrote is the dashboard's own, so the same --out runs again.
    const again = join(fx.root, "o", "dash.html");
    assert.equal(runOut(fx, again).status, 0);
    const r2 = runOut(fx, again);
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(r2.stdout.split("\n")[0], `Dashboard: ${again}`);
    assert.deepEqual(readdirSync(join(fx.root, "tmp")), []);
  } finally { fx.cleanup(); }
});

test("createDashboard: a bad out throws EDASHBOARD before creating anything", () => {
  const fx = makeFixture();
  try {
    const out = join(fx.root, "out", "dash");
    assert.throws(() => dashFor(fx, { out, projectsDir: null }), (e) => e.code === "EDASHBOARD" && e.message.includes(`"${out}"`));
    assert.equal(existsSync(join(fx.root, "out")), false);
  } finally { fx.cleanup(); }
});

test("--out X.HTML writes the site folder X, and x.htm writes x", () => {
  const fx = makeFixture();
  try {
    const out = join(fx.root, "out", "X.HTML");
    const r = runOut(fx, out);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.split("\n")[0], `Dashboard: ${out}`);
    assert.ok(statSync(out).isFile());
    assert.ok(existsSync(join(fx.root, "out", "X", "index.html")));
    const dash = dashFor(fx, { out: join(fx.root, "out", "x.htm"), projectsDir: null });
    dash.generate();
    assert.equal(dash.site, join(fx.root, "out", "x"));
    assert.ok(statSync(join(fx.root, "out", "x.htm")).isFile());
    assert.ok(existsSync(join(fx.root, "out", "x", "index.html")));
  } finally { fx.cleanup(); }
});

// ---------- --open ----------
// Windows used to go through `cmd /c start`, which re-parses & and % in an unquoted path; explorer.exe
// takes it as one argument. No Windows host runs this suite, so this pure builder is the only check.
test("openCommand: the path is one argument on every platform, and nothing goes through cmd", () => {
  const posix = "/tmp/a b&c%d/dashboard.html", win = "C:\\a&b\\x%y%\\dashboard.html";
  const cases = [["win32", win, "explorer.exe"], ["win32", posix, "explorer.exe"], ["darwin", posix, "open"], ["linux", posix, "xdg-open"], ["freebsd", posix, "xdg-open"], ["linux", win, "xdg-open"]];
  for (const [platform, file, cmd] of cases) {
    const got = openCommand(platform, file);
    assert.deepEqual(got, [cmd, [file]], `${platform} ${file}`);
    assert.equal(got[1].length, 1);
    assert.equal(got[1][0], file);
    assert.doesNotMatch(got[0], /cmd/i);
  }
});

// A missing opener (no xdg-open on a headless box) is reported by spawn as an async "error" event,
// which try/catch cannot see; with no listener it crashed the run after the page was written.
test("CLI: --open with no opener on PATH still exits 0 and prints the path", POSIX, () => {
  const fx = makeFixture();
  try {
    const tmp = join(fx.root, "tmp"), empty = join(fx.root, "empty-path"), out = join(fx.root, "o", "dashboard.html");
    mkdirSync(tmp); mkdirSync(empty);
    const r = spawnSync(process.execPath, [SCRIPT, "--open", "--no-usage", "--out", out], { cwd: fx.repo, encoding: "utf8", env: { ...process.env, PATH: empty, TMPDIR: tmp, TEMP: tmp, TMP: tmp } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(`Dashboard: ${out}`), r.stdout);
    assert.ok(statSync(out).isFile());
  } finally { fx.cleanup(); }
});
