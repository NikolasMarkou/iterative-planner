#!/usr/bin/env node
// changelog.mjs — the ONLY writer of changelog.xml. CLI + library. Node.js 18+ (ESM). Zero deps.
//
// Subcommands: append (write one entry) | import (legacy .md -> .xml) | render (.xml -> legacy .md)
//
// DECISION plan_2026-07-14_79ee0f59/D-002 — NO SUB-AGENT EVER HAND-WRITES XML. This script is that
// rule made mechanical: every byte of changelog.xml is produced here, by code, from typed fields.
//
// What NOT to do:
//   - Do NOT add a "just append a line" fast path, and do NOT let an agent prompt (ip-executor)
//     emit raw XML. Appending to an XML document is NOT a pure append — the root element must be
//     reopened — so an LLM editing this file by hand will eventually leave an unclosed or misnested
//     tag and the ledger becomes unreadable for EVERY downstream reader. That is the single most
//     likely way the whole XML direction fails (plan.md Pre-Mortem #1). The defence is structural,
//     not prompt discipline: parse -> validate -> splice -> re-serialize -> atomic rename.
//   - Do NOT skip the schema check in appendEntry() "because the CLI args are already typed". The
//     check is what makes A6 falsifiable: if a field an executor needs cannot pass through here,
//     that is a STOP condition for the migration, not something to route around.
//   - Do NOT let import() drop a line it cannot parse. An append-only ledger that silently loses a
//     row is worse than one carrying a row we do not understand. Unparseable -> <raw>, verbatim.
//   - Do NOT write changelog.xml with writeFileSync directly. A crash mid-write would leave a
//     truncated, unparseable document — i.e. exactly the corruption D-002 exists to prevent.
//     .tmp + renameSync (atomic on POSIX) is the only write path.
// See decisions.md D-002.
//
// ---------------------------------------------------------------------------
// The model: ONE XML element per LINE of the legacy markdown, in file order.
//
//   entry line              -> <entry ts= step= commit= path= op= radius= dref= reason=/>
//   inline compression line -> <compressed count= from= to= files=/>
//   the 4-line metadata blk -> <compressed-summary entries-at-compress= elided-groups= elided-lines=/>
//   ANYTHING else           -> <raw line="N">…the line, verbatim…</raw>
//
// The header, blank lines, and any line that fails the schema are all <raw>. That is deliberate:
// it makes render() a dumb, total function (no reconstruction, no "canonical header" guess), and it
// is what makes the byte-exact round-trip hold for files this script did not write.
//
// Byte-exactness is enforced BY CONSTRUCTION, not by hope: import() re-renders every element it
// builds and compares it to the source line; a mismatch demotes the line to <raw>. So
// `import -> render` is the identity on bytes for ANY input, including inputs with formatting we
// did not anticipate. Do not remove that guard to "clean up" a line — the ledger is evidence, and
// evidence is not reformatted.
//
// Trailing newline: lines = content.split("\n") keeps the trailing "" element, which becomes a
// trailing empty <raw/>; parts.join("\n") reverses it exactly. A file with no trailing newline has
// no such element and stays that way. append() therefore inserts BEFORE a trailing empty <raw/>.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, serialize } from "./xml.mjs";
import { CHANGELOG_SPEC, rootElement, validateElement } from "./schema.mjs";
import {
  CHANGELOG_COMPRESSED_INLINE_RE,
  COMPRESSED_SUMMARY_CLOSE,
  COMPRESSED_SUMMARY_OPEN,
  splitChangelogFields,
} from "./shared.mjs";

const XML_NAME = "changelog.xml";
const MD_NAME = "changelog.md";
const SEP = " | ";

/** The 4-line legacy header bootstrap writes. Seeded into a fresh doc so render() emits it. */
export const MD_HEADER_LINES = [
  "# Changelog",
  "*Append-only per-edit ledger. One line per file edit. Owner: ip-executor (writes). Reader: ip-reviewer at REFLECT.*",
  "*Format: `UTC | iter-N/step-M | commit | path | OP(+N,-M) | radius:TIER(score) | D-NNN-or-dash | reason`*",
  "*See references/blast-radius.md for radius scoring. Decision-ref optional — `-` means no `# DECISION` anchor governs this edit.*",
];

/** Entry attribute order == legacy field order. serialize() preserves insertion order. */
const ENTRY_FIELDS = ["ts", "step", "commit", "path", "op", "radius", "dref", "reason"];

