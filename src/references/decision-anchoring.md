# Decision Anchoring Reference

Code from failed iterations carries invisible context. Without anchors → someone "fixes" a deliberate choice back to known-broken.

## When to Anchor

Add `# DECISION plan_YYYY-MM-DD_XXXXXXXX/D-NNN` when ANY apply:

- Code implements approach chosen **after a prior approach failed**
- Implementation is **non-obvious** ("why not do X instead?")
- Simpler-looking alternative was **deliberately rejected**
- Code works around a **framework/library/dependency constraint**
- **3-strike** forced a different approach

## Format

Anchors carry the originating plan's directory name as a prefix on the decision ID. This makes anchors globally unambiguous and resolvable even after `plans/DECISIONS.md` sliding-window trim drops the originating plan section.

**Canonical form**: `# DECISION <plan-id>/D-NNN`

```python
# DECISION plan_2026-01-15_a3f1b2c9/D-003: Using stateless tokens instead of dual-write.
# Dual-write doubled Redis memory due to 30-day TTLs (see plan_2026-01-15_a3f1b2c9 D-002, D-003).
# Do NOT switch back to session-store-based approach without addressing memory growth.
def create_token(user):
    ...
```

```ruby
# DECISION plan_2026-01-15_a3f1b2c9/D-005: Calling Redis directly, not through SessionStore.
# SessionStore#find deserializes into cookie format, which breaks token flow.
# Three attempts to adapt SessionStore failed (see decisions.md D-003..D-005).
def authenticate!(request)
  token = Redis.current.get("token:#{extract_token(request)}")
  ...
end
```

Short. Reference decision ID from the named plan's `decisions.md`. Enough to stop blind changes + pointer to full story.

### Bare anchors (legacy, deprecated)

Pre-v2.14.0 anchors lacking the plan-id prefix:

```python
# DECISION D-003: <legacy form, predates plan-id qualification>
```

The validator accepts bare anchors but emits `WARN [anchor-unqualified]` to nudge migration. Resolution falls back to the active plan's `decisions.md`. New anchors MUST be qualified.

## Rules

- One comment block per decision, at point of impact.
- Reference qualified decision ID (`plan_X/D-NNN`). Full story in that plan's `decisions.md`.
- State what NOT to do and why (prevent regression, not explain implementation).
- Strip anchors for reverted code.
- Don't anchor trivial choices.
- Plan-id = active plan's directory name at anchor placement time (e.g. `plan_2026-05-07_7556fb98`); does not change if anchor is moved.

## Formal Grammar

The validator and any tooling MUST recognize anchors via these regex patterns. The leading comment marker is language-driven (extension dispatch). The token sequence after the marker is `DECISION`, an optional plan-id prefix `<plan_YYYY-MM-DD_XXXXXXXX>/`, then `D-` followed by exactly three digits, optionally followed by ` [STALE]`, then either end-of-line, whitespace, or `:`.

The plan-id prefix matches `plan_\d{4}-\d{2}-\d{2}_[0-9a-f]+` (the bootstrap plan-directory format).

