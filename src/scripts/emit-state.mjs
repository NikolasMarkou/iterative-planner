#!/usr/bin/env node
// Router: emit the operative per-state rule block for a named protocol state.
//
// Usage:
//   node emit-state.mjs --state <explore|plan|execute|reflect|pivot>
//
// Prints the verbatim body of the per-state rule block (extracted from SKILL.md
// "## Per-State Rules") to stdout and exits 0.
//
// Exit-code contract:
//   missing/absent --state flag (incl. --state as last token) → USAGE on stderr, exit 2
//     (POSIX usage-error convention).
//   unknown state value (incl. `close`, which has no module), unreadable module,
//     or empty/whitespace-only module → a clear diagnostic on stderr, exit 1.
//
// The per-state bodies live in ./modules/state-<state>.md, resolved relative to this
// script via import.meta.url so the router works regardless of CWD and inside the
// installed skill bundle. Emission is byte-faithful (verbatim file content, no trim).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const VALID_STATES = ["explore", "plan", "execute", "reflect", "pivot"];

const USAGE = "Usage: node emit-state.mjs --state <explore|plan|execute|reflect|pivot>";

// Return the module-file content for `state`, or null if `state` is not a valid state.
// Byte-faithful: returns the file content verbatim (no trim, no re-encode) so the
// emitted rules match the SKILL.md source exactly.
export function emitState(state, modulesBaseUrl = new URL("./modules/", import.meta.url)) {
  if (!VALID_STATES.includes(state)) return null;
  const url = new URL(`state-${state}.md`, modulesBaseUrl);
  return readFileSync(url);
}

// Pure, injectable seam: resolve and validate a state's module body, returning a
// tagged result instead of throwing or process.exit-ing. Unit-tested directly with a
// temp `modulesBaseUrl`. modulesBaseUrl is dependency injection for testability — NOT
// a config/env toggle; the default arg reproduces the production path byte-identically.
export function resolveModuleBody(state, modulesBaseUrl = new URL("./modules/", import.meta.url)) {
  if (!VALID_STATES.includes(state)) {
    return { ok: false, code: 1, message: `unknown state '${state}'; valid: ${VALID_STATES.join("|")}` };
  }
  let body;
  try {
    body = emitState(state, modulesBaseUrl);
  } catch (err) {
    return { ok: false, code: 1, message: `cannot read module for ${state}: ${err.code || err.message}` };
  }
  if (body.length === 0 || body.toString().trim() === "") {
    return { ok: false, code: 1, message: `module for ${state} is empty/corrupt` };
  }
  return { ok: true, body };
}

function runCli(argv) {
  const idx = argv.indexOf("--state");
  if (idx === -1 || idx === argv.length - 1) {
    process.stderr.write(USAGE + "\n");
    process.exit(2);
  }
  const state = argv[idx + 1];
  const result = resolveModuleBody(state);
  if (!result.ok) {
    process.stderr.write(result.message + "\n");
    process.exit(result.code);
  }
  process.stdout.write(result.body);
  process.exit(0);
}

// Standard Node.js ESM dual-mode guard (mirrors bootstrap.mjs): importable in tests
// without triggering CLI dispatch / process.exit.
const isEntryPoint = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  runCli(process.argv.slice(2));
}
