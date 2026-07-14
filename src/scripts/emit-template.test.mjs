// Requires Node.js 18+
// Tests for emit-template.mjs — per-template slicer over the canonical
// src/references/file-formats.md.
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

import { resolveTemplate, servedRegionEnd, VALID_TEMPLATES, TEMPLATE_MARKER } from "./emit-template.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const emitTemplatePath = join(here, "emit-template.mjs");
const fileFormatsPath = join(here, "..", "references", "file-formats.md");

// Canonical 17 slugs, in file order.
const CANONICAL = [
  "state",
  "plan",
  "decisions",
  "findings",
  "progress",
  "verification",
  "checkpoints",
  "findings-consolidated",
  "decisions-consolidated",
  "lessons",
  "system",
  "index",
  "lessons-snapshot",
  "changelog",
  "summary",
  "presentation-contracts",
  "lessons-synthesis",
];

// Template-specific sentinel substring proving the right slice was emitted.
// Each verified present in its marker-delimited section before relying on it.
const SENTINELS = {
  state: "Pre-Step Checklist",
  plan: "Problem Statement",
  decisions: "Entry Schema by Type",
  findings: "Key Constraints",
  progress: "In Progress",
  verification: "Criteria Verification",
  checkpoints: "When to Checkpoint",
  // These three sentinels are the SECTION HEADINGS, not the files' H1s: an H1 like
  // "# Consolidated Findings" is part of bootstrap's HEADER, and rule (h) [header-copy] forbids
  // those bytes before <!-- TEMPLATE:END -->. A sentinel must key on content the worked example
  // legitimately owns — keying it on bootstrap's bytes is the coupling the gate exists to break.
  "findings-consolidated": "plans/FINDINGS.md (consolidated)",
  "decisions-consolidated": "plans/DECISIONS.md (consolidated)",
  lessons: "Patterns That Work",
  system: "System Atlas",
  index: "plans/INDEX.md",
  "lessons-snapshot": "Automatic snapshot of",
  changelog: "Intra-plan compression",
  summary: "Decision Anchors Registry",
  "presentation-contracts": "PC-EXPLORE",
  "lessons-synthesis": "Failed Approaches",
};

// Compute the expected byte slice for a slug using the SAME definition as
// resolveTemplate: bytes from the line AFTER the slug's marker line up to the
// start of the next `<!-- TEMPLATE:` marker. Operates on the raw Buffer.
function expectedSlice(buf, slug) {
  const marker = Buffer.from(`<!-- TEMPLATE:${slug} -->`);
  const mIdx = buf.indexOf(marker);
  assert.notEqual(mIdx, -1, `marker for '${slug}' not found in file-formats.md`);
  let start = buf.indexOf(0x0a, mIdx);
  start = start === -1 ? buf.length : start + 1;
  const nextIdx = buf.indexOf(Buffer.from("<!-- TEMPLATE:"), start);
  const end = nextIdx === -1 ? buf.length : nextIdx;
  return buf.subarray(start, end);
}

// --- Module API ---------------------------------------------------------------

test("VALID_TEMPLATES is the canonical 17-slug list", () => {
  assert.deepEqual(VALID_TEMPLATES, CANONICAL);
});

test("every slug's marker exists in file-formats.md", () => {
  const text = readFileSync(fileFormatsPath, "utf8");
  for (const slug of VALID_TEMPLATES) {
    assert.ok(
      text.includes(`<!-- TEMPLATE:${slug} -->`),
      `file-formats.md missing marker for '${slug}'`,
    );
  }
  assert.ok(
    text.includes("<!-- TEMPLATE:END -->"),
    "file-formats.md missing END terminator",
  );
});

test("each slug emits non-empty content with its sentinel", () => {
  for (const slug of VALID_TEMPLATES) {
    const r = resolveTemplate(slug);
    assert.equal(r.ok, true, `resolveTemplate('${slug}') not ok`);
    const text = r.body.toString();
    assert.ok(text.length > 0, `resolveTemplate('${slug}') empty`);
    assert.ok(
      text.includes(SENTINELS[slug]),
      `'${slug}' slice missing sentinel '${SENTINELS[slug]}'`,
    );
  }
});

// --- CLI success: round-trip fidelity ----------------------------------------

test("CLI --name <slug> exits 0 and stdout byte-equals the marker-delimited slice", () => {
  const buf = readFileSync(fileFormatsPath);
  for (const slug of VALID_TEMPLATES) {
    const res = spawnSync("node", [emitTemplatePath, "--name", slug], {
      encoding: "buffer",
    });
    assert.equal(
      res.status,
      0,
      `--name ${slug} expected exit 0; stderr=${res.stderr}`,
    );
    const expected = expectedSlice(buf, slug);
    assert.ok(
      res.stdout.equals(expected),
      `--name ${slug} stdout did not byte-match the marker-delimited slice`,
    );
  }
});

// --- CLI error paths ----------------------------------------------------------

test("CLI no --name exits 2 with Usage on stderr", () => {
  const res = spawnSync("node", [emitTemplatePath], { encoding: "utf8" });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /Usage/);
});

