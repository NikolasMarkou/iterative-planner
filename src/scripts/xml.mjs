#!/usr/bin/env node
// xml.mjs — a hand-written XML parser + serializer for plan-dir artifacts. Node.js 18+ (ESM).
//
// DECISION plan_2026-07-14_79ee0f59/D-001 — this parser is hand-written ON PURPOSE and its subset
// is deliberately SMALL. Node 18 ships no XML parser (no DOMParser, no `xml` module) and this
// repo's hardest property is ZERO RUNTIME DEPENDENCIES — the skill installs as a bare file tree
// with no npm step. Rather than break that, we own a parser, at a 300-LINE HARD BUDGET.
//
// What NOT to do here:
//   - Do NOT add namespaces, DTD/doctype/entity declarations, or general processing-instruction
//     semantics (the XML declaration is a special case, not a PI mechanism). No XPath, no
//     pretty-printing, no mixed-content coercion.
//   - Do NOT grow this file past 300 lines to make some exotic document parse. The line cap IS the
//     tripwire (plan.md Pre-Mortem #2): if a real requirement needs namespaces, a DTD, or another
//     ~100 lines of edge cases, then the decision to hand-write was WRONG and must be RE-OPENED
//     (take a real XML dependency, or fall back to a sidecar encoding) — not silently paid for by
//     growing this file. Report the trigger; do not "make it work".
//   - Do NOT make the parser lenient. Silently accepting malformed XML is the widest blast radius
//     in this plan: schema.mjs would then validate garbage and the changelog would assert things
//     that are not true. Malformed input THROWS, with line and column.
// See decisions.md D-001.
//
// DOM shape (plain objects, discriminated by `type` — no classes, no prototypes). serialize()
// also accepts a bare `{name, attrs, children}` (no `type`) as an element:
//   { type: "document", name: null, attrs: {}, children: [...] }   <- what parse() returns
//   { type: "element",  name, attrs: {k: v}, children: [...] }     <- attrs are decoded strings
//   { type: "text",     value }   entity-decoded | { type: "cdata", value }  raw, never decoded
//   { type: "comment",  value }   inner text     | { type: "decl",  attrs }  the <?xml ... ?> decl
//
// Round-trip contract: serialize(parse(x)) is a FIXED POINT — it converges after one pass. It is
// deliberately NOT byte-identical to arbitrary input: numeric refs decode (`&#65;` -> `A`),
// `<a></a>` canonicalizes to `<a/>`, escaping is normalized. What IS preserved: text bytes
// (whitespace included), attribute order, comments, CDATA, the declaration.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const NAME_RE = /^[A-Za-z_][A-Za-z0-9._-]*$/; // no ":" — namespaces are unsupported, and a
const NAME_START_RE = /[A-Za-z_]/; //             namespaced doc must fail LOUDLY, not silently.
const NAME_CHAR_RE = /[A-Za-z0-9._-]/;
const WS_RE = /[ \t\r\n]/;
const DECL_ATTRS = ["version", "encoding", "standalone"];
const ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
// [open, close, type, label]. Order matters: `<!--` and `<![CDATA[` both start with `<!`, so both
// must be tested before the `<!` doctype rejection.
const DELIMITED = [
  ["<!--", "-->", "comment", "comment"],
  ["<![CDATA[", "]]>", "cdata", "CDATA section"],
];
// The two escape sets differ, and the difference is load-bearing. TEXT: `>` is escaped
// unconditionally — that is what makes a literal `]]>` in text safe with no special case. ATTR:
// quotes must go, and a literal newline/CR/tab MUST become a numeric ref, because a conformant
// reader normalizes raw whitespace in an attribute value to a space — which would silently
// corrupt e.g. a changelog `reason` carrying a newline.
const TEXT_ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const ATTR_ESC = { ...TEXT_ESC, '"': "&quot;", "'": "&apos;", "\r": "&#13;", "\n": "&#10;", "\t": "&#9;" };

/** 1-based line/column for an offset. Error path only, so the O(pos) scan is fine. */
export function lineCol(src, pos) {
  const upto = src.slice(0, Math.max(0, pos));
  const lastNl = upto.lastIndexOf("\n");
  return { line: (upto.match(/\n/g) ?? []).length + 1, column: upto.length - lastNl };
}

/** Escape for TEXT content. */
export function escapeText(value) {
  return String(value).replace(/[&<>]/g, (c) => TEXT_ESC[c]);
}