// The inline summary's shape, and the 2 numeric lines of the top-of-file block. The `- (compressed:`
// prefix itself is recognized by shared.mjs's CHANGELOG_COMPRESSED_INLINE_RE (one source of truth
// for "is this line a compression summary"); these add the field capture the importer needs.
const INLINE_RE = /^- \(compressed: (\d+) low-decision-impact edits, (iter-\d+\/step-\d+)(?:\.\.(iter-\d+\/step-\d+))?, files: (\d+)\)$/;
const SUMMARY_ENTRIES_RE = /^<!-- entries-at-compress: (\d+) -->$/;
const SUMMARY_ELIDED_RE = /^<!-- elided-groups: (\d+), elided-lines: (\d+) -->$/;

const isElement = (n) => !!n && typeof n === "object" && (n.type === "element" || (!n.type && typeof n.name === "string"));
const el = (name, attrs, children = []) => ({ type: "element", name, attrs, children });

// ---------------------------------------------------------------------------
// Document shape
// ---------------------------------------------------------------------------

/** Rebuild the root's children from an element list, one per line, 2-space indented. */
function setElements(root, elements) {
  const kids = [];
  for (const e of elements) kids.push({ type: "text", value: "\n  " }, e);
  kids.push({ type: "text", value: "\n" });
  root.children = kids;
  return root;
}

/** The element children of the <changelog> root, in document order. */
export function elementsOf(doc) {
  const root = rootElement(doc);
  return (root?.children ?? []).filter(isElement);
}

/** A document wrapping the given elements. */
export function makeDoc(elements = []) {
  const root = setElements(el("changelog", {}), elements);
  return {
    type: "document",
    name: null,
    attrs: {},
    children: [
      { type: "decl", attrs: { version: "1.0", encoding: "UTF-8" } },
      { type: "text", value: "\n" },
      root,
      { type: "text", value: "\n" },
    ],
  };
}

/**
 * A fresh changelog: the legacy 4-line header, a blank separator, and the trailing-newline
 * sentinel — i.e. render() of it is byte-identical to what `bootstrap.mjs new` writes today plus
 * the blank line every real changelog carries before its first entry.
 */
export function emptyDoc() {
  const raws = [...MD_HEADER_LINES, "", ""].map((line, i) => rawEl(line, i + 1));
  return makeDoc(raws);
}

function rawEl(text, lineNo) {
  const attrs = lineNo ? { line: String(lineNo) } : {};
  return el("raw", attrs, text === "" ? [] : [{ type: "text", value: text }]);
}

/** The verbatim text of a <raw> (its text/CDATA children, concatenated). */
export function rawText(e) {
  return (e.children ?? [])
    .filter((c) => c.type === "text" || c.type === "cdata")
    .map((c) => String(c.value ?? ""))
    .join("");
}

// ---------------------------------------------------------------------------
// render — XML -> the byte-identical legacy markdown
// ---------------------------------------------------------------------------

/** One entry element -> its legacy pipe-delimited line. */
export function entryLine(e) {
  return ENTRY_FIELDS.map((f) => e.attrs?.[f] ?? "").join(SEP);
}

/** One <compressed> -> its inline summary line (the range collapses when from == to). */
export function compressedLine(e) {
  const { count, from, to, files } = e.attrs ?? {};
  const range = to && to !== from ? `${from}..${to}` : from;
  return `- (compressed: ${count} low-decision-impact edits, ${range}, files: ${files})`;
}

/** One <compressed-summary> -> the 4-line top-of-file metadata block. */
export function summaryLines(e) {
  const a = e.attrs ?? {};
  return [
    COMPRESSED_SUMMARY_OPEN,
    `<!-- entries-at-compress: ${a["entries-at-compress"]} -->`,
    `<!-- elided-groups: ${a["elided-groups"]}, elided-lines: ${a["elided-lines"]} -->`,
    COMPRESSED_SUMMARY_CLOSE,
  ].join("\n");
}

/** One element -> the source line(s) it stands for. */
export function elementLines(e) {
  switch (e.name) {
    case "entry": return entryLine(e);
    case "compressed": return compressedLine(e);
    case "compressed-summary": return summaryLines(e);
    case "raw": return rawText(e);
    default: return rawText(e); // unknown element: emit whatever text it carries, never crash
  }
}

/** Render a parsed changelog document back to the legacy markdown, byte for byte. */
export function renderDoc(doc) {
  const elements = elementsOf(doc);
  if (elements.length === 0) return "";
  return elements.map(elementLines).join("\n");
}

