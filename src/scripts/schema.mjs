#!/usr/bin/env node
// schema.mjs — the declarative definition of the changelog's field shapes. Node.js 18+ (ESM).
// Zero dependencies. Library only: no CLI, no side effects on import.
//
// DECISION plan_2026-07-14_79ee0f59/D-001 — this spec is the SINGLE SOURCE OF TRUTH for the
// changelog's field shapes. It REPLACES the six hand-maintained regexes that lived inline in
// validate-plan.mjs's checkChangelogFormat (TS / STEP / COMMIT / OP / RADIUS / DREF).
//
// The changelog artifact itself is MARKDOWN (pipe-delimited, one line per edit, appended
// atomically). The XML encoding that briefly wrapped it was REVERTED in v2.35.0 — it turned an
// O(1) line append into an O(file) read-modify-write and lost entries under concurrency. This
// module is the part of that work that PAID OFF and stayed: the field shapes have exactly one
// definition, and validate-plan.mjs's markdown path checks each line against it.
//
// What NOT to do here:
//   - Do NOT re-declare a changelog field regex anywhere else (validate-plan.mjs, bootstrap.mjs).
//     Six regexes kept in lockstep by hand is the defect this module exists to remove. If a field
//     shape changes, it changes HERE and every consumer moves with it.
//   - Do NOT loosen a field to `free-text` "to make a real changelog validate". A too-permissive
//     spec passes all of its own tests and silently destroys validation the repo already had —
//     that is this module's named failure mode. Every shape the six regexes rejected must still be
//     rejected; schema.test.mjs enumerates them case by case. Weakening one means deleting its
//     rejection test, which is a loud, reviewable act.
//   - Do NOT re-derive the decision-id grammar. Import DECISION_ID_NUM_PATTERN from shared.mjs
//     (D-005: a hand-copied `\d{3,}` without the boundary corrupts source in bootstrap retire).
//   - Do NOT make validateElement() throw on invalid content. Invalid content is a FINDING: it is
//     reported as an issue so the validator can rank it, batch it, and keep going. A validator that
//     dies on the first bad row is useless.
// See decisions.md D-001.
//
// A spec is a plain object (no classes, no registry):
//   { root, severity, check, elements: { <name>: { attrs, children, text } } }
//   attrs:    { <attr>: { type, required, ...typeOptions } }
//   children: { <childName>: "*" | "?" | "+" | "1" }   // cardinality; any other child is an error
//   text:     true  // element may carry text/CDATA content (default: text is an error)
//
// The "element" is a plain node object — `{ type: "element", name, attrs, children }`. A changelog
// LINE is checked by building one synthetic <entry> node from its 8 fields (entryFromFields) and
// running it through validateElement(). The node shape is an internal detail of that check; there
// is no XML on disk.
//
// Field types: enum | regex | int | iso-datetime | path | free-text.

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
  // Ports the legacy `!path || path.includes("|")` check. The pipe ban is not decoration: the
  // changelog is pipe-delimited, so a path containing "|" is unparseable and must stay rejected.
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
 * The changelog record model. `entry` is the one the validator exercises today (one markdown line
 * -> one synthetic <entry> node -> validateElement); `compressed` and `compressed-summary` declare
 * the shapes bootstrap's compressor emits, and `raw` stands for any line that is not a record
 * (header, blank, an unparseable row that must never be dropped).
 *
 * `severity: "WARN"` and `check: "changelog-malformed"` are not decoration — they are the tier and
 * slug the repo already promises for this artifact (file-formats.md: "Changelog issues are
 * advisory only. Never blocks CLOSE."). Changing them changes a published contract.
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

/** Build a node. Not exported as a general utility — entryFromFields() is the only intended maker. */
const makeElement = (name, attrs, children = []) => ({ type: "element", name, attrs, children });

/** Attribute order == the changelog line's field order. */
const ENTRY_FIELDS = ["ts", "step", "commit", "path", "op", "radius", "dref", "reason"];

/**
 * A synthetic <entry> node from the 8 pipe-delimited fields of a changelog line, in field order.
 *
 * This is the seam that let the six hand-maintained field regexes in validate-plan.mjs's
 * checkChangelogFormat be DELETED rather than duplicated: the validator splits a markdown line with
 * splitChangelogFields(), builds the node here, and runs it through validateElement() against
 * CHANGELOG_SPEC. Do not re-implement this shape anywhere else.
 *
 * With `validate: true` it returns null when the fields do not satisfy the spec; the validator
 * passes `false` because it wants the ISSUES, not a yes/no.
 */
export function entryFromFields(fields, validate = true) {
  const attrs = {};
  ENTRY_FIELDS.forEach((f, i) => { attrs[f] = fields[i]; });
  const e = makeElement("entry", attrs);
  if (validate && validateElement(e, CHANGELOG_SPEC, "<entry>").length > 0) return null;
  return e;
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
 * Validate one element (and its subtree) against `spec`. This is the module's whole public driver:
 * the validator builds a synthetic <entry> from a changelog line (entryFromFields) and checks it
 * here, so every field shape is defined exactly once.
 *
 * Returns an array of `{severity, check, message}` issues. NEVER throws: a malformed node object
 * becomes an issue, not a crash. That is load-bearing — the changelog is ADVISORY and a bad row
 * must never be able to take down a CLOSE.
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
