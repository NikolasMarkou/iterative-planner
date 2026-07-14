#!/usr/bin/env node
// Requires Node.js 18+
//
// check-template-parity — executable gate enforcing bootstrap.mjs PLAN_TEMPLATES
// <-> src/references/file-formats.md `<!-- SKELETON:* -->` byte-parity.
//
// The defect this prevents: the bytes `bootstrap.mjs new` writes into a fresh plan dir live
// in TWO places — bootstrap's inline literals (it never reads file-formats.md; that
// zero-file-dependency property is load-bearing) and the doc publishing those skeletons.
// Nothing compared them, so drift was silent both ways and had gone live twice (a SYSTEM.md
// schema bootstrap never shipped; a changelog header the doc lied about).
//
// Rules, both directions:
//   (a) parity       — every PLAN_TEMPLATES[slug] byte-equals its SKELETON region body.
//   (b) completeness — set equality, template keys <-> doc regions; an orphan EITHER way FAILs.
//   (c) encodability — no template may contain a ``` fence (it would close its region's block
//                      early) or the literal `<!-- TEMPLATE:` (it would truncate
//                      emit-template.mjs's last slice). This keeps rule (a) expressible.
//   (d) typing       — a non-string template is REPORTED, not thrown on.
//   (e) line-endings — one CRLF hint instead of 12 byte-parity failures with no stated cause.
//   (f) duplicate-region — a repeated `<!-- SKELETON:x -->` marker. Silently last-wins meant a
//                      garbage first region (the one a HUMAN reads) could hide behind a clean
//                      second one, and the gate still printed PASS.
//   (g) coverage     — the gate must compare at least EXPECTED_SLUGS slugs. Without this,
//                      checkParity({}, "") reports issues=0 and PASSES, comparing nothing.
//                      A gate that cannot fail vacuously must enforce its own floor: `make
//                      validate` runs this CLI, not the suite, so an assertion in the tests
//                      would have left the floor to a human reading stdout.
//
// Region<->bytes contract: a body is the lines strictly between the opening ```markdown fence
// and its closing fence, joined with "\n", plus a trailing "\n". A marker NOT followed by a
// fenced block is not a region — rule (b) then reports that slug as unregioned, so a broken
// fence fails loudly instead of skipping silently.
//
// Pure functions, zero I/O, exported for the tests; CLI only under isEntryPoint. PLAN_TEMPLATES
// is imported in-process: bootstrap has the same guard, so this import does NOT run bootstrap's
// CLI and `make validate` creates no plan dirs. Node builtins only; no flags.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLAN_TEMPLATES } from "./bootstrap.mjs";

export const DOC_REL = "src/references/file-formats.md";
export const SRC_REL = "src/scripts/bootstrap.mjs";

const MARKER_RE = /^<!-- SKELETON:([A-Za-z-]+) -->$/;
const FENCE = "```";
const BANNED = [FENCE, "<!-- TEMPLATE:"];

// The floor. A gate that PASSES having compared fewer slugs than exist is the defect this
// script exists to prevent, so the expected count is enforced here, not by a human reading
// stdout (`make validate` does not run the suite). Bump it when a template is added.
export const EXPECTED_SLUGS = 12;

// Scan a doc for `<!-- SKELETON:<slug> -->` regions.
// Returns { regions: Map<slug, {body, bodyLine, markerLine}>, endLine, duplicates } — 1-based lines.
// A repeated marker is FIRST-wins (a human reading the doc reads the first) and is reported as a
// duplicate. Last-wins would let a garbage first region hide behind a clean second one.
export function parseSkeletons(docText) {
  const regions = new Map();
  const duplicates = [];
  const lines = (docText || "").split("\n");
  let endLine = 1;
  for (let i = 0; i < lines.length; i++) {
    const m = MARKER_RE.exec(lines[i].trim());
    if (!m) continue;
    if (m[1] === "END") {
      endLine = i + 1;
      continue;
    }
    if (!lines[i + 1] || !lines[i + 1].startsWith(FENCE)) continue;
    const close = lines.findIndex((l, j) => j > i + 1 && l.trim() === FENCE);
    if (close === -1) continue;
    if (regions.has(m[1])) {
      duplicates.push({ slug: m[1], firstLine: regions.get(m[1]).markerLine, dupLine: i + 1 });
      continue;
    }
    regions.set(m[1], {
      body: lines.slice(i + 2, close).join("\n") + "\n",
      bodyLine: i + 3,
      markerLine: i + 1,
    });
  }
  return { regions, endLine, duplicates };
}

// Index of the first differing line, or -1 if byte-equal. Trailing-newline drift shows up
// here too: "a\n" splits to ["a",""], "a" to ["a"].
export function firstDiffLine(a, b) {
  const la = a.split("\n");
  const lb = b.split("\n");
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) return i;
  }
  return -1;
}

