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
//   (h) header-copy  — no run of 2+ consecutive lines of any template's HEADER (its leading lines
//                      up to its first blank line) may appear in any SERVED ARTIFACT. The substrate
//                      is resolveTemplate(slug).body for all 17 VALID_TEMPLATES — the EXACT bytes
//                      `emit-template --name <slug>` serves agents — NOT a doc region or boundary.
//                      A restatement in a served body is a SECOND, UN-GATED copy of bootstrap's
//                      bytes, free to drift and served to every agent. COMPARES BYTES against
//                      PLAN_TEMPLATES; it does not classify prose. Five predecessors each checked a
//                      PROXY for the served region (skeleton half, phrase set, first/last boundary,
//                      anchored-line grammar), and each diverged from the UNANCHORED slicer on the
//                      first reviewer attempt; D-009 eliminated the proxy — the check now CALLS the
//                      slicer, so the thing checked IS the thing served.
//   (i) served-resolve — every one of the 17 VALID_TEMPLATES slugs must resolve. A slug whose
//                      marker was removed/renamed/redirected so resolveTemplate returns !ok is a
//                      LOUD FAIL naming it — never a silently dropped slug (that silent drop was the
//                      enabling half of the fifth consecutive break).
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
// DECISION plan-2026-07-14T141152-113d5b92/D-009: import the SLICER itself (resolveTemplate) and
// check its OUTPUT for all 17 slugs — the union of what emit-template serves agents — instead of
// approximating where that output ends with a doc boundary. Five guards fell because each derived a
// PROXY for the served region (a skeleton half, a phrase set, a boundary, an anchored-line grammar)
// and every proxy diverged from resolveTemplate's UNANCHORED substring slicer. There is no boundary
// left to import; the thing checked IS the thing served. TEMPLATE_MARKER stays (shared literal,
// used by BANNED below). See decisions.md D-009.
import { resolveTemplate, VALID_TEMPLATES, TEMPLATE_MARKER } from "./emit-template.mjs";

export const DOC_REL = "src/references/file-formats.md";
export const SRC_REL = "src/scripts/bootstrap.mjs";

const MARKER_RE = /^<!-- SKELETON:([A-Za-z-]+) -->$/;
const FENCE = "```";
const BANNED = [FENCE, TEMPLATE_MARKER];

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
export function checkParity(templates, docText, srcText = "", expectedSlugs = EXPECTED_SLUGS, servedScope = VALID_TEMPLATES, docBuf = Buffer.from(docText || "")) {
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

  // (h) header-copy + (i) served-resolve — check the SERVED ARTIFACTS THEMSELVES. Every adjacent
  // line-pair of every PLAN_TEMPLATES header is a key; any such pair reappearing inside a served
  // body is an un-gated second copy of bootstrap's bytes, served to agents. Threshold 2, not 1: a
  // 1-line run would fire on every `# Progress` heading. That cost is NAMED — `plan` and `progress`
  // have 1-line headers (CLAUDE.md says so). No allowlist, no exception, no skip.
  const pairs = new Map(); // "<lineA>\n<lineB>" -> slug, over every header of length >= 2
  for (const slug of slugs.filter((s) => typeof templates[s] === "string")) {
    const h = header(templates[slug]);
    for (let i = 0; i + 1 < h.length; i++) if (!pairs.has(pair(h, i))) pairs.set(pair(h, i), slug);
  }
  // DECISION plan-2026-07-14T141152-113d5b92/D-009: the SUBSTRATE is resolveTemplate's OUTPUT, not a
  // doc region/boundary. For each slug in servedScope (default VALID_TEMPLATES — fail-closed: all 17,
  // never a silent subset), resolveTemplate(slug, docBuf) returns the EXACT bytes emit-template
  // serves that slug's agents; we scan THAT body. Do NOT reintroduce a boundary / served-region /
  // docText line-window scan here — five reviewers broke every proxy for the served region because
  // each diverged from this UNANCHORED slicer. A slug that fails to resolve is a LOUD FAIL naming it
  // (a removed/renamed/redirected marker can NEVER silently drop a slug), never a bare `continue`.
  // `docBuf` defaults to Buffer.from(docText) but the CLI passes the RAW file bytes it read once, so
  // the served substrate is byte-identical to emit-template's own raw read even for invalid UTF-8.
  let servedChecked = 0;
  for (const served of servedScope) {
    const r = resolveTemplate(served, docBuf);
    if (!r.ok) {
      push(DOC_REL, endLine, "served-resolve",
        `emit-template cannot serve '${served}' (${r.message}) — a slug whose marker was removed, ` +
        `renamed, or redirected must fail LOUDLY, never drop silently from the served-artifact check`);
      continue;
    }
    servedChecked++;
    const body = r.body.toString().split("\n");
    for (let i = 0; i + 1 < body.length; i++) {
      const slug = pairs.get(pair(body, i));
      // A 3+-line header overlaps its own windows: report each run once, at its first line.
      if (!slug || (i > 0 && pairs.get(pair(body, i - 1)) === slug)) continue;
      push(DOC_REL, endLine, "header-copy",
        `emit-template --name ${served} serves a body that restates PLAN_TEMPLATES.${slug}'s header ` +
        `bytes — an un-gated second copy served to agents. State bootstrap's bytes only in the ` +
        `<!-- SKELETON:${slug} --> region; point there from the ${served} worked example instead.`);
    }
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

  return { issues, compared, served: servedChecked };
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
  // Read the doc ONCE as raw bytes — byte-identical to emit-template's CLI read — then derive the
  // string for parity comparisons and pass the raw Buffer to the served-artifact loop (NOTE 2).
  const docRaw = readFileSync(join(repoRoot, DOC_REL));
  const docText = docRaw.toString("utf8");
  const srcText = readFileSync(join(repoRoot, SRC_REL), "utf8");
  const { issues, compared, served } = checkParity(PLAN_TEMPLATES, docText, srcText, EXPECTED_SLUGS, VALID_TEMPLATES, docRaw);
  if (issues.length === 0) {
    console.log(
      `check-template-parity: PASS (${compared} slugs compared byte-for-byte — ` +
      `PLAN_TEMPLATES == ${DOC_REL} SKELETON regions; ${served} served artifacts checked for ` +
      `header-copy via resolveTemplate)`,
    );
    process.exit(0);
  }
  console.error(`check-template-parity: FAIL — ${issues.length} issue(s):`);
  console.error(report(issues));
  process.exit(1);
}
