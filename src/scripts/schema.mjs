#!/usr/bin/env node
// schema.mjs — declarative element/attribute specs + validateDoc() for plan-dir XML artifacts.
// Node.js 18+ (ESM). Zero dependencies.
//
// DECISION plan_2026-07-14_79ee0f59/D-001 — this spec is the SINGLE SOURCE OF TRUTH for the
// changelog's field shapes. It REPLACES the six hand-maintained regexes that lived inline in
// validate-plan.mjs's checkChangelogFormat (TS / STEP / COMMIT / OP / RADIUS / DREF).
//
// What NOT to do here:
//   - Do NOT re-declare a changelog field regex anywhere else (validate-plan.mjs, changelog.mjs,
//     bootstrap.mjs). The whole point of the XML migration is that the schema stops being
//     reconstructed by N independent regexes that must be kept in lockstep by hand. If a field
//     shape changes, it changes HERE and every consumer moves with it.
//   - Do NOT loosen a field to `free-text` "to make a real changelog validate". A too-permissive
//     spec passes all of its own tests and silently destroys validation the repo already had —
//     that is this module's named failure mode (plan.md Failure Modes) and criterion C10 exists
//     to prevent it. Every shape the six regexes rejected must still be rejected; schema.test.mjs
//     enumerates them case by case. Weakening one means deleting its rejection test, which is a
//     loud, reviewable act.
//   - Do NOT re-derive the decision-id grammar. Import DECISION_ID_NUM_PATTERN from shared.mjs
//     (D-005: a hand-copied `\d{3,}` without the boundary corrupts source in bootstrap retire).
//   - Do NOT make validateDoc() throw on invalid CONTENT. Throwing is xml.mjs's job, and only for
//     malformed SYNTAX. Invalid content is a FINDING: it is reported as an issue so the validator
//     can rank it, batch it, and keep going. A validator that dies on the first bad row is useless.
// See decisions.md D-001.
//
// A spec is a plain object (no classes, no registry):
//   { root, severity, check, elements: { <name>: { attrs, children, text } } }
//   attrs:    { <attr>: { type, required, ...typeOptions } }
//   children: { <childName>: "*" | "?" | "+" | "1" }   // cardinality; any other child is an error
//   text:     true  // element may carry text/CDATA content (default: text is an error)
//
// Field types: enum | regex | int | iso-datetime | path | free-text.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "./xml.mjs";
import { DECISION_ID_NUM_PATTERN } from "./shared.mjs";

// ---------------------------------------------------------------------------
// Field types
// ---------------------------------------------------------------------------

const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const INT_RE = /^-?\d+$/;

// Each checker returns null when the value is valid, or a short reason string.
const TYPES = {
  enum: (v, f) => ((f.values ?? []).includes(v) ? null : `must be one of: ${(f.values ?? []).join(", ")}`),
  regex: (v, f) => (f.pattern.test(v) ? null : `must match ${f.pattern.source}`),
  int: (v, f) => {
    if (!INT_RE.test(v)) return "must be an integer";
    const n = Number(v);
    if (f.min !== undefined && n < f.min) return `must be >= ${f.min}`;
    if (f.max !== undefined && n > f.max) return `must be <= ${f.max}`;
    return null;
  },
  // Shape AND calendar: the old TS regex happily accepted 2026-13-45T99:99:99Z.
  //
  // The calendar check is a ROUND TRIP, not `Date.parse(v) !== NaN`. Date.parse is not a calendar
  // validator: V8 rejects month 13 but silently ROLLS OVER an out-of-range day, so
  // Date.parse("2026-02-30T00:00:00Z") returns a finite time (Mar 2) and a NaN check would pass a
  // date that does not exist. Re-serializing and comparing is the only cheap way to catch that.
  "iso-datetime": (v) => {
    if (!ISO_DT_RE.test(v)) return "must be an ISO-8601 UTC timestamp (YYYY-MM-DDTHH:MM:SSZ)";
    const t = Date.parse(v);
    if (!Number.isFinite(t)) return "is not a real calendar date/time";
    return new Date(t).toISOString().replace(".000Z", "Z") === v ? null : "is not a real calendar date/time";
  },
  // Ports the legacy `!path || path.includes("|")` check. The pipe ban is a legacy-encoding
  // artifact kept on purpose: the markdown changelog is pipe-delimited, so a path containing "|"
  // is unparseable there and must stay rejected in both encodings (one shape, two encodings).
  path: (v) => {
    if (v.trim() === "") return "must not be empty";
    if (v.includes("|")) return 'must not contain "|"';
    if (/[\r\n]/.test(v)) return "must not contain a newline";
    return null;
  },
  // Anything goes — pipes, newlines, unicode arrows — but "required" still means non-empty.
  "free-text": (v, f) => (f.allowEmpty || v.trim() !== "" ? null : "must not be empty"),
};

