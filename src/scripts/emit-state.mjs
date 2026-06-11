#!/usr/bin/env node
// Router: emit the operative per-state rule block for a named protocol state.
//
// Usage:
//   node emit-state.mjs --state <explore|plan|execute|reflect|pivot>
//
// Prints the verbatim body of the per-state rule block (extracted from SKILL.md
// "## Per-State Rules") to stdout and exits 0. Unknown or missing state → a clear
// stderr message + exit 1. CLOSE has no standalone Per-State block and is rejected.
//
// The per-state bodies live in ./modules/state-<state>.md, resolved relative to this
// script via import.meta.url so the router works regardless of CWD and inside the
// installed skill bundle.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const VALID_STATES = ["explore", "plan", "execute", "reflect", "pivot"];

const USAGE = "Usage: node emit-state.mjs --state <explore|plan|execute|reflect|pivot>";

// Return the module-file content for `state`, or null if `state` is not a valid state.
// Byte-faithful: returns the file content verbatim (no trim, no re-encode) so the
// emitted rules match the SKILL.md source exactly.
export function emitState(state) {
  if (!VALID_STATES.includes(state)) return null;
  const url = new URL(`./modules/state-${state}.md`, import.meta.url);
  return readFileSync(url);
}

function runCli(argv) {
  const idx = argv.indexOf("--state");
  if (idx === -1 || idx === argv.length - 1) {
    process.stderr.write(USAGE + "\n");
    process.exit(1);
  }
  const state = argv[idx + 1];
  if (!VALID_STATES.includes(state)) {
    process.stderr.write(
      `unknown state '${state}'; valid: ${VALID_STATES.join("|")}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(emitState(state));
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
