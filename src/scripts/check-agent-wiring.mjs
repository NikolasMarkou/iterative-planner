#!/usr/bin/env node
// Requires Node.js 18+
//
// check-agent-wiring — executable gate for the PROSE layer: shipped agent
// prompts, per-state rule modules, SKILL.md, the reference knowledge base.
// Nothing else checks this layer, so drift there rots silently (the GHOST
// constraint: absence of validator errors == absence of a checker).
//
// Rules:
//   (a) script-path        — `node [options...] <path>/scripts/<x>.mjs` must
//        use the `<skill-path>` placeholder; a bare path resolves to nothing
//        from a consuming project's root. Interposed node options (`-e`,
//        `--test`) do not exempt the invocation.
//   (b) reference-citation — every `references/<f>.md` citation must resolve,
//        written either way (`references/x.md` or `src/references/x.md`).
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
//
// --emit-edges [path] (opt-in): additionally serialize the cross-reference
// edges the scan already verifies to a JSONL file (default
// src/references/kg-edges.jsonl, resolved against repo root). An edge is a
// verified-OK match of rules (a)(b)(c) — one {src, dst, type, line} object per
// line, collected at the same pass points that feed `issues` (one enumeration,
// two consumers). Deliberately excluded: rule (d) (file-level, no line/dst),
// violating matches, and unresolvable citations/pointers (a broken or
// unverifiable pointer is not a verified relationship). The edge list includes
// same-file self-edges (src == dst) by design: a `§` pointer with no preceding
// citation resolves within its own file, mirroring rule (c)'s real verify
// logic. Without the flag the
// checker is byte-identical to its read-only self: no file is written.

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// DECISION plan-2026-09-01T100120-4f591469/D-012 — command grammar (`node`, option run, script
// arg), not token adjacency: a flag between `node` and the path used to evade this rule entirely.
// Do not widen the option run past a leading `-`, or `node` in ordinary prose swallows later paths.
const SCRIPT_ARG_RE = /\bnode(?:\s+-[^\s`'"]*)*\s+([^\s`'"]*scripts\/[A-Za-z0-9_.-]+\.mjs)/g;
const CITATION_RE = /`([A-Za-z0-9_<][A-Za-z0-9_.<>/-]*\.md)`/g;
// Trailing lookahead is `(?!\w)` (not `(?![\w.])`) so a sentence-final code —
// "see Section B.10." — is still a code, not silently skipped.
const SECTION_CODE_RE = /(?<![\w.])([A-Z]\.\d+(?:\.\d+)*)(?!\w)/g;
const OK_PREFIX = "<skill-path>/scripts/";

// The floor (anti-vacuity), mirroring EXPECTED_SLUGS in
// check-template-parity.mjs. The scanned file set is DISCOVERED at runtime
// (readdir over three dirs), so a renamed/emptied dir used to shrink the walk
// silently and the gate still printed PASS over whatever was left. The CLI
// fails loud (`FAIL [scan-floor]`) when any of the three scanned dirs
// contributes zero .md files or the total file count sinks below this floor.
// Real count today: 23 files (8 agents + 5 modules + SKILL.md + 9 references)
// — the floor is set EQUAL to it, matching the exact-floor idiom of
// EXPECTED_MIN_FILES (check-register.mjs) and EXPECTED_SLUGS
// (check-template-parity.mjs); a floor with headroom lets that many runtime
// prompt bodies be deleted and still pass. Bump deliberately when the real
// count changes — the pin test in check-agent-wiring.test.mjs asserts this
// constant equals the live file count discovered from the real repo, so a
// legitimate new agent/module/reference turns the build red here rather than
// silently widening the gap. Enforced in the CLI (isEntryPoint) only — the
// pure scan functions take explicit text and have no discovery step to floor,
// so importers are unchanged.
export const EXPECTED_MIN_PROSE_FILES = 23;

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
export function scanScriptPaths(relPath, text, edges) {
  const issues = [];
  for (const line of tagLines(text)) {
    for (const m of line.text.matchAll(SCRIPT_ARG_RE)) {
      if (m[1].startsWith(OK_PREFIX)) {
        edges?.push({ src: relPath, dst: `src/scripts/${m[1].slice(OK_PREFIX.length)}`, type: "script-path", line: line.no });
        continue;
      }
      issues.push(issue("script-path", relPath, line.no,
        `\`node ${m[1]}\` — script invocations must use the \`${OK_PREFIX}\` placeholder (a bare path resolves to nothing from a consuming project's root)`));
    }
  }
  return issues;
}

// DECISION plan-2026-09-01T100120-4f591469/D-013 — `src/references/x.md` and `references/x.md`
// name the same file; rules (b) and (c) must agree via this one normalizer. Do not reintroduce a
// `startsWith("references/")` guard in either — that let the `src/` spelling skip validation.
/** Canonical repo-relative spelling of a cited doc path. */
export function canonicalDocPath(citation) {
  const c = citation || "";
  return c.startsWith("src/") ? c.slice("src/".length) : c;
}

/** (b) `references/<f>.md` citations that do not resolve (either spelling). */
export function scanReferenceCitations(relPath, text, refExists, edges) {
  const issues = [];
  for (const line of tagLines(text)) {
    if (line.fenced) continue;
    for (const m of line.text.matchAll(CITATION_RE)) {
      const cited = canonicalDocPath(m[1]);
      if (!cited.startsWith("references/")) continue;
      if (refExists(cited.slice("references/".length))) {
        edges?.push({ src: relPath, dst: `src/${cited}`, type: "reference-citation", line: line.no });
        continue;
      }
      issues.push(issue("reference-citation", relPath, line.no,
        `\`${m[1]}\` does not resolve to a file in src/references/`));
    }
  }
  return issues;
}

/** Map a cited doc path to its repo-relative source path (null = unverifiable). */
export function resolveTarget(citation, selfPath) {
  if (!citation) return selfPath;
  const c = canonicalDocPath(citation);
  if (c.startsWith("references/")) return `src/${c}`;
  if (c.startsWith("agents/")) return `src/${c}`;
  if (c.startsWith("scripts/modules/")) return `src/${c}`;
  if (c === "SKILL.md") return "src/SKILL.md";
  return null;
}

/**
 * (c) Section pointers. `headingsFor(repoRelPath)` returns the target's heading
 * list, or null when the target cannot be read (pointer skipped as unverifiable).
 */
export function scanSectionPointers(relPath, text, headingsFor, edges) {
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
        } else {
          edges?.push({ src: relPath, dst: target, type: "section-pointer", line: line.no });
        }
        continue;
      }
      if (!headings.some((h) => opensWith(rest, h.title))) {
        add(line, `\`§ ${rest.trim().slice(0, 40)}\` matches no heading in ${target}`);
      } else {
        edges?.push({ src: relPath, dst: target, type: "section-pointer", line: line.no });
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

// DECISION plan-2026-07-16T085306-8bd12f33/D-004 — edges are ONLY verified-OK matches from the
// same loops that feed `issues`; no parallel collector pass, no localeCompare sort (breaks
// cross-platform byte-identity).
/** Serialize edges to deterministic JSONL: dedupe, sort, fixed key order. */
export function serializeEdges(edges) {
  const lines = (edges || [])
    .slice()
    .sort((a, b) => {
      if (a.src < b.src) return -1;
      if (a.src > b.src) return 1;
      if (a.line !== b.line) return a.line - b.line;
      if (a.dst < b.dst) return -1;
      if (a.dst > b.dst) return 1;
      if (a.type < b.type) return -1;
      if (a.type > b.type) return 1;
      return 0;
    })
    .map((e) => JSON.stringify({ src: e.src, dst: e.dst, type: e.type, line: e.line }));
  const unique = [...new Set(lines)];
  return unique.length === 0 ? "" : unique.join("\n") + "\n";
}

const isEntryPoint = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  // repoRoot override: opt-in env var read HERE only (inside isEntryPoint), so tests can
  // spawn real CLI FAIL branches against fixture roots without touching module scope or CLI behavior.
  const repoRoot =
    process.env.IP_CHECK_AGENT_WIRING_ROOT ??
    join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const mds = (rel) =>
    readdirSync(join(repoRoot, rel)).filter((f) => f.endsWith(".md")).sort()
      .map((f) => `${rel}/${f}`);
  const sources = [
    ["src/agents", mds("src/agents")],
    ["src/scripts/modules", mds("src/scripts/modules")],
    ["src/references", mds("src/references")],
  ];
  const files = [...sources[0][1], ...sources[1][1], "src/SKILL.md", ...sources[2][1]];

  // Anti-vacuity scan floor: runs BEFORE the scan loops, so a passing run's
  // stdout is byte-identical to the pre-floor gate and a shrunken discovery
  // never reaches the scans at all.
  const floorFailures = [];
  for (const [dir, list] of sources) {
    if (list.length === 0) {
      floorFailures.push(`${dir} contributed 0 .md files (each scanned dir must contribute >= 1)`);
    }
  }
  if (files.length < EXPECTED_MIN_PROSE_FILES) {
    floorFailures.push(`scanned only ${files.length} prose file(s), below EXPECTED_MIN_PROSE_FILES = ${EXPECTED_MIN_PROSE_FILES}`);
  }
  if (floorFailures.length > 0) {
    console.error(`check-agent-wiring: FAIL [scan-floor] — ${floorFailures.length} discovery failure(s):`);
    for (const f of floorFailures) console.error(`  ${f}`);
    process.exit(1);
  }
  const cache = new Map();
  const headingsFor = (rel) => {
    if (!cache.has(rel)) {
      const abs = join(repoRoot, rel);
      cache.set(rel, existsSync(abs) ? parseHeadings(readFileSync(abs, "utf8")) : null);
    }
    return cache.get(rel);
  };
  const refExists = (name) => existsSync(join(repoRoot, "src", "references", name));

  // --emit-edges [path]: opt-in; without it edges stays undefined and the
  // scans behave exactly as the read-only gate always has.
  const argv = process.argv;
  const emitIdx = argv.indexOf("--emit-edges");
  let edges;
  let edgesPath = null;
  if (emitIdx !== -1) {
    const next = argv[emitIdx + 1];
    edgesPath = next && !next.startsWith("--")
      ? next
      : join(repoRoot, "src/references/kg-edges.jsonl");
    edges = [];
  }

  const issues = [];
  for (const rel of files) {
    const text = readFileSync(join(repoRoot, rel), "utf8");
    // DECISION plan-2026-09-04T124202-72910089/D-001: rule (d)'s skill-path
    // resolution scan is agents-only on purpose, not widened to
    // src/scripts/modules/*.md. Agent prompts are spawned fresh each time and
    // must locally resolve <skill-path> themselves; module bodies are always
    // inlined into an already-resolved reading context by emit-state.mjs, so
    // they never need their own resolution line. Do NOT widen this scan to
    // modules/*.md without first adding a local <skill-path> resolution line
    // to all 5 modules — none carries one today, so widening now would fail
    // all 5 immediately (see decisions.md D-001).
    issues.push(
      ...scanScriptPaths(rel, text, edges),
      ...scanReferenceCitations(rel, text, refExists, edges),
      ...scanSectionPointers(rel, text, headingsFor, edges),
      ...(rel.startsWith("src/agents/") ? scanSkillPathResolution(rel, text) : []),
    );
  }

  if (edgesPath !== null) {
    // Written on both the PASS and FAIL branches: edges are the *passing*
    // matches — other files' failures do not invalidate them.
    const out = serializeEdges(edges);
    try {
      writeFileSync(edgesPath, out);
    } catch (err) {
      // DECISION plan-2026-07-21T111733-38d0cd87/D-001 — fail LOUD, do not mkdirSync the parent:
      // a typo'd --emit-edges path must exit 1 with err.code reported verbatim, never silently create dirs.
      console.error(`check-agent-wiring: FAIL [emit-edges-write-failed] ${edgesPath} (${err.code})`);
      process.exit(1);
    }
    const n = out === "" ? 0 : out.split("\n").length - 1;
    console.log(`emit-edges: wrote ${n} edge(s) to ${edgesPath}`);
  }

  if (issues.length === 0) {
    console.log(`check-agent-wiring: PASS (${files.length} prose files — script paths, reference citations, section pointers, skill-path resolution)`);
    process.exit(0);
  }
  console.error(`check-agent-wiring: FAIL — ${issues.length} wiring error(s) across ${new Set(issues.map((i) => i.file)).size} file(s):`);
  for (const line of report(issues)) console.error(line);
  process.exit(1);
}
