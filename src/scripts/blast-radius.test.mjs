#!/usr/bin/env node
// Tests for blast-radius.mjs.
// Run: node --test src/scripts/blast-radius.test.mjs
// Requires: Node.js 18+

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, rmSync, unlinkSync } from "fs";
import { join, resolve } from "path";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { randomBytes } from "crypto";

const SCRIPT = resolve(import.meta.dirname, "blast-radius.mjs");

function makeTempDir() {
  const name = `radius-test-${randomBytes(4).toString("hex")}`;
  const dir = join(tmpdir(), name);
  mkdirSync(dir, { recursive: true });
  // initialize as git repo
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "init"], { cwd: dir });
  return dir;
}

function removeTempDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function run(cwd, ...args) {
  const r = spawnSync("node", [SCRIPT, ...args], { cwd, encoding: "utf-8", timeout: 5000 });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.status ?? 1 };
}

function git(cwd, ...a) {
  return spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, encoding: "utf-8" });
}
function commitAll(cwd, msg = "c") { git(cwd, "add", "-A"); git(cwd, "commit", "-qm", msg); }
/** A temp dir that is NOT a git repo. */
function makeNonGitDir() {
  const dir = join(tmpdir(), `radius-nogit-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("blast-radius.mjs — D-003: spawnSync argv shape prevents shell injection (OBS-002)", () => {
  // Injection happens in `git diff ... -- "${repoRel}"` and similar — the
  // filename is interpolated into the shell argv BEFORE the file-existence
  // check (see blast-radius.mjs `if (!existsSync(filePath)) { tryExec(...) }`).
  // So the file does NOT need to exist on disk to trip the injection — only
  // the argv string handling matters.
  it("filename containing $() must not execute via shell expansion", () => {
    const cwd = makeTempDir();
    try {
      const sentinel = join(tmpdir(), `radius_pwn_${randomBytes(6).toString("hex")}`);
      assert.ok(!existsSync(sentinel), "sentinel must not exist pre-run");

      const badName = `x$(touch ${sentinel}).js`;
      const r = run(cwd, badName, "--verbose");

      assert.equal(r.exitCode, 0, `blast-radius must always exit 0; got ${r.exitCode}`);
      assert.ok(!existsSync(sentinel),
        `shell injection: ${sentinel} was created — argv must never reach a shell. stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    } finally {
      removeTempDir(cwd);
    }
  });

  it("filename containing backticks must not execute via shell expansion", () => {
    const cwd = makeTempDir();
    try {
      const sentinel = join(tmpdir(), `radius_tic_${randomBytes(6).toString("hex")}`);
      assert.ok(!existsSync(sentinel), "sentinel must not exist pre-run");

      const badName = "x`touch " + sentinel + "`.js";
      const r = run(cwd, badName, "--verbose");
      assert.equal(r.exitCode, 0, `blast-radius must always exit 0; got ${r.exitCode}`);
      assert.ok(!existsSync(sentinel),
        `shell injection (backtick): ${sentinel} was created. stdout:\n${r.stdout}`);
    } finally {
      removeTempDir(cwd);
    }
  });

  it("clean filename produces normal radius output (regression)", () => {
    const cwd = makeTempDir();
    try {
      writeFileSync(join(cwd, "clean.js"), "var x = 1;\n");
      spawnSync("git", ["add", "-A"], { cwd });
      spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "add"], { cwd });
      const r = run(cwd, "clean.js", "--verbose");
      assert.equal(r.exitCode, 0);
      assert.ok(/^radius:(LOW|MED|HIGH|UNKNOWN)\b/.test(r.stdout.trim()),
        `expected radius:TIER format, got:\n${r.stdout}`);
    } finally {
      removeTempDir(cwd);
    }
  });
});

