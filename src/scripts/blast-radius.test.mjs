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
