// Requires Node.js 18+
// Tests for check-doc-parity.mjs — File Ownership table parity gate.
//
// Importing comparison from the .mjs is side-effect-free: the CLI body runs
// only under the isEntryPoint guard.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { comparison } from "./check-doc-parity.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const script = join(here, "check-doc-parity.mjs");

test("real repo: README mirrors SKILL.md File Ownership -> exit 0", () => {
  const res = spawnSync("node", [script], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(
    res.status,
    0,
    `expected exit 0; stdout=${res.stdout} stderr=${res.stderr}`,
  );
});

test("negative: SKILL key absent from README is reported missing", () => {
  const skill = [
    "### File Ownership Model",
    "| File | Owner | Readers |",
    "|------|-------|---------|",
    "| `a.md` | X | Y |",
    "| `b.md` | X | Y |",
    "| `c.md` | X | Y |",
    "",
    "## Next Section",
  ].join("\n");
  const readme = [
    "### File ownership",
    "| File | Owner | Readers |",
    "|------|-------|---------|",
    "| `a.md` | X | Y |",
    "| `b.md` | X | Y |",
    "",
    "## Next Section",
  ].join("\n");
  const { missing } = comparison(skill, readme);
  assert.equal(missing.length, 1);
  assert.ok(missing.includes("c.md"), `expected c.md in ${JSON.stringify(missing)}`);
});

test("merged cell + (index) suffix: no false positive", () => {
  const skill = [
    "### File Ownership Model",
    "| File | Owner | Readers |",
    "|------|-------|---------|",
    "| `findings.md` (index) | Orchestrator | All |",
    "| `plans/LESSONS.md` | Archivist | All |",
    "| `plans/SYSTEM.md` | Archivist | All |",
    "",
    "## Next Section",
  ].join("\n");
  const readme = [
    "### File ownership",
    "| File | Owner | Readers |",
    "|------|-------|---------|",
    "| `findings.md` (index) | Orchestrator | All |",
    "| `plans/LESSONS.md`, `plans/SYSTEM.md` | Archivist | All |",
    "",
    "## Next Section",
  ].join("\n");
  const { missing } = comparison(skill, readme);
  assert.deepEqual(missing, []);
});