// H2 — the UNKNOWN exit paths were entirely untested. Each must exit 0 and
// emit the documented reason token.
describe("blast-radius.mjs — H2: UNKNOWN exit paths", () => {
  it("no file arg → UNKNOWN(no-file-arg)", () => {
    const cwd = makeTempDir();
    try {
      const r = run(cwd);
      assert.equal(r.exitCode, 0);
      assert.match(r.stdout.trim(), /^radius:UNKNOWN\(no-file-arg\)$/);
    } finally { removeTempDir(cwd); }
  });

  it("outside a git repo → UNKNOWN(no-git)", () => {
    const dir = makeNonGitDir();
    try {
      writeFileSync(join(dir, "f.js"), "x\n");
      const r = run(dir, "f.js");
      assert.equal(r.exitCode, 0);
      assert.match(r.stdout.trim(), /^radius:UNKNOWN\(no-git\)$/);
    } finally { removeTempDir(dir); }
  });

  it("directory argument → UNKNOWN(is-directory)", () => {
    const cwd = makeTempDir();
    try {
      mkdirSync(join(cwd, "subdir"));
      const r = run(cwd, "subdir");
      assert.equal(r.exitCode, 0);
      assert.match(r.stdout.trim(), /^radius:UNKNOWN\(is-directory\)$/);
    } finally { removeTempDir(cwd); }
  });

  it("nonexistent untracked file → UNKNOWN(not-tracked)", () => {
    const cwd = makeTempDir();
    try {
      const r = run(cwd, "ghost.js");
      assert.equal(r.exitCode, 0);
      assert.match(r.stdout.trim(), /^radius:UNKNOWN\(not-tracked\)$/);
    } finally { removeTempDir(cwd); }
  });
});

// H2 — the --json mode is consumed by the orchestrator but was tested nowhere.
describe("blast-radius.mjs — H2: --json output", () => {
  it("clean tracked file emits the full JSON schema", () => {
    const cwd = makeTempDir();
    try {
      writeFileSync(join(cwd, "clean.js"), "var x = 1;\n");
      commitAll(cwd);
      const r = run(cwd, "clean.js", "--json");
      assert.equal(r.exitCode, 0);
      const obj = JSON.parse(r.stdout.trim());
      assert.ok(["LOW", "MED", "HIGH"].includes(obj.tier), `tier: ${obj.tier}`);
      assert.equal(typeof obj.score, "number");
      assert.equal(obj.file, "clean.js");
      for (const k of ["loc", "deps", "shared", "api", "tests", "hist"]) {
        assert.ok(obj.signals[k], `signals.${k} present`);
        assert.equal(typeof obj.signals[k].score, "number", `signals.${k}.score numeric`);
      }
    } finally { removeTempDir(cwd); }
  });

  it("UNKNOWN path emits JSON with tier+reason+file", () => {
    const dir = makeNonGitDir();
    try {
      writeFileSync(join(dir, "f.js"), "x\n");
      const r = run(dir, "f.js", "--json");
      assert.equal(r.exitCode, 0);
      const o = JSON.parse(r.stdout.trim());
      assert.equal(o.tier, "UNKNOWN");
      assert.equal(o.reason, "no-git");
      assert.equal(o.file, "f.js");
    } finally { removeTempDir(dir); }
  });
});