// ---------------------------------------------------------------------------
// The changelog spec — the 6 former validate-plan.mjs regexes, as typed fields.
// ---------------------------------------------------------------------------

/** `iter-N/step-M` (former STEP regex). Also used by <compressed>'s from/to range bounds. */
export const STEP_RE = /^iter-\d+\/step-\d+$/;
/** Short-or-full lowercase hex hash, or the literal `uncommitted` (former COMMIT regex). */
export const COMMIT_RE = /^([0-9a-f]{7,40}|uncommitted)$/;
/** Op + LOC (former OP regex). */
export const OP_RE = /^(CREATE\(\+\d+\)|EDIT\(\+\d+,-\d+\)|DELETE\(-\d+\)|RENAME\([^→]+→[^)]+\)|REVERT\([^)]+\))$/;
/**
 * Radius (former RADIUS regex). The outer group is load-bearing: without it `^` anchors only the
 * first alternative and `$` only the last, so `radius:LOW(2)trailing` would pass.
 */
export const RADIUS_RE = /^(radius:(LOW|MED|HIGH)\(-?\d+\)|radius:UNKNOWN\([^)]+\))$/;
/** Decision-ref: a decision id, or `-` for "no anchor governs this edit" (former DREF regex). */
export const DREF_RE = new RegExp(`^(D-${DECISION_ID_NUM_PATTERN}|-)$`);

const ENTRY_ATTRS = {
  ts: { type: "iso-datetime", required: true },
  step: { type: "regex", required: true, pattern: STEP_RE },
  commit: { type: "regex", required: true, pattern: COMMIT_RE },
  path: { type: "path", required: true },
  op: { type: "regex", required: true, pattern: OP_RE },
  radius: { type: "regex", required: true, pattern: RADIUS_RE },
  dref: { type: "regex", required: true, pattern: DREF_RE },
  reason: { type: "free-text", required: true },
};

/**
 * The changelog document spec.
 *
 * `severity: "WARN"` and `check: "changelog-malformed"` are not decoration — they are the tier and
 * slug the repo already promises for this artifact (file-formats.md: "Changelog issues are
 * advisory only. Never blocks CLOSE."). Changing them changes a published contract.
 *
 * <raw> exists so the step-10 importer NEVER drops a line it could not parse. A legacy changelog
 * line that fails the field types is preserved verbatim as text inside <raw> rather than being
 * silently discarded — losing an append-only ledger entry is worse than carrying a bad one.
 */
export const CHANGELOG_SPEC = {
  root: "changelog",
  severity: "WARN",
  check: "changelog-malformed",
  elements: {
    changelog: {
      attrs: {},
      children: { "compressed-summary": "?", entry: "*", compressed: "*", raw: "*" },
    },
    entry: { attrs: ENTRY_ATTRS, children: {} },
    // One elided group of low-decision-impact edits, AT its original chronological position.
    compressed: {
      attrs: {
        count: { type: "int", required: true, min: 1 },
        from: { type: "regex", required: true, pattern: STEP_RE },
        to: { type: "regex", required: true, pattern: STEP_RE },
        files: { type: "int", required: true, min: 1 },
      },
      children: {},
    },
    // Top-of-file compression metadata. `entries-at-compress` is the dual-count idempotency key.
    "compressed-summary": {
      attrs: {
        "entries-at-compress": { type: "int", required: true, min: 0 },
        "elided-groups": { type: "int", required: true, min: 0 },
        "elided-lines": { type: "int", required: true, min: 0 },
      },
      children: {},
    },
    // A line that never parsed cleanly. Preserved verbatim, never dropped.
    raw: {
      attrs: { line: { type: "int", required: false, min: 1 } },
      children: {},
      text: true,
    },
  },
};

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

const isElement = (n) => !!n && typeof n === "object" && (n.type === "element" || (!n.type && typeof n.name === "string"));

/**
 * The root element of a parsed document (or the node itself, if already an element). Lives here,
 * not in xml.mjs: it had no call site there (and xml.mjs is at its 300-line budget), and this
 * module is its first real consumer — see the NOTE at the bottom of xml.mjs.
 */
export function rootElement(node) {
  if (!node || typeof node !== "object") return null;
  if (isElement(node)) return node;
  return (node.children ?? []).find(isElement) ?? null;
}

