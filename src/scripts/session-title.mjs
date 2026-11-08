// Requires Node.js 18+
// session-title.mjs — optional Claude Code hook helper (SessionStart / UserPromptSubmit).
//
// Prints one JSON line carrying a `sessionTitle` so the session shows what the active plan is about
// (same effect as /rename). READ-ONLY by construction: it never writes a file, spawns a process or
// touches the network, and every failure path prints nothing and exits 0. The user opts in by pasting
// the snippet from `--print-settings` into ~/.claude/settings.json; nothing installs it.
//
// Interface contract:
//   stdin   Claude Code hook JSON ({hook_event_name, cwd, source?, session_title?}).
//   stdout  `{"hookSpecificOutput":{"hookEventName":..,"sessionTitle":..}}` or nothing.
//   flag    `--print-settings` prints the hooks JSON snippet (command = this script's own path), no stdin read.
//   exit    always 0.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isatty } from "node:tty";
import { fileURLToPath } from "node:url";
import { ANY_PLAN_ID_RE, extractField } from "./shared.mjs";

const EVENTS = ["SessionStart", "UserPromptSubmit"];
const SEP = " · ";
const STATES = "EXPLORE|PLAN|EXECUTE|REFLECT|PIVOT|CLOSE|UNKNOWN";
const OWN_REST_RE = new RegExp(`^(${STATES}) \\u00b7 `);
const UNSAFE_RE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
// Also: the Arabic letter mark (a bidi control), Mongolian vowel separator, combining grapheme joiner,
// variation selectors, and the Unicode TAG block U+E0000-E007F (invisible text that renders as nothing).
const INVISIBLE_RE = /[\u00ad\u061c\u034f\u180e\u200b-\u200d\u2060\ufeff\ufe00-\ufe0f\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
const MAX_STDIN = 1024 * 1024;
const STDIN_TIMEOUT_MS = 2000;
const MAX_GOAL = 50;
const START_SOURCES = new Set(["startup", "resume", "fork"]);

/** Remove zero-width/soft-hyphen chars, blank out control, C1 and bidi chars, and collapse whitespace, so a title is one plain line. */
function sanitize(text) {
  return String(text).replace(INVISIBLE_RE, "").replace(UNSAFE_RE, " ").replace(/\s+/g, " ").trim();
}

/**
 * Read stdin as text (<= 1 MB, <= 2 s). Resolves what was received so far on timeout (the caller parses it;
 * incomplete JSON fails to parse and prints nothing), "" on error or over-cap. Never rejects. Always releases
 * stdin, so the process can exit even when the parent never closes the pipe.
 */
function readStdin() {
  return new Promise((done) => {
    const chunks = [];
    let size = 0;
    let finished = false;
    const finish = (text) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      process.stdin.removeAllListeners("data");
      process.stdin.destroy();
      done(text);
    };
    const timer = setTimeout(() => finish(Buffer.concat(chunks).toString("utf8")), STDIN_TIMEOUT_MS);
    process.stdin.on("data", (c) => {
      size += c.length;
      if (size > MAX_STDIN) return finish("");
      chunks.push(c);
    });
    process.stdin.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => finish(""));
  });
}

function readSafe(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Walk up from `cwd` to the first dir holding plans/.current_plan. Returns {root, id} or null. */
function findPlan(cwd) {
  let dir = resolve(cwd);
  for (;;) {
    const ptr = join(dir, "plans", ".current_plan");
    if (existsSync(ptr)) {
      const id = (readSafe(ptr) ?? "").trim();
      return ANY_PLAN_ID_RE.test(id) ? { root: dir, id } : null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function cleanGoal(plan) {
  const m = plan && plan.match(/^## Goal[^\S\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m);
  const lines = (m ? m[1] : "").split("\n");
  for (const raw of lines) {
    const line = sanitize(raw);
    if (!line) continue;
    const chars = Array.from(line);
    return chars.length > MAX_GOAL ? chars.slice(0, MAX_GOAL - 1).join("").trimEnd() + "…" : line;
  }
  return "?";
}

function projectName(root) {
  return sanitize(basename(root)) || "?";
}

/** Pure: the title for a project root + plan id, or null. */
export function computeTitle(root, id) {
  const planDir = join(root, "plans", id);
  const state = extractField(readSafe(join(planDir, "state.md")), /^# Current State:\s*([A-Za-z]+)/m);
  const stateName = state && new RegExp(`^(${STATES})$`).test(state.toUpperCase()) ? state.toUpperCase() : "UNKNOWN";
  return [projectName(root), stateName, cleanGoal(readSafe(join(planDir, "plan.md")))].join(SEP);
}

/** Pure: the stdout line for a parsed hook payload, or null for "print nothing". */
export function hookOutput(input) {
  if (!input || typeof input !== "object") return null;
  const event = input.hook_event_name;
  if (!EVENTS.includes(event)) return null;
  if (event === "SessionStart" && input.source != null && !START_SOURCES.has(input.source)) return null;
  const found = findPlan(typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd());
  if (!found) return null;
  const title = computeTitle(found.root, found.id);
  const current = typeof input.session_title === "string" ? input.session_title : "";
  if (current) {
    const prefix = projectName(found.root) + SEP;
    const own = current.startsWith(prefix) && OWN_REST_RE.test(current.slice(prefix.length));
    if (!own || current === title) return null;
  }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, sessionTitle: title } });
}

function printSettings() {
  const command = `node "${fileURLToPath(import.meta.url)}"`;
  const hooks = {};
  for (const e of EVENTS) hooks[e] = [{ hooks: [{ type: "command", command }] }];
  console.log(JSON.stringify({ hooks }, null, 2));
}

async function main() {
  if (process.argv.includes("--print-settings")) return printSettings();
  if (isatty(0)) return;
  const out = hookOutput(JSON.parse(await readStdin()));
  if (out) console.log(out);
}

function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  // Silent by contract: a hook helper must never break the user's prompt.
  main().catch(() => {});
}
