// Requires Node.js 18+
// Tests for emit-state.mjs — per-state rule-block router.
//
// Importing the module is side-effect-free: the CLI body runs only under the
// isEntryPoint guard, so this suite running at all proves no spurious process.exit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { emitState, resolveModuleBody, VALID_STATES } from "./emit-state.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const emitStatePath = join(here, "emit-state.mjs");

// Resolve the module file the same way emit-state.mjs does (relative to the script).
function moduleFileFor(state) {
  return join(here, "modules", `state-${state}.md`);
}

// State-specific sentinel substring proving the right block was emitted.
const SENTINELS = {
  explore: "DO NOT skip EXPLORE",
  plan: "Problem Statement first",
  execute: "Post-Step Gate",
  reflect: "Gate-In",
  pivot: "Ghost constraint scan",
};

// Fallback sentinel for explore (the spec allows either of two substrings).
const EXPLORE_ALT = "Exploration Confidence";

// --- Module API ---------------------------------------------------------------

test("VALID_STATES is the canonical 5-state list", () => {
  assert.deepEqual(VALID_STATES, ["explore", "plan", "execute", "reflect", "pivot"]);
});

test("emitState export is a function (no CLI side effects on import)", () => {
  assert.equal(typeof emitState, "function");
});

// Verify each sentinel actually exists in its module file before relying on it.
test("each module file contains its expected sentinel", () => {
  for (const state of VALID_STATES) {
    const text = readFileSync(moduleFileFor(state), "utf8");
    if (state === "explore") {
      assert.ok(
        text.includes(SENTINELS.explore) || text.includes(EXPLORE_ALT),
        `explore module missing both sentinels`,
      );
    } else {
      assert.ok(
        text.includes(SENTINELS[state]),
        `${state} module missing sentinel '${SENTINELS[state]}'`,
      );
    }
  }
});

test("emitState(state) returns non-empty content with the right sentinel", () => {
  for (const state of VALID_STATES) {
    const out = emitState(state);
    assert.ok(out, `emitState('${state}') returned falsy`);
    const text = out.toString();
    assert.ok(text.length > 0, `emitState('${state}') returned empty`);
    if (state === "explore") {
      assert.ok(
        text.includes(SENTINELS.explore) || text.includes(EXPLORE_ALT),
        `emitState('explore') missing both sentinels`,
      );
    } else {
      assert.ok(
        text.includes(SENTINELS[state]),
        `emitState('${state}') missing sentinel '${SENTINELS[state]}'`,
      );
    }
  }
});

test("emitState returns null for unsupported / unknown states", () => {
  assert.equal(emitState("close"), null);
  assert.equal(emitState("bogus"), null);
});

// --- CLI success: round-trip fidelity ----------------------------------------

test("CLI --state <valid> exits 0 and stdout byte-equals the module file", () => {
  for (const state of VALID_STATES) {
    const res = spawnSync("node", [emitStatePath, "--state", state], {
      encoding: "buffer",
    });
    assert.equal(
      res.status,
      0,
      `--state ${state} expected exit 0; stderr=${res.stderr}`,
    );
    assert.ok(res.stdout.length > 0, `--state ${state} produced empty stdout`);
    const expected = readFileSync(moduleFileFor(state));
    assert.ok(
      res.stdout.equals(expected),
      `--state ${state} stdout did not byte-match module file`,
    );
  }
});

// --- CLI error paths ----------------------------------------------------------

test("CLI --state bogus exits 1 with 'unknown state' on stderr", () => {
  const res = spawnSync("node", [emitStatePath, "--state", "bogus"], {
    encoding: "utf8",
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /unknown state/);
});

test("CLI with no --state flag exits 2 with usage on stderr", () => {
  const res = spawnSync("node", [emitStatePath], { encoding: "utf8" });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /Usage/);
});

test("CLI --state close is rejected (exit 1)", () => {
  const res = spawnSync("node", [emitStatePath, "--state", "close"], {
    encoding: "utf8",
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /unknown state/);
});

// --- resolveModuleBody failure paths ------------------------------------------
// Direct (no-spawn) tests of the injectable seam. pathToFileURL(dir) does NOT add a
// trailing slash, so we append one — a base URL ending in "/" makes
// `new URL("state-explore.md", base)` resolve INTO the temp dir.

test("resolveModuleBody reports empty/corrupt for a zero-byte module", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "emit-state-"));
  try {
    const base = pathToFileURL(tmpDir + "/");
    writeFileSync(join(tmpDir, "state-explore.md"), "");
    const r = resolveModuleBody("explore", base);
    assert.equal(r.ok, false);
    assert.equal(r.code, 1);
    assert.match(r.message, /empty|corrupt/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("resolveModuleBody reports cannot-read for a missing module", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "emit-state-"));
  try {
    const base = pathToFileURL(tmpDir + "/");
    // Do not write the file — the module is absent.
    const r = resolveModuleBody("explore", base);
    assert.equal(r.ok, false);
    assert.equal(r.code, 1);
    assert.match(r.message, /cannot read/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("resolveModuleBody reports unknown state for an invalid state (default base)", () => {
  const r = resolveModuleBody("bogus");
  assert.equal(r.ok, false);
  assert.match(r.message, /unknown state/);
});
