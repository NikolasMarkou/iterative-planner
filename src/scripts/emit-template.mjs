#!/usr/bin/env node
// Router: emit exactly ONE plan-file template, sliced on demand from the canonical
// src/references/file-formats.md.
//
// Usage:
//   node emit-template.mjs --name <state|plan|decisions|findings|progress|verification|
//     checkpoints|findings-consolidated|decisions-consolidated|lessons|system|index|
//     lessons-snapshot|changelog|summary|presentation-contracts>
//
// Prints the named template slice to stdout byte-faithfully and exits 0.
//
// Design — slicer over the canonical file (single source of truth preserved):
// the 16 templates still live whole inside file-formats.md; this router does NOT
// extract them into modules. Boundaries are explicit `<!-- TEMPLATE:<slug> -->`
// HTML-comment markers (one before each section header, plus a terminating
// `<!-- TEMPLATE:END -->`). The slice runs from the line AFTER a slug's marker up
// to the NEXT marker. Slicing is byte-faithful: it operates on the raw Buffer via
// Buffer.indexOf, because file-formats.md contains multibyte characters (e.g. →)
// and string char indices are NOT byte offsets. If the router fails for any reason
// the agent falls back to reading file-formats.md whole (additive, non-breaking).
//
// Exit-code contract (mirrors emit-state.mjs):
//   missing/absent --name flag (incl. --name as last token) → USAGE on stderr, exit 2
//     (POSIX usage-error convention).
//   unknown slug / unreadable file-formats.md / missing marker / empty slice →
//     a clear diagnostic on stderr, exit 1.
//   valid slug → byte-faithful slice on stdout, exit 0.
//
// file-formats.md is resolved relative to this script via import.meta.url so the
// router works regardless of CWD and inside the installed skill bundle.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const VALID_TEMPLATES = ["state","plan","decisions","findings","progress","verification","checkpoints","findings-consolidated","decisions-consolidated","lessons","system","index","lessons-snapshot","changelog","summary","presentation-contracts","lessons-synthesis"];

const USAGE = "Usage: node emit-template.mjs --name <" + VALID_TEMPLATES.join("|") + ">";

// Pure, injectable seam: resolve and validate a template slice, returning a tagged
// result instead of throwing or process.exit-ing. fileFormatsUrl is dependency
// injection for testability — NOT a config/env toggle; the default arg reproduces
// the production path byte-identically. Slicing is done on the raw Buffer so the
// emitted slice is byte-identical to the source region (multibyte-safe).
export function resolveTemplate(slug, fileFormatsUrl = new URL("../references/file-formats.md", import.meta.url)) {
  if (!VALID_TEMPLATES.includes(slug)) {
    return { ok: false, code: 1, message: `unknown template '${slug}'; valid: ${VALID_TEMPLATES.join("|")}` };
  }
  let buf;
  try {
    buf = readFileSync(fileFormatsUrl);
  } catch (err) {
    return { ok: false, code: 1, message: `cannot read file-formats.md: ${err.code || err.message}` };
  }
  const marker = Buffer.from(`<!-- TEMPLATE:${slug} -->`);
  const mIdx = buf.indexOf(marker);
  if (mIdx === -1) {
    return { ok: false, code: 1, message: `template marker for '${slug}' not found` };
  }
  // Content begins on the line AFTER the marker line (the section header line).
  let start = buf.indexOf(0x0a, mIdx);
  start = start === -1 ? buf.length : start + 1;
  // Slice ends at the start of the NEXT marker (END terminator guarantees one exists).
  const nextIdx = buf.indexOf(Buffer.from("<!-- TEMPLATE:"), start);
  const end = nextIdx === -1 ? buf.length : nextIdx;
  const body = buf.subarray(start, end);
  if (body.length === 0 || body.toString().trim() === "") {
    return { ok: false, code: 1, message: `template '${slug}' is empty` };
  }
  return { ok: true, body };
}

function runCli(argv) {
  const idx = argv.indexOf("--name");
  if (idx === -1 || idx === argv.length - 1) {
    process.stderr.write(USAGE + "\n");
    process.exit(2);
  }
  const result = resolveTemplate(argv[idx + 1]);
  if (!result.ok) {
    process.stderr.write(result.message + "\n");
    process.exit(result.code);
  }
  process.stdout.write(result.body);
  process.exit(0);
}

// Standard Node.js ESM dual-mode guard (mirrors emit-state.mjs): importable in tests
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
