#!/usr/bin/env node
// Requires Node.js 18+
// dashboard.mjs — a read-only, live-updating HTML view of the plans directory.
//
// It reads plans/ (in the repo and in every git worktree of it) and, optionally, Claude Code's
// session logs, and writes a small static site:
//   dashboard.html                  the plan that is running now (pointer, else most recent activity)
//   dashboard/index.html            every plan, newest first, including closed plans whose directory
//                                   is gone (their INDEX.md row + consolidated-ledger sections)
//   dashboard/p/<plan>.html         one page per plan: phase rail, steps, decisions, timeline, checks,
//                                   activity, documents, and token usage
//   dashboard/p/<plan>/<doc>.html   every markdown file of the plan, rendered
//   dashboard/ledger/<FILE>.html    plans/SYSTEM.md, LESSONS.md, FINDINGS.md, DECISIONS.md, ANCHORS.md, INDEX.md
//   dashboard/assets/*              shared css/js, search index, live manifest, data.json, usage cache
//
//   node <skill-path>/scripts/dashboard.mjs                 write once and print the path
//   node <skill-path>/scripts/dashboard.mjs --watch         keep it current; open pages update themselves
//   node <skill-path>/scripts/dashboard.mjs --open          also open it in the default browser
//   Options: --out <file.html>  --plan <plan-id>  --no-usage  --interval <seconds>  --help
//   (--out must name a .html or .htm file; anything else is rejected before a write. An explicit
//   --out is used as given, with no privacy check.)
//
// WHAT IT NEVER DOES: write anything under the repo (output goes to a private per-user folder in the
// OS temp dir, refused if other users can reach it, unless --out says otherwise), make a network
// request (system fonts; no remote assets), or run when imported (the CLI is behind the isEntryPoint
// guard, so the test suite imports the pure functions).
//
// TOKEN USAGE comes from Claude Code's own session logs, <config>/projects/<repo-slug>/*.jsonl and
// <session>/subagents/agent-*.jsonl, where <config> is $CLAUDE_CONFIG_DIR or ~/.claude. Every
// assistant line carries message.model and message.usage. Two facts about those logs decide the
// arithmetic, and both are pinned by tests:
//   1. A streamed reply is logged once per content block under the same message id, so records are
//      de-duplicated by id, keeping the largest value of each field (output grows across the copies).
//   2. A forked sub-agent's log starts with a copy of the parent's launching message (same id,
//      truncated output). Each message is counted once, and the main-session copy wins.
// Only sessions that ran this skill count (an iterative-planner Skill call, or an ip-* sub-agent).
// They are split across plans by time window: a plan owns [start, close]; a sub-agent run is kept
// whole and goes to the plan whose window holds its first message. Planner usage outside every
// window, and usage from sessions that never ran the planner, are reported separately, never mixed in.
// The log format is Claude Code's and is not a published interface; if it is absent or changes,
// the usage section says it found nothing rather than failing the page.
//
// COST: one pass per tick over the plan directories found (O(plan dirs)), plus the bytes appended to
// the session logs since the last tick (the logs are append-only, so they are read incrementally and
// the position is cached). git runs once per tick for the live plan; commit history is re-read only
// when that worktree's HEAD moves. Documents whose source did not change are not re-rendered, and
// output that did not change is not rewritten. With --watch the interval backs off to 60 s while
// nothing changes. Under the default output folder each write costs one extra mkdir and lstat, to
// re-check that the folder is still private.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ANY_PLAN_ID_RE,
  DECISION_ID_NUM_PATTERN,
  planDateFromId,
  splitChangelogFields,
  stripHtmlComments,
} from "./shared.mjs";

// ---------- small helpers ----------
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };
const git = (cwd, ...a) => {
  try { return execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 32 << 20 }); }
  catch { return ""; }
};
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
// Clip without leaving a dangling backtick — an unclosed code span renders literally.
const clipCode = (s, n) => { let c = clip(s.trim(), n); if ((c.match(/`/g) || []).length % 2) c = c.replace(/`([^`]*)$/, "$1"); return c; };
const oneLine = (s) => String(s || "").replace(/\s*\n+\s*/g, " ").trim();
// One line for summaries: list markers dropped, list items joined with a middle dot.
const flat = (s) => String(s || "").split("\n").map((l) => l.trim()).filter(Boolean).reduce((acc, l, i) => {
  const bullet = /^([-*+]|\d+\.)\s+/.test(l);
  l = l.replace(/^([-*+]|\d+\.)\s+/, "");
  return i === 0 ? l : acc + (bullet ? " · " : " ") + l;
}, "");
const sha = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);
const stamp = (ms) => new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const day = (ms) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
// Relative times are filled in by the page script, so a page stays byte-identical until its data changes.
const t = (ms) => (ms ? `<time data-ms="${Math.round(ms)}">${stamp(ms)}</time>` : "—");
const section = (text, heading) => {
  const re = new RegExp(`^## ${heading}[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m");
  return (text.match(re) || [])[1] || "";
};
const cmpStep = (a, b) => {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? -1) - (y[i] ?? -1); if (d) return d; }
  return 0;
};
/** Start time of a plan from its id: the new grammar carries a UTC time, the legacy one only a date. */
export const planStart = (id) => {
  const m = /^plan-(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})(\d{2})-/.exec(id);
  if (m) return Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
  const d = planDateFromId(id);
  return d ? Date.parse(`${d}T00:00:00Z`) : 0;
};
export const fmtN = (n) => {
  const f = (v, d) => v.toFixed(d).replace(/\.0+$/, "");
  if (n >= 1e9) return f(n / 1e9, n >= 1e10 ? 1 : 2) + "B";
  if (n >= 1e6) return f(n / 1e6, n >= 1e8 ? 0 : 1) + "M";
  if (n >= 1e3) return f(n / 1e3, n >= 1e5 ? 0 : 1) + "K";
  return String(Math.round(n));
};
const fmtDur = (ms) => {
  if (!ms || ms < 0) return "—";
  const m = ms / 60000;
  if (m < 60) return `${Math.max(1, Math.round(m))} min`;
  if (m < 48 * 60) return `${(m / 60).toFixed(m < 600 ? 1 : 0)} h`;
  return `${(m / 1440).toFixed(1)} d`;
};
const pct = (a, b) => (b ? (a / b) * 100 : 0);
const pctLabel = (a, b) => { const p = pct(a, b); return p === 0 ? "0%" : p < 0.1 ? "<0.1%" : p < 10 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`; };

// ---------- icons ----------
const I = {
  mark: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="10.14 4" transform="rotate(-87 12 12)"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m16 16 4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  dots: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5.5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="18.5" cy="12" r="1.6" fill="currentColor"/></svg>',
  chev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6.5 12.5 3.5 3.5 7.5-8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  cross: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7.5 7.5 9 9m0-9-9 9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h6.5L18 8v12.5H7z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M13 3.5V8.5h5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13m-5-5 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H6m5-5-5 5 5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

// ---------- markdown ----------
// Plan files are written by agents, so every byte of them is untrusted: all text is escaped first and
// only a fixed set of constructs is turned into markup. Raw HTML in a plan file renders as text, and
// only http(s) links become anchors.
export function inline(s) {
  const codes = [];
  s = String(s ?? "").replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = esc(s)
    .replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*(?!\s)([^*\n]+?)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, txt, url) => (/^https?:\/\//.test(url) ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${txt}</a>` : `<span class="lnk" title="${url}">${txt}</span>`));
  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${esc(codes[n])}</code>`);
}

// Hard-wrapped prose rejoins into one paragraph; short or metadata-style lines keep their line breaks.
const joinLines = (lines) => lines.map(inline).reduce((acc, cur, i) => {
  if (!i) return cur;
  const prev = lines[i - 1], next = lines[i];
  const br = / {2}$/.test(prev) || prev.trim().length < 55 || /^\s*(\*|_|\(?[A-Z][\w ]{0,24}\)?:)/.test(next);
  return acc + (br ? "<br>" : " ") + cur;
}, "");

export function mdToHtml(src) {
  src = String(src).replace(/<!--[\s\S]*?-->/g, "").replace(/\r/g, "");
  const L = src.split("\n");
  const out = [], toc = [], used = new Set();
  const slug = (txt) => {
    const m = txt.match(/^(D-\d+|F-\d+)\b/);
    const s = m ? m[1] : (txt.toLowerCase().replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "h");
    let k = s, n = 2; while (used.has(k)) k = `${s}-${n++}`; used.add(k); return k;
  };
  const isList = (l) => /^\s*([-*+]|\d+\.)\s+/.test(l);
  const isSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const isHr = (l) => /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l);
  const startsBlock = (l, next) => /^\s*```/.test(l) || /^#{1,6}\s/.test(l) || /^>/.test(l) || isList(l) || isHr(l) || (/^\s*\|/.test(l) && isSep(next || ""));
  const cells = (r) => r.replace(/`[^`]*`/g, (s) => s.replace(/\|/g, "\u0001")).trim().replace(/^\||\|$/g, "").split("|").map((c) => c.replace(/\u0001/g, "|").trim());
  let i = 0, m;
  while (i < L.length) {
    const l = L[i];
    if (!l.trim()) { i++; continue; }
    if (/^\s*```/.test(l)) {
      const buf = []; i++;
      while (i < L.length && !/^\s*```/.test(L[i])) buf.push(L[i++]);
      i++; out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`); continue;
    }
    if ((m = l.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/))) {
      const lvl = m[1].length, id = slug(m[2]);
      if (lvl === 2 || lvl === 3) toc.push({ lvl, id, txt: m[2] });
      out.push(`<h${lvl} id="${id}">${inline(m[2])}</h${lvl}>`); i++; continue;
    }
    if (isHr(l)) { out.push("<hr>"); i++; continue; }
    if (/^\s*\|/.test(l) && isSep(L[i + 1] || "")) {
      const head = cells(l); i += 2; const rows = [];
      while (i < L.length && /^\s*\|/.test(L[i])) rows.push(cells(L[i++]));
      out.push(`<div class="tbl"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    if (/^>/.test(l)) {
      const buf = []; while (i < L.length && /^>/.test(L[i])) buf.push(L[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote>${mdToHtml(buf.join("\n")).html}</blockquote>`); continue;
    }
    if (isList(l)) {
      const items = [];
      while (i < L.length) {
        const cur = L[i];
        if ((m = cur.match(/^(\s*)([-*+]|\d+)\.?\s+(.*)$/)) && isList(cur)) {
          let text = m[3], checked = null;
          const cb = text.match(/^\[( |x|X)\]\s*(.*)$/); if (cb) { checked = cb[1] !== " "; text = cb[2]; }
          items.push({ indent: m[1].replace(/\t/g, "    ").length, ordered: /\d/.test(m[2]), start: Number(m[2]) || 1, text: [text], checked });
          i++;
        } else if (cur.trim() && /^\s+/.test(cur) && !/^\s*```/.test(cur)) { items.at(-1).text.push(cur.trim()); i++; }
        else if (!cur.trim()) {
          let j = i; while (j < L.length && !L[j].trim()) j++;
          if (j < L.length && (isList(L[j]) || /^\s+\S/.test(L[j]))) i = j; else break;
        } else break;
      }
      let html = ""; const stack = [];
      for (const it of items) {
        while (stack.length && it.indent < stack.at(-1).indent) html += `</li></${stack.pop().tag}>`;
        // A switch between bullets and numbers at the same depth ends one list and starts the other.
        if (stack.length && it.indent === stack.at(-1).indent && it.ordered !== (stack.at(-1).tag === "ol")) html += `</li></${stack.pop().tag}>`;
        if (!stack.length || it.indent > stack.at(-1).indent) {
          const tag = it.ordered ? "ol" : "ul";
          stack.push({ indent: it.indent, tag });
          html += `<${tag}${it.ordered && it.start !== 1 ? ` start="${it.start}"` : ""}${it.checked !== null ? ' class="tasks"' : ""}>`;
        } else html += "</li>";
        const box = it.checked === null ? "" : `<span class="cb${it.checked ? " on" : ""}">${it.checked ? I.check : ""}</span>`;
        html += `<li>${box}${joinLines(it.text)}`;
      }
      while (stack.length) html += `</li></${stack.pop().tag}>`;
      out.push(html); continue;
    }
    const buf = [];
    while (i < L.length && L[i].trim() && !(buf.length && startsBlock(L[i], L[i + 1]))) buf.push(L[i++]);
    out.push(`<p>${joinLines(buf)}</p>`);
  }
  return { html: out.join("\n"), toc };
}

// ---------- plan-file parsing (pure; every function takes file text) ----------
const PHASES = ["EXPLORE", "PLAN", "EXECUTE", "REFLECT", "PIVOT", "CLOSE"];
const ISO_RE = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ/;

/** state.md → phase, iteration, current step, transition history, and how often each phase was entered. */
export function parseState(text) {
  const g = (re) => (text.match(re) || [])[1]?.trim() || "";
  const hist = [];
  const block = (text.split(/^## Transition History:\s*$/m)[1] || "").split("<!--")[0];
  for (const line of block.split("\n")) {
    if (/^- /.test(line)) hist.push({ text: line.slice(2), sub: [] });
    else if (/^\s+- /.test(line) && hist.length) hist.at(-1).sub.push(line.trim().slice(2));
  }
  const visits = Object.fromEntries(PHASES.map((p) => [p, 0]));
  for (const h of hist) { const m = h.text.match(/→\s*(EXPLORE|PLAN|EXECUTE|REFLECT|PIVOT|CLOSE)\b/); if (m) visits[m[1]]++; }
  const last = g(/^## Last Transition:\s*(.+)$/m);
  const lastTs = Date.parse((last.match(ISO_RE) || [])[0] || "") || 0;
  const lastDetail = ((last.match(/\((.*)\)\s*$/) || [])[1] || "").replace(ISO_RE, "").replace(/[,;\s]+$/, "").trim();
  return { phase: g(/^# Current State:\s*(\S+)/m), iteration: g(/^## Iteration:\s*(.+)$/m), step: g(/^## Current Plan Step:\s*(.+)$/m), hist, visits, lastTs, lastDetail };
}

/** plan.md → title, goal, and the numbered steps with their [RISK]/[IRREVERSIBLE]/← CURRENT annotations. */
export function parsePlan(text) {
  const title = (text.match(/^# (.+)$/m) || [])[1] || "";
  const goal = section(text, "Goal").trim();
  const steps = [];
  for (const line of section(text, "Steps").split("\n")) {
    const m = line.match(/^(\d+(?:\.\d+)*)\.\s+\[( |x|X)\]\s+(.*)$/);
    if (!m) continue;
    const rest = m[3];
    const plain = rest.replace(/\s*\[(?:RISK|deps|IRREVERSIBLE)[^\]]*\]/gi, "").replace(/\s*←\s*CURRENT\b/, "").replace(/\s*—\s*DONE\b.*$/, "");
    steps.push({
      key: m[1], done: m[2] !== " ", source: "plan",
      title: (rest.match(/\*\*(.+?)\*\*/) || [])[1] || clipCode(plain, 120),
      commit: (rest.match(/DONE\s+([0-9a-f]{7,})/) || [])[1] || "",
      risk: (rest.match(/\[RISK:\s*(\w+)/i) || [])[1] || "",
      irreversible: /\[IRREVERSIBLE\]/.test(rest),
      current: /←\s*CURRENT\b/.test(rest),
    });
  }
  return { title, goal, steps };
}

export function parseProgress(text) {
  const items = (h) => section(text, h).split("\n").filter((l) => /^- /.test(l)).map((l) => l.replace(/^- (\[[ xX]\] )?/, ""));
  return { inProgress: items("In Progress"), blocked: items("Blocked"), flags: items("Hand-off flags") };
}

const DECISION_HEAD_RE = new RegExp(`^#{2,3} (D-${DECISION_ID_NUM_PATTERN}) \\| (.+?) \\| (.+)$`, "m");
/** decisions.md → entries, newest first. HTML comments (the schema example) are blanked first; a repeated id keeps its last entry. */
export function parseDecisions(text) {
  text = stripHtmlComments(text);
  const byId = new Map();
  for (const p of text.split(new RegExp(`^(?=#{2,3} D-${DECISION_ID_NUM_PATTERN} \\|)`, "m")).slice(1)) {
    const head = p.match(DECISION_HEAD_RE);
    if (!head) continue;
    const field = (name) => ((p.match(new RegExp(`\\*\\*${name}\\*\\*:\\s*([\\s\\S]*?)(?=\\n\\*\\*[A-Z][\\w -]+\\*\\*:|\\n#{2,3} |$)`)) || [])[1] || "").trim();
    byId.set(head[1], { id: head[1], phase: head[2], date: head[3].trim(), decision: field("Decision"), context: field("Context"), tradeoff: field("Trade-off"), reasoning: field("Reasoning"), body: p });
  }
  return [...byId.values()].sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)));
}

/** changelog.md → one entry per data line, split by the shared 8-field splitter (the reason may contain " | "). */
export function parseChangelog(text) {
  return text.split("\n").filter((l) => /^\d{4}-\d\d-\d\dT/.test(l)).map((l) => {
    const [utc, step, commit, file, op, radius, dref, why] = splitChangelogFields(l);
    return { utc, step: step || "", commit, file, op, radius, dref, why: why || "" };
  });
}

