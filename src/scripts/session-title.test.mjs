// Requires Node.js 18+
// Tests for session-title.mjs — the optional, read-only Claude Code hook helper.
// Fixtures are temp project dirs (realpath'd) removed in finally blocks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "session-title.mjs");
const PLAN_ID = "plan-2026-11-08T045739-7cce7d81";

function project({ goal = "Ship the thing", state = "EXECUTE", pointer = PLAN_ID, stateFile = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "st-")));
  mkdirSync(join(root, "plans", PLAN_ID), { recursive: true });
  if (pointer !== null) writeFileSync(join(root, "plans", ".current_plan"), pointer + "\n");
  if (stateFile) writeFileSync(join(root, "plans", PLAN_ID, "state.md"), `# Current State: ${state}\n## Iteration: 1\n`);
  writeFileSync(join(root, "plans", PLAN_ID, "plan.md"), `# Plan v1\n\n## Goal\n${goal}\n\n## Context\nx\n`);
  return root;
}

function run(input, args = []) {
  const r = spawnSync("node", [SCRIPT, ...args], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function withProject(opts, fn) {
  const root = project(opts);
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const titleOf = (r) => JSON.parse(r.stdout).hookSpecificOutput.sessionTitle;

test("SessionStart prints the title", () => {
  withProject({}, (root) => {
    const r = run({ hook_event_name: "SessionStart", source: "startup", cwd: root });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
    assert.equal(out.hookSpecificOutput.sessionTitle, `${basename(root)} · EXECUTE · Ship the thing`);
    assert.equal(r.stdout.trim().split("\n").length, 1);
  });
});

test("SessionStart without source and with resume/fork prints", () => {
  withProject({}, (root) => {
    for (const source of [undefined, "resume", "fork"]) {
      assert.ok(run({ hook_event_name: "SessionStart", source, cwd: root }).stdout, String(source));
    }
  });
});

test("UserPromptSubmit echoes its event name", () => {
  withProject({ state: "REFLECT" }, (root) => {
    const r = run({ hook_event_name: "UserPromptSubmit", cwd: root });
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(titleOf(r), / · REFLECT · /);
  });
});

test("subdirectory cwd walks up to the project root", () => {
  withProject({}, (root) => {
    const sub = join(root, "a", "b");
    mkdirSync(sub, { recursive: true });
    assert.equal(titleOf(run({ hook_event_name: "UserPromptSubmit", cwd: sub })).split(" · ")[0], basename(root));
  });
});

test("no plan prints nothing", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "st-")));
  try {
    const r = run({ hook_event_name: "SessionStart", cwd: root });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("garbage or traversal pointer prints nothing", () => {
  for (const pointer of ["not-a-plan", "plan-../x", ""]) {
    withProject({ pointer }, (root) => {
      const r = run({ hook_event_name: "SessionStart", cwd: root });
      assert.equal(r.status, 0, pointer);
      assert.equal(r.stdout, "", pointer);
    });
  }
});

test("invalid JSON stdin and empty stdin print nothing, exit 0", () => {
  for (const input of ["{not json", ""]) {
    const r = run(input);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  }
});

test("other events and SessionStart source clear print nothing", () => {
  withProject({}, (root) => {
    for (const payload of [
      { hook_event_name: "PreToolUse", cwd: root },
      { hook_event_name: "SessionStart", source: "clear", cwd: root },
      { hook_event_name: "SessionStart", source: "compact", cwd: root },
    ]) {
      const r = run(payload);
      assert.equal(r.status, 0);
      assert.equal(r.stdout, "");
    }
  });
});

test("a foreign session_title (user rename) is respected", () => {
  withProject({}, (root) => {
    assert.equal(run({ hook_event_name: "UserPromptSubmit", cwd: root, session_title: "my refactor" }).stdout, "");
  });
});

test("our own earlier title is updated, an identical one is not re-emitted", () => {
  withProject({ state: "REFLECT" }, (root) => {
    const old = `${basename(root)} · EXECUTE · Ship the thing`;
    const r = run({ hook_event_name: "UserPromptSubmit", cwd: root, session_title: old });
    assert.match(titleOf(r), / · REFLECT · /);
    assert.equal(run({ hook_event_name: "UserPromptSubmit", cwd: root, session_title: titleOf(r) }).stdout, "");
  });
});

test("long goal is truncated with an ellipsis", () => {
  withProject({ goal: "x".repeat(200) }, (root) => {
    const goal = titleOf(run({ hook_event_name: "SessionStart", cwd: root })).split(" · ")[2];
    assert.ok(goal.length <= 50);
    assert.ok(goal.endsWith("…"));
  });
});

test("multi-line goal: first non-empty line, controls and pipes handled; empty goal is ?", () => {
  withProject({ goal: "\n\nFirst | line\u0007 here\nsecond" }, (root) => {
    assert.equal(titleOf(run({ hook_event_name: "SessionStart", cwd: root })).split(" · ")[2], "First | line here");
  });
  withProject({ goal: "" }, (root) => {
    assert.equal(titleOf(run({ hook_event_name: "SessionStart", cwd: root })).split(" · ")[2], "?");
  });
});

test("missing state.md shows UNKNOWN", () => {
  withProject({ stateFile: false }, (root) => {
    assert.match(titleOf(run({ hook_event_name: "SessionStart", cwd: root })), / · UNKNOWN · /);
  });
});

test("--print-settings prints valid JSON with exactly two events", () => {
  const r = run("", ["--print-settings"]);
  assert.equal(r.status, 0);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(j.hooks).sort(), ["SessionStart", "UserPromptSubmit"]);
  for (const ev of Object.values(j.hooks)) {
    const cmd = ev[0].hooks[0];
    assert.equal(cmd.type, "command");
    assert.ok(cmd.command.startsWith('node "'));
    assert.ok(cmd.command.endsWith('session-title.mjs"'));
    assert.ok(cmd.command.includes(SCRIPT));
  }
});

test("source imports no write, spawn or network API", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const imports = [...src.matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1]);
  assert.ok(imports.every((m) => m.startsWith("node:") || m === "./shared.mjs"), imports.join());
  for (const bad of ["child_process", "node:http", "node:https", "node:net", "fetch(", "writeFile", "appendFile", "mkdirSync", "rmSync", "unlink", "renameSync", "createWriteStream"]) {
    assert.ok(!src.includes(bad), bad);
  }
  assert.ok(!/from "node:fs"/.test(src) || /import \{ existsSync, readFileSync \} from "node:fs"/.test(src));
});