// ---------------------------------------------------------------------------
// import — legacy markdown -> XML, losslessly
// ---------------------------------------------------------------------------

/**
 * A synthetic <entry> node from the 8 legacy pipe-delimited fields, in field order.
 *
 * Exported (with `validate: false`) so validate-plan.mjs's LEGACY markdown path can run a
 * markdown line through the EXACT SAME schema field types as the XML path — one shape, two
 * encodings. That is what let the six hand-maintained field regexes in checkChangelogFormat be
 * DELETED rather than duplicated. Do not re-implement this shape anywhere else.
 */
export function entryFromFields(fields, validate = true) {
  const attrs = {};
  ENTRY_FIELDS.forEach((f, i) => { attrs[f] = fields[i]; });
  const e = el("entry", attrs);
  if (validate && validateElement(e, CHANGELOG_SPEC, "<entry>").length > 0) return null;
  return e;
}

/**
 * Parse the legacy markdown into a document. NEVER drops a line: every line becomes exactly one
 * element, and an element is only used when it re-renders to the source line byte-for-byte.
 */
export function importMarkdown(md) {
  const lines = String(md).split("\n");
  const elements = [];
  const keep = (e, source) => {
    if (e && elementLines(e) === source) { elements.push(e); return true; }
    return false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // The 4-line top-of-file metadata block (one element, four source lines).
    if (line === COMPRESSED_SUMMARY_OPEN && lines[i + 3] === COMPRESSED_SUMMARY_CLOSE) {
      const m1 = SUMMARY_ENTRIES_RE.exec(lines[i + 1] ?? "");
      const m2 = SUMMARY_ELIDED_RE.exec(lines[i + 2] ?? "");
      if (m1 && m2) {
        const block = lines.slice(i, i + 4).join("\n");
        const e = el("compressed-summary", {
          "entries-at-compress": m1[1],
          "elided-groups": m2[1],
          "elided-lines": m2[2],
        });
        if (validateElement(e, CHANGELOG_SPEC, "<compressed-summary>").length === 0 && keep(e, block)) {
          i += 3;
          continue;
        }
      }
    }

    // An inline compression summary.
    if (CHANGELOG_COMPRESSED_INLINE_RE.test(line)) {
      const m = INLINE_RE.exec(line);
      if (m) {
        const e = el("compressed", { count: m[1], from: m[2], to: m[3] ?? m[2], files: m[4] });
        if (validateElement(e, CHANGELOG_SPEC, "<compressed>").length === 0 && keep(e, line)) continue;
      }
    }

    // An entry line: 8 fields, every one passing the schema, and re-rendering to itself.
    if (line.includes(SEP)) {
      const fields = splitChangelogFields(line);
      if (fields.length === 8 && keep(entryFromFields(fields), line)) continue;
    }

    elements.push(rawEl(line, i + 1));
  }

  return makeDoc(elements);
}

// ---------------------------------------------------------------------------
// append — the one and only write path
// ---------------------------------------------------------------------------

/** UTC ISO-8601, second precision — the `ts` shape schema.mjs's iso-datetime type requires. */
export function nowTs(d = new Date()) {
  return `${d.toISOString().slice(0, 19)}Z`;
}

/**
 * Splice a new <entry> into `doc` after the last entry/compressed element, before the trailing
 * empty <raw/> that carries the file's final newline. Append-only and chronological by
 * construction. Returns `{ doc, issues }`; a non-empty `issues` means NOTHING was appended.
 */