export function parseVerification(text) {
  const rows = [];
  for (const line of section(text, "Criteria Verification").split("\n")) {
    if (!/^\|\s*\d+\s*\|/.test(line)) continue;
    const c = line.split(/\s\|\s/).map((s) => s.replace(/^\|\s*|\s*\|$/g, "").trim());
    rows.push({ n: c[0], criterion: c[1], result: c[4] || "", evidence: c[5] || "" });
  }
  return rows;
}

export function parseSummary(text) {
  return {
    title: ((text.match(/^# (.+)$/m) || [])[1] || "").replace(/^Summary:\s*/, ""),
    bottomLine: oneLine((text.match(/\*\*Bottom line\*\*:\s*([\s\S]*?)(?=\n\s*\n|\n#)/) || [])[1]),
    outcome: section(text, "Outcome").trim(),
  };
}

/** "Phase 2 — Regroup (web)" → { kicker: "Phase 2", title: "Regroup", note: "web" }. Labels without that shape pass through. */
export const splitLabel = (label) => {
  const m = label.match(/^(Phase \d+[A-Za-z]?)\s*[—–:-]\s*(.+)$/);
  let title = m ? m[2] : label, note = "";
  const n = title.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  if (n && n[1].length > 8) { title = n[1]; note = n[2]; }
  return { kicker: m ? m[1] : "", title, note };
};

// ---------- token usage ----------
const ROLE = { orchestrator: "Orchestrator", "ip-executor": "Executor", "ip-explorer": "Explorer", "ip-reviewer": "Reviewer", "ip-verifier": "Verifier", "ip-boyscout": "Hygiene sweep", "ip-archivist": "Archivist", "ip-plan-writer": "Plan writer", fork: "Fork" };
export const roleName = (type) => ROLE[type] || String(type).replace(/^ip-/, "").replace(/^./, (c) => c.toUpperCase());
/** "claude-opus-4-1-20250805" → "Opus 4.1". */
export const modelName = (id) => {
  const m = String(id).replace(/^claude-/, "").replace(/-\d{8}$/, "").split("-");
  const fam = m.filter((x) => /^[a-z]/i.test(x)).map((x) => x[0].toUpperCase() + x.slice(1)).join(" ");
  const ver = m.filter((x) => /^\d+$/.test(x)).join(".");
  return `${fam}${ver ? " " + ver : ""}`;
};
/** Step keys an executor run names in its task description: "Execute step 6", "fixes 6.1 + 10.6". */
export const stepsOf = (desc) => {
  const m = String(desc).match(/\b(?:steps?|fix(?:es)?)\s+(\d+(?:\.\d+)*(?:\s*(?:\+|,|&|and)\s*\d+(?:\.\d+)*)*)/i);
  return m ? m[1].split(/\s*(?:\+|,|&|and)\s*/).filter(Boolean) : [];
};
/** Claude Code's per-project log directory name: every non-alphanumeric character of the path becomes "-". */
export const projectSlug = (root) => root.replace(/[^a-zA-Z0-9]/g, "-");

/** Fold one log line into a file's cache entry. Records are [ts, model, input, output, cacheRead, cacheWrite]. */
export function ingestLine(c, line) {
  if (!c.planner && line.includes('"skill":"iterative-planner"')) c.planner = true;
  if (!line.includes('"type":"assistant"') || !line.includes('"usage"')) return false;
  let l; try { l = JSON.parse(line); } catch { return false; }
  const model = l.message?.model, u = l.message?.usage;
  if (l.type !== "assistant" || !u || !model || model === "<synthetic>") return false;
  const ts = Date.parse(l.timestamp) || 0;
  const id = l.message.id || l.requestId || l.uuid;
  const rec = [ts, model, u.input_tokens || 0, u.output_tokens || 0, u.cache_read_input_tokens || 0, u.cache_creation_input_tokens || 0];
  const prev = c.msgs[id];
  c.msgs[id] = prev ? [prev[0], model, Math.max(prev[2], rec[2]), Math.max(prev[3], rec[3]), Math.max(prev[4], rec[4]), Math.max(prev[5], rec[5])] : rec;
  if (!c.first || ts < c.first) c.first = ts;
  if (ts > c.last) c.last = ts;
  return true;
}

/** List session logs for these roots. Returns [{file, kind: main|sub, sid, metaFile?}]. */
export function transcriptFiles(projectsDir, roots) {
  const out = [];
  if (!projectsDir) return out;
  for (const r of roots) {
    const dir = path.join(projectsDir, projectSlug(r));
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.isFile() && e.name.endsWith(".jsonl")) out.push({ file: path.join(dir, e.name), kind: "main", sid: e.name.slice(0, -6) });
      else if (e.isDirectory()) {
        const sub = path.join(dir, e.name, "subagents");
        let subs = [];
        try { subs = fs.readdirSync(sub); } catch { continue; }
        for (const f of subs) if (f.endsWith(".jsonl")) out.push({ file: path.join(sub, f), kind: "sub", sid: e.name, metaFile: path.join(sub, f.replace(/\.jsonl$/, ".meta.json")) });
      }
    }
  }
  return out;
}

/** Read the bytes appended to a log since the last scan. Never consumes a half-written last line. Returns true if anything was read. */
export function scanFile(cache, t) {
  let size; try { size = fs.statSync(t.file).size; } catch { return false; }
  let c = cache.files[t.file];
  if (c && size < c.offset) c = null; // rewritten or truncated → rescan from the start
  let grew = false;
  if (!c) {
    c = cache.files[t.file] = { kind: t.kind, sid: t.sid, agent: t.kind === "sub" ? path.basename(t.file, ".jsonl").replace(/^agent-/, "") : "", offset: 0, planner: false, first: 0, last: 0, msgs: {} };
    grew = true;
  }
  if (t.kind === "sub" && !c.meta) {
    try { const m = JSON.parse(read(t.metaFile)); c.meta = { type: m.agentType || "agent", desc: m.description || "" }; }
    catch { c.meta = { type: "agent", desc: "" }; }
  }
  if (size > c.offset) {
    const fd = fs.openSync(t.file, "r");
    try {
      const buf = Buffer.alloc(size - c.offset);
      fs.readSync(fd, buf, 0, buf.length, c.offset);
      const lastNl = buf.lastIndexOf(10);
      if (lastNl >= 0) {
        for (const line of buf.toString("utf8", 0, lastNl).split("\n")) if (line) ingestLine(c, line);
        c.offset += lastNl + 1;
        grew = true;
      }
    } finally { fs.closeSync(fd); }
  }
  return grew;
}

/** Group cached log files into sessions; a session is a planner session if any of its files shows the skill or an ip-* agent. */
export function sessionsOf(cache, files) {
  const sessions = new Map();
  for (const t of files) {
    const c = cache.files[t.file];
    if (!c) continue;
    const s = sessions.get(t.sid) || { sid: t.sid, planner: false, main: null, subs: [] };
    if (t.kind === "main") s.main = c; else s.subs.push(c);
    if (c.planner || /^ip-/.test(c.meta?.type || "")) s.planner = true;
    sessions.set(t.sid, s);
  }
  return [...sessions.values()];
}

export const newAgg = () => ({ inp: 0, out: 0, cr: 0, cw: 0, msgs: 0, byRole: {}, byModel: {}, byHour: {}, bySteps: {}, runs: [], sessions: new Set(), first: 0, last: 0 });
const tokOf = (r) => r[2] + r[3] + r[4] + r[5];
export const total = (a) => (a ? a.inp + a.out + a.cr + a.cw : 0);
function addMsg(a, r, role) {
  const tok = tokOf(r);
  a.inp += r[2]; a.out += r[3]; a.cr += r[4]; a.cw += r[5]; a.msgs++;
  const ro = (a.byRole[role] ||= { tok: 0, out: 0, runs: 0, msgs: 0 }); ro.tok += tok; ro.out += r[3]; ro.msgs++;
  const mo = (a.byModel[r[1]] ||= { tok: 0, out: 0, msgs: 0 }); mo.tok += tok; mo.out += r[3]; mo.msgs++;
  const h = Math.floor(r[0] / 3.6e6) * 3.6e6; a.byHour[h] = (a.byHour[h] || 0) + tok;
  if (!a.first || r[0] < a.first) a.first = r[0];
  if (r[0] > a.last) a.last = r[0];
}
function mergeAgg(into, a) {
  for (const k of ["inp", "out", "cr", "cw", "msgs"]) into[k] += a[k];
  for (const [r, v] of Object.entries(a.byRole)) { const x = (into.byRole[r] ||= { tok: 0, out: 0, runs: 0, msgs: 0 }); for (const k in v) x[k] += v[k]; }
  for (const [m, v] of Object.entries(a.byModel)) { const x = (into.byModel[m] ||= { tok: 0, out: 0, msgs: 0 }); for (const k in v) x[k] += v[k]; }
  for (const [h, v] of Object.entries(a.byHour)) into.byHour[h] = (into.byHour[h] || 0) + v;
  into.runs.push(...a.runs);
  for (const s of a.sessions) into.sessions.add(s);
}

/**
 * Split usage across plans. `windows` = [{name, start, end}] sorted by start.
 * Returns { byPlan: Map(name → agg), between: agg (planner usage outside every window), outside: agg (non-planner sessions) }.
 */
export function attribute(sessions, windows) {
  const find = (ts) => { let w = null; for (const x of windows) { if (x.start <= ts) w = x; else break; } return w && ts <= w.end ? w.name : null; };
  const byPlan = new Map(), between = newAgg(), outside = newAgg();
  const agg = (name) => (name ? (byPlan.get(name) || byPlan.set(name, newAgg()).get(name)) : between);
  const seen = new Set(); // every message counted once; main-session copies first, since they carry the full output
  for (const s of sessions) if (s.main) for (const id of Object.keys(s.main.msgs)) seen.add(id);
  for (const s of sessions) {
    if (s.main) for (const r of Object.values(s.main.msgs)) {
      const a = s.planner ? agg(find(r[0])) : outside;
      addMsg(a, r, "orchestrator"); a.sessions.add(s.sid);
    }
    for (const c of s.subs) {
      const recs = Object.entries(c.msgs).filter(([id]) => !seen.has(id) && seen.add(id)).map(([, r]) => r);
      if (!recs.length) continue;
      const a = s.planner ? agg(find(c.first)) : outside;
      const role = c.meta?.type || "agent";
      const run = { id: c.agent, role, desc: c.meta?.desc || "", models: {}, tok: 0, out: 0, first: c.first, last: c.last, lastCall: 0, steps: role === "ip-executor" ? stepsOf(c.meta?.desc) : [] };
      let lastTs = -1;
      for (const r of recs) {
        addMsg(a, r, role); run.tok += tokOf(r); run.out += r[3]; run.models[r[1]] = (run.models[r[1]] || 0) + 1;
        if (r[0] >= lastTs) { lastTs = r[0]; run.lastCall = tokOf(r); }
      }
      a.byRole[role].runs++;
      a.runs.push(run);
      for (const k of run.steps) { const st = (a.bySteps[k] ||= { tok: 0, runs: 0 }); st.tok += run.tok / run.steps.length; st.runs++; }
      a.sessions.add(s.sid);
    }
  }
  for (const a of [...byPlan.values(), between, outside]) a.runs.sort((x, y) => y.first - x.first);
  return { byPlan, between, outside };
}

/** Bucket hourly totals so a chart never has more than 96 columns; empty buckets stay, so gaps in activity read as gaps. */
export function timeSeries(byHour) {
  const hours = Object.entries(byHour).map(([h, v]) => [Number(h), v]).sort((x, y) => x[0] - y[0]);
  if (!hours.length) return { series: [], size: 1 };
  const span = hours.at(-1)[0] - hours[0][0];
  const size = [1, 2, 3, 6, 12, 24].find((h) => span / (h * 3.6e6) < 96) || 24;
  const B = size * 3.6e6, sums = new Map();
  for (const [h, v] of hours) { const k = Math.floor(h / B) * B; sums.set(k, (sums.get(k) || 0) + v); }
  const series = [];
  for (let k = Math.floor(hours[0][0] / B) * B; k <= hours.at(-1)[0]; k += B) series.push([k, sums.get(k) || 0]);
  return { series, size };
}

// ---------- discovery ----------
function listFiles(dir, depth = 2) {
  const out = [];
  const walk = (d, lvl) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (lvl < depth) walk(p, lvl + 1); continue; }
      let st; try { st = fs.statSync(p); } catch { continue; }
      out.push({ path: p, rel: path.relative(dir, p), ms: st.mtimeMs, size: st.size });
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => b.ms - a.ms);
}

/** A plans/.current_plan pointer is trusted only when it names a plan id (either grammar) that exists — same rule as bootstrap. */
export function readPointer(plansDir) {
  try {
    const name = fs.readFileSync(path.join(plansDir, ".current_plan"), "utf8").trim();
    return name && ANY_PLAN_ID_RE.test(name) && fs.existsSync(path.join(plansDir, name)) ? name : null;
  } catch { return null; }
}

/** Plan directories and cross-plan ledgers across the given roots, plus closed plans known only from INDEX.md / ledger sections. */
export function discover(roots) {
  const dirs = new Map(), ledgers = new Map(), pointers = new Set();
  for (const root of roots) {
    const pdir = path.join(root, "plans");
    let names = [];
    try { names = fs.readdirSync(pdir); } catch { continue; }
    const ptr = readPointer(pdir);
    if (ptr) pointers.add(ptr);
    for (const n of names) {
      const p = path.join(pdir, n);
      if (/^[A-Z]+\.md$/.test(n)) { const ms = mtime(p); if (!ledgers.has(n) || ledgers.get(n).ms < ms) ledgers.set(n, { file: n, path: p, ms }); continue; }
      if (!ANY_PLAN_ID_RE.test(n) || !fs.existsSync(path.join(p, "state.md"))) continue;
      const active = listFiles(p)[0]?.ms || 0;
      // A plan copied into several worktrees shows up more than once — keep the freshest copy.
      if (!dirs.has(n) || dirs.get(n).active < active) dirs.set(n, { name: n, dir: p, root, active });
    }
  }
  const live = [...dirs.values()].sort((a, b) => b.active - a.active);
  const index = new Map();
  for (const line of read(ledgers.get("INDEX.md")?.path).split("\n")) {
    const c = line.split("|").map((s) => s.trim());
    if (ANY_PLAN_ID_RE.test(c[1] || "")) index.set(c[1], { date: c[2], goal: c[3], topics: c[4] });
  }
  const sectionNames = new Set();
  for (const f of ["FINDINGS.md", "DECISIONS.md"]) for (const m of read(ledgers.get(f)?.path).matchAll(/^## (plan[-_]\S+)\s*$/gm)) if (ANY_PLAN_ID_RE.test(m[1])) sectionNames.add(m[1]);
  const archived = [...new Set([...index.keys(), ...sectionNames])].filter((n) => !dirs.has(n))
    .map((n) => ({ name: n, index: index.get(n), start: planStart(n) }));
  return { live, archived, ledgers: [...ledgers.values()], pointers };
}

// ---------- the site ----------
const LEDGER_ORDER = ["SYSTEM.md", "LESSONS.md", "FINDINGS.md", "DECISIONS.md", "ANCHORS.md", "INDEX.md"];
const LEDGER_TITLES = { "SYSTEM.md": "System atlas", "LESSONS.md": "Lessons", "FINDINGS.md": "All findings", "DECISIONS.md": "All decisions", "ANCHORS.md": "Decision anchors", "INDEX.md": "Plan index" };
const PHASE_LABEL = { EXPLORE: "Explore", PLAN: "Plan", EXECUTE: "Execute", REFLECT: "Reflect", PIVOT: "Pivot", CLOSE: "Closed" };
const PHASE_VERB = { EXPLORE: "Exploring", PLAN: "Planning", EXECUTE: "Executing", REFLECT: "Reflecting", PIVOT: "Pivoting", CLOSE: "Closed" };
const cap = (p) => (p ? p[0] + p.slice(1).toLowerCase() : "");
const LIVE_WINDOW = 30 * 60 * 1000;

// The temp folder name carries the user id where there is one (POSIX), so each user gets their own;
// Windows has none, and its %TEMP% is already per-user.
export function defaultOut(repo) {
  const owner = typeof process.getuid === "function" ? `-${process.getuid()}` : "";
  return path.join(os.tmpdir(), `iterative-planner-dashboard${owner}`, `${path.basename(repo)}-${sha(repo).slice(0, 8)}`, "dashboard.html");
}
// The one rule for --out, used by parseArgs (exit 2) and createDashboard (throws). The site folder is
// the entry path minus its suffix, so --out must name a .html or .htm file (any case) with a name
// before the suffix; anything else made the entry and the site folder the same path (EISDIR). That name
// cannot be only dots or spaces: "." and ".." make the site folder the current folder or its parent, and
// Windows strips trailing dots and spaces, so there "...", ". " and the like can do the same. A site
// folder that already exists must be one a dashboard run wrote (it holds assets/live.js, the last file a
// run writes), or --out docs.html would replace a project's own docs/index.html.
// Takes the raw value; returns an error message naming it, or null. Never throws, never writes.
// DECISION plan-2026-10-06T182322-ea385857/D-003: reject a bad --out, never normalise it (no appended
// .html, no folder-means-folder/dashboard.html): a guess surprises, and a rejection can be relaxed later.
export function validateOut(raw) {
  const want = `--out must be a .html or .htm file path, such as out/dashboard.html (got "${raw}"`;
  if (/[\\/]$/.test(raw)) return `${want}, which ends in a folder separator)`;
  if (!/[^\\/]\.html?$/i.test(raw)) return `${want})`;
  if (/(^|[\\/])[. ]+\.html?$/i.test(raw)) return `${want}, whose name before the suffix is only dots or spaces)`;
  try { if (fs.statSync(raw).isDirectory()) return `${want}, which is an existing folder)`; } catch { /* a missing path is fine */ }
  const site = path.resolve(raw).replace(/\.html?$/i, ""); // as createDashboard derives it: "a/../docs.html" is docs
  let st = null; try { st = fs.statSync(site); } catch { /* no site folder yet */ }
  if (st && !st.isDirectory()) return `${want}, whose site folder "${site}" is an existing file)`;
  if (st && !fs.existsSync(path.join(site, "assets", "live.js"))) return `${want}, whose site folder "${site}" already exists and was not written by the dashboard; remove it or pick another name)`;
  return null;
}
export function defaultProjectsDir() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
}

/**
 * Create a dashboard writer. Options: repo (default cwd), out (entry .html or .htm), projectsDir (null disables usage),
 * pinned (plan id to treat as live), now (clock, for tests), worktrees (default true).
 * Returns { generate(): boolean changed, flush(), entry, site }.
 */
export function createDashboard(opts = {}) {
  const bad = opts.out ? validateOut(opts.out) : null;
  if (bad) throw Object.assign(new Error(bad), { code: "EDASHBOARD" });
  const repo = path.resolve(opts.repo || process.cwd());
  const entry = path.resolve(opts.out || defaultOut(repo));
  const base = path.dirname(entry);
  const site = entry.replace(/\.html?$/i, "");
  // With no --out, the folder defaultOut names (two levels above the entry) must stay private to this user.
  const privateRoot = opts.out ? null : path.dirname(path.dirname(entry));
  const now = opts.now || Date.now;
  const projectsDir = opts.projectsDir === undefined ? defaultProjectsDir() : opts.projectsDir;
  const watch = !!opts.watch;
  const OUT = {
    all: path.join(site, "index.html"),
    plan: (name) => path.join(site, "p", `${name}.html`),
    doc: (name, rel) => path.join(site, "p", name, rel.replace(/\.md$/, ".html")),
    archived: (name) => path.join(site, "archived", `${name}.html`),
    ledger: (file) => path.join(site, "ledger", file.replace(/\.md$/, ".html")),
    asset: (name) => path.join(site, "assets", name),
  };
  const href = (from, to) => path.relative(path.dirname(from), to).split(path.sep).join("/") || ".";
  const keyOf = (file) => path.relative(base, file).split(path.sep).join("/");
  const ctx = { repo, entry, base, OUT, href, now, sitemap: { plans: [], ledgers: [], activeName: "" } };

  // Lookups that spawn processes but rarely change: valid for `ttl` ms while `stamp` is unchanged.
  const MEMO = new Map();
  const cached = (key, ttl, stampVal, fn) => {
    const c = MEMO.get(key);
    if (c && c.stamp === stampVal && now() - c.at < ttl) return c.val;
    const val = fn(); MEMO.set(key, { at: now(), stamp: stampVal, val }); return val;
  };
  const roots = () => cached("roots", 60e3, "", () => {
    const out = new Set([repo]);
    if (opts.worktrees !== false) for (const line of git(repo, "worktree", "list", "--porcelain").split("\n")) if (line.startsWith("worktree ")) out.add(path.resolve(line.slice(9).trim()));
    return [...out];
  });
  // The worktree's HEAD reflog changes on every commit or checkout there — a free "did git move?" signal.
  const headStamp = (root) => {
    const dir = cached(`gitdir|${root}`, Infinity, "", () => git(root, "rev-parse", "--absolute-git-dir").trim());
    return dir ? String(mtime(path.join(dir, "logs", "HEAD"))) : "";
  };
  function gitInfo(root, planId, live) {
    const hash = (planId.match(/([0-9a-f]{8})$/) || [])[1] || "";
    // Closed plans: commits do not move, re-check every 5 min. Live plan: when HEAD moves (2 min backstop).
    const planCommits = cached(`log|${root}|${hash}`, live ? 120e3 : 300e3, live ? headStamp(root) : "", () => !hash ? [] :
      git(root, "log", "--all", "-F", `--grep=${hash}/iter-`, "--format=%h%x09%cI%x09%s").split("\n").filter(Boolean).map((l) => {
        const [h, iso, subject] = l.split("\t");
        const tag = subject.match(/^\[plan-[^\]]*?-([0-9a-f]{8})\/iter-(\d+)\/step-([\d.]+)\]\s*(.*)$/);
        return { hash: h, ms: Date.parse(iso), plan: tag?.[1], iter: tag?.[2], step: tag?.[3], title: tag?.[4] || subject };
      }).filter((c) => c.plan === hash));
    if (!live) return { branch: "", planCommits, dirty: [] };
    const lines = git(root, "status", "--porcelain", "-b").split("\n").filter(Boolean); // one process: branch + changes
    const branch = (lines[0] || "").startsWith("## ") ? lines.shift().slice(3).split("...")[0].replace(/^No commits yet on /, "") : "";
    const dirty = lines.map((l) => ({ code: l.slice(0, 2).trim(), file: l.slice(3) }))
      .filter((d) => !d.file.startsWith("plans/"))
      .map((d) => ({ ...d, ms: mtime(path.join(root, d.file)) }))
      .sort((a, b) => b.ms - a.ms);
    return { branch, planCommits, dirty };
  }

  function build(pick, isActive) {
    const f = (n) => read(path.join(pick.dir, n));
    const state = parseState(f("state.md"));
    const plan = parsePlan(f("plan.md"));
    const summary = parseSummary(f("summary.md"));
    const files = listFiles(pick.dir);
    const latestFile = files[0]?.ms || 0;
    const live = isActive && (state.phase !== "CLOSE" || now() - latestFile < LIVE_WINDOW);
    const g = gitInfo(pick.root, pick.name, live);
    const decisions = parseDecisions(f("decisions.md"));
    const changelog = parseChangelog(f("changelog.md"));
    // Steps: plan.md's list + completion-fix sub-steps (N.K) seen in commits, decisions or the changelog.
    const iter = (state.iteration.match(/\d+/) || ["1"])[0];
    const steps = new Map(plan.steps.map((s) => [s.key, { ...s }]));
    for (const c of g.planCommits) {
      if (c.iter !== iter) continue;
      const s = steps.get(c.step) || { key: c.step, title: c.title, source: "fix" };
      s.done = true; s.commit ||= c.hash;
      steps.set(c.step, s);
    }
    for (const d of [...decisions].reverse()) {
      for (const m of d.body.matchAll(new RegExp(`iter-${iter}/step-(\\d+(?:\\.\\d+)*)\`?:?\\s*([^\\n]*)`, "g"))) {
        if (steps.has(m[1]) || !m[1].includes(".")) continue;
        const desc = m[2].replace(/^[.,;)]+\s*/, "").split(/(?<=[a-z)])\.\s/)[0].replace(/\*\*/g, "");
        steps.set(m[1], { key: m[1], title: clip(desc || `Completion fix (${d.id})`, 110), source: "fix", from: d.id, done: false });
      }
    }
    for (const c of changelog) {
      // A changelog line means the edit happened, even for bookkeeping-only steps with no commit.
      const k = (c.step.match(new RegExp(`iter-${iter}/step-(\\d+(?:\\.\\d+)*)`)) || [])[1];
      if (!k) continue;
      const s = steps.get(k);
      if (!s) steps.set(k, { key: k, title: c.why, source: "fix", done: true, commit: /^[0-9a-f]{7}/.test(c.commit) ? c.commit : "" });
      else if (s.source === "fix") s.done = true;
    }
    return {
      pick, live, state, plan, summary, files, g, decisions, changelog,
      label: summary.title || plan.title.replace(/^Plan v\d+:\s*/, "") || pick.name,
      started: planStart(pick.name),
      latestMs: Math.max(latestFile, g.dirty[0]?.ms || 0, g.planCommits[0]?.ms || 0),
      closed: state.phase === "CLOSE" ? (state.lastTs || latestFile) : 0,
      progress: parseProgress(f("progress.md")),
      verification: parseVerification(f("verification.md")),
      stepList: [...steps.values()].sort((a, b) => cmpStep(a.key, b.key)),
      stateMs: mtime(path.join(pick.dir, "state.md")),
    };
  }

  // ---- writing: unchanged output is neither re-read nor rewritten; unchanged documents are not re-rendered
  const VERSIONS = {}, LAST = new Map(), RENDERED = new Map();
  // Throws EDASHBOARD unless the private root is a folder owned by this user and closed to others. It runs at
  // the top of generate(), before anything under the root is read (a FIFO planted there would hang the read),
  // and again before every write (a temp cleaner can delete the root during --watch and someone else re-create it).
  const checkRoot = () => {
    if (!privateRoot) return;
    try { fs.mkdirSync(privateRoot, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
    const st = fs.lstatSync(privateRoot), uid = typeof process.getuid === "function" ? process.getuid() : null;
    // DECISION plan-2026-10-06T182322-ea385857/D-002: refuse a loose or foreign folder, never chmod it.
    // chmod follows symlinks, and a folder that was ever open to others may already hold planted entries.
    const why = st.isSymbolicLink() ? "it is a symlink"
      : !st.isDirectory() ? "it is not a folder"
      : uid !== null && st.uid !== uid ? `it belongs to another user (uid ${st.uid})`
      : uid !== null && (st.mode & 0o077) !== 0 ? `other users have access to it (mode ${(st.mode & 0o777).toString(8)})`
      : "";
    if (why) throw Object.assign(new Error(`refusing to use ${privateRoot}: ${why}. Remove it, or pass --out <file.html> to write somewhere else`), { code: "EDASHBOARD" });
  };
  // The only writer. Every write, --out included, goes to a per-process temp name opened exclusively, so a
  // symlink planted there is never followed.
  const writeAtomic = (file, text) => {
    checkRoot();
    fs.mkdirSync(path.dirname(file), privateRoot ? { recursive: true, mode: 0o700 } : { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`, wopts = privateRoot ? { flag: "wx", mode: 0o600 } : { flag: "wx" };
    try { fs.writeFileSync(tmp, text, wopts); } catch (e) {
      if (e.code !== "EEXIST") throw e;
      fs.unlinkSync(tmp); // left by a crashed run whose pid was reused, or planted: never written through
      fs.writeFileSync(tmp, text, wopts);
    }
    try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* already gone */ } throw e; }
  };
  function put(file, html) {
    // Usage figures move on every model call; they sit in <!--v--> fences so pages can reload for them at a slower pace.
    const hash = sha(html), shash = sha(html.replace(/<!--v-->[\s\S]*?<!--\/v-->/g, ""));
    VERSIONS[keyOf(file)] = [hash, shash];
    if (LAST.get(file) === hash) return;
    html = html.replace("__PD_HASH__", hash).replace("__PD_SHASH__", shash);
    if (LAST.has(file) || read(file) !== html) writeAtomic(file, html);
    LAST.set(file, hash);
  }
  function putRaw(file, text) {
    const hash = sha(text);
    if (LAST.get(file) === hash) return;
    if (LAST.has(file) || read(file) !== text) writeAtomic(file, text);
    LAST.set(file, hash);
  }
  function putMemo(file, sig, render) {
    const r = RENDERED.get(file);
    if (r && r.sig === sig) { VERSIONS[keyOf(file)] = r.v; return; }
    put(file, render());
    RENDERED.set(file, { sig, v: VERSIONS[keyOf(file)] });
  }

  // ---- usage cache: only saves re-reading the logs on the next start, so in watch mode it is written at most once a minute
  const CACHE_FILE = OUT.asset("usage-cache.json");
  let usageCache = null, cacheDirty = false, lastPersist = 0, lastSig = "";
  function persistCache() {
    if (!cacheDirty || !usageCache) return;
    writeAtomic(CACHE_FILE, JSON.stringify(usageCache));
    cacheDirty = false; lastPersist = now();
  }
  function collectSessions(rootList) {
    if (!projectsDir) return [];
    if (!usageCache) { try { const j = JSON.parse(read(CACHE_FILE)); if (j.v === 3) usageCache = j; } catch { /* rebuilt below */ } }
    usageCache ||= { v: 3, files: {} };
    const files = transcriptFiles(projectsDir, rootList);
    for (const tf of files) if (scanFile(usageCache, tf)) cacheDirty = true;
    if (cacheDirty && now() - lastPersist > (watch ? 60e3 : 0)) persistCache();
    return sessionsOf(usageCache, files);
  }

  function generate() {
    checkRoot();
    const rootList = roots();
    const { live, archived, ledgers, pointers } = discover(rootList);
    const pinned = opts.pinned && live.find((p) => p.name === opts.pinned);
    // The live plan: a pinned id, else a plan some worktree's pointer names (freshest first), else the most recent activity.
    const active = pinned || live.find((p) => pointers.has(p.name)) || live[0];
    const models = live.map((p) => build(p, p === active));

    // A plan owns [start, close]; an unclosed older plan runs until the next one starts.
    const windows = [
      ...models.map((m) => ({ name: m.pick.name, start: m.started, end: m.closed || (m.live ? Infinity : 0) })),
      ...archived.map((p) => ({ name: p.name, start: p.start, end: 0 })),
    ].sort((a, b) => a.start - b.start);
    windows.forEach((w, i) => { if (!w.end) w.end = windows[i + 1] ? windows[i + 1].start - 1 : Infinity; });
    const att = attribute(collectSessions(rootList), windows);
    for (const m of models) m.usage = att.byPlan.get(m.pick.name) || newAgg();
    for (const p of archived) p.usage = att.byPlan.get(p.name) || newAgg();
    ctx.usageEnabled = !!projectsDir;

    ctx.sitemap = {
      activeName: active?.name || "",
      ledgers: LEDGER_ORDER.map((f) => ledgers.find((l) => l.file === f)).filter(Boolean),
      plans: [
        ...models.map((m) => { const L = splitLabel(m.label); return { name: m.pick.name, ms: m.started, out: OUT.plan(m.pick.name), short: `${L.kicker ? L.kicker + " — " : ""}${clip(L.title, 44)}` }; }),
        ...archived.map((p) => ({ name: p.name, ms: p.start, out: OUT.archived(p.name), short: `${planDateFromId(p.name) || ""} — ${clip(archivedLabel(p), 44)}` })),
      ].sort((a, b) => b.ms - a.ms),
    };

    const search = [];
    const add = (file, title, sub, kind) => search.push({ t: title, s: sub, k: kind, u: keyOf(file) });
    for (const m of models) {
      const L = splitLabel(m.label);
      add(OUT.plan(m.pick.name), `${L.kicker ? L.kicker + " — " : ""}${L.title}`, `${PHASE_LABEL[m.state.phase] || m.state.phase} · ${m.pick.name}`, "Plan");
      for (const f of m.files.filter((x) => x.rel.endsWith(".md"))) add(OUT.doc(m.pick.name, f.rel), f.rel.split(path.sep).join("/"), L.kicker || L.title, "Doc");
      for (const d of m.decisions) search.push({ t: `${d.id} — ${clip(flat(d.decision).replace(/\*\*|`/g, ""), 90)}`, s: L.kicker || L.title, k: "Decision", u: `${keyOf(OUT.doc(m.pick.name, "decisions.md"))}#${d.id}` });
    }
    for (const p of archived) add(OUT.archived(p.name), archivedLabel(p), `Archived · ${p.name}`, "Plan");
    for (const l of ctx.sitemap.ledgers) add(OUT.ledger(l.file), LEDGER_TITLES[l.file] || l.file, l.file, "Ledger");
    add(OUT.all, "All plans", "Overview", "Page");

    const siteSig = sha(JSON.stringify(ctx.sitemap));
    for (const m of models) {
      put(OUT.plan(m.pick.name), renderPlan(ctx, m, OUT.plan(m.pick.name)));
      const L = splitLabel(m.label);
      for (const f of m.files.filter((x) => x.rel.endsWith(".md"))) {
        const out = OUT.doc(m.pick.name, f.rel);
        putMemo(out, `${siteSig}|${f.ms}|${f.size}|${m.label}`, () => renderDoc(ctx, { here: out, current: m.pick.name, title: f.rel.split(path.sep).join("/"), crumbs: `<span>${esc(L.kicker || clip(L.title, 40))}</span><span class="dot-sep"></span><code>${esc(m.pick.name)}</code>`, src: read(f.path), ms: f.ms, source: path.relative(m.pick.root, f.path).split(path.sep).join("/"), back: { href: href(out, OUT.plan(m.pick.name)), label: L.kicker || "Plan" } }));
      }
    }
    const ledgerSig = ledgers.map((l) => l.ms).join(",");
    for (const p of archived) putMemo(OUT.archived(p.name), `${siteSig}|${ledgerSig}|${total(p.usage)}`, () => renderArchived(ctx, p, ledgers, OUT.archived(p.name)));
    for (const l of ctx.sitemap.ledgers) putMemo(OUT.ledger(l.file), `${siteSig}|${l.ms}`, () => renderDoc(ctx, { here: OUT.ledger(l.file), current: "", title: LEDGER_TITLES[l.file] || l.file, crumbs: `<span>Cross-plan ledger</span><span class="dot-sep"></span><code>${esc(l.file)}</code>`, src: read(l.path), ms: l.ms, source: `plans/${l.file}`, back: { href: href(OUT.ledger(l.file), OUT.all), label: "All plans" } }));
    put(OUT.all, renderAll(ctx, models, archived, att, OUT.all));
    const am = models.find((m) => m.pick === active);
    put(entry, am ? renderPlan(ctx, am, entry) : shell(ctx, { title: "Planner", here: entry, current: "", body: `<main id="main" class="wrap"><p class="empty">No plan directories under ${esc(path.join(repo, "plans"))} or its worktrees. Create one with bootstrap.mjs new.</p></main>` }));

    putRaw(OUT.asset("site.css"), CSS);
    putRaw(OUT.asset("site.js"), JS);
    putRaw(OUT.asset("search.js"), `window.__pdSearch=${JSON.stringify(search)};`);
    const aggOut = (a) => ({ inp: a.inp, out: a.out, cr: a.cr, cw: a.cw, msgs: a.msgs, byModel: a.byModel, byRole: a.byRole,
      runs: a.runs.map((r) => ({ id: r.id, role: r.role, desc: r.desc, tok: r.tok, out: r.out, lastCall: r.lastCall, first: r.first, last: r.last })) });
    putRaw(OUT.asset("data.json"), JSON.stringify({
      windows: windows.map((w) => ({ ...w, end: Number.isFinite(w.end) ? w.end : null })),
      plans: models.map((m) => ({ name: m.pick.name, label: m.label, phase: m.state.phase, live: m.live, started: m.started, closed: m.closed,
        steps: { done: m.stepList.filter((s) => s.done).length, total: m.stepList.length }, decisions: m.decisions.length, commits: m.g.planCommits.map((c) => c.hash),
        checks: { pass: m.verification.filter((v) => /PASS/i.test(v.result)).length, total: m.verification.length }, usage: aggOut(m.usage) })),
      archived: archived.map((p) => ({ name: p.name, usage: aggOut(p.usage) })),
      between: aggOut(att.between), outside: aggOut(att.outside),
    }, null, 1));
    // Heartbeat + per-page content hashes; open pages poll this and reload only when their own hash changes.
    writeAtomic(OUT.asset("live.js"), `window.__pd={gen:${now()},v:${JSON.stringify(VERSIONS)}};`);
    const sig = JSON.stringify(VERSIONS), changed = sig !== lastSig;
    lastSig = sig;
    return changed;
  }

  return { generate, flush: persistCache, entry, site };
}

// ---------- rendering ----------
const phasePill = (p, live) => `<span class="pill${live ? " is-live" : ""}"><i></i>${esc(PHASE_LABEL[p] || cap(p) || "?")}</span>`;
const tip = (s) => ` data-tip="${esc(s)}"`;
const vol = (s) => `<!--v-->${s}<!--/v-->`;
const archivedLabel = (p) => { const g = p.index?.goal; return g ? (g.length >= 58 ? g.replace(/\s+\S*$/, "") + "…" : g) : p.name; };
const sectionHead = (id, title, extra = "", link = "") => `<div class="sh" id="${id}"><h2>${title}</h2>${extra ? `<span class="sh-x">${extra}</span>` : ""}${link}</div>`;
const moreLink = (url, label) => `<a class="sh-more" href="${esc(url)}">${esc(label)}${I.arrow}</a>`;
// "D-001 | EXPLORE → PLAN | 2026-10-03" → "D-001 · Explore → Plan"
const tocLabel = (txt) => txt.replace(/\s*\|\s*\d{4}-\d\d-\d\d\s*$/, "").replace(/\s*\|\s*/g, " · ").replace(/\b(EXPLORE|PLAN|EXECUTE|REFLECT|PIVOT|CLOSE)\b/g, (p) => cap(p));

function topbar(ctx, here, current) {
  const { OUT, href, entry, sitemap } = ctx;
  const opts = sitemap.plans.map((p) => `<option value="${esc(href(here, p.out))}"${p.name === current ? " selected" : ""}>${esc(p.short)}${p.name === sitemap.activeName ? "  ● live" : ""}</option>`).join("");
  return `<header class="bar"><div class="bar-in">
    <a class="brand" href="${esc(href(here, entry))}" aria-label="Planner — live plan">${I.mark}<span>Planner</span></a>
    <label class="switch"><span class="vh">Switch plan</span><select onchange="if(this.value)location.href=this.value">${current ? "" : '<option value="" selected>Jump to a plan…</option>'}${opts}</select>${I.chev}</label>
    <nav class="bar-r" aria-label="Site">
      <a class="live-pill" id="live-pill" href="${esc(href(here, entry))}" title="Live updates"><i></i><span>Live</span></a>
      <a class="bar-link hide-sm${here === OUT.all ? " cur" : ""}" href="${esc(href(here, OUT.all))}">All plans</a>
      <button class="icon-btn" type="button" data-open-search aria-label="Search" title="Search">${I.search}</button>
      <details class="menu"><summary class="icon-btn" aria-label="More">${I.dots}</summary>
        <div class="menu-pop">
          <a href="${esc(href(here, OUT.all))}">All plans</a>
          <div class="menu-h">Cross-plan ledgers</div>
          ${sitemap.ledgers.map((l) => `<a href="${esc(href(here, OUT.ledger(l.file)))}">${esc(LEDGER_TITLES[l.file] || l.file)}</a>`).join("")}
          <div class="menu-h">Appearance</div>
          <div class="seg" role="group" aria-label="Theme"><button type="button" data-theme-set="auto">Auto</button><button type="button" data-theme-set="light">Light</button><button type="button" data-theme-set="dark">Dark</button></div>
          <div class="menu-h">Live updates</div>
          <div class="seg" role="group" aria-label="Live updates"><button type="button" data-live-set="on">On</button><button type="button" data-live-set="off">Paused</button></div>
        </div>
      </details>
    </nav>
  </div></header>`;
}

function shell(ctx, { title, here, current, body, live = false }) {
  const a = (n) => esc(ctx.href(here, ctx.OUT.asset(n)));
  const baseHref = ctx.href(here, path.join(ctx.base, "x")).replace(/x$/, "");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
<script>try{var t=localStorage.getItem('pd-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}</script>
<link rel="stylesheet" href="${a("site.css")}">
</head>
<body data-key="${esc(ctx.href(path.join(ctx.base, "x"), here))}" data-hash="__PD_HASH__" data-shash="__PD_SHASH__" data-base="${esc(baseHref)}" data-livejs="${a("live.js")}" data-live="${live ? 1 : 0}">
<a class="skip" href="#main">Skip to content</a>
${topbar(ctx, here, current)}
${body}
<div class="tip" id="tip" role="tooltip" hidden></div>
<div class="palette" id="palette" hidden><div class="pal-box" role="dialog" aria-label="Search">
  <div class="pal-in">${I.search}<input id="pal-q" type="search" placeholder="Search plans, documents, decisions…" autocomplete="off" spellcheck="false"></div>
  <ul id="pal-list" role="listbox"></ul>
</div></div>
<script src="${a("search.js")}" defer></script>
<script src="${a("site.js")}" defer></script>
</body></html>`;
}

function phaseRail(state, live) {
  const order = ["EXPLORE", "PLAN", "EXECUTE", "REFLECT", ...(state.visits.PIVOT ? ["PIVOT"] : []), "CLOSE"];
  const curIdx = order.indexOf(state.phase);
  return `<ol class="rail${live ? " is-live" : ""}" aria-label="Phases">${order.map((p, i) => {
    const n = state.visits[p] || (p === "EXPLORE" && curIdx >= 0 ? 1 : 0);
    const cls = p === state.phase ? "cur" : n || i < curIdx ? "done" : "todo";
    return `<li class="${cls}"${p === state.phase ? ' aria-current="step"' : ""}><span class="node"></span><span class="rl">${cap(p)}</span><span class="rc">${n > 1 ? `×${n}` : ""}</span></li>`;
  }).join("")}</ol>`;
}

const TOKEN_TYPES = [
  { key: "cr", label: "Cache reads", note: "context re-read from the prompt cache", cls: "s1" },
  { key: "fresh", label: "Fresh input", note: "uncached input + cache writes", cls: "s2" },
  { key: "out", label: "Output", note: "tokens the models wrote", cls: "s3" },
];
const typeVal = (a, k) => (k === "fresh" ? a.inp + a.cw : a[k]);

function usageBlock(ctx, a, { scope = "plan" } = {}) {
  const tot = total(a);
  if (!ctx.usageEnabled) return '<p class="empty">Usage is turned off (--no-usage).</p>';
  if (!tot) return `<p class="empty">No Claude Code session logs found for this ${scope === "plan" ? "plan" : "repo"}. Usage is read from <code>&lt;config&gt;/projects</code> (<code>$CLAUDE_CONFIG_DIR</code> or <code>~/.claude</code>).</p>`;
  const roles = Object.entries(a.byRole).sort((x, y) => y[1].tok - x[1].tok);
  const models = Object.entries(a.byModel).sort((x, y) => y[1].tok - x[1].tok);
  const maxRole = roles[0]?.[1].tok || 1;
  const { series, size } = timeSeries(a.byHour);
  const maxH = Math.max(...series.map((x) => x[1]), 1);
  const multiDay = series.length && series.at(-1)[0] - series[0][0] > 20 * 3.6e6;
  const fmtBucket = (h) => new Date(h).toLocaleString("en-GB", size >= 24 ? { day: "numeric", month: "short" } : { weekday: "short", hour: "2-digit", minute: "2-digit" }) + (size > 1 && size < 24 ? `–${new Date(h + size * 3.6e6).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}` : "");
  const fmtTick = (h) => new Date(h).toLocaleString("en-GB", size >= 24 ? { day: "numeric", month: "short" } : multiDay ? { weekday: "short", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" });
  const ticks = series.length > 2 ? [series[0][0], series[Math.floor((series.length - 1) / 2)][0], series.at(-1)[0]] : series.map((x) => x[0]);
  const per = size === 1 ? "per hour" : size === 24 ? "per day" : `per ${size} hours`;
  return `
  <div class="usage">
    <div class="u-hero">
      <div class="u-total"><span class="u-n">${fmtN(tot)}</span><span class="u-l">tokens · ${a.msgs.toLocaleString("en-GB")} model calls${a.runs.length ? ` · ${a.runs.length} agent runs` : ""}</span></div>
      <div class="u-models" aria-label="Models">${models.map(([m, v]) => `<span class="chip"${tip(`${modelName(m)}\n${fmtN(v.tok)} tokens · ${fmtN(v.out)} output\n${v.msgs.toLocaleString("en-GB")} calls · ${pctLabel(v.tok, tot)} of usage`)}>${esc(modelName(m))}<b>${esc(pctLabel(v.tok, tot))}</b></span>`).join("")}</div>
    </div>
    <div class="stack" role="img" aria-label="${esc(`Token mix: ${TOKEN_TYPES.map((ty) => `${ty.label} ${pctLabel(typeVal(a, ty.key), tot)}`).join(", ")}`)}">${TOKEN_TYPES.map((ty) => { const v = typeVal(a, ty.key); return v ? `<span class="mix ${ty.cls}" style="flex-grow:${v}"${tip(`${ty.label} — ${fmtN(v)} (${pctLabel(v, tot)})\n${ty.note}`)}></span>` : ""; }).join("")}</div>
    <ul class="legend">${TOKEN_TYPES.map((ty) => { const v = typeVal(a, ty.key); return `<li${tip(ty.note)}><i class="sw ${ty.cls}"></i><span>${ty.label}</span><b>${fmtN(v)}</b><em>${esc(pctLabel(v, tot))}</em></li>`; }).join("")}</ul>
    <div class="u-grid">
      <div>
        <div class="u-h">By agent</div>
        <ul class="hbars">${roles.map(([r, v]) => `<li${tip(`${roleName(r)}\n${fmtN(v.tok)} tokens · ${fmtN(v.out)} output\n${v.runs ? `${v.runs} run${v.runs > 1 ? "s" : ""} · ` : ""}${v.msgs.toLocaleString("en-GB")} calls`)}><span class="hb-l">${esc(roleName(r))}${v.runs ? `<em>${v.runs}×</em>` : ""}</span><span class="hb-t"><span style="width:${Math.max(0.6, pct(v.tok, maxRole)).toFixed(2)}%"></span></span><span class="hb-v">${fmtN(v.tok)}</span></li>`).join("")}</ul>
      </div>
      <div>
        <div class="u-h">Over time <span>tokens ${per}</span></div>
        <div class="cols" role="img" aria-label="Tokens ${per}">${series.map(([h, v]) => `<span class="col"${tip(`${fmtBucket(h)}\n${v ? fmtN(v) + " tokens" : "no activity"}`)}><span style="height:${v ? Math.max(2, pct(v, maxH)).toFixed(1) : 0}%"></span></span>`).join("")}</div>
        <div class="cols-x" aria-hidden="true">${series.map(([h], i) => `<span>${ticks.includes(h) ? `<b class="${i === 0 ? "first" : i === series.length - 1 ? "last" : "mid"}">${esc(fmtTick(h))}</b>` : ""}</span>`).join("")}</div>
        <details class="tview"><summary>Show as table</summary><div class="tbl"><table><thead><tr><th>${size >= 24 ? "Day" : "Time"}</th><th class="num">Tokens</th></tr></thead><tbody>${series.filter((x) => x[1]).map(([h, v]) => `<tr><td>${esc(fmtBucket(h))}</td><td class="num">${fmtN(v)}</td></tr>`).join("")}</tbody></table></div></details>
      </div>
    </div>
    ${a.runs.length ? `
    <details class="runs" data-id="runs-${scope}">
      <summary><span>Agent runs</span><em>${a.runs.length}</em>${I.chev}</summary>
      <ul>${a.runs.map((r) => `<li><span class="r-role">${esc(roleName(r.role))}</span><span class="r-desc">${esc(r.desc || "—")}</span><span class="r-meta">${Object.keys(r.models).map((m) => esc(modelName(m))).join(", ")} · ${fmtDur(r.last - r.first)} · ${t(r.first)}</span><span class="r-tok">${fmtN(r.tok)}</span></li>`).join("")}</ul>
    </details>` : ""}
    <p class="foot">From Claude Code's session logs. ${scope === "plan" ? "Only planner sessions count, assigned to this plan by time window; each sub-agent run stays whole. “Orchestrator” is the main session thread." : "Only planner sessions count, assigned to plans by time window."}</p>
  </div>`;
}

function renderPlan(ctx, m, here) {
  const { OUT, href } = ctx;
  const { pick, state, plan, progress, decisions, changelog, verification, g, files, stepList, summary, usage } = m;
  const docHref = (rel) => esc(href(here, OUT.doc(pick.name, rel)));
  const docUrl = (rel) => href(here, OUT.doc(pick.name, rel));
  const done = stepList.filter((s) => s.done).length;
  const pending = stepList.filter((s) => !s.done);
  const lastEdit = changelog.at(-1);
  const lastCommit = g.planCommits[0];
  const latestDecision = decisions[0];
  const L = splitLabel(m.label);
  const verb = state.phase === "CLOSE" && m.live ? "Closing" : PHASE_VERB[state.phase] || cap(state.phase);
  const executing = state.phase === "EXECUTE" && pending.length;
  const nextStep = executing ? (pending.find((s) => s.current) || pending[0]) : null;
  const head = nextStep ? { verb: `${verb} step ${nextStep.key}`, detail: nextStep.title } : { verb, detail: state.lastDetail || state.step };
  const passCount = verification.filter((v) => /PASS/i.test(v.result)).length;
  const tokens = total(usage);
  const models = Object.entries(usage.byModel).sort((x, y) => y[1].tok - x[1].tok).map(([k]) => modelName(k));
  const end = m.closed || m.latestMs;
  const showNow = m.live || !summary.bottomLine;

  const header = `
  <section class="hero wrap" id="overview">
    <div class="eyebrow">${L.kicker ? `<span>${esc(L.kicker)}</span><span class="dot-sep"></span>` : ""}<code>${esc(pick.name)}</code></div>
    <h1>${inline(L.title)}</h1>
    ${L.note ? `<p class="h1-note">${esc(L.note)}</p>` : ""}
    <div class="meta">${phasePill(state.phase, m.live)}<span>Started ${t(m.started)}</span>${m.closed ? `<span>Closed after ${fmtDur(m.closed - m.started)}</span>` : m.live ? `<span>Running for <span data-since="${m.started}">${fmtDur(m.latestMs - m.started)}</span></span>` : ""}<span>Last activity ${t(m.latestMs)}</span>${models.length ? vol(`<span class="hide-sm">${esc(models.join(" · "))}</span>`) : ""}</div>
    ${phaseRail(state, m.live)}
    <dl class="kpis">
      <div><dt>Steps</dt><dd>${done}<small>/${stepList.length}</small></dd><div class="mini" aria-hidden="true">${stepList.map((s) => `<i class="${s.done ? "on" : ""}"></i>`).join("")}</div></div>
      <div><dt>Decisions</dt><dd>${decisions.length}</dd></div>
      <div><dt>Commits</dt><dd>${g.planCommits.length}</dd></div>
      <div><dt>Checks</dt><dd>${verification.length ? `${passCount}<small>/${verification.length}</small>` : "—"}</dd></div>
      <div><dt>Tokens</dt><dd>${vol(tokens ? fmtN(tokens) : "—")}</dd></div>
      <div><dt>${m.closed ? "Duration" : "Elapsed"}</dt><dd>${fmtDur(end - m.started)}</dd></div>
    </dl>
  </section>`;

  const tabs = `<nav class="tabs" aria-label="Sections"><div class="wrap tabs-in">
    <a href="#now">${showNow ? "Now" : "Outcome"}</a><a href="#steps">Steps</a><a href="#usage">Usage</a><a href="#decisions">Decisions</a><a href="#timeline">Timeline</a><a href="#documents">Documents</a>${verification.length ? '<a href="#checks">Checks</a>' : ""}<a href="#activity">Activity</a>
  </div></nav>`;

  const signals = [
    latestDecision && `<li><span class="sg-k">Latest decision</span><div><a href="${docHref("decisions.md")}#${esc(latestDecision.id)}" class="mono">${esc(latestDecision.id)}</a> <span class="muted">${esc(latestDecision.phase)}</span><p>${inline(clip(flat(latestDecision.decision), 260))}</p></div></li>`,
    lastCommit && `<li><span class="sg-k">Last commit</span><div><code>${esc(lastCommit.hash)}</code> <span class="muted">step ${esc(lastCommit.step)} · ${t(lastCommit.ms)}</span><p>${inline(lastCommit.title)}</p></div></li>`,
    lastEdit && `<li><span class="sg-k">Last edit</span><div><code>${esc(lastEdit.file)}</code> <span class="muted">${esc(lastEdit.step.replace(/^iter-\d+\//, ""))} · ${t(Date.parse(lastEdit.utc))}</span><p>${inline(clip(lastEdit.why, 200))}</p></div></li>`,
  ].filter(Boolean).join("");
  const upNext = pending.filter((s) => s !== nextStep).slice(0, 2);
  const now = showNow ? `
  <section class="now${m.live ? " is-live" : ""}">
    <div class="sh" id="now"><h2>${m.live ? '<span class="pulse"></span>Right now' : "Where it stopped"}</h2></div>
    <p class="now-h"><span>${esc(head.verb)}</span>${head.detail ? ` — ${inline(clip(head.detail, 160))}` : ""}</p>
    ${upNext.length ? `<p class="now-next"><span class="muted">Up next</span> ${upNext.map((s) => `<span class="mono">${esc(s.key)}</span> ${inline(clip(s.title, 80))}`).join(" · ")}</p>` : ""}
    ${g.dirty.length ? `<div class="inflight"><div class="sg-k">Uncommitted in ${esc(path.basename(pick.root))} — work in flight</div><ul>${g.dirty.slice(0, 6).map((d) => `<li><code>${esc(d.code)}</code><span>${esc(d.file)}</span>${t(d.ms)}</li>`).join("")}</ul></div>` : ""}
    ${progress.blocked.length ? `<div class="blocked"><div class="sg-k">Blocked</div><ul>${progress.blocked.map((i) => `<li>${inline(i)}</li>`).join("")}</ul></div>` : ""}
    <ul class="signals">${signals}</ul>
    ${m.live && m.latestMs - m.stateMs > 5 * 60 * 1000 ? `<p class="foot">state.md was last written ${t(m.stateMs)}; there is newer activity, so the phase line may lag.</p>` : ""}
  </section>` : "";
  const outcome = summary.bottomLine ? `
  <section class="outcome">
    ${sectionHead(showNow ? "outcome" : "now", "Outcome", "", moreLink(docUrl("summary.md"), "Full summary"))}
    <p class="lede">${inline(summary.bottomLine)}</p>
    ${summary.outcome ? `<details class="disclose" data-id="outcome-${esc(pick.name)}"><summary>Read the outcome section${I.chev}</summary><div class="md">${mdToHtml(summary.outcome).html}</div></details>` : ""}
  </section>` : "";

  const goalItems = plan.goal.split("\n").filter((l) => /^\d+\.\s/.test(l)).map((l) => l.replace(/^\d+\.\s/, ""));
  const goal = plan.goal ? `
  <section>
    ${sectionHead("goal", "Goal", "", moreLink(docUrl("plan.md"), "plan.md"))}
    ${goalItems.length ? `<ol class="goal">${goalItems.map((x) => `<li>${inline(x)}</li>`).join("")}</ol>` : `<div class="md clamp">${mdToHtml(clip(plan.goal, 1400)).html}</div>`}
  </section>` : "";

  const nextKey = m.live && nextStep ? nextStep.key : null;
  const steps = `
  <section>
    ${sectionHead("steps", "Steps", `${done} of ${stepList.length} done`, moreLink(docUrl("plan.md"), "plan.md"))}
    <ol class="steps">${stepList.map((s) => {
      const u = usage.bySteps[s.key];
      const tags = [
        s.risk && `<span class="tag risk-${esc(s.risk.toLowerCase())}"><i></i>${esc(s.risk.toLowerCase())} risk</span>`,
        s.irreversible && '<span class="tag">irreversible</span>',
        s.source === "fix" && `<span class="tag">completion fix${s.from ? ` · <a href="${docHref("decisions.md")}#${esc(s.from)}">${esc(s.from)}</a>` : ""}</span>`,
      ].filter(Boolean).join("");
      return `<li class="${s.done ? "done" : "todo"}${s.source === "fix" ? " fix" : ""}${s.key === nextKey ? " next" : ""}">
        <span class="st">${s.done ? I.check : ""}</span><span class="k">${esc(s.key)}</span>
        <div class="sb"><div class="stt">${inline(s.title)}</div>${tags ? `<div class="tags">${tags}</div>` : ""}</div>
        <div class="sr">${s.commit ? `<code>${esc(s.commit)}</code>` : ""}${u ? vol(`<span class="tk"${tip(`Executor tokens for step ${s.key}${u.runs > 1 ? ` (${u.runs} runs)` : ""}`)}>${fmtN(u.tok)}</span>`) : ""}</div>
      </li>`;
    }).join("")}</ol>
  </section>`;

  const usageSec = `<section>${vol(sectionHead("usage", "Usage", tokens ? `${fmtN(tokens)} tokens` : "") + usageBlock(ctx, usage, { scope: "plan" }))}</section>`;

  const decs = `
  <section>
    ${sectionHead("decisions", "Decisions", String(decisions.length), moreLink(docUrl("decisions.md"), "decisions.md"))}
    <div class="acc">${decisions.map((d, i) => `
      <details data-id="dec-${esc(pick.name)}-${esc(d.id)}"${i === 0 && m.live ? " open" : ""}>
        <summary><span class="mono">${esc(d.id)}</span><span class="acc-t">${inline(clip(flat(d.decision), 150))}</span><span class="acc-m">${esc(d.phase.replace(/\s*\(.*$/, ""))}</span>${I.chev}</summary>
        <div class="acc-b">${["context", "decision", "tradeoff", "reasoning"].filter((k) => d[k]).map((k) => `<div class="field"><div class="fl">${{ context: "Context", decision: "Decision", tradeoff: "Trade-off", reasoning: "Reasoning" }[k]}</div><div class="md">${mdToHtml(d[k]).html}</div></div>`).join("")}
        <a class="sh-more" href="${docHref("decisions.md")}#${esc(d.id)}">Open in decisions.md${I.arrow}</a></div>
      </details>`).join("")}</div>
  </section>`;

  const timeline = `
  <section>
    ${sectionHead("timeline", "Timeline", `${state.hist.length} entries · newest first`, moreLink(docUrl("state.md"), "state.md"))}
    <ol class="tl">${[...state.hist].reverse().map((h) => {
      const tr = h.text.match(/^([A-Z]+\s*→\s*[A-Z]+)\s*(.*)$/);
      const ts = Date.parse((h.text.match(ISO_RE) || [])[0] || "") || 0;
      const rest = (tr ? tr[2] : h.text).replace(/^\(|\)$/g, "").replace(ISO_RE, "").replace(/[,\s]+$/, "").replace(/^[:,\s]+/, "");
      return `<li class="${tr ? "tr" : "note"}"><span class="tl-n"></span><div>${tr ? `<span class="tl-h">${esc(tr[1].replace(/\s*→\s*/, " → "))}</span>${ts ? ` <span class="muted">${t(ts)}</span>` : ""}` : ""}<p>${inline(rest)}</p>${h.sub.length ? `<p class="tl-sub">${h.sub.map(inline).join("<br>")}</p>` : ""}</div></li>`;
    }).join("")}</ol>
  </section>`;

  const order = ["summary.md", "plan.md", "progress.md", "state.md", "verification.md", "decisions.md", "changelog.md", "findings.md"];
  const mdFiles = files.filter((f) => f.rel.endsWith(".md"));
  const groups = [
    ["Plan files", mdFiles.filter((f) => !f.rel.includes(path.sep)).sort((a, b) => ((order.indexOf(a.rel) + 1) || 99) - ((order.indexOf(b.rel) + 1) || 99) || a.rel.localeCompare(b.rel))],
    ["Findings & reviews", mdFiles.filter((f) => f.rel.startsWith(`findings${path.sep}`)).sort((a, b) => a.ms - b.ms)],
    ["Checkpoints", mdFiles.filter((f) => f.rel.startsWith(`checkpoints${path.sep}`)).sort((a, b) => a.rel.localeCompare(b.rel))],
  ];
  const docs = `
  <section>
    ${sectionHead("documents", "Documents", String(mdFiles.length))}
    ${groups.filter(([, list]) => list.length).map(([name, list]) => `
      <div class="grp">${name}</div>
      <ul class="docs">${list.map((f) => `<li><a href="${docHref(f.rel)}">${I.file}<span>${esc(f.rel.replace(/^(findings|checkpoints)[\\/]/, "").replace(/\.md$/, ""))}</span><em>${Math.max(1, Math.round(f.size / 1024))} KB · ${t(f.ms)}</em></a></li>`).join("")}</ul>`).join("")}
  </section>`;

  const checks = verification.length ? `
  <section>
    ${sectionHead("checks", "Checks", `${passCount} of ${verification.length} pass`, moreLink(docUrl("verification.md"), "verification.md"))}
    <ul class="checks">${verification.map((v) => { const ok = /PASS/i.test(v.result), bad = /FAIL/i.test(v.result); return `<li${tip(v.evidence)}><span class="res ${ok ? "ok" : bad ? "bad" : "na"}">${ok ? I.check : bad ? I.cross : ""}<b>${esc(ok ? "Pass" : bad ? "Fail" : v.result || "—")}</b></span><span>${inline(clip(v.criterion, 130))}</span></li>`; }).join("")}</ul>
    <p class="foot">verification.md written ${t(mtime(path.join(pick.dir, "verification.md")))}${m.live ? " — it may predate the latest fixes" : ""}.</p>
  </section>` : "";

  const activity = `
  <section>
    ${sectionHead("activity", "Activity")}
    ${g.planCommits.length ? `<div class="grp">Commits</div><ul class="feed">${g.planCommits.slice(0, 24).map((c) => `<li><code>${esc(c.hash)}</code><div><span class="mono k">${esc(c.step)}</span> ${inline(clip(c.title, 110))}</div>${t(c.ms)}</li>`).join("")}</ul>` : ""}
    ${changelog.length ? `<div class="grp">Ledger edits <span class="muted">· ${changelog.length} total</span> <a class="grp-more" href="${docHref("changelog.md")}">changelog.md</a></div><ul class="feed">${changelog.slice(-8).reverse().map((c) => `<li><code>${esc(c.step.replace(/^iter-\d+\/step-/, ""))}</code><div><span class="path">${esc(c.file)}</span> <span class="muted">${esc(c.op)}</span><p>${inline(clip(c.why, 160))}</p></div>${t(Date.parse(c.utc))}</li>`).join("")}</ul>` : ""}
    ${progress.flags.length ? `<details class="disclose" data-id="flags-${esc(pick.name)}"><summary>Hand-off flags · ${progress.flags.length}${I.chev}</summary><ul class="flags">${progress.flags.map((f) => `<li>${inline(f)}</li>`).join("")}</ul></details>` : ""}
  </section>`;

  const body = `
  ${header}
  ${tabs}
  <main id="main" class="wrap layout">
    <div class="main-col">${m.live ? now + outcome : outcome + now}${goal}${steps}${usageSec}${decs}${timeline}</div>
    <aside class="side-col">${docs}${checks}${activity}</aside>
  </main>`;
  return shell(ctx, { title: `${m.live ? "● " : ""}${L.kicker || clip(L.title, 32)} · Planner`, here, current: pick.name, body, live: m.live });
}

function renderDoc(ctx, { here, current, title, crumbs, src, ms, source, back }) {
  const { html, toc } = mdToHtml(src);
  const body = `
  <main id="main" class="wrap docwrap">
    <header class="doc-h">
      ${back ? `<a class="back" href="${esc(back.href)}">${I.back}${esc(back.label)}</a>` : ""}
      <div class="eyebrow">${crumbs}</div>
      <h1 class="doc-t">${esc(title)}</h1>
      <div class="meta">${ms ? `<span>Updated ${t(ms)}</span>` : ""}<span class="path hide-sm">${esc(source)}</span></div>
    </header>
    <div class="docgrid${toc.length > 2 ? "" : " no-toc"}">
      ${toc.length > 2 ? `<nav class="toc" aria-label="Contents"><details open data-id="toc"><summary>Contents${I.chev}</summary><ul>${toc.map((h) => `<li class="l${h.lvl}"><a href="#${h.id}">${inline(clip(tocLabel(h.txt), 80))}</a></li>`).join("")}</ul></details></nav>` : ""}
      <article class="md doc">${html || '<p class="muted">(empty)</p>'}</article>
    </div>
  </main>`;
  return shell(ctx, { title: `${title} · Planner`, here, current, body });
}

function renderArchived(ctx, p, ledgers, here) {
  const sec = (file) => {
    const txt = read(ledgers.find((l) => l.file === file)?.path);
    const m = txt.match(new RegExp(`^## ${p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m"));
    return m ? m[1].trim() : "";
  };
  const parts = [];
  if (p.index) parts.push(`**Goal (from INDEX.md):** ${p.index.goal}${p.index.topics ? `\n\n**Topics:** ${p.index.topics}` : ""}`);
  parts.push("> This plan's directory is gone. What survives is its INDEX.md row and its sections in the consolidated ledgers, shown below.");
  if (total(p.usage)) parts.push(`**Usage:** ${fmtN(total(p.usage))} tokens (${fmtN(p.usage.out)} output) in planner sessions during this plan's time window — ${Object.keys(p.usage.byModel).map(modelName).join(", ")}.`);
  const f = sec("FINDINGS.md"), d = sec("DECISIONS.md");
  if (f) parts.push(`## Findings\n\n${f}`);
  if (d) parts.push(`## Decisions\n\n${d}`);
  if (!f && !d) parts.push("*No ledger sections found for this plan.*");
  return renderDoc(ctx, { here, current: p.name, title: archivedLabel(p), crumbs: `<span>Archived plan</span><span class="dot-sep"></span><code>${esc(p.name)}</code>`, src: parts.join("\n\n"), ms: 0, source: "plans/INDEX.md + plans/FINDINGS.md + plans/DECISIONS.md", back: { href: ctx.href(here, ctx.OUT.all), label: "All plans" } });
}

function renderAll(ctx, models, archived, att, here) {
  const { OUT, href, sitemap } = ctx;
  const all = newAgg();
  for (const a of att.byPlan.values()) mergeAgg(all, a);
  all.runs.sort((x, y) => y.first - x.first);
  const totalAll = total(all);
  const sorted = [...models].sort((a, b) => b.started - a.started);
  const tokRows = [
    ...sorted.map((m) => ({ label: splitLabel(m.label), tok: total(m.usage) })),
    ...[...archived].sort((a, b) => b.start - a.start).map((p) => ({ label: { kicker: "", title: archivedLabel(p) }, tok: total(p.usage) })),
  ].filter((r) => r.tok);
  const maxTok = Math.max(...tokRows.map((r) => r.tok), 1);
  const card = (m, i) => {
    const L = splitLabel(m.label);
    const done = m.stepList.filter((s) => s.done).length;
    const blurb = m.summary.bottomLine || oneLine(m.plan.goal.split("\n").find((l) => l.trim()) || "");
    const tok = total(m.usage);
    return `
    <a class="pcard${m.live ? " is-live" : ""}" href="${esc(href(here, OUT.plan(m.pick.name)))}" style="--i:${i}">
      <div class="pc-top">${phasePill(m.state.phase, m.live)}<span class="muted">${esc(day(m.started))}</span><span class="muted hide-sm">· ${m.closed ? `closed after ${fmtDur(m.closed - m.started)}` : `last activity ${t(m.latestMs)}`}</span></div>
      <div class="pc-k">${esc(L.kicker || "Plan")}</div>
      <h3>${inline(L.title)}</h3>
      <p>${inline(clip(blurb.replace(/^\d+\.\s*/, ""), 300))}</p>
      <dl class="pc-s"><div><dt>Steps</dt><dd>${done}/${m.stepList.length}</dd></div><div><dt>Decisions</dt><dd>${m.decisions.length}</dd></div><div><dt>Commits</dt><dd>${m.g.planCommits.length}</dd></div>${tok ? `<div><dt>Tokens</dt><dd>${vol(fmtN(tok))}</dd></div>` : ""}</dl>
      <span class="pc-go" aria-hidden="true">${I.arrow}</span>
    </a>`;
  };
  const byModel = Object.entries(all.byModel).sort((x, y) => y[1].tok - x[1].tok).map(([k]) => modelName(k)).join(", ");
  const body = `
  <main id="main" class="wrap">
    <section class="hero hero-all">
      <div class="eyebrow"><span>Iterative planner</span><span class="dot-sep"></span><span>${esc(path.basename(ctx.repo))}</span></div>
      <h1>Every plan, in one place.</h1>
      <p class="lede">${models.length} plan${models.length === 1 ? "" : "s"} with full history${archived.length ? `, ${archived.length} archived` : ""}${totalAll ? vol(` · ${fmtN(totalAll)} tokens on ${byModel}`) : ""}.</p>
    </section>
    <div class="pcards">${sorted.map(card).join("") || '<p class="empty">No plan directories yet.</p>'}</div>
    ${totalAll ? vol(`
    <section class="all-usage">
      ${sectionHead("usage", "Usage", `${fmtN(totalAll)} tokens in planner sessions`)}
      <div class="u-grid u-grid-top">
        <div><div class="u-h">By plan</div><ul class="hbars">${tokRows.map((r) => `<li${tip(`${r.label.kicker ? r.label.kicker + " — " : ""}${r.label.title}\n${fmtN(r.tok)} tokens`)}><span class="hb-l">${esc(r.label.kicker || clip(r.label.title, 26))}</span><span class="hb-t"><span style="width:${Math.max(0.6, pct(r.tok, maxTok)).toFixed(2)}%"></span></span><span class="hb-v">${fmtN(r.tok)}</span></li>`).join("")}</ul></div>
        <div class="u-aside">
          ${total(att.between) ? `<p><b>${fmtN(total(att.between))}</b> tokens in planner sessions between plans — after one closed, before the next started. Not counted above.</p>` : ""}
          ${total(att.outside) ? `<p><b>${fmtN(total(att.outside))}</b> tokens in ${att.outside.sessions.size} other Claude Code session${att.outside.sessions.size > 1 ? "s" : ""} in this repo that never ran the planner. Not counted above.</p>` : ""}
        </div>
      </div>
      ${usageBlock(ctx, all, { scope: "all" })}
    </section>`) : ""}
    ${archived.length ? `
    <section>
      ${sectionHead("archived", "Archived plans", String(archived.length))}
      <ul class="arch">${[...archived].sort((a, b) => b.start - a.start).map((p) => `<li><a href="${esc(href(here, OUT.archived(p.name)))}"><span class="muted mono">${esc(p.index?.date || planDateFromId(p.name) || "")}</span><span>${esc(archivedLabel(p))}</span>${I.arrow}</a></li>`).join("")}</ul>
    </section>` : ""}
    ${sitemap.ledgers.length ? `
    <section>
      ${sectionHead("ledgers", "Cross-plan ledgers")}
      <div class="ledgers">${sitemap.ledgers.map((l) => `<a href="${esc(href(here, OUT.ledger(l.file)))}"><b>${esc(LEDGER_TITLES[l.file] || l.file)}</b><span>${esc(l.file)} · ${t(l.ms)}</span></a>`).join("")}</div>
    </section>` : ""}
  </main>`;
  return shell(ctx, { title: "All plans · Planner", here, current: "", body });
}

// ---------- assets ----------
// Colors: one monochrome ink scale for the interface; color is reserved for data. The three token-type
// colors are a colorblind-checked categorical set (light and dark steps of the same hues), and status
// colors always ship with an icon and a label. Fonts are local system faces only — no network.
const CSS = String.raw`
:root{
  color-scheme:light;
  --page:#f6f5f1;--surface:#fcfcfb;--sunk:#efeee9;--ink:#0b0b0b;--ink-2:#52514e;--ink-3:#898781;
  --line:#e4e2db;--line-2:#d3d1c8;--hover:rgba(11,11,11,.035);--bar:#2c2b29;
  --good:#0ca30c;--good-ink:#006300;--warning:#fab219;--serious:#ec835a;--critical:#d03b3b;
  --s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;
  --shadow:0 1px 0 rgba(11,11,11,.04),0 12px 32px -18px rgba(11,11,11,.18);
  --ping:rgba(12,163,12,.5);
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --serif:"Iowan Old Style","Palatino Linotype",Palatino,Cambria,Georgia,serif;
  --mono:ui-monospace,"Cascadia Mono",Consolas,SFMono-Regular,Menlo,"Liberation Mono",monospace;
  --gut:16px;--bar-h:56px;
}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])){
  color-scheme:dark;
  --page:#0d0d0c;--surface:#1a1a19;--sunk:#141413;--ink:#f4f3ee;--ink-2:#c3c2b7;--ink-3:#898781;
  --line:#2a2a28;--line-2:#383835;--hover:rgba(255,255,255,.045);--bar:#dedcd3;
  --good-ink:#2fbf2f;--s1:#3987e5;--s2:#d95926;--s3:#199e70;
  --shadow:0 1px 0 rgba(255,255,255,.03),0 16px 40px -20px rgba(0,0,0,.7);
}}
:root[data-theme="dark"]{
  color-scheme:dark;
  --page:#0d0d0c;--surface:#1a1a19;--sunk:#141413;--ink:#f4f3ee;--ink-2:#c3c2b7;--ink-3:#898781;
  --line:#2a2a28;--line-2:#383835;--hover:rgba(255,255,255,.045);--bar:#dedcd3;
  --good-ink:#2fbf2f;--s1:#3987e5;--s2:#d95926;--s3:#199e70;
  --shadow:0 1px 0 rgba(255,255,255,.03),0 16px 40px -20px rgba(0,0,0,.7);
}
@media (min-width:760px){:root{--gut:32px}}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-padding-top:calc(var(--bar-h) + 64px)}
body{margin:0;background:var(--page);color:var(--ink);font:400 15px/1.6 var(--sans);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;min-height:100vh;overflow-x:hidden}
body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:-1;background:radial-gradient(1100px 520px at 12% -12%,var(--surface),transparent 70%)}
a{color:inherit;text-decoration-color:var(--line-2);text-underline-offset:3px}
a:hover{text-decoration-color:currentColor}
code,.mono{font-family:var(--mono);font-size:.86em;letter-spacing:-.01em}
code{background:var(--sunk);border-radius:5px;padding:.08em .38em;overflow-wrap:anywhere}
svg{width:1em;height:1em;flex:none}
.wrap{max-width:1240px;margin:0 auto;padding-left:max(var(--gut),env(safe-area-inset-left));padding-right:max(var(--gut),env(safe-area-inset-right))}
.muted{color:var(--ink-3)}
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.skip{position:absolute;left:-999px;top:8px;z-index:50;background:var(--ink);color:var(--page);padding:8px 12px;border-radius:8px}
.skip:focus{left:8px}
:focus-visible{outline:2px solid var(--ink);outline-offset:2px;border-radius:4px}
.dot-sep{display:inline-block;width:3px;height:3px;border-radius:50%;background:var(--ink-3);vertical-align:middle;margin:0 9px}
.empty{color:var(--ink-3);padding:8px 0}
.hide-sm{display:none}
@media (min-width:760px){.hide-sm{display:revert}}
.bar{position:sticky;top:0;z-index:20;background:color-mix(in srgb,var(--page) 82%,transparent);backdrop-filter:saturate(1.4) blur(14px);-webkit-backdrop-filter:saturate(1.4) blur(14px);border-bottom:1px solid var(--line)}
.bar-in{max-width:1240px;margin:0 auto;height:var(--bar-h);display:flex;align-items:center;gap:10px;padding:0 max(var(--gut),env(safe-area-inset-left))}
.brand{display:flex;align-items:center;gap:8px;text-decoration:none;font-weight:600;letter-spacing:-.01em;flex:none}
.brand svg{width:22px;height:22px}
.brand span{display:none}
@media (min-width:560px){.brand span{display:inline}}
.switch{position:relative;flex:1;min-width:0;max-width:420px;display:flex;align-items:center}
.switch select{appearance:none;-webkit-appearance:none;width:100%;font:500 14px/1 var(--sans);color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:999px;height:36px;padding:0 34px 0 14px;text-overflow:ellipsis;cursor:pointer}
@media (max-width:759px){.switch select{font-size:16px}}
.switch select:hover{border-color:var(--line-2)}
.switch svg{position:absolute;right:12px;pointer-events:none;color:var(--ink-3)}
.bar-r{margin-left:auto;display:flex;align-items:center;gap:4px;flex:none}
.bar-link{text-decoration:none;font-weight:500;font-size:14px;padding:8px 12px;border-radius:999px;color:var(--ink-2)}
.bar-link:hover,.bar-link.cur{color:var(--ink);background:var(--hover)}
.live-pill{display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 12px;border-radius:999px;text-decoration:none;font-size:13px;font-weight:500;color:var(--ink-2);border:1px solid var(--line);background:var(--surface)}
.live-pill i{width:7px;height:7px;border-radius:50%;background:var(--ink-3)}
.live-pill.on i{background:var(--good);animation:ping 2.4s infinite}
.live-pill.stale i{background:var(--warning)}
@media (max-width:440px){.live-pill span{display:none}.live-pill{padding:0 11px}}
.icon-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:40px;height:40px;padding:0 8px;border-radius:999px;border:0;background:none;color:var(--ink-2);cursor:pointer;font:inherit;list-style:none}
.icon-btn:hover{background:var(--hover);color:var(--ink)}
.icon-btn svg{width:19px;height:19px}
.menu{position:relative}
.menu-pop{position:absolute;right:0;top:calc(100% + 8px);width:244px;background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);padding:8px;display:flex;flex-direction:column;animation:pop .14s ease-out}
.menu-pop a{text-decoration:none;padding:9px 10px;border-radius:8px;font-size:14px}
.menu-pop a:hover{background:var(--hover)}
.menu-h{font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--ink-3);padding:12px 10px 6px}
.seg{display:flex;gap:2px;background:var(--sunk);border-radius:10px;padding:3px;margin:0 6px 6px}
.seg button{flex:1;border:0;background:none;font:500 13px var(--sans);color:var(--ink-2);padding:7px 0;border-radius:7px;cursor:pointer}
.seg button.on{background:var(--surface);color:var(--ink);box-shadow:0 1px 2px rgba(0,0,0,.1)}
.hero{padding-top:36px}
@media (min-width:760px){.hero{padding-top:60px}}
.eyebrow{display:flex;align-items:center;flex-wrap:wrap;font-size:13px;color:var(--ink-3);font-weight:500}
.eyebrow code{background:none;padding:0;color:var(--ink-3)}
h1{font:400 clamp(34px,6.4vw,60px)/1.05 var(--serif);letter-spacing:-.022em;margin:14px 0 14px;max-width:20ch;text-wrap:balance}
.h1-note{font:italic 400 clamp(17px,2vw,20px)/1.4 var(--serif);color:var(--ink-3);margin:-4px 0 16px;max-width:60ch}
.meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px 18px;font-size:13.5px;color:var(--ink-2)}
.pill{display:inline-flex;align-items:center;gap:7px;height:26px;padding:0 11px;border-radius:999px;font-size:12.5px;font-weight:600;letter-spacing:.01em;background:var(--ink);color:var(--page)}
.pill i{width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.45}
.pill.is-live i{background:var(--good);opacity:1;animation:ping 2.4s infinite}
.rail{list-style:none;margin:40px 0 0;padding:0;display:grid;grid-auto-flow:column;grid-auto-columns:minmax(62px,1fr);overflow-x:auto;scrollbar-width:none}
.rail::-webkit-scrollbar{display:none}
.rail li{position:relative;display:flex;flex-direction:column;gap:9px;padding-right:8px}
.rail li::before{content:"";position:absolute;left:0;right:0;top:6px;height:1px;background:var(--line-2)}
.rail li.done::before{background:var(--ink)}
.rail li.cur::before{background:linear-gradient(90deg,var(--ink) 0 13px,var(--line-2) 13px)}
.rail li:last-child::before{right:auto;width:13px}
.rail .node{position:relative;z-index:1;width:13px;height:13px;border-radius:50%;background:var(--page);border:1.5px solid var(--line-2)}
.rail li.done .node{background:var(--ink);border-color:var(--ink)}
.rail li.cur .node{background:var(--page);border:4px solid var(--ink)}
.rail.is-live li.cur .node{--ping:color-mix(in srgb,var(--ink) 35%,transparent);animation:ping 2.4s infinite}
.rail .rl{font-size:11.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)}
.rail li.done .rl,.rail li.cur .rl{color:var(--ink)}
.rail .rc{font:500 12px var(--mono);color:var(--ink-3);min-height:1.2em;margin-top:-7px}
.kpis{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));margin:30px 0 0;border-top:1px solid var(--line)}
.kpis>div{padding:16px 0 18px;border-bottom:1px solid var(--line);min-width:0}
.kpis>div:nth-child(odd){padding-right:16px;border-right:1px solid var(--line)}
.kpis>div:nth-child(even){padding-left:16px}
@media (min-width:760px){.kpis{grid-template-columns:repeat(6,minmax(0,1fr));border-bottom:1px solid var(--line)}.kpis>div,.kpis>div:nth-child(n){border-bottom:0;padding:18px 18px 20px;border-right:1px solid var(--line)}.kpis>div:first-child{padding-left:0}.kpis>div:last-child{border-right:0}}
.kpis dt{font-size:12.5px;color:var(--ink-3);font-weight:500}
.kpis dd{margin:4px 0 0;font:500 28px/1.1 var(--sans);letter-spacing:-.025em}
.kpis dd small{font-size:.55em;color:var(--ink-3);letter-spacing:0;margin-left:2px}
.mini{display:flex;gap:2px;margin-top:10px}
.mini i{flex:1;height:4px;border-radius:2px;background:var(--line-2)}
.mini i.on{background:var(--ink)}
.tabs{position:sticky;top:var(--bar-h);z-index:15;background:color-mix(in srgb,var(--page) 88%,transparent);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border-bottom:1px solid var(--line);margin-top:28px}
.tabs-in{display:flex;gap:2px;overflow-x:auto;scrollbar-width:none;height:50px;align-items:center}
.tabs-in::-webkit-scrollbar{display:none}
.tabs a{flex:none;text-decoration:none;font-size:14px;font-weight:500;color:var(--ink-3);padding:7px 12px;border-radius:999px;transition:color .15s,background .15s}
.tabs a:first-child{margin-left:-12px}
.tabs a:hover{color:var(--ink)}
.tabs a.on{color:var(--ink);background:var(--hover)}
.layout{display:grid;grid-template-columns:minmax(0,1fr);gap:0 72px;padding-bottom:96px}
@media (min-width:1080px){.layout{grid-template-columns:minmax(0,1fr) 340px}}
.main-col,.side-col{min-width:0}
:where(.main-col,.side-col,main.wrap)>section{padding-top:48px}
.sh{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 12px;padding-bottom:14px;margin-bottom:18px;border-bottom:1px solid var(--line)}
.sh h2{font:400 27px/1.15 var(--serif);letter-spacing:-.015em;margin:0;display:flex;align-items:center;gap:10px}
.sh-x{font-size:13.5px;color:var(--ink-3)}
.sh-more{margin-left:auto;display:inline-flex;align-items:center;gap:5px;font-size:13px;color:var(--ink-2);text-decoration:none;white-space:nowrap}
.sh-more:hover{color:var(--ink)}
.sh-more svg{transition:transform .15s}
.sh-more:hover svg{transform:translateX(2px)}
.foot{font-size:12.5px;color:var(--ink-3);margin:14px 0 0}
.grp{font-size:11.5px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--ink-3);margin:24px 0 6px;display:flex;gap:6px;align-items:baseline}
.sh+.grp{margin-top:0}
.grp-more{margin-left:auto;text-transform:none;letter-spacing:0;font-weight:500;font-size:12.5px;color:var(--ink-2);text-decoration:none}
.now{margin-top:44px;padding:22px 20px;background:var(--surface);border:1px solid var(--line);border-radius:20px;box-shadow:var(--shadow)}
@media (min-width:760px){.now{padding:30px 34px}}
.now .sh{border:0;padding:0;margin:0 0 12px}
.now .sh h2{font:600 12px/1 var(--sans);letter-spacing:.09em;text-transform:uppercase;color:var(--ink-2)}
.pulse{width:8px;height:8px;border-radius:50%;background:var(--good);animation:ping 2.4s infinite}
.now-h{font:400 clamp(23px,3.4vw,32px)/1.22 var(--serif);letter-spacing:-.014em;margin:0 0 6px;text-wrap:pretty}
.now-h span{font-style:italic}
.now-next{margin:10px 0 0;font-size:14px;color:var(--ink-2)}
.inflight,.blocked{margin-top:18px;border-radius:12px;padding:12px 14px;background:color-mix(in srgb,var(--warning) 14%,var(--surface))}
.blocked{background:color-mix(in srgb,var(--critical) 12%,var(--surface))}
.inflight ul,.blocked ul{list-style:none;margin:6px 0 0;padding:0;font-size:13.5px}
.inflight li{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:10px;align-items:baseline;padding:2px 0}
.inflight li span{overflow-wrap:anywhere}
.inflight time{color:var(--ink-3);font-size:12.5px}
.sg-k{font-size:11.5px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--ink-3)}
.signals{list-style:none;margin:22px 0 0;padding:0}
.signals li{display:grid;grid-template-columns:minmax(0,1fr);gap:4px;padding:14px 0 0;margin-top:14px;border-top:1px solid var(--line);font-size:14px}
@media (min-width:760px){.signals li{grid-template-columns:136px minmax(0,1fr);gap:18px}}
.signals p{margin:4px 0 0;color:var(--ink-2)}
.signals a.mono{font-weight:500}
.lede{font:400 clamp(19px,2.4vw,23px)/1.45 var(--serif);letter-spacing:-.006em;margin:0;color:var(--ink);text-wrap:pretty}
.hero-all .lede{color:var(--ink-2);max-width:62ch}
details>summary{list-style:none;cursor:pointer}
details>summary::-webkit-details-marker{display:none}
.disclose{margin-top:14px}
.disclose>summary{display:inline-flex;align-items:center;gap:6px;font-size:13.5px;font-weight:500;color:var(--ink-2)}
details>summary>svg{transition:transform .2s;color:var(--ink-3)}
details[open]>summary>svg{transform:rotate(180deg)}
.goal{margin:0;padding:0;list-style:none;counter-reset:g;display:grid;gap:12px}
.goal li{counter-increment:g;display:grid;grid-template-columns:30px minmax(0,1fr);font-size:15px}
.goal li::before{content:counter(g,decimal-leading-zero);font:500 12px/2 var(--mono);color:var(--ink-3)}
.clamp p{margin:0 0 10px}
.steps{list-style:none;margin:0;padding:0}
.steps>li{display:grid;grid-template-columns:22px 34px minmax(0,1fr);gap:4px 10px;align-items:start;padding:13px 0;border-bottom:1px solid var(--line);position:relative}
@media (min-width:640px){.steps>li{grid-template-columns:22px 38px minmax(0,1fr) auto}}
.steps>li.fix{padding-left:24px}
.steps>li.fix::before{content:"";position:absolute;left:10px;top:-1px;height:25px;width:12px;border-left:1px solid var(--line-2);border-bottom:1px solid var(--line-2);border-bottom-left-radius:8px}
.st{width:20px;height:20px;border-radius:50%;border:1.5px solid var(--line-2);display:grid;place-items:center;margin-top:1px}
.st svg{width:13px;height:13px}
.done .st{background:var(--ink);border-color:var(--ink);color:var(--page)}
.next .st{border:2px solid var(--ink);--ping:color-mix(in srgb,var(--ink) 30%,transparent);animation:ping 2.4s infinite}
.k{font:500 13px/22px var(--mono);color:var(--ink-3)}
.sb{min-width:0}
.stt{font-size:15px;line-height:1.45}
.todo .stt{font-weight:500}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px}
.tag{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--ink-2);border:1px solid var(--line);border-radius:999px;padding:1px 9px;white-space:nowrap}
.tag a{color:inherit}
.tag i{width:6px;height:6px;border-radius:50%;background:var(--ink-3)}
.risk-high i{background:var(--critical)}.risk-medium i{background:var(--serious)}.risk-low i{background:var(--good)}
.sr{grid-column:3;display:flex;gap:10px;align-items:center;font-size:12.5px}
.sr:empty{display:none}
@media (min-width:640px){.sr{grid-column:auto;justify-content:flex-end;padding-top:2px}}
.tk{font:500 12.5px var(--mono);color:var(--ink-3);cursor:default}
.usage{font-size:14px}
.u-hero{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:14px 24px;margin-bottom:20px}
.u-total{display:flex;flex-direction:column}
.u-n{font:500 clamp(46px,7vw,64px)/1 var(--sans);letter-spacing:-.045em}
.u-l{color:var(--ink-3);font-size:13.5px;margin-top:8px}
.u-models{display:flex;flex-wrap:wrap;gap:6px}
.chip{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:500;border:1px solid var(--line);background:var(--surface);border-radius:999px;padding:5px 12px;cursor:default}
.chip b{font:500 12px var(--mono);color:var(--ink-3)}
.stack{display:flex;gap:2px;height:12px;border-radius:6px;overflow:hidden}
.stack .mix{min-width:3px;transition:opacity .15s;cursor:default}
.stack:hover .mix{opacity:.5}.stack .mix:hover{opacity:1}
.s1{background:var(--s1)}.s2{background:var(--s2)}.s3{background:var(--s3)}
.legend{list-style:none;margin:12px 0 0;padding:0;display:flex;flex-wrap:wrap;gap:8px 24px;font-size:13.5px;color:var(--ink-2)}
.legend li{display:flex;align-items:center;gap:7px;cursor:default}
.legend b{font-weight:500;color:var(--ink)}
.legend em{font:normal 12px var(--mono);color:var(--ink-3)}
.sw{width:10px;height:10px;border-radius:3px;display:inline-block}
.u-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:32px;margin-top:34px}
@media (min-width:860px){.u-grid{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:48px}}
.u-grid-top{margin:0 0 40px}
.u-h{font-size:11.5px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--ink-3);margin-bottom:12px}
.u-h span{text-transform:none;letter-spacing:0;font-weight:400;margin-left:6px}
.u-aside{padding-top:28px}
.u-aside p{margin:0 0 14px;color:var(--ink-2);font-size:14px;max-width:46ch}
.u-aside b{font-weight:600;color:var(--ink)}
.hbars{list-style:none;margin:0;padding:0;display:grid;gap:2px}
.hbars li{display:grid;grid-template-columns:minmax(84px,124px) minmax(0,1fr) 52px;align-items:center;gap:12px;padding:5px 6px;margin:0 -6px;border-radius:8px;cursor:default}
.hbars li:hover{background:var(--hover)}
.hb-l{font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hb-l em{font:normal 11.5px var(--mono);color:var(--ink-3);margin-left:6px}
.hb-t{height:8px}
.hb-t span{display:block;height:100%;background:var(--bar);border-radius:0 4px 4px 0}
.hb-v{font:500 12.5px var(--mono);text-align:right;font-variant-numeric:tabular-nums}
.cols{display:flex;align-items:flex-end;gap:2px;height:132px;border-bottom:1px solid var(--line-2)}
.col{flex:1;max-width:24px;height:100%;display:flex;align-items:flex-end;cursor:default}
.col span{display:block;width:100%;background:var(--bar);border-radius:4px 4px 0 0;transition:opacity .15s}
.cols:hover .col span{opacity:.4}.cols .col:hover span{opacity:1}
.cols-x{display:flex;gap:2px;font:12px var(--mono);color:var(--ink-3);margin-top:7px;height:16px}
.cols-x>span{flex:1;max-width:24px;position:relative}
.cols-x b{position:absolute;top:0;font-weight:400;white-space:nowrap}
.cols-x b.first{left:0}.cols-x b.mid{left:50%;transform:translateX(-50%)}.cols-x b.last{right:0}
.tview{margin-top:10px}
.tview summary{color:var(--ink-3);font-size:12.5px;display:inline-block}
.tview .tbl{margin-top:8px}
.runs{margin-top:30px;border-top:1px solid var(--line)}
.runs>summary{display:flex;align-items:center;gap:8px;padding:14px 0;font-weight:500}
.runs>summary em{font:normal 12px var(--mono);color:var(--ink-3)}
.runs>summary svg{margin-left:auto}
.runs ul{list-style:none;margin:0;padding:0;max-height:520px;overflow:auto}
.runs li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 16px;padding:10px 0;border-top:1px solid var(--line);font-size:13.5px}
@media (min-width:760px){.runs li{grid-template-columns:112px minmax(0,1fr) auto 60px}}
.r-role{font-weight:500}
.r-desc{color:var(--ink-2);grid-column:1/-1;grid-row:2}
.r-meta{color:var(--ink-3);font-size:12.5px;grid-column:1/-1;grid-row:3}
@media (min-width:760px){.r-desc,.r-meta{grid-column:auto;grid-row:auto}}
.r-tok{font:500 12.5px var(--mono);text-align:right;grid-row:1;grid-column:2}
@media (min-width:760px){.r-tok{grid-column:auto}}
.acc details{border-bottom:1px solid var(--line)}
.acc summary{display:grid;grid-template-columns:52px minmax(0,1fr);gap:4px 12px;align-items:baseline;padding:14px 0}
.acc summary:hover .acc-t{color:var(--ink)}
.acc summary .mono{font-weight:500;color:var(--ink)}
.acc-t{color:var(--ink-2);font-size:14.5px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.acc details[open] .acc-t{color:var(--ink);-webkit-line-clamp:unset;display:block}
.acc-m,.acc summary>svg{display:none}
@media (min-width:760px){.acc summary{grid-template-columns:56px minmax(0,1fr) auto 16px}.acc-m{display:block;font-size:12.5px;color:var(--ink-3);white-space:nowrap}.acc summary>svg{display:block;align-self:center}}
.acc-b{padding:0 0 22px}
@media (min-width:760px){.acc-b{padding-left:68px}}
.field{margin:0 0 14px}
.fl{font-size:11.5px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--ink-3);margin-bottom:4px}
.field .md p{margin:0 0 8px}
.tl{list-style:none;margin:0;padding:0 6px 0 0;max-height:640px;overflow:auto;scrollbar-width:thin;-webkit-mask-image:linear-gradient(180deg,#000 calc(100% - 48px),transparent);mask-image:linear-gradient(180deg,#000 calc(100% - 48px),transparent)}
.tl li{display:grid;grid-template-columns:20px minmax(0,1fr);gap:10px;padding:0 0 18px;position:relative}
.tl li::before{content:"";position:absolute;left:5px;top:16px;bottom:0;width:1px;background:var(--line)}
.tl-n{width:11px;height:11px;border-radius:50%;border:1.5px solid var(--line-2);background:var(--page);margin-top:6px;position:relative;z-index:1}
.tl li.tr .tl-n{background:var(--ink);border-color:var(--ink)}
.tl-h{font:500 13px var(--mono);letter-spacing:.01em}
.tl p{margin:2px 0 0;font-size:14px;color:var(--ink-2)}
.tl li.note p{color:var(--ink-3)}
.tl .tl-sub{font-size:13px;color:var(--ink-3)}
.docs{list-style:none;margin:0;padding:0}
.docs a{display:grid;grid-template-columns:18px minmax(0,1fr) auto;gap:10px;align-items:center;text-decoration:none;padding:7px 8px;margin:0 -8px;border-radius:8px;font-size:14px;min-height:40px}
.docs a:hover{background:var(--hover)}
.docs svg{width:16px;height:16px;color:var(--ink-3)}
.docs span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.docs em{font:normal 12px var(--sans);color:var(--ink-3);white-space:nowrap}
.checks{list-style:none;margin:0;padding:0}
.checks li{display:grid;grid-template-columns:62px minmax(0,1fr);gap:10px;padding:9px 0;border-bottom:1px solid var(--line);font-size:13.5px;color:var(--ink-2);cursor:default}
.res{display:inline-flex;align-items:center;gap:5px;font-size:12px;height:22px}
.res b{font-weight:500;color:var(--ink-2)}
.res svg{width:15px;height:15px}
.res.ok svg{color:var(--good-ink)}.res.bad svg{color:var(--critical)}
.feed{list-style:none;margin:0 0 8px;padding:0}
.feed li{display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 10px;padding:10px 0;border-bottom:1px solid var(--line);font-size:13.5px}
.feed li>time{grid-column:2;color:var(--ink-3);font-size:12px}
.feed .k{color:var(--ink-3);margin-right:2px}
.feed p{margin:2px 0 0;color:var(--ink-2)}
.path{font-family:var(--mono);font-size:12.5px;overflow-wrap:anywhere}
.flags{margin:10px 0 0;padding-left:18px;font-size:13.5px;color:var(--ink-2)}
.flags li{margin:0 0 10px}
.hero-all{padding-bottom:36px}
.hero-all h1{max-width:14ch}
.pcards{display:grid;gap:14px;grid-template-columns:minmax(0,1fr)}
@media (min-width:900px){.pcards{grid-template-columns:repeat(2,minmax(0,1fr))}.pcards .pcard.is-live{grid-column:1/-1}}
.pcard{position:relative;display:block;text-decoration:none;background:var(--surface);border:1px solid var(--line);border-radius:20px;padding:22px 22px 20px;transition:border-color .2s,transform .2s,box-shadow .2s}
.pcard:hover{border-color:var(--line-2);box-shadow:var(--shadow);transform:translateY(-1px)}
@media (min-width:760px){.pcard{padding:26px 28px 24px}.pcard.is-live{padding:32px 34px 28px}}
.pc-top{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:13px;padding-right:44px}
.pc-k{margin-top:22px;font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)}
.pcard h3{font:400 clamp(25px,3vw,34px)/1.1 var(--serif);letter-spacing:-.016em;margin:4px 0 10px;max-width:24ch;text-wrap:balance}
.pcard p{margin:0;color:var(--ink-2);font-size:14.5px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;max-width:80ch}
.pc-s{display:flex;flex-wrap:wrap;gap:8px 28px;margin:22px 0 0}
.pc-s dt{font-size:12px;color:var(--ink-3)}
.pc-s dd{margin:0;font:500 18px var(--sans);letter-spacing:-.015em}
.pc-go{position:absolute;right:20px;top:20px;width:36px;height:36px;border-radius:50%;display:grid;place-items:center;border:1px solid var(--line);color:var(--ink-2);transition:all .2s}
.pcard:hover .pc-go{background:var(--ink);color:var(--page);border-color:var(--ink)}
.arch{list-style:none;margin:0;padding:0}
.arch a{display:grid;grid-template-columns:96px minmax(0,1fr) 18px;gap:12px;align-items:center;text-decoration:none;padding:13px 0;border-bottom:1px solid var(--line);font-size:14.5px;min-height:48px}
.arch a svg{color:var(--ink-3);transition:transform .15s}
.arch a:hover svg{transform:translateX(3px);color:var(--ink)}
.arch .mono{font-size:12.5px}
.ledgers{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px;padding-bottom:64px}
.ledgers a{display:flex;flex-direction:column;gap:4px;text-decoration:none;padding:16px;border:1px solid var(--line);border-radius:14px;background:var(--surface);transition:border-color .2s}
.ledgers a:hover{border-color:var(--line-2)}
.ledgers b{font-weight:500}
.ledgers span{font-size:12.5px;color:var(--ink-3)}
.docwrap{padding-bottom:96px}
.doc-h{padding:28px 0 8px;max-width:860px}
@media (min-width:760px){.doc-h{padding-top:44px}}
.back{display:inline-flex;align-items:center;gap:6px;font-size:13.5px;color:var(--ink-2);text-decoration:none;margin-bottom:20px;min-height:32px}
.back:hover{color:var(--ink)}
.doc-t{font-size:clamp(28px,4.6vw,44px);max-width:none;word-break:break-word}
.docgrid{display:grid;grid-template-columns:minmax(0,1fr);gap:20px;margin-top:22px}
@media (min-width:1080px){.docgrid{grid-template-columns:220px minmax(0,1fr);gap:32px}.docgrid.no-toc{grid-template-columns:minmax(0,1fr)}}
.toc{font-size:13.5px;min-width:0}
@media (min-width:1080px){.toc{position:sticky;top:calc(var(--bar-h) + 24px);max-height:calc(100vh - var(--bar-h) - 48px);overflow:auto;scrollbar-width:thin}}
.toc summary{display:flex;align-items:center;justify-content:space-between;font-size:11.5px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--ink-3);padding:12px 0}
.toc ul{list-style:none;margin:0;padding:0;border-left:1px solid var(--line)}
.toc li a{display:block;text-decoration:none;color:var(--ink-3);padding:4px 0 4px 14px;margin-left:-1px;border-left:1px solid transparent;line-height:1.4}
.toc li.l3 a{padding-left:26px;font-size:13px}
.toc li a:hover{color:var(--ink)}
.toc li a.on{color:var(--ink);border-left-color:var(--ink)}
@media (max-width:1079px){.toc{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:2px 16px}.toc ul{border:0;margin-bottom:12px;max-height:50vh;overflow:auto}.toc li a{padding:7px 0;border:0}.toc li.l3 a{padding-left:14px}}
.doc{background:var(--surface);border:1px solid var(--line);border-radius:20px;padding:22px 18px;font-size:15.5px;line-height:1.7;min-width:0}
@media (min-width:760px){.doc{padding:44px 56px}}
.doc>*{max-width:76ch}
.doc>.tbl,.doc>pre{max-width:none}
.md h1{font:400 32px/1.15 var(--serif);margin:0 0 20px;letter-spacing:-.018em;max-width:none}
.md h2{font:400 25px/1.2 var(--serif);letter-spacing:-.012em;margin:44px 0 14px}
.md h3{font:600 16.5px/1.35 var(--sans);letter-spacing:-.01em;margin:30px 0 8px}
.md h4{font:600 14.5px var(--sans);margin:22px 0 6px}
.md>:first-child{margin-top:0}
.md p{margin:0 0 14px}
.md ul,.md ol{padding-left:22px;margin:0 0 14px}
.md li{margin:5px 0}
.md li::marker{color:var(--ink-3)}
.md ul.tasks{list-style:none;padding-left:2px}
.cb{display:inline-grid;place-items:center;width:16px;height:16px;border:1.5px solid var(--line-2);border-radius:5px;margin-right:8px;vertical-align:-3px}
.cb svg{width:11px;height:11px}
.cb.on{background:var(--ink);border-color:var(--ink);color:var(--page)}
.md strong{font-weight:600}
.md pre{background:var(--sunk);border-radius:12px;padding:16px;overflow:auto;font-size:12.5px;line-height:1.55;margin:0 0 16px}
.md pre code{background:none;padding:0;font-size:inherit}
.md blockquote{margin:0 0 16px;padding:2px 0 2px 18px;border-left:2px solid var(--ink);color:var(--ink-2);font:italic 400 17.5px/1.55 var(--serif)}
.md blockquote p{margin:0}
.md hr{border:0;border-top:1px solid var(--line);margin:32px 0}
.tbl{overflow-x:auto;margin:0 0 18px;border:1px solid var(--line);border-radius:12px;-webkit-overflow-scrolling:touch}
.tbl table{border-collapse:collapse;font-size:13.5px;line-height:1.5;min-width:100%}
.tbl th,.tbl td{padding:9px 12px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}
.tbl tr:last-child td{border-bottom:0}
.tbl th{font-weight:600;font-size:12px;letter-spacing:.03em;color:var(--ink-2);background:var(--sunk);white-space:nowrap}
.tbl .num{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums}
.lnk{text-decoration:underline;text-decoration-color:var(--line-2);text-underline-offset:3px}
.tip{position:fixed;z-index:60;pointer-events:none;max-width:300px;background:var(--ink);color:var(--page);font-size:12.5px;line-height:1.45;padding:8px 11px;border-radius:10px;white-space:pre-line;box-shadow:0 10px 30px rgba(0,0,0,.2)}
.palette{position:fixed;inset:0;z-index:70;background:color-mix(in srgb,var(--page) 55%,transparent);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex;justify-content:center;align-items:flex-start;padding:max(10vh,12px) 12px 12px}
.palette[hidden]{display:none}
.pal-box{width:min(640px,100%);background:var(--surface);border:1px solid var(--line);border-radius:18px;box-shadow:0 30px 80px -20px rgba(0,0,0,.35);overflow:hidden;animation:pop .14s ease-out}
.pal-in{display:flex;align-items:center;gap:10px;padding:0 16px;border-bottom:1px solid var(--line)}
.pal-in svg{width:18px;height:18px;color:var(--ink-3)}
.pal-in input{flex:1;min-width:0;height:56px;border:0;background:none;font:400 17px var(--sans);color:var(--ink);outline:none}
.pal-in input::-webkit-search-cancel-button{display:none}
#pal-list{list-style:none;margin:0;padding:6px;max-height:min(60vh,480px);overflow:auto}
#pal-list li a{display:grid;grid-template-columns:72px minmax(0,1fr);gap:2px 12px;padding:10px 12px;border-radius:10px;text-decoration:none}
#pal-list li a b{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#pal-list li a em{grid-column:2;font-style:normal;font-size:12.5px;color:var(--ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#pal-list li a span{grid-row:span 2;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);padding-top:3px}
#pal-list li.on a,#pal-list li a:hover{background:var(--hover)}
#pal-list .none{padding:18px 12px;color:var(--ink-3);font-size:14px}
@keyframes ping{0%{box-shadow:0 0 0 0 var(--ping)}70%,100%{box-shadow:0 0 0 7px transparent}}
@keyframes pop{from{opacity:0;transform:translateY(-4px) scale(.985)}to{opacity:1;transform:none}}
@keyframes rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
.intro .hero>*,.intro .now,.intro .main-col>section,.intro .side-col>section,.intro .pcard,.intro .doc-h,.intro .docgrid{animation:rise .6s cubic-bezier(.2,.7,.2,1) both}
.intro .hero>:nth-child(2){animation-delay:.05s}.intro .hero>:nth-child(3){animation-delay:.1s}.intro .hero>:nth-child(4){animation-delay:.15s}.intro .hero>:nth-child(5){animation-delay:.2s}.intro .hero>:nth-child(6){animation-delay:.25s}
.intro .main-col>:nth-child(1){animation-delay:.28s}.intro .main-col>:nth-child(2){animation-delay:.34s}.intro .side-col>:nth-child(1){animation-delay:.36s}
.intro .pcard{animation-delay:calc(.1s + var(--i,0) * .07s)}
.intro .docgrid{animation-delay:.08s}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
@media print{.bar,.tabs,.palette,.tip{display:none}.now,.doc,.pcard{box-shadow:none}}
`;

// The page script: relative times, theme, remembered <details>, live updates, tooltips, scroll-spy, search.
// Live updates poll assets/live.js by script tag (file:// pages cannot fetch). A page reloads only when its
// own content hash changed: at once for a structural change, at most every 2 min for a usage-only one, and
// never twice for the same version (if a reload did not bring it, the manifest and the file disagree).
const JS = String.raw`
(function () {
  var B = document.body, KEY = B.dataset.key, BASE = B.dataset.base || '';
  var ls = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
  var ss = { get: function (k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} } };
  var loadedAt = Date.now();
  if (!ss.get('pd-seen:' + KEY)) { document.documentElement.classList.add('intro'); ss.set('pd-seen:' + KEY, '1'); }
  var saved = ss.get('pd-scroll:' + KEY);
  if (saved) { ss.set('pd-scroll:' + KEY, ''); requestAnimationFrame(function () { window.scrollTo(0, +saved); }); }

  function ago(ms) { var s = Math.max(0, (Date.now() - ms) / 1000);
    return s < 45 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? (s / 3600).toFixed(s < 36000 ? 1 : 0) + ' h ago' : (s / 86400).toFixed(1) + ' d ago'; }
  function dur(ms) { var m = ms / 60000; return m < 60 ? Math.max(1, Math.round(m)) + ' min' : m < 2880 ? (m / 60).toFixed(m < 600 ? 1 : 0) + ' h' : (m / 1440).toFixed(1) + ' d'; }
  function stampAll() {
    document.querySelectorAll('time[data-ms]').forEach(function (el) { if (!el.title) el.title = el.textContent; el.textContent = ago(+el.dataset.ms); });
    document.querySelectorAll('[data-since]').forEach(function (el) { el.textContent = dur(Date.now() - +el.dataset.since); });
  }
  stampAll(); setInterval(stampAll, 30000);

  function applyTheme(v) {
    if (v === 'light' || v === 'dark') document.documentElement.dataset.theme = v; else delete document.documentElement.dataset.theme;
    document.querySelectorAll('[data-theme-set]').forEach(function (b) { b.classList.toggle('on', b.dataset.themeSet === (v || 'auto')); });
  }
  applyTheme(ls.get('pd-theme'));

  var open = {}; try { open = JSON.parse(ss.get('pd-open') || '{}'); } catch (e) {}
  document.querySelectorAll('details[data-id]').forEach(function (d) {
    if (d.dataset.id in open) d.open = open[d.dataset.id];
    d.addEventListener('toggle', function () { open[d.dataset.id] = d.open; ss.set('pd-open', JSON.stringify(open)); });
  });

  var pill = document.getElementById('live-pill');
  var paused = ls.get('pd-live') === 'off';
  function setLiveButtons() { document.querySelectorAll('[data-live-set]').forEach(function (b) { b.classList.toggle('on', (b.dataset.liveSet === 'off') === paused); }); }
  function setPill(state, label, title) { if (!pill) return; pill.className = 'live-pill ' + state; pill.querySelector('span').textContent = label; pill.title = title; }
  function poll() {
    if (document.hidden) return;
    var s = document.createElement('script');
    s.src = B.dataset.livejs + '?' + Date.now();
    s.onload = function () {
      s.remove(); var pd = window.__pd; if (!pd) return;
      if (paused) setPill('', 'Paused', 'Live updates are paused');
      else if (Date.now() - pd.gen > 150000) setPill('stale', 'Offline', 'The dashboard is not being regenerated (run it with --watch)');
      else setPill('on', 'Live', 'Live — this page updates itself when its content changes');
      var v = pd.v && pd.v[KEY];
      if (!paused && v && v[0] !== B.dataset.hash && v[0] !== ss.get('pd-want:' + KEY) && !String(window.getSelection())) {
        if (v[1] !== B.dataset.shash || Date.now() - loadedAt > 120000) { ss.set('pd-want:' + KEY, v[0]); ss.set('pd-scroll:' + KEY, String(window.scrollY)); location.reload(); }
      }
    };
    s.onerror = function () { s.remove(); setPill('stale', 'Offline', 'Live manifest not found'); };
    document.head.appendChild(s);
  }
  setLiveButtons(); poll(); setInterval(poll, 5000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });

  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-theme-set]'); if (b) { ls.set('pd-theme', b.dataset.themeSet); applyTheme(b.dataset.themeSet); }
    var l = e.target.closest('[data-live-set]'); if (l) { paused = l.dataset.liveSet === 'off'; ls.set('pd-live', paused ? 'off' : 'on'); setLiveButtons(); poll(); }
    document.querySelectorAll('details.menu[open]').forEach(function (m) { if (!m.contains(e.target)) m.open = false; });
  });

  var tipEl = document.getElementById('tip'), tipFor = null;
  function place(x, y) { var w = tipEl.offsetWidth, h = tipEl.offsetHeight, px = Math.min(Math.max(8, x + 14), innerWidth - w - 8), py = y - h - 12; if (py < 8) py = y + 20; tipEl.style.left = px + 'px'; tipEl.style.top = py + 'px'; }
  function showTip(el, x, y) { tipFor = el; tipEl.textContent = el.dataset.tip; tipEl.hidden = false; place(x, y); }
  function hideTip() { tipFor = null; tipEl.hidden = true; }
  document.addEventListener('pointerover', function (e) { var el = e.target.closest('[data-tip]'); if (el && e.pointerType === 'mouse' && el.dataset.tip) showTip(el, e.clientX, e.clientY); });
  document.addEventListener('pointermove', function (e) { if (tipFor && e.pointerType === 'mouse') { if (!tipFor.contains(e.target)) hideTip(); else place(e.clientX, e.clientY); } });
  document.addEventListener('pointerdown', function (e) {
    var el = e.target.closest('[data-tip]');
    if (e.pointerType !== 'mouse' && el && el.dataset.tip) { var r = el.getBoundingClientRect(); if (tipFor === el) hideTip(); else showTip(el, r.left + r.width / 2 - 14, r.top); }
    else if (!el) hideTip();
  });
  addEventListener('scroll', function () { if (tipFor) hideTip(); }, { passive: true });

  function spy(links, margin, onActive) {
    if (!links.length || !('IntersectionObserver' in window)) return;
    var map = {}; links.forEach(function (a) { var id = decodeURIComponent(a.hash.slice(1)); if (document.getElementById(id)) map[id] = a; });
    var io = new IntersectionObserver(function (es) { es.forEach(function (en) { if (en.isIntersecting && map[en.target.id]) { links.forEach(function (a) { a.classList.remove('on'); }); map[en.target.id].classList.add('on'); if (onActive) onActive(map[en.target.id]); } }); }, { rootMargin: margin });
    Object.keys(map).forEach(function (id) { io.observe(document.getElementById(id)); });
  }
  spy([].slice.call(document.querySelectorAll('.tabs a')), '-130px 0px -60% 0px', function (a) { var bar = a.parentNode; bar.scrollTo({ left: a.offsetLeft - bar.clientWidth / 2 + a.clientWidth / 2, behavior: 'smooth' }); });
  spy([].slice.call(document.querySelectorAll('.toc a')), '-90px 0px -75% 0px');

  // Search: opened from the search button; Esc closes, arrows + Enter pick a result.
  var pal = document.getElementById('palette'), q = document.getElementById('pal-q'), list = document.getElementById('pal-list'), sel = 0, results = [];
  var RANK = { Plan: 0, Page: 1, Ledger: 2, Doc: 3, Decision: 4 };
  function render() {
    var words = q.value.toLowerCase().split(/\s+/).filter(Boolean), idx = window.__pdSearch || [], phrase = words.join(' ');
    results = idx.filter(function (it) { var h = (it.t + ' ' + it.s + ' ' + it.k).toLowerCase(); return words.every(function (w) { return h.indexOf(w) >= 0; }); })
      .filter(function (it) { return words.length || it.k !== 'Decision'; })
      .sort(function (a, b) { return (b.t.toLowerCase().indexOf(phrase) >= 0) - (a.t.toLowerCase().indexOf(phrase) >= 0) || RANK[a.k] - RANK[b.k]; })
      .slice(0, 60);
    sel = 0; list.innerHTML = '';
    if (!results.length) { list.innerHTML = '<li class="none">Nothing matches.</li>'; return; }
    results.forEach(function (it, i) {
      var li = document.createElement('li'), a = document.createElement('a'), k = document.createElement('span'), b = document.createElement('b'), em = document.createElement('em');
      if (i === 0) li.className = 'on';
      a.href = BASE + it.u; k.textContent = it.k; b.textContent = it.t; em.textContent = it.s;
      a.appendChild(k); a.appendChild(b); a.appendChild(em); li.appendChild(a); list.appendChild(li);
    });
  }
  function move(d) { var items = list.querySelectorAll('li'); if (!results.length) return; items[sel].classList.remove('on'); sel = (sel + d + results.length) % results.length; items[sel].classList.add('on'); items[sel].scrollIntoView({ block: 'nearest' }); }
  function openPal() { pal.hidden = false; q.value = ''; render(); setTimeout(function () { q.focus(); }, 0); }
  function closePal() { pal.hidden = true; }
  document.addEventListener('click', function (e) { if (e.target.closest('[data-open-search]')) { e.preventDefault(); openPal(); } else if (e.target === pal) closePal(); });
  q.addEventListener('input', render);
  document.addEventListener('keydown', function (e) {
    if (pal.hidden) { if (e.key === 'Escape') hideTip(); return; }
    if (e.key === 'Escape') closePal();
    else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter' && results[sel]) { e.preventDefault(); location.href = BASE + results[sel].u; }
  });
})();
`;

// ---------- CLI ----------
const USAGE = `Usage: node dashboard.mjs [--watch] [--open] [--out <file.html>] [--plan <plan-id>] [--no-usage] [--interval <seconds>]

Writes a read-only HTML view of plans/ (this repo and its git worktrees) and prints where it is.
  --watch            keep regenerating; open pages update themselves (backs off to 60 s while idle)
  --interval <s>     watch interval in seconds (default 10)
  --open             open the dashboard in the default browser
  --out <file.html>  where to write it, a .html or .htm file (default: a private per-user folder in the OS temp dir)
                     an explicit --out is used as given, with no privacy check
  --plan <plan-id>   treat this plan as the live one (default: plans/.current_plan, else the most recent)
  --no-usage         skip token usage (read from Claude Code's session logs under $CLAUDE_CONFIG_DIR or ~/.claude)`;

export function parseArgs(argv) {
  const o = { watch: false, open: false, usage: true, interval: 10, out: null, plan: null, help: false, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], val = () => { const v = argv[i + 1]; if (v === undefined || v.startsWith("--")) { o.error = `${a} needs a value`; return null; } i++; return v; };
    if (a === "--watch") o.watch = true;
    else if (a === "--open") o.open = true;
    else if (a === "--no-usage") o.usage = false;
    else if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--out") { o.out = val(); if (o.out !== null) o.error ||= validateOut(o.out); }
    else if (a === "--plan") o.plan = val();
    else if (a === "--interval") { const n = Number(val()); if (!(n >= 1)) o.error ||= "--interval needs a number of seconds (>= 1)"; else o.interval = n; }
    else o.error ||= `unknown option: ${a}`;
  }
  return o;
}

// The opener for a platform, as [command, args], with the file as exactly one argument and no shell.
// Exported so the Windows branch can be tested on a host that is not Windows.
// DECISION plan-2026-10-06T182322-ea385857/D-004: on Windows use explorer.exe, never `cmd /c start`:
// cmd re-parses & ^ | % in the path (a folder named a&b splits the command); explorer takes it as one argument.
export function openCommand(platform, file) {
  if (platform === "win32") return ["explorer.exe", [file]];
  if (platform === "darwin") return ["open", [file]];
  return ["xdg-open", [file]];
}

function openInBrowser(file) {
  const [cmd, args] = openCommand(process.platform, file);
  // A missing opener is reported as an async "error" event, not a throw; with no listener it would crash
  // the run after the page was written. The path is printed either way.
  try { spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref(); } catch { /* the path is printed either way */ }
}

const isEntryPoint = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(USAGE); process.exit(0); }
  if (o.error) { console.error(`dashboard: ${o.error}\n\n${USAGE}`); process.exit(2); }
  const dash = createDashboard({ repo: process.cwd(), out: o.out, pinned: o.plan, projectsDir: o.usage ? undefined : null, watch: o.watch });
  // A refusal (EDASHBOARD) is one line; anything else keeps its stack.
  const fail = (e) => { console.error(e.code === "EDASHBOARD" ? `dashboard: ${e.message}` : e.stack || e.message); process.exit(1); };
  try { dash.generate(); dash.flush(); } catch (e) { fail(e); }
  console.log(`Dashboard: ${dash.entry}`);
  if (o.open) openInBrowser(dash.entry);
  if (o.watch) {
    console.log(`Watching every ${o.interval}s (backing off to 60s while nothing changes). Ctrl-C to stop.`);
    let wait = o.interval;
    const tick = () => {
      let changed = true;
      // A refused folder stays refused, so stop; any other error may pass (a file mid-save), so keep watching.
      try { changed = dash.generate(); } catch (e) { if (e.code === "EDASHBOARD") fail(e); console.error(e.stack || e.message); }
      wait = changed ? o.interval : Math.min(Math.round(wait * 1.5), 60);
      setTimeout(tick, wait * 1000);
    };
    setTimeout(tick, o.interval * 1000);
    for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { try { dash.flush(); } catch (e) { fail(e); } process.exit(0); });
  }
}