// H2 — individual signal scoring was untested (a broken signal would return a
// wrong tier silently). Assert per-signal scores via the --json breakdown.
describe("blast-radius.mjs — H2: signal scoring", () => {
  it("shared-path file (lib/) scores shared=2", () => {
    const cwd = makeTempDir();
    try {
      mkdirSync(join(cwd, "lib"));
      writeFileSync(join(cwd, "lib", "thing.js"), "var a = 1;\n");
      commitAll(cwd);
      const r = run(cwd, join("lib", "thing.js"), "--json");
      const o = JSON.parse(r.stdout.trim());
      assert.equal(o.signals.shared.score, 2, JSON.stringify(o.signals.shared));
      assert.equal(o.signals.shared.match, true);
    } finally { removeTempDir(cwd); }
  });

  it("non-shared path scores shared=0", () => {
    const cwd = makeTempDir();
    try {
      writeFileSync(join(cwd, "app.js"), "var a = 1;\n");
      commitAll(cwd);
      const r = run(cwd, "app.js", "--json");
      assert.equal(JSON.parse(r.stdout.trim()).signals.shared.score, 0);
    } finally { removeTempDir(cwd); }
  });

  it("added `export` line scores api=2", () => {
    const cwd = makeTempDir();
    try {
      writeFileSync(join(cwd, "mod.js"), "var a = 1;\n");
      commitAll(cwd);
      writeFileSync(join(cwd, "mod.js"), "var a = 1;\nexport function foo() {}\n"); // unstaged
      const r = run(cwd, "mod.js", "--json");
      const o = JSON.parse(r.stdout.trim());
      assert.equal(o.signals.api.score, 2, JSON.stringify(o.signals.api));
      assert.ok(o.signals.api.hits >= 1);
    } finally { removeTempDir(cwd); }
  });

  it("LOC churn > 20 lines scores loc >= 1", () => {
    const cwd = makeTempDir();
    try {
      writeFileSync(join(cwd, "big.js"), "x\n");
      commitAll(cwd);
      const added = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
      writeFileSync(join(cwd, "big.js"), "x\n" + added + "\n"); // unstaged
      const r = run(cwd, "big.js", "--json");
      const o = JSON.parse(r.stdout.trim());
      assert.ok(o.signals.loc.score >= 1, `expected loc>=1, got ${JSON.stringify(o.signals.loc)}`);
      assert.ok(o.signals.loc.added >= 20);
    } finally { removeTempDir(cwd); }
  });

  it("--verbose appends the per-signal breakdown", () => {
    const cwd = makeTempDir();
    try {
      writeFileSync(join(cwd, "v.js"), "x\n");
      commitAll(cwd);
      const r = run(cwd, "v.js", "--verbose");
      assert.equal(r.exitCode, 0);
      for (const sig of [/loc=\d+/, /deps=\d+/, /shared=\d+/, /api=\d+/, /tests=/, /hist=\d+/]) {
        assert.match(r.stdout, sig);
      }
    } finally { removeTempDir(cwd); }
  });
});