| Style | Comment marker | Regex (anchor first line) |
|---|---|---|
| Hash-comment (Python, Ruby, shell, YAML, TOML, R, Perl, Makefile) | `#` | `^\s*#\s+DECISION\s+(?:plan_\d{4}-\d{2}-\d{2}_[0-9a-f]+\/)?D-\d{3}(\s+\[STALE\])?(:|\s|$)` |
| Slash-comment (JS, TS, Go, Rust, C, C++, Java, Swift, Kotlin, Scala, C#, PHP) | `//` | `^\s*//\s+DECISION\s+(?:plan_\d{4}-\d{2}-\d{2}_[0-9a-f]+\/)?D-\d{3}(\s+\[STALE\])?(:|\s|$)` |
| Block-comment (C, C++, Java, JS, CSS, etc.) | `/* */` | `/\*\s*DECISION\s+(?:plan_\d{4}-\d{2}-\d{2}_[0-9a-f]+\/)?D-\d{3}(\s+\[STALE\])?.*?\*/` |
| HTML / Markdown | `<!-- -->` | `<!--\s*DECISION\s+(?:plan_\d{4}-\d{2}-\d{2}_[0-9a-f]+\/)?D-\d{3}(\s+\[STALE\])?.*?-->` |
| SQL | `--` | `^\s*--\s+DECISION\s+(?:plan_\d{4}-\d{2}-\d{2}_[0-9a-f]+\/)?D-\d{3}(\s+\[STALE\])?(:|\s|$)` |

The plan-id prefix is an **optional non-capturing group** in each regex. Captured groups (in order): plan-id (if present, captured separately for resolution), STALE marker. Implementations may capture either or both as named groups.

**Extension matrix** — validator dispatches by file extension:

| Extensions | Marker style |
|---|---|
| `.py .rb .sh .bash .zsh .yml .yaml .toml .r .pl .pm Makefile .mk .tf` | Hash |
| `.js .jsx .ts .tsx .mjs .cjs .go .rs .c .h .cpp .hpp .cc .java .swift .kt .scala .cs .php` | Slash and Block |
| `.css .scss .less` | Block |
| `.html .htm .md .mdx .vue .svelte` | HTML (and Slash inside `<script>`) |
| `.sql` | Double-dash and Block |

Files outside this matrix are skipped by the reverse-anchor scan.

### Markdown and HTML (implemented in v2.32.0)

`.md` is inside the scanned-extension set (`ANCHOR_SOURCE_EXTS`) of **both** `src/scripts/validate-plan.mjs` and `src/scripts/bootstrap.mjs retire`. Before v2.32.0 the HTML / Markdown row of the grammar table above described a form that no tool implemented; Markdown was a blind spot in which an orphan anchor could sit indefinitely, invisible to the validator and unreachable by `retire`. Three consequences:

- **Only the HTML-comment opener form is recognized in Markdown.** An anchor in a `.md` file must be an HTML comment whose first token after the opener is `DECISION`. Nothing else in a `.md` file is an anchor. A `#`- or `//`-style example inside a fenced code block — such as the Python and Ruby snippets under § Format above — is prose, not an anchor: the hash, slash, and SQL scans are extension-gated, and `.md` appears in none of their extension lists.
- **The block-comment scan is gated off for HTML-style extensions** (`.md`, `.markdown`, `.mdx`, `.html`, `.htm`, via `HTML_STYLE_EXTS`). Block-comment delimiters occur as ordinary prose in Markdown, and that scan's inner regex has no comment-marker prefix — see the placeholder-id rule below.
- **`retire` stamps exactly what the validator scans.** `bootstrap.mjs cmdRetire` selects an HTML-scoped matcher for `.md`, so bare-prose `DECISION <plan-id>/D-NNN` text in Markdown is left untouched by the irreversible `[STALE]` rewrite.

## Writing About Anchors — Placeholder Ids Are Mandatory

> **Rule.** Documentation examples of anchors — in Markdown **or** in source comments — MUST use placeholder ids (`<plan-id>`, `D-NNN`). A concrete `plan_YYYY-MM-DD_hex/D-NNN`, or a bare `D-` followed by three digits, inside a scanned comment becomes a **real, reportable anchor**.

This rule is **not Markdown-specific**. It holds for every extension in `ANCHOR_SOURCE_EXTS`.

**Why.** The block-comment scan's inner regex carries **no comment-marker prefix**: it matches the bare `DECISION` + id token sequence anywhere inside a block comment. A comment that *quotes* a block-comment example is therefore indistinguishable from the example itself.

The canonical instance is `CHANGELOG.md:331` — the release note describing a previous fix to this very scanner, which quotes an illustrative block comment holding two bare three-digit decision ids, purely as prose about the bug being fixed. Before the HTML-extension gate landed, adding `.md` to the scanned set turned that line into an immediate `ERROR [anchor-orphan]` plus two `WARN [anchor-unqualified]`, exit 1: the repository failing its own gate on a sentence about the gate.

The hazard is **not** confined to Markdown. The same trap fired inside `src/scripts/validate-plan.mjs` — a `.mjs` file, where the block scan correctly still runs — when a `NOTE:` comment reproduced that snippet verbatim. Describe block-comment delimiters in prose; do not reproduce a delimiter pair around a concrete id.

Placeholder examples are inert **by construction**, not by exclusion list: `<plan-id>` fails the plan-id pattern `plan_\d{4}-\d{2}-\d{2}_[0-9a-f]+`, and `D-NNN` fails `D-\d{3}`. Neither can ever be reported.

## Multi-line Anchors

Anchors may span multiple comment lines for longer rationale. Rules:

- The qualified `<plan-id>/D-NNN` identifier MUST appear on the **first** line.
- Subsequent comment lines extend the rationale until the first non-comment line or blank line.
- One block per decision. Multiple decisions at the same location → multiple blocks, each with its own first line.

## `[STALE]` Marker

When code is reverted but the anchor cannot be removed in the same pass (e.g. during PIVOT triage when scope is being narrowed before commit), mark the anchor as `[STALE]`:

```python
# DECISION plan_2026-01-15_a3f1b2c9/D-007 [STALE]: Reverted during PIVOT to approach C — see decisions.md D-009.
```

- STALE anchors signal "this anchor's referenced code path no longer applies but the marker is preserved temporarily for traceability."
- All STALE anchors SHOULD be removed before CLOSE. The CLOSE audit flags them so the agent can decide: remove (preferred), keep with explicit rationale in `summary.md` Decision Anchors Registry, or convert to a non-STALE anchor referencing a fresh decision entry.
- The validator emits WARN (not ERROR) for STALE orphans (STALE anchor with no backing entry) — plain (non-STALE) orphans remain ERROR. WARN is non-blocking; the agent owns the disposition.

## Expiration Handling

Anchors are permanent in code; backing context lives in per-plan `decisions.md` + consolidated `plans/DECISIONS.md` (sliding-window trimmed to 4 plans). Plan-qualified anchors close the historical orphan gap.

Resolver order:

| # | Source | Note |
|---|---|---|
| 1 | `plans/<plan-id>/decisions.md` | source of truth, never trimmed |
| 2 | `plans/DECISIONS.md ## <plan-id>` | if within sliding window |
| 3 | `summary.md ## Decision Anchors Registry` | forward-only mitigation for critical-path anchors |

If the plan directory is deleted (rare), anchor remains a breadcrumb; registry copy in `summary.md` is the last resort.

**Migration**: bare `D-NNN` anchors (pre-v2.14.0) lack prefix → validator `WARN [anchor-unqualified]`, resolved against active plan's `decisions.md`. New anchors MUST be qualified.

## Audit at CLOSE

Before `summary.md`: scan `decisions.md` for failed alternatives / 3-strike pivots. Verify corresponding code has anchor comments with the active plan-id prefix. Plan directory is ephemeral — anchors in code outlive it.

In `summary.md`:
- List files with anchors and which qualified `<plan-id>/D-NNN` they reference.
- Maintain the `## Decision Anchors Registry` block for critical-path anchors so the rationale survives even if the plan directory itself is later removed.
