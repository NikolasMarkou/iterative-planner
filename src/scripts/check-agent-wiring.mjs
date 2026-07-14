#!/usr/bin/env node
// Requires Node.js 18+
//
// check-agent-wiring — executable gate for the PROSE layer: shipped agent
// prompts, per-state rule modules, SKILL.md, the reference knowledge base.
// Nothing else checks this layer, so drift there rots silently (the GHOST
// constraint: absence of validator errors == absence of a checker).
//
// Rules:
//   (a) script-path        — `node <path>/scripts/<x>.mjs` must use the
//        `<skill-path>` placeholder; a bare path resolves to nothing from a
//        consuming project's root.
//   (b) reference-citation — every `references/<f>.md` citation must resolve.
//   (c) section-pointer    — pointers must read `§ <Code> <Title>` (or
//        `§ <Title>`), with code AND title agreeing with a real heading in the
//        target file. Existence alone is toothless: a pointer to `C.11` when
//        the target is `C.12` names a real heading and means the wrong thing.
//   (d) skill-path-resolution — an agent invoking `<skill-path>/scripts/...`
//        must carry a line saying how `<skill-path>` resolves.
//
// Scope: src/agents/*.md, src/scripts/modules/*.md, src/SKILL.md,
// src/references/*.md. NOT README.md / CLAUDE.md — there `node src/scripts/...`
// is correct (repo-developer docs, not shipped prompts).
//
// (b) and (c) skip fenced code blocks (a citation in a fence is an example).
// (a) does NOT: an invocation is an instruction wherever it is printed. Pure
// functions are exported for tests; the CLI runs only under isEntryPoint.
// Zero dependencies: node: builtins only.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_ARG_RE = /\bnode\s+([^\s`'"]*scripts\/[A-Za-z0-9_.-]+\.mjs)/g;
const CITATION_RE = /`([A-Za-z0-9_<][A-Za-z0-9_.<>/-]*\.md)`/g;
// Trailing lookahead is `(?!\w)` (not `(?![\w.])`) so a sentence-final code —
// "see Section B.10." — is still a code, not silently skipped.
const SECTION_CODE_RE = /(?<![\w.])([A-Z]\.\d+(?:\.\d+)*)(?!\w)/g;
const OK_PREFIX = "<skill-path>/scripts/";

const issue = (rule, file, line, message) => ({ rule, file, line, message });

