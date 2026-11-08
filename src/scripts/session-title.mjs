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

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ANY_PLAN_ID_RE, extractField } from "./shared.mjs";

const EVENTS = ["SessionStart", "UserPromptSubmit"];
const SEP = " · ";
const STATES = "EXPLORE|PLAN|EXECUTE|REFLECT|PIVOT|CLOSE|UNKNOWN";
const OWN_TITLE_RE = new RegExp(`^.+ \\u00b7 (${STATES}) \\u00b7 `);
const MAX_GOAL = 50;
const START_SOURCES = new Set(["startup", "resume", "fork"]);

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
    const line = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    if (line) return line.length > MAX_GOAL ? line.slice(0, MAX_GOAL - 1).trimEnd() + "…" : line;
  }
  return "?";
}

/** Pure: the title for a project root + plan id, or null. */
export function computeTitle(root, id) {
  const planDir = join(root, "plans", id);
  const state = extractField(readSafe(join(planDir, "state.md")), /^# Current State:\s*([A-Za-z]+)/m);
  const stateName = state && new RegExp(`^(${STATES})$`).test(state.toUpperCase()) ? state.toUpperCase() : "UNKNOWN";
  return [basename(root), stateName, cleanGoal(readSafe(join(planDir, "plan.md")))].join(SEP);
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
  if (current && (!OWN_TITLE_RE.test(current) || current === title)) return null;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, sessionTitle: title } });
}

function printSettings() {
  const command = `node "${fileURLToPath(import.meta.url)}"`;
  const hooks = {};
  for (const e of EVENTS) hooks[e] = [{ hooks: [{ type: "command", command }] }];
  console.log(JSON.stringify({ hooks }, null, 2));
}

function main() {
  if (process.argv.includes("--print-settings")) return printSettings();
  if (process.stdin.isTTY) return;
  const out = hookOutput(JSON.parse(readFileSync(0, "utf8")));
  if (out) console.log(out);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch {
    // Silent by contract: a hook helper must never break the user's prompt.
  }
}