test("CLI --name bogus exits 1 with unknown template on stderr", () => {
  const res = spawnSync("node", [emitTemplatePath, "--name", "bogus"], {
    encoding: "utf8",
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /unknown template/);
});

// --- resolveTemplate failure paths (no spawn, injected temp file-formats.md) --
// resolveTemplate's 2nd arg is a fileFormatsUrl pointing at the FILE itself, so
// pass pathToFileURL(join(tmpDir, "file-formats.md")).

test("resolveTemplate reports cannot-read for a missing file-formats.md", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "emit-template-"));
  try {
    const missingUrl = pathToFileURL(join(tmpDir, "file-formats.md"));
    const r = resolveTemplate("state", missingUrl);
    assert.equal(r.ok, false);
    assert.equal(r.code, 1);
    assert.match(r.message, /cannot read/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("resolveTemplate reports empty for a slug whose slice is empty", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "emit-template-"));
  try {
    const url = pathToFileURL(join(tmpDir, "file-formats.md"));
    // state's marker is immediately followed by the END marker → empty slice.
    writeFileSync(
      join(tmpDir, "file-formats.md"),
      "<!-- TEMPLATE:state -->\n<!-- TEMPLATE:END -->\n",
    );
    const r = resolveTemplate("state", url);
    assert.equal(r.ok, false);
    assert.equal(r.code, 1);
    assert.match(r.message, /empty/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("resolveTemplate reports not-found when the slug marker is absent", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "emit-template-"));
  try {
    const url = pathToFileURL(join(tmpDir, "file-formats.md"));
    // No state marker anywhere in the file.
    writeFileSync(
      join(tmpDir, "file-formats.md"),
      "# file-formats\n<!-- TEMPLATE:plan -->\nbody\n<!-- TEMPLATE:END -->\n",
    );
    const r = resolveTemplate("state", url);
    assert.equal(r.ok, false);
    assert.equal(r.code, 1);
    assert.match(r.message, /not found/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("resolveTemplate returns ok:false for unknown slug (default base)", () => {
  const r = resolveTemplate("bogus");
  assert.equal(r.ok, false);
  assert.match(r.message, /unknown template/);
});

// --- servedRegionEnd: the shared served-region boundary (D-008) ----------------
// servedRegionEnd OWNS "where does the half emit-template serves to agents end". The checker
// IMPORTS it (see check-template-parity.mjs) instead of re-deriving the boundary with an exact-line
// END match — so the two consumers cannot disagree. These tests pin the properties CLAUDE.md's
// "may only widen" clause depends on.

test("servedRegionEnd(realDoc) is the <!-- TEMPLATE:END --> line, not the prose substrings after it", () => {
  const text = readFileSync(fileFormatsPath, "utf8");
  const lines = text.split("\n");
  const end = servedRegionEnd(text); // 0-based line index
  // It lands on the standalone END terminator — the terminator of the LAST valid slug.
  assert.equal(lines[end].trim(), "<!-- TEMPLATE:END -->");
  // And NOT on the last `<!-- TEMPLATE:` SUBSTRING in the doc: the skeleton-half prose below END
  // contains that substring (the 1029/1031 landmine). A naive last-substring definition would land
  // there and widen the scan into the skeletons. Prove those substrings sit AFTER the boundary.
  let lastSubstringLine = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].includes(TEMPLATE_MARKER)) lastSubstringLine = i;
  assert.ok(lastSubstringLine > end, "prose `<!-- TEMPLATE:` substrings must sit AFTER the boundary");
});

test("servedRegionEnd: renaming END + an early decoy END does NOT move the boundary earlier", () => {
  const baseline = [
    "<!-- TEMPLATE:state -->",
    "state body",
    "<!-- TEMPLATE:index -->",
    "index body",
    "<!-- TEMPLATE:END -->",
    "skeleton half",
  ].join("\n");
  assert.equal(servedRegionEnd(baseline), 4); // END, terminator of the last slug `index`

  // Reviewer 4's exact move: rename the real terminator, insert a fresh decoy END BEFORE the last slug.
  const exploit = [
    "<!-- TEMPLATE:state -->",
    "state body",
    "<!-- TEMPLATE:END -->",         // decoy inserted early (line 2)
    "<!-- TEMPLATE:index -->",       // last valid slug (line 3)
    "poison line below the decoy",   // (line 4)
    "<!-- TEMPLATE:END-OF-LIST -->", // real terminator renamed (line 5)
    "skeleton half",
  ].join("\n");
  const moved = servedRegionEnd(exploit);
  // Anchored to the last slug's terminator (line 5), NOT the early decoy (line 2). The poison at
  // line 4 stays INSIDE the served region — the exploit cannot hide it by shrinking the boundary.
  assert.equal(moved, 5);
  assert.ok(moved > 4);
});

test("servedRegionEnd: a later valid-slug marker only widens the boundary", () => {
  const before = [
    "<!-- TEMPLATE:state -->",
    "state body",
    "<!-- TEMPLATE:END -->",
    "skeleton",
  ].join("\n");
  assert.equal(servedRegionEnd(before), 2); // END, terminator of `state`

  const widened = [
    "<!-- TEMPLATE:state -->",
    "state body",
    "<!-- TEMPLATE:END -->",
    "skeleton",
    "<!-- TEMPLATE:index -->", // a real slug added later (line 4)
    "index body",
    "<!-- TEMPLATE:END -->",   // its terminator (line 6)
  ].join("\n");
  const after = servedRegionEnd(widened);
  assert.equal(after, 6);
  assert.ok(after > 2, "a later slug moves the last-slug terminator later — widen only");
});

test("servedRegionEnd: no slug marker at all → end of doc (fail-closed, scan everything)", () => {
  assert.equal(servedRegionEnd(""), 1); // "".split("\n") === [""]
  const noMarkers = "line one\nline two\nline three";
  assert.equal(servedRegionEnd(noMarkers), noMarkers.split("\n").length);
});