// #9 — the tier mapping (blast-radius.mjs:263 `score <= 2 ? "LOW" : score <= 5
// ? "MED" : "HIGH"`) and the deps/tests signals were untested: a scoring
// regression could feed the executor a wrong tier and bypass blast-radius
// review. The tier mapping is an inline ternary (not an importable function),
// so each boundary is exercised by composing signals whose total score lands
// exactly on the boundary, then asserting the `tier` field via --json.
//
// Boundary thresholds confirmed from source: LOW for score <= 2, MED for
// 3 <= score <= 5, HIGH for score >= 6. Boundary scores tested: 2->LOW (upper
// edge of LOW), 3->MED (lower edge of MED), 5->MED (upper edge of MED),
// 6->HIGH (lower edge of HIGH). Signal building blocks used (all deterministic
// in an isolated temp repo with no plans/ dir, so loc=0 and hist=0):
//   shared = 2  when the file path is under lib/ (sharedPath)
//   api    = 2  when the working-tree diff adds an `export` line (publicApiTouch)
//   deps   = 1  when 1..5 other files import the file's basename (reverseDeps)
describe("blast-radius.mjs — #9: tier-boundary mapping (LOW<=2, MED 3-5, HIGH>=6)", () => {
  it("score 2 -> LOW (upper edge of LOW): api=2 alone", () => {
    const cwd = makeTempDir();
    try {
      writeFileSync(join(cwd, "mod.js"), "var a=1;\n");
      commitAll(cwd);
      writeFileSync(join(cwd, "mod.js"), "var a=1;\nexport function foo(){}\n"); // unstaged: api=2
      const o = JSON.parse(run(cwd, "mod.js", "--json").stdout.trim());
      assert.equal(o.score, 2, JSON.stringify(o.signals));
      assert.equal(o.tier, "LOW", JSON.stringify(o));
    } finally { removeTempDir(cwd); }
  });

  it("score 3 -> MED (lower edge of MED): shared=2 + deps=1", () => {
    const cwd = makeTempDir();
    try {
      mkdirSync(join(cwd, "lib"));
      writeFileSync(join(cwd, "lib", "a.js"), "export const a=1;\n"); // shared=2 (lib/)
      writeFileSync(join(cwd, "one.js"), 'import { a } from "./lib/a.js";\n'); // deps=1
      commitAll(cwd);
      const o = JSON.parse(run(cwd, join("lib", "a.js"), "--json").stdout.trim());
      assert.equal(o.signals.shared.score, 2);
      assert.equal(o.signals.deps.score, 1, JSON.stringify(o.signals.deps));
      assert.equal(o.score, 3, JSON.stringify(o.signals));
      assert.equal(o.tier, "MED", JSON.stringify(o));
    } finally { removeTempDir(cwd); }
  });

  it("score 5 -> MED (upper edge of MED): shared=2 + api=2 + deps=1", () => {
    const cwd = makeTempDir();
    try {
      mkdirSync(join(cwd, "lib"));
      writeFileSync(join(cwd, "lib", "b.js"), "export const b=1;\n");
      writeFileSync(join(cwd, "oneb.js"), 'import { b } from "./lib/b.js";\n'); // deps=1
      commitAll(cwd);
      writeFileSync(join(cwd, "lib", "b.js"), "export const b=1;\nexport function f(){}\n"); // api=2 (unstaged)
      const o = JSON.parse(run(cwd, join("lib", "b.js"), "--json").stdout.trim());
      assert.equal(o.signals.shared.score, 2);
      assert.equal(o.signals.api.score, 2);
      assert.equal(o.signals.deps.score, 1, JSON.stringify(o.signals.deps));
      assert.equal(o.score, 5, JSON.stringify(o.signals));
      assert.equal(o.tier, "MED", JSON.stringify(o));
    } finally { removeTempDir(cwd); }
  });

  it("score 6 -> HIGH (lower edge of HIGH): shared=2 + api=2 + deps=2", () => {
    const cwd = makeTempDir();
    try {
      mkdirSync(join(cwd, "lib"));
      writeFileSync(join(cwd, "lib", "core.js"), "export const c=1;\n");
      for (let i = 1; i <= 6; i++) {
        writeFileSync(join(cwd, `u${i}.js`), 'import { c } from "./lib/core.js";\n'); // 6 importers -> deps=2
      }
      commitAll(cwd);
      writeFileSync(join(cwd, "lib", "core.js"), "export const c=1;\nexport function more(){}\n"); // api=2
      const o = JSON.parse(run(cwd, join("lib", "core.js"), "--json").stdout.trim());
      assert.equal(o.signals.deps.score, 2, JSON.stringify(o.signals.deps)); // count 6 in [6,20]
      assert.equal(o.score, 6, JSON.stringify(o.signals));
      assert.equal(o.tier, "HIGH", JSON.stringify(o));
    } finally { removeTempDir(cwd); }
  });
});