export function appendEntry(doc, fields) {
  const e = entryFromFields(ENTRY_FIELDS.map((f) => String(fields[f] ?? "")), false);
  const issues = validateElement(e, CHANGELOG_SPEC, "<entry>");
  if (issues.length > 0) return { doc, issues };

  const elements = elementsOf(doc);
  // Insert before a trailing empty <raw/> (the trailing-newline sentinel), else at the end.
  const last = elements[elements.length - 1];
  const at = last && last.name === "raw" && rawText(last) === "" ? elements.length - 1 : elements.length;
  elements.splice(at, 0, e);
  const root = rootElement(doc);
  if (root) setElements(root, elements);
  return { doc, issues: [] };
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

export const xmlPath = (planDir) => join(planDir, XML_NAME);
export const mdPath = (planDir) => join(planDir, MD_NAME);

/** Parse a changelog.xml (throws on a well-formedness error, with line:column). */
export const parseXml = (xml) => parse(xml);

/** Serialize a document. The trailing newline is part of the document (a text node at doc level). */
export const serializeDoc = (doc) => serialize(doc);

/** Read the plan dir's changelog.xml, or null if absent. Throws if present but malformed. */
export function readDoc(planDir) {
  const p = xmlPath(planDir);
  if (!existsSync(p)) return null;
  return parse(readFileSync(p, "utf8"));
}

/**
 * Atomic write: .tmp + renameSync. A crash mid-write leaves the ORIGINAL changelog.xml intact —
 * never a truncated, unparseable document. Same idiom as bootstrap.mjs's compressors.
 */
export function writeDocAtomic(file, doc) {
  const xml = serialize(doc);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, xml);
  renameSync(tmp, file);
  return xml;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") flags.dryRun = true;
    else if (a.startsWith("--")) flags[a.slice(2)] = argv[++i];
    else positional.push(a);
  }
  return { flags, positional };
}

const USAGE = `usage:
  changelog.mjs append --plan-dir D --iter N --step M --commit C --path P --op O --radius R [--dref X] --reason "..." [--ts T] [--dry-run]
  changelog.mjs import <plan-dir> [--dry-run]      # changelog.md -> changelog.xml (--dry-run prints the XML)
  changelog.mjs render <plan-dir> | render -       # changelog.xml -> the legacy markdown (- reads XML from stdin)`;

function cmdAppend(flags) {
  const need = ["plan-dir", "iter", "step", "commit", "path", "op", "radius", "reason"];
  const missing = need.filter((k) => flags[k] === undefined || flags[k] === "");
  if (missing.length > 0) {
    console.error(`changelog: append: missing ${missing.map((m) => `--${m}`).join(", ")}\n${USAGE}`);
    return 2;
  }
  const planDir = flags["plan-dir"];
  const file = xmlPath(planDir);

  let doc;
  try {
    doc = readDoc(planDir) ?? emptyDoc();
  } catch (e) {
    console.error(`changelog: ${file}: ${e.message}`);
    return 1;
  }

  const { issues } = appendEntry(doc, {
    ts: flags.ts ?? nowTs(),
    step: `iter-${flags.iter}/step-${flags.step}`,
    commit: flags.commit,
    path: flags.path,
    op: flags.op,
    radius: flags.radius,
    dref: flags.dref ?? "-",
    reason: flags.reason,
  });
  if (issues.length > 0) {
    for (const i of issues) console.error(`changelog: rejected: ${i.message}`);
    return 1;
  }

  if (flags.dryRun) {
    process.stdout.write(serialize(doc));
    return 0;
  }
  writeDocAtomic(file, doc);
  console.log(`appended 1 entry to ${file}`);
  return 0;
}

function cmdImport(planDir, flags) {
  if (!planDir) { console.error(USAGE); return 2; }
  const src = mdPath(planDir);
  if (!existsSync(src)) {
    console.error(`changelog: import: no ${src}`);
    return 1;
  }
  const doc = importMarkdown(readFileSync(src, "utf8"));
  const xml = serialize(doc);

  if (flags.dryRun) {
    process.stdout.write(xml);
    return 0;
  }
  const dest = xmlPath(planDir);
  if (existsSync(dest)) {
    console.error(`changelog: import: ${dest} already exists (refusing to overwrite; use --dry-run to preview)`);
    return 1;
  }
  writeDocAtomic(dest, doc);
  const n = elementsOf(doc).length;
  console.log(`imported ${n} element(s) -> ${dest}`);
  return 0;
}

function cmdRender(target) {
  if (!target) { console.error(USAGE); return 2; }
  let xml;
  try {
    xml = target === "-" ? readFileSync(0, "utf8") : readFileSync(xmlPath(target), "utf8");
  } catch (e) {
    console.error(`changelog: render: ${e.message}`);
    return 1;
  }
  let doc;
  try {
    doc = parse(xml);
  } catch (e) {
    console.error(`changelog: render: ${e.message}`);
    return 1;
  }
  process.stdout.write(renderDoc(doc));
  return 0;
}

const isEntryPoint = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const [cmd, arg] = positional;
  let code;
  switch (cmd) {
    case "append": code = cmdAppend(flags); break;
    case "import": code = cmdImport(arg, flags); break;
    case "render": code = cmdRender(arg); break;
    default:
      console.error(USAGE);
      code = 2;
  }
  process.exit(code);
}