/** Split into lines tagged with fenced-code membership (1-based numbers). */
export function tagLines(text) {
  let fenced = false;
  return (text || "").split("\n").map((t, i) => {
    const isFence = /^\s*(```|~~~)/.test(t);
    if (isFence) fenced = !fenced;
    return { no: i + 1, text: t, fenced: isFence || fenced };
  });
}

/** Normalize a heading title / pointer text for comparison. */
export function norm(s) {
  return (s || "").replace(/[`*"'“”]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** A heading's comparable core: cut at the first " — " or " (" qualifier. */
export function headingCore(title) {
  let t = title || "";
  for (const sep of [" — ", " ("]) {
    const i = t.indexOf(sep);
    if (i > 0) t = t.slice(0, i);
  }
  return norm(t);
}

/** Headings of a markdown doc (fences skipped): { code, title }. */
export function parseHeadings(text) {
  const out = [];
  for (const line of tagLines(text)) {
    if (line.fenced) continue;
    const m = /^#{1,6}\s+(.*)$/.exec(line.text);
    if (!m) continue;
    const c = /^([A-Z](?:\.\d+)+)\s+(.*)$/.exec(m[1].trim());
    out.push(c ? { code: c[1], title: c[2] } : { code: null, title: m[1].trim() });
  }
  return out;
}

/** True when `rest` opens with `title` on a word boundary. */
function opensWith(rest, title) {
  const r = norm(rest);
  const t = headingCore(title);
  if (!t || !r.startsWith(t)) return false;
  const next = r.charAt(t.length);
  return next === "" || !/[a-z0-9]/.test(next);
}

/** (a) Script invocations that do not use the `<skill-path>` placeholder. */
export function scanScriptPaths(relPath, text) {
  const issues = [];
  for (const line of tagLines(text)) {
    for (const m of line.text.matchAll(SCRIPT_ARG_RE)) {
      if (m[1].startsWith(OK_PREFIX)) continue;
      issues.push(issue("script-path", relPath, line.no,
        `\`node ${m[1]}\` — script invocations must use the \`${OK_PREFIX}\` placeholder (a bare path resolves to nothing from a consuming project's root)`));
    }
  }
  return issues;
}

/** (b) `references/<f>.md` citations that do not resolve. */
export function scanReferenceCitations(relPath, text, refExists) {
  const issues = [];
  for (const line of tagLines(text)) {
    if (line.fenced) continue;
    for (const m of line.text.matchAll(CITATION_RE)) {
      if (!m[1].startsWith("references/")) continue;
      if (refExists(m[1].slice("references/".length))) continue;
      issues.push(issue("reference-citation", relPath, line.no,
        `\`${m[1]}\` does not resolve to a file in src/references/`));
    }
  }
  return issues;
}

/** Map a cited doc path to its repo-relative source path (null = unverifiable). */
export function resolveTarget(citation, selfPath) {
  if (!citation) return selfPath;
  if (citation.startsWith("references/")) return `src/${citation}`;
  if (citation.startsWith("agents/")) return `src/${citation}`;
  if (citation.startsWith("scripts/modules/")) return `src/${citation}`;
  if (citation === "SKILL.md") return "src/SKILL.md";
  return null;
}

/**
 * (c) Section pointers. `headingsFor(repoRelPath)` returns the target's heading
 * list, or null when the target cannot be read (pointer skipped as unverifiable).
 */
export function scanSectionPointers(relPath, text, headingsFor) {
  const issues = [];
  const add = (line, message) =>
    issues.push({ rule: "section-pointer", file: relPath, line: line.no, message });

  for (const line of tagLines(text)) {
    if (line.fenced || /^#{1,6}\s/.test(line.text)) continue;
    const cites = [...line.text.matchAll(CITATION_RE)].map((m) => ({
      idx: m.index,
      path: m[1],
    }));
    const consumed = [];

    for (const m of line.text.matchAll(/§\s*/g)) {
      const at = m.index;
      const rest = line.text.slice(at + m[0].length);
      const cite = [...cites].reverse().find((c) => c.idx < at);
      const target = resolveTarget(cite ? cite.path : null, relPath);
      const headings = target ? headingsFor(target) : null;
      const codeM = /^([A-Z])(?![A-Za-z])((?:\.\d+)+)?/.exec(rest);
      consumed.push([at, at + m[0].length + (codeM ? codeM[0].length : 0)]);

      if (codeM && !codeM[2]) {
        add(line, `\`§ ${codeM[1]}\` is unverifiable — use \`§ <Code> <Title>\` (a bare section letter names no heading)`);
        continue;
      }
      if (!headings) continue; // target not readable — cannot verify
      if (codeM) {
        const code = codeM[1] + codeM[2];
        const h = headings.find((x) => x.code === code);
        const titleRest = rest.slice(codeM[0].length).trim();
        if (!h) {
          add(line, `\`§ ${code}\` names no heading in ${target}`);
        } else if (!opensWith(titleRest, h.title)) {
          add(line, `\`§ ${code}\` must be followed by its heading title — ${target} § ${code} is "${headingCore(h.title)}", pointer says "${norm(titleRest).slice(0, 40) || "(nothing)"}"`);
        }
        continue;
      }
      if (!headings.some((h) => opensWith(rest, h.title))) {
        add(line, `\`§ ${rest.trim().slice(0, 40)}\` matches no heading in ${target}`);
      }
    }

    for (const m of line.text.matchAll(SECTION_CODE_RE)) {
      if (consumed.some(([s, e]) => m.index >= s && m.index < e)) continue;
      add(line, `bare section code \`${m[1]}\` — write pointers as \`§ ${m[1]} <Title>\` so the code and the heading title must agree`);
    }
  }
  return issues;
}

/** (d) An agent that runs `<skill-path>/scripts/...` must say how it resolves it. */
export function scanSkillPathResolution(relPath, text) {
  const lines = tagLines(text);
  if (!lines.some((l) => l.text.includes("<skill-path>/scripts/"))) return [];
  const resolves = lines.some(
    (l) => /<skill-path>/.test(l.text) && /Resolv|SKILL PATH:/.test(l.text),
  );
  if (resolves) return [];
  return [issue("skill-path-resolution", relPath, 1,
    "invokes `<skill-path>/scripts/...` but carries no `<skill-path>` resolution pointer (a line naming `Resolving <skill-path>` or the `SKILL PATH:` dispatch preamble)")];
}

/** Render issues as a stable, greppable report. */
export function report(issues) {
  return issues.map((i) => `  ${i.file}:${i.line} [${i.rule}] ${i.message}`);
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
  const mds = (rel) =>
    readdirSync(join(repoRoot, rel)).filter((f) => f.endsWith(".md")).sort()
      .map((f) => `${rel}/${f}`);
  const files = [...mds("src/agents"), ...mds("src/scripts/modules"), "src/SKILL.md", ...mds("src/references")];
  const cache = new Map();
  const headingsFor = (rel) => {
    if (!cache.has(rel)) {
      const abs = join(repoRoot, rel);
      cache.set(rel, existsSync(abs) ? parseHeadings(readFileSync(abs, "utf8")) : null);
    }
    return cache.get(rel);
  };
  const refExists = (name) => existsSync(join(repoRoot, "src", "references", name));

  const issues = [];
  for (const rel of files) {
    const text = readFileSync(join(repoRoot, rel), "utf8");
    issues.push(
      ...scanScriptPaths(rel, text),
      ...scanReferenceCitations(rel, text, refExists),
      ...scanSectionPointers(rel, text, headingsFor),
      ...(rel.startsWith("src/agents/") ? scanSkillPathResolution(rel, text) : []),
    );
  }

  if (issues.length === 0) {
    console.log(`check-agent-wiring: PASS (${files.length} prose files — script paths, reference citations, section pointers, skill-path resolution)`);
    process.exit(0);
  }
  console.error(`check-agent-wiring: FAIL — ${issues.length} wiring error(s) across ${new Set(issues.map((i) => i.file)).size} file(s):`);
  for (const line of report(issues)) console.error(line);
  process.exit(1);
}