function walk(el, at, spec, issues, mk) {
  const def = spec.elements?.[el.name];
  if (!def) {
    issues.push(mk(`${at}: unknown element <${el.name}>`));
    return;
  }

  // Attributes: unknown, missing-required, and wrong-shape are three distinct findings.
  const attrs = el.attrs ?? {};
  const declared = def.attrs ?? {};
  for (const [name, value] of Object.entries(attrs)) {
    const field = declared[name];
    if (!field) {
      issues.push(mk(`${at}: unknown attribute "${name}"`));
      continue;
    }
    const why = TYPES[field.type] ? TYPES[field.type](String(value), field) : `unknown field type "${field.type}"`;
    if (why) issues.push(mk(`${at}: attribute "${name}" ${why} (got "${value}")`));
  }
  for (const [name, field] of Object.entries(declared)) {
    if (field.required && !Object.hasOwn(attrs, name)) issues.push(mk(`${at}: missing required attribute "${name}"`));
  }

  // Children: cardinality + text policy. Comments are always ignored.
  const allowed = def.children ?? {};
  const counts = new Map();
  for (const child of el.children ?? []) {
    if (!child || typeof child !== "object") continue;
    if (child.type === "comment" || child.type === "decl") continue;
    if (child.type === "text" || child.type === "cdata") {
      if (!def.text && String(child.value ?? "").trim() !== "") {
        issues.push(mk(`${at}: text content is not allowed in <${el.name}>`));
      }
      continue;
    }
    if (!isElement(child)) {
      issues.push(mk(`${at}: unexpected node type "${child.type}"`));
      continue;
    }
    counts.set(child.name, (counts.get(child.name) ?? 0) + 1);
  }
  for (const [name, n] of counts) {
    if (!Object.hasOwn(allowed, name)) {
      issues.push(mk(`${at}: unexpected child element <${name}>`));
      continue;
    }
    const card = allowed[name];
    if ((card === "?" || card === "1") && n > 1) issues.push(mk(`${at}: <${name}> may appear at most once (found ${n})`));
  }
  for (const [name, card] of Object.entries(allowed)) {
    const n = counts.get(name) ?? 0;
    if ((card === "1" || card === "+") && n < 1) issues.push(mk(`${at}: missing required child <${name}>`));
  }

  const seen = new Map();
  for (const child of el.children ?? []) {
    if (!isElement(child)) continue;
    const idx = (seen.get(child.name) ?? 0) + 1;
    seen.set(child.name, idx);
    if (Object.hasOwn(allowed, child.name)) walk(child, `${at}/<${child.name}>[${idx}]`, spec, issues, mk);
  }
}

const makeIssue = (spec) => (message) => ({
  severity: spec?.severity ?? "WARN",
  check: spec?.check ?? "schema",
  message,
});

/**
 * Validate one element (and its subtree) against `spec`. Exported so the legacy markdown changelog
 * path can validate a synthetic <entry> node built from splitChangelogFields() through the exact
 * same field types as the XML path — one shape, two encodings.
 *
 * Returns an array of `{severity, check, message}` issues. NEVER throws: a malformed node object
 * becomes an issue, not a crash.
 */
export function validateElement(el, spec, at) {
  const issues = [];
  const mk = makeIssue(spec);
  try {
    if (!isElement(el)) return [mk("expected an element node")];
    walk(el, at ?? `<${el.name}>`, spec, issues, mk);
  } catch (e) {
    issues.push(mk(`schema validation aborted on a malformed node: ${e.message}`));
  }
  return issues;
}

/**
 * Validate a parsed document against `spec`. Returns the validator's standard issue objects —
 * `{severity, check, message}` — and NEVER throws on invalid content (see the D-001 anchor above).
 */
export function validateDoc(doc, spec) {
  const mk = makeIssue(spec);
  try {
    const root = rootElement(doc);
    if (!root) return [mk("document has no root element")];
    if (root.name !== spec.root) return [mk(`root element is <${root.name}>, expected <${spec.root}>`)];
    return validateElement(root, spec, `<${root.name}>`);
  } catch (e) {
    return [mk(`schema validation aborted: ${e.message}`)];
  }
}

const isEntryPoint = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

// CLI: validate a changelog.xml against CHANGELOG_SPEC. Prints one line per issue; exit 1 if any.
// A SYNTAX error (from xml.mjs) exits 2 — it is a different failure than a CONTENT finding.
if (isEntryPoint) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: schema.mjs <changelog.xml>   # validate against CHANGELOG_SPEC");
    process.exit(2);
  }
  let doc;
  try {
    doc = parse(readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`schema: ${file}: ${e.message}`);
    process.exit(2);
  }
  const issues = validateDoc(doc, CHANGELOG_SPEC);
  for (const i of issues) console.log(`${i.severity} [${i.check}] ${i.message}`);
  console.log(issues.length === 0 ? `PASS ${file}` : `${issues.length} issue(s) in ${file}`);
  process.exit(issues.length === 0 ? 0 : 1);
}