// 1-based line of a slug's key inside bootstrap's PLAN_TEMPLATES literal (1 if not found).
export function locateTemplateKey(srcText, slug) {
  const re = new RegExp(`^\\s*(?:"${slug}"|${slug})\\s*:`);
  const i = (srcText || "").split("\n").findIndex((l) => re.test(l));
  return i === -1 ? 1 : i + 1;
}

// Pure check. `compared` is the number of slugs ACTUALLY byte-compared — a gate that
// passes having compared nothing is the exact failure this script exists to prevent,
// so the count is reported, never implied.
export function checkParity(templates, docText, srcText = "", expectedSlugs = EXPECTED_SLUGS) {
  const issues = [];
  const push = (file, line, rule, message) => issues.push({ file, line, rule, message });
  const { regions, endLine, duplicates } = parseSkeletons(docText);
  const slugs = Object.keys(templates);
  let compared = 0;

  // (e) line-endings — one hint, not a 12-issue wall. Parity compares bytes, so a CRLF doc
  // fails every slug at once with nothing pointing at the actual cause.
  if ((docText || "").includes("\r")) {
    push(DOC_REL, 1, "line-endings",
      `${DOC_REL} has CRLF line endings; parity compares bytes. Normalize to LF (\`core.autocrlf=input\`).`);
  }

  // (f) duplicate-region — a repeated marker means the doc a human reads and the region a
  // last-wins parser compared are different bytes. Silently last-wins was a vacuous PASS.
  for (const d of duplicates) {
    push(DOC_REL, d.dupLine, "duplicate-region",
      `<!-- SKELETON:${d.slug} --> appears twice (lines ${d.firstLine} and ${d.dupLine}) — ` +
      `a reader sees the first region; only one may exist`);
  }

  // (d) typing + (c) encodability
  for (const slug of slugs) {
    if (typeof templates[slug] !== "string") {
      push(SRC_REL, locateTemplateKey(srcText, slug), "typing",
        `PLAN_TEMPLATES.${slug} is ${typeof templates[slug]}, not a string — cannot byte-compare`);
      continue;
    }
    for (const bad of BANNED) {
      if (!templates[slug].includes(bad)) continue;
      const what = bad === FENCE ? "a triple-backtick fence" : `the literal \`${bad}\``;
      push(SRC_REL, locateTemplateKey(srcText, slug), "encodability",
        `PLAN_TEMPLATES.${slug} contains ${what} — it would corrupt its SKELETON region`);
    }
  }

  // (b) completeness — both directions
  for (const slug of slugs) {
    if (!regions.has(slug)) {
      push(DOC_REL, endLine, "completeness",
        `PLAN_TEMPLATES.${slug} has no <!-- SKELETON:${slug} --> region`);
    }
  }
  for (const [slug, r] of regions) {
    if (!Object.prototype.hasOwnProperty.call(templates, slug)) {
      push(DOC_REL, r.markerLine, "completeness",
        `<!-- SKELETON:${slug} --> region has no PLAN_TEMPLATES.${slug}`);
    }
  }

  // (a) parity
  for (const slug of slugs) {
    const r = regions.get(slug);
    if (!r || typeof templates[slug] !== "string") continue;
    compared++;
    const d = firstDiffLine(templates[slug], r.body);
    if (d === -1) continue;
    const docLines = r.body.split("\n");
    const tplLines = templates[slug].split("\n");
    push(DOC_REL, r.bodyLine + Math.min(d, docLines.length - 1), "parity",
      `PLAN_TEMPLATES.${slug} != its SKELETON region at body line ${d + 1} — doc has ` +
      `${JSON.stringify(docLines[d] ?? null)}, bootstrap has ${JSON.stringify(tplLines[d] ?? null)}`);
  }

  // (g) coverage — the floor. checkParity({}, "") used to report issues=0 and PASS.
  if (compared < expectedSlugs) {
    push(DOC_REL, endLine, "coverage",
      `only ${compared} of ${expectedSlugs} expected slugs were byte-compared — ` +
      `a gate that compares nothing passes vacuously`);
  }

  return { issues, compared };
}

export function report(issues) {
  return issues.map((i) => `  ${i.file}:${i.line} [${i.rule}] ${i.message}`).join("\n");
}

const isEntryPoint = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const docText = readFileSync(join(repoRoot, DOC_REL), "utf8");
  const srcText = readFileSync(join(repoRoot, SRC_REL), "utf8");
  const { issues, compared } = checkParity(PLAN_TEMPLATES, docText, srcText);
  if (issues.length === 0) {
    console.log(
      `check-template-parity: PASS (${compared} slugs compared byte-for-byte — ` +
      `PLAN_TEMPLATES == ${DOC_REL} SKELETON regions)`,
    );
    process.exit(0);
  }
  console.error(`check-template-parity: FAIL — ${issues.length} issue(s):`);
  console.error(report(issues));
  process.exit(1);
}
