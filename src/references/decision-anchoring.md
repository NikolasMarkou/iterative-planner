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

- **One comment block per decision, at point of impact.** Not scattered across files.
- **Reference the qualified decision ID** (`plan_X/D-NNN`). Full story lives in that plan's `decisions.md`.
- **State what NOT to do** and why. Prevent regression, not explain implementation.
- **Strip anchors for reverted code.** Anchors only live on surviving code.
- **Don't anchor trivial choices.** Only when real decision history exists.
- **Plan-id is the active plan's directory name** at the time the anchor is placed (e.g. `plan_2026-05-07_7556fb98`). It does not change if the anchor is later moved within the same codebase.

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
- All STALE anchors MUST be removed before CLOSE. The CLOSE audit lists them as blockers if any remain.
- The validator MAY downgrade STALE orphans (STALE anchor with no backing entry) to WARN rather than ERROR — but plain (non-STALE) orphans remain ERROR.

## Expiration Handling

Anchors are permanent in code; their backing decision context lives in per-plan `decisions.md` (kept in `plans/<plan-id>/`) and `plans/DECISIONS.md` (sliding-window trimmed to 4 plans).

**Plan-qualified anchors** close the historical orphan gap: even after `plans/DECISIONS.md` rotates an old plan out, the anchor names the originating plan directory directly. Resolvers (validator, humans) consult:

1. The plan's per-plan `plans/<plan-id>/decisions.md` (always the source of truth, never trimmed).
2. The consolidated `plans/DECISIONS.md` `## <plan-id>` section if still within the sliding window.
3. The plan's `summary.md` `## Decision Anchors Registry` (forward-only mitigation for critical-path anchors).

If the plan directory itself has been deleted from the project (rare — plan dirs are gitignored and ephemeral), the anchor remains a permanent breadcrumb pointing at the absent plan-id; the registry copy in `summary.md` is the last resort.

**Migration note**: bare `D-NNN` anchors (pre-v2.14.0) lack the prefix. Validator emits `WARN [anchor-unqualified]` and resolves them against the active plan's `decisions.md` only. New anchors should always be qualified.

## Audit at CLOSE

Before `summary.md`: scan `decisions.md` for failed alternatives / 3-strike pivots. Verify corresponding code has anchor comments with the active plan-id prefix. Plan directory is ephemeral — anchors in code outlive it.

In `summary.md`:
- List files with anchors and which qualified `<plan-id>/D-NNN` they reference.
- Maintain the `## Decision Anchors Registry` block for critical-path anchors so the rationale survives even if the plan directory itself is later removed.
