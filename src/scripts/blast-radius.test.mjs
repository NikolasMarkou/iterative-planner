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