// #9 — deps (reverseDeps) and tests (testDelta) signal contributions were
// untested. Assert each contributes its expected non-zero score via --json on
// the minimal fixture that triggers it.
describe("blast-radius.mjs — #9: deps + tests signal contributions", () => {
  it("deps signal: a single importer contributes deps.score=1 (count=1)", () => {
    const cwd = makeTempDir();
    try {
      writeFileSync(join(cwd, "dep.js"), "export const x=1;\n");
      writeFileSync(join(cwd, "user.js"), 'import { x } from "./dep.js";\n');
      commitAll(cwd);
      const o = JSON.parse(run(cwd, "dep.js", "--json").stdout.trim());
      assert.equal(o.signals.deps.count, 1, JSON.stringify(o.signals.deps));
      assert.equal(o.signals.deps.score, 1, JSON.stringify(o.signals.deps));
    } finally { removeTempDir(cwd); }
  });

  it("deps signal: no importer contributes deps.score=0 (count=0)", () => {
    const cwd = makeTempDir();
    try {
      writeFileSync(join(cwd, "lonely.js"), "export const z=1;\n");
      commitAll(cwd);
      const o = JSON.parse(run(cwd, "lonely.js", "--json").stdout.trim());
      assert.equal(o.signals.deps.count, 0, JSON.stringify(o.signals.deps));
      assert.equal(o.signals.deps.score, 0);
    } finally { removeTempDir(cwd); }
  });

  it("tests signal: a changed test referencing the file contributes tests.score=-1", () => {
    const cwd = makeTempDir();
    try {
      writeFileSync(join(cwd, "widget.js"), "export const y=1;\n");
      commitAll(cwd);
      mkdirSync(join(cwd, "test"));
      // Staged (changed vs HEAD) test file under test/ referencing the basename.
      writeFileSync(join(cwd, "test", "widget.test.js"), "import { y } from \"../widget.js\";\n// widget test\n");
      git(cwd, "add", "-A");
      const o = JSON.parse(run(cwd, "widget.js", "--json").stdout.trim());
      assert.equal(o.signals.tests.hit, true, JSON.stringify(o.signals.tests));
      assert.equal(o.signals.tests.score, -1, JSON.stringify(o.signals.tests));
    } finally { removeTempDir(cwd); }
  });

  it("tests signal: no related test change contributes tests.score=0", () => {
    const cwd = makeTempDir();
    try {
      writeFileSync(join(cwd, "solo.js"), "export const s=1;\n");
      commitAll(cwd);
      const o = JSON.parse(run(cwd, "solo.js", "--json").stdout.trim());
      assert.equal(o.signals.tests.hit, false);
      assert.equal(o.signals.tests.score, 0);
    } finally { removeTempDir(cwd); }
  });

  it("hist signal: file in active plan state.md Change Manifest -> hist.score=1, hist.prior=true", () => {
    // iterationHistory() reads plans/.current_plan to find the active plan dir,
    // then searches state.md (and checkpoints/*.md) for the target file path.
    // Constructing a fake plans/ dir here exercises that path directly.
    const cwd = makeTempDir();
    try {
      writeFileSync(join(cwd, "tracked.js"), "export const t=1;\n");
      commitAll(cwd);

      // Build a minimal plans/ dir with .current_plan and a state.md that
      // references "tracked.js" in the Change Manifest section.
      const planId = "plan_2026-01-01_aaaaaaaa";
      const planDir = join(cwd, "plans", planId);
      mkdirSync(planDir, { recursive: true });
      writeFileSync(join(cwd, "plans", ".current_plan"), planId + "\n");
      const stateContent = [
        "# Current State: EXECUTE",
        "## Iteration: 1",
        "## Current Plan Step: 1",
        "## Change Manifest (current iteration)",
        "- step-1: tracked.js — some change (abc1234)",
        "## Last Transition: INIT -> EXECUTE",
      ].join("\n") + "\n";
      writeFileSync(join(planDir, "state.md"), stateContent);

      const o = JSON.parse(run(cwd, "tracked.js", "--json").stdout.trim());
      assert.equal(o.signals.hist.score, 1,
        `expected hist.score=1 (file in plan manifest); got ${JSON.stringify(o.signals.hist)}`);
      assert.equal(o.signals.hist.prior, true,
        `expected hist.prior=true; got ${JSON.stringify(o.signals.hist)}`);
    } finally { removeTempDir(cwd); }
  });
});