/** Escape for an ATTRIBUTE value (always emitted double-quoted). */
export function escapeAttr(value) {
  return String(value).replace(/[&<>"'\r\n\t]/g, (c) => ATTR_ESC[c]);
}

/**
 * Parse an XML string into the plain-object DOM documented above. Throws on ANY well-formedness
 * violation; the Error carries `.line`, `.column`, `.position` and its message ends with
 * `(line L, column C)`.
 */
export function parse(src) {
  if (typeof src !== "string") throw new TypeError("parse(xml): expected a string");
  const s = src;
  let i = 0;
  const err = (msg, at = i) => {
    const { line, column } = lineCol(s, at);
    const message = `XML parse error: ${msg} (line ${line}, column ${column})`;
    throw Object.assign(new Error(message), { line, column, position: at });
  };
  // Entity decoding. `base` is the absolute offset of `raw` so errors report a real position.
  const decode = (raw, base) => {
    let out = "";
    let k = 0;
    for (;;) {
      const a = raw.indexOf("&", k);
      if (a < 0) return out + raw.slice(k);
      out += raw.slice(k, a);
      const semi = raw.indexOf(";", a);
      if (semi < 0 || semi === a + 1) err('malformed entity reference (a bare "&" must be written "&amp;")', base + a);
      const body = raw.slice(a + 1, semi);
      if (body[0] === "#") {
        const hex = body[1] === "x" || body[1] === "X";
        const digits = hex ? body.slice(2) : body.slice(1);
        const ok = digits && (hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits);
        if (!ok) err(`malformed character reference "&${body};"`, base + a);
        const code = Number.parseInt(digits, hex ? 16 : 10);
        if (!Number.isInteger(code) || code < 1 || code > 0x10ffff) err(`character reference "&${body};" is out of range`, base + a);
        out += String.fromCodePoint(code);
      } else if (Object.hasOwn(ENTITIES, body)) out += ENTITIES[body];
      else err(`unknown entity "&${body};" — only the 5 predefined entities and numeric character references are supported (no DTD)`, base + a);
      k = semi + 1;
    }
  };
  const skipWs = () => {
    while (i < s.length && WS_RE.test(s[i])) i++;
  };
  const readName = (what) => {
    const start = i;
    if (i >= s.length || !NAME_START_RE.test(s[i])) err(`expected ${what} name`);
    i++;
    while (i < s.length && NAME_CHAR_RE.test(s[i])) i++;
    return s.slice(start, i);
  };

  // Shared by start tags and the XML declaration: read attributes until a terminator is consumed.
  const readAttrs = (terminators, owner, open) => {
    const attrs = {};
    for (;;) {
      const wsStart = i;
      skipWs();
      const term = terminators.find((t) => s.startsWith(t, i));
      if (term) {
        i += term.length;
        return { attrs, term };
      }
      if (i >= s.length) err(`unclosed <${owner}> tag`, open);
      if (i === wsStart) err(`expected whitespace before the next attribute in <${owner}>`);
      const aStart = i;
      const aName = readName("attribute");
      if (Object.hasOwn(attrs, aName)) err(`duplicate attribute "${aName}" in <${owner}>`, aStart);
      skipWs();
      if (s[i] !== "=") err(`expected "=" after attribute "${aName}"`);
      i++;
      skipWs();
      const q = s[i];
      if (q !== '"' && q !== "'") err(`value of attribute "${aName}" must be quoted`);
      i++;
      const vStart = i;
      const end = s.indexOf(q, i);
      if (end < 0) err(`unterminated value for attribute "${aName}"`, vStart);
      const raw = s.slice(vStart, end);
      const lt = raw.indexOf("<");
      if (lt >= 0) err(`raw "<" in value of attribute "${aName}" (use &lt;)`, vStart + lt);
      attrs[aName] = decode(raw, vStart);
      i = end + 1;
    }
  };

  // One node at the current cursor. Callers handle `</` themselves.
  const parseNode = () => {
    // Comments and CDATA are the same shape: an opaque run scanned to a closing delimiter.
    for (const [open, close, type, label] of DELIMITED) {
      if (!s.startsWith(open, i)) continue;
      const at = i;
      const end = s.indexOf(close, i + open.length);
      if (end < 0) err(`unterminated ${label}`, at);
      const value = s.slice(i + open.length, end);
      i = end + close.length;
      return { type, value };
    }
    if (s.startsWith("<?", i)) err("processing instructions are not supported (only a leading XML declaration)");
    if (s.startsWith("<!", i)) err("DTD / doctype declarations are not supported");
    if (s[i] === "<") {
      if (!NAME_START_RE.test(s[i + 1] ?? "")) err('stray "<" (write a literal "<" as &lt;)');
      return parseElement();
    }
    const start = i;
    while (i < s.length && s[i] !== "<") i++;
    return { type: "text", value: decode(s.slice(start, i), start) };
  };

  const parseElement = () => {
    const open = i;
    i++; // consume "<"
    const name = readName("element");
    const { attrs, term } = readAttrs(["/>", ">"], name, open);
    if (term === "/>") return { type: "element", name, attrs, children: [] };
    const children = [];
    for (;;) {
      if (i >= s.length) err(`unclosed element <${name}>`, open);
      if (s.startsWith("</", i)) {
        const cStart = i;
        i += 2;
        const cName = readName("closing tag");
        skipWs();
        if (s[i] !== ">") err(`malformed closing tag </${cName}>`, cStart);
        i++;
        if (cName !== name) err(`mismatched closing tag </${cName}> for <${name}>`, cStart);
        return { type: "element", name, attrs, children };
      }
      children.push(parseNode());
    }
  };

  // Document level: an optional declaration, then prolog/epilog comments + whitespace around
  // exactly ONE root element. parseNode() lexes; here we only enforce what may appear where.
  const children = [];
  let rootSeen = false;
  while (i < s.length) {
    const at = i;
    if (s.startsWith("<?xml", i)) {
      if (children.length > 0) err("the XML declaration must be the first thing in the document", at);
      i += 5;
      const { attrs } = readAttrs(["?>"], "?xml", at);
      const bad = Object.keys(attrs).find((k) => !DECL_ATTRS.includes(k));
      if (bad) err(`unknown XML-declaration attribute "${bad}"`, at);
      children.push({ type: "decl", attrs });
      continue;
    }
    if (rootSeen && s[i] === "<" && NAME_START_RE.test(s[i + 1] ?? "")) {
      err("junk after the root element: a document may have only one root", at);
    }
    const node = parseNode();
    if (node.type === "cdata") err("CDATA is not allowed outside the root element", at);
    if (node.type === "text" && node.value.trim() !== "") err("text is not allowed outside the root element", at);
    if (node.type === "element") rootSeen = true;
    children.push(node);
  }
  if (!rootSeen) err(s.trim() === "" ? "empty document: no root element" : "no root element", s.length);
  return { type: "document", name: null, attrs: {}, children };
}

function attrsToString(attrs, owner) {
  let out = "";
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (!NAME_RE.test(k)) throw new Error(`serialize: invalid attribute name "${k}" on <${owner}>`);
    if (v === null || v === undefined) continue;
    out += ` ${k}="${escapeAttr(v)}"`;
  }
  return out;
}

/**
 * Serialize any node (or a whole document) to an XML string. No pretty-printing: what goes out is
 * exactly the tree, so text/whitespace survives untouched. Throws on a node that cannot be
 * represented (bad name, a comment containing "-->").
 */
export function serialize(node) {
  if (!node || typeof node !== "object") throw new TypeError("serialize(node): expected a node object");
  const type = node.type ?? (typeof node.name === "string" ? "element" : null);
  switch (type) {
    case "document": return (node.children ?? []).map(serialize).join("");
    case "decl": return `<?xml${attrsToString(node.attrs, "?xml")}?>`;
    case "text": return escapeText(node.value ?? "");
    // A CDATA body cannot contain "]]>", so split it across two sections. Re-parsing yields two
    // adjacent cdata nodes whose serialization is identical — the fixed point holds.
    case "cdata": return `<![CDATA[${String(node.value ?? "").replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
    case "comment": {
      const value = String(node.value ?? "");
      if (value.includes("-->")) throw new Error('serialize: comment value may not contain "-->"');
      return `<!--${value}-->`;
    }
    case "element": {
      if (!NAME_RE.test(node.name ?? "")) throw new Error(`serialize: invalid element name "${node.name}"`);
      const head = `${node.name}${attrsToString(node.attrs, node.name)}`;
      const kids = node.children ?? [];
      return kids.length === 0 ? `<${head}/>` : `<${head}>${kids.map(serialize).join("")}</${node.name}>`;
    }
    default: throw new TypeError(`serialize: unknown node type "${node.type}"`);
  }
}

// NOTE: no rootElement()/query helpers here on purpose — they have no call site yet. schema.mjs
// (step 9) is their first real consumer and should add them there, with a caller.

const isEntryPoint = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

// CLI: well-formedness check — prints the canonical re-serialization (exit 0) or the parse error
// with line:column (exit 1). Importing this module has no side effects.
if (isEntryPoint) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: xml.mjs <file.xml>   # well-formedness check; prints the canonical re-serialization");
    process.exit(2);
  }
  try {
    const out = serialize(parse(readFileSync(file, "utf8")));
    process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
  } catch (e) {
    console.error(`xml: ${file}: ${e.message}`);
    process.exit(1);
  }
}
