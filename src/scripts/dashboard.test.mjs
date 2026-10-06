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
  mdToHtml,
  modelName,
  openCommand,
  parseArgs,
  parseChangelog,
  parseDecisions,
  parsePlan,
  parseState,
  parseVerification,
  projectSlug,
  readPointer,
  scanFile,
  sessionsOf,
  splitLabel,
  stepsOf,
  timeSeries,
  total,
  transcriptFiles,
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
    const folder = join(root, "d.html");
    mkdirSync(folder);
    // A name before the suffix made only of dots or spaces makes the site folder the current folder or its
    // parent: directly for "." and "..", and on Windows (which strips trailing dots and spaces) for the rest.
    for (const v of ["dash", "dash/", "dash\\", "x.txt", ".html", "out/.htm", "..html", "...html", "x/...htm", "x\\..html", "....html", ". .html", " ..html", "x/ . .htm", " .html", folder]) {
      const { error } = parseArgs(["--out", v]);
      assert.ok(error, `--out ${v} should be rejected`);
      assert.ok(error.includes(v), `the error names the value: ${error}`);
      assert.match(error, /\.html or \.htm file path/);
    }
    assert.match(parseArgs(["--out", folder]).error, /existing folder/);
    for (const v of ["X.HTML", "x.htm", "out/Dash.Html", "a..html", "a .html", join(root, "missing", "page.html")]) assert.equal(parseArgs(["--out", v]).error, null, `--out ${v} should be accepted`);
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