// Defect #1 — untracked/new files scored LOW(0). Every signal that read the diff
// called `git diff HEAD`, which by design excludes untracked files, so a brand-new
// file (the `OP=CREATE` case, and typically the riskiest edit) got the LOWEST
// possible radius. This had ZERO coverage precisely because every test above stages
// or commits its fixture first. These tests score files WITHOUT `git add`.
//
// Pre-fix repro (500-line new file): unstaged → `radius:LOW(0) loc=0(+0,-0)`;
// after `git add` with zero content change → `radius:MED(3) loc=3(+500,-0)`.
describe("blast-radius.mjs — defect #1: untracked (CREATE) files are scored from content", () => {
  it("500-line UNTRACKED file: loc.added=500, loc.score=3, total score > 0, exit 0", () => {
    const cwd = makeTempDir();
    try {
      const body = Array.from({ length: 500 }, (_, i) => `line${i}`).join("\n") + "\n";
      writeFileSync(join(cwd, "big.js"), body); // NOT staged, NOT committed
      const r = run(cwd, "big.js", "--json");
      assert.equal(r.exitCode, 0, "blast-radius must always exit 0");
      const o = JSON.parse(r.stdout.trim());
      assert.equal(o.signals.loc.added, 500,
        `untracked file must be scored by content; got ${JSON.stringify(o.signals.loc)}`);
      assert.equal(o.signals.loc.removed, 0);
      assert.equal(o.signals.loc.score, 3, JSON.stringify(o.signals.loc));
      assert.ok(o.score > 0, `expected score > 0 for a 500-line new file, got ${o.score}`);
      assert.notEqual(o.tier, "UNKNOWN");
    } finally { removeTempDir(cwd); }
  });

  it("staging an untracked file changes nothing (the pre-fix LOW(0) -> MED(3) jump is gone)", () => {
    const cwd = makeTempDir();
    try {
      const body = Array.from({ length: 500 }, (_, i) => `line${i}`).join("\n") + "\n";
      writeFileSync(join(cwd, "big.js"), body);
      const before = JSON.parse(run(cwd, "big.js", "--json").stdout.trim());
      git(cwd, "add", "big.js"); // zero content change
      const after = JSON.parse(run(cwd, "big.js", "--json").stdout.trim());
      assert.deepEqual(before.signals.loc, after.signals.loc,
        `git add alone must not move the score: ${JSON.stringify(before.signals.loc)} vs ${JSON.stringify(after.signals.loc)}`);
      assert.equal(before.score, after.score);
      assert.equal(before.tier, after.tier);
    } finally { removeTempDir(cwd); }
  });

  it("UNTRACKED file exporting a public symbol scores api=2 (body scanned, no diff exists)", () => {
    const cwd = makeTempDir();
    try {
      writeFileSync(join(cwd, "newapi.js"), "const priv = 1;\nexport function foo() {}\n"); // untracked
      const r = run(cwd, "newapi.js", "--json");
      assert.equal(r.exitCode, 0);
      const o = JSON.parse(r.stdout.trim());
      assert.equal(o.signals.api.score, 2, JSON.stringify(o.signals.api));
      assert.equal(o.signals.api.hits, 1, JSON.stringify(o.signals.api));
    } finally { removeTempDir(cwd); }
  });

  it("UNTRACKED test file is seen by testDelta (tests.score=-1) for an untracked module", () => {
    const cwd = makeTempDir();
    try {
      writeFileSync(join(cwd, "widget.js"), "export const w = 1;\n"); // untracked module
      mkdirSync(join(cwd, "test"));
      writeFileSync(join(cwd, "test", "widget.test.js"), 'import { w } from "../widget.js";\n'); // untracked test
      const o = JSON.parse(run(cwd, "widget.js", "--json").stdout.trim());
      assert.equal(o.signals.tests.hit, true, JSON.stringify(o.signals.tests));
      assert.equal(o.signals.tests.score, -1, JSON.stringify(o.signals.tests));
    } finally { removeTempDir(cwd); }
  });

  it("empty UNTRACKED file scores loc.added=0 and stays LOW (no off-by-one from the trailing newline)", () => {
    const cwd = makeTempDir();
    try {
      writeFileSync(join(cwd, "empty.js"), "");
      const r = run(cwd, "empty.js", "--json");
      assert.equal(r.exitCode, 0);
      const o = JSON.parse(r.stdout.trim());
      assert.equal(o.signals.loc.added, 0, JSON.stringify(o.signals.loc));
      assert.equal(o.signals.loc.score, 0);
    } finally { removeTempDir(cwd); }
  });

  it("REGRESSION PIN: tracked-file scores are unchanged by the untracked-file fix", () => {
    // Same three fixtures the tier-boundary suite pins, re-asserted with exact
    // pre-fix values. If the CREATE synthesis ever leaks into the tracked path,
    // these move.
    const cwd = makeTempDir();
    try {
      // (a) committed, unmodified file -> everything 0 -> LOW(0)
      writeFileSync(join(cwd, "quiet.js"), "var a = 1;\n");
      commitAll(cwd);
      const quiet = JSON.parse(run(cwd, "quiet.js", "--json").stdout.trim());
      assert.deepEqual(
        { loc: quiet.signals.loc.score, added: quiet.signals.loc.added, api: quiet.signals.api.score, score: quiet.score, tier: quiet.tier },
        { loc: 0, added: 0, api: 0, score: 0, tier: "LOW" }, JSON.stringify(quiet));

      // (b) committed file, unstaged 30-line append -> loc=1, added=30
      writeFileSync(join(cwd, "churn.js"), "x\n");
      commitAll(cwd);
      writeFileSync(join(cwd, "churn.js"), "x\n" + Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n") + "\n");
      const churn = JSON.parse(run(cwd, "churn.js", "--json").stdout.trim());
      assert.equal(churn.signals.loc.added, 30, JSON.stringify(churn.signals.loc));
      assert.equal(churn.signals.loc.removed, 0);
      assert.equal(churn.signals.loc.score, 1, JSON.stringify(churn.signals.loc));

      // (c) committed file, unstaged export added -> api=2 via the DIFF path
      //     (only the added line counts — the pre-existing export must NOT be
      //     re-counted, which is exactly what a body scan on a tracked file would do)
      writeFileSync(join(cwd, "api.js"), "export const old = 1;\n");
      commitAll(cwd);
      writeFileSync(join(cwd, "api.js"), "export const old = 1;\nexport function added() {}\n");
      const api = JSON.parse(run(cwd, "api.js", "--json").stdout.trim());
      assert.equal(api.signals.api.hits, 1,
        `tracked file must be scored from the diff, not the body; got ${JSON.stringify(api.signals.api)}`);
      assert.equal(api.signals.api.score, 2);
    } finally { removeTempDir(cwd); }
  });

  it("UNTRACKED binary file still emits UNKNOWN(unreadable), exit 0", () => {
    const cwd = makeTempDir();
    try {
      writeFileSync(join(cwd, "blob.js"), Buffer.from([0x61, 0x00, 0x62, 0x00]));
      const r = run(cwd, "blob.js");
      assert.equal(r.exitCode, 0);
      assert.match(r.stdout.trim(), /^radius:UNKNOWN\(unreadable\)$/);
    } finally { removeTempDir(cwd); }
  });

  it("nonexistent path still emits UNKNOWN(not-tracked), exit 0 (guard preserved)", () => {
    const cwd = makeTempDir();
    try {
      const r = run(cwd, "nope.js", "--json");
      assert.equal(r.exitCode, 0);
      const o = JSON.parse(r.stdout.trim());
      assert.equal(o.tier, "UNKNOWN");
      assert.equal(o.reason, "not-tracked");
    } finally { removeTempDir(cwd); }
  });

  it("untracked file outside a git repo still emits UNKNOWN(no-git), exit 0 (guard preserved)", () => {
    const dir = makeNonGitDir();
    try {
      writeFileSync(join(dir, "loose.js"), "export const q = 1;\n");
      const r = run(dir, "loose.js");
      assert.equal(r.exitCode, 0);
      assert.match(r.stdout.trim(), /^radius:UNKNOWN\(no-git\)$/);
    } finally { removeTempDir(dir); }
  });
});
