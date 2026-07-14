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
//   (f) duplicate-region — a repeated load-bearing marker, in EITHER family. For `<!-- SKELETON:x -->`,
//                      silently last-wins meant a garbage first region (the one a HUMAN reads) could
//                      hide behind a clean second one, and the gate still printed PASS. For
//                      `<!-- TEMPLATE:END -->`, a duplicate moves rule (h)'s scan boundary — see (h).
//   (g) coverage     — the gate must compare at least EXPECTED_SLUGS slugs. Without this,
//                      checkParity({}, "") reports issues=0 and PASSES, comparing nothing.
//                      A gate that cannot fail vacuously must enforce its own floor: `make
//                      validate` runs this CLI, not the suite, so an assertion in the tests
//                      would have left the floor to a human reading stdout.
//   (h) header-copy  — no run of 2+ consecutive lines of any template's HEADER (its leading
//                      lines up to its first blank line) may appear BEFORE `<!-- TEMPLATE:END -->`.
//                      That half is what `emit-template` serves to agents; the SKELETON half is
//                      what this gate compares. A restatement over there is a SECOND, UN-GATED
//                      copy — free to drift, and served to every agent when it does. This
//                      COMPARES BYTES against PLAN_TEMPLATES; it does not classify prose. Its
//                      predecessor was a 4-phrase prose set, and it fell to the first synonym
//                      tried: a phrase list guesses at intent, and a guess is evadable. It was
//                      DELETED, not extended — a successful synonym proves the category is wrong.
//                      THE BOUNDARY IS PART OF THE RULE. No TEMPLATE:END marker => no provable
//                      boundary => scan the whole doc. MORE than one => the doc is ambiguous: rule
//                      (f) FAILs it, and the scan stops at the LAST one, never the first. Taking the
//                      first was a hole: a decoy `<!-- TEMPLATE:END -->` inserted early truncated no
//                      slice (emit-template splits on ANY `<!-- TEMPLATE:` marker) and shrank this
//                      scan to nothing, so bootstrap's header bytes plus a fabricated line could sit
//                      in a worked example with the whole board green. A boundary an attacker can
//                      move must only ever WIDEN the scan. Fail closed in both directions.
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
const TEMPLATE_END = "<!-- TEMPLATE:END -->";

// The floor. A gate that PASSES having compared fewer slugs than exist is the defect this
// script exists to prevent, so the expected count is enforced here, not by a human reading
// stdout (`make validate` does not run the suite). Bump it when a template is added.
export const EXPECTED_SLUGS = 12;

// A template's HEADER: its leading lines up to (not including) its first blank line. This is the
// run bootstrap writes and agents never populate — they append BELOW it. It is therefore the only
// part of a plan file that can exist twice, drift, and lie: a truthful populated example reuses a
// skeleton's structure (a table header, a `## Completed` heading) but never its header.
// Contains no blank line by construction, so rule (h) needs no blank-line special case.
export function header(text) {
  const lines = (text || "").split("\n");
  const blank = lines.findIndex((l) => l.trim() === "");
  return lines.slice(0, blank === -1 ? lines.length : blank);
}

// The rule's unit of comparison: the adjacent line-pair starting at i. Threshold 2, not 1 — a
// 1-line run would fire on every `# Progress` heading in the doc.
const pair = (lines, i) => `${lines[i]}\n${lines[i + 1]}`;

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

  // (h) header-copy — bootstrap's header bytes, compared. Every adjacent line-pair of every
  // header is a key; any such pair reappearing before `<!-- TEMPLATE:END -->` is an un-gated
  // second copy. Threshold 2, not 1: a 1-line run would fire on every `# Progress` heading in the
  // doc. That cost is NAMED, not hidden — `plan` and `progress` have 1-line headers and sit below
  // it (CLAUDE.md says so). No allowlist, no exception, no skip: if this fires on something the doc
  // cannot give up, the RULE's scope is wrong — re-scope it, never exempt the line.
  const pairs = new Map(); // "<lineA>\n<lineB>" -> slug, over every header of length >= 2
  for (const slug of slugs.filter((s) => typeof templates[s] === "string")) {
    const h = header(templates[slug]);
    for (let i = 0; i + 1 < h.length; i++) if (!pairs.has(pair(h, i))) pairs.set(pair(h, i), slug);
  }
  // The boundary. Take the LAST TEMPLATE:END, never the first: a decoy inserted early must only be
  // able to WIDEN this scan, never shrink it. Taking the first let one inserted line hide the rest
  // of the doc from this rule while truncating no emit-template slice. Duplicates FAIL via (f).
  const lines = (docText || "").split("\n");
  const ends = lines.reduce((a, l, i) => (l.trim() === TEMPLATE_END ? [...a, i] : a), []);
  for (const dup of ends.slice(1)) {
    push(DOC_REL, dup + 1, "duplicate-region",
      `${TEMPLATE_END} appears twice (lines ${ends[0] + 1} and ${dup + 1}) — it is the boundary of ` +
      `the half emit-template serves to agents, and rule [header-copy] scans up to it; only one may exist`);
  }
  const stop = ends.length === 0 ? lines.length : ends[ends.length - 1];
  for (let i = 0; i + 1 < stop; i++) {
    const slug = pairs.get(pair(lines, i));
    // A 3+-line header overlaps its own windows: report each run once, at its first line.
    if (!slug || (i > 0 && pairs.get(pair(lines, i - 1)) === slug)) continue;
    push(DOC_REL, i + 1, "header-copy",
      `lines ${i + 1}-${i + 2} restate PLAN_TEMPLATES.${slug}'s header bytes before <!-- TEMPLATE:END --> — ` +
      `an un-gated second copy, and emit-template serves THAT half to agents. State bootstrap's bytes ` +
      `only in the <!-- SKELETON:${slug} --> region; point here instead.`);
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
