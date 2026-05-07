# Decision Anchoring Reference

Code from failed iterations carries invisible context. Without anchors → someone "fixes" a deliberate choice back to known-broken.

## When to Anchor

Add `# DECISION D-NNN` when ANY apply:

- Code implements approach chosen **after a prior approach failed**
- Implementation is **non-obvious** ("why not do X instead?")
- Simpler-looking alternative was **deliberately rejected**
- Code works around a **framework/library/dependency constraint**
- **3-strike** forced a different approach

## Format

Short. Reference decision ID from `decisions.md`. Enough to stop blind changes + pointer to full story.

```python
# DECISION D-003: Using stateless tokens instead of dual-write.
# Dual-write doubled Redis memory due to 30-day TTLs (see decisions.md D-002, D-003).
# Do NOT switch back to session-store-based approach without addressing memory growth.
def create_token(user):
    ...
```

```ruby
# DECISION D-005: Calling Redis directly, not through SessionStore.
# SessionStore#find deserializes into cookie format, which breaks token flow.
# Three attempts to adapt SessionStore failed (see decisions.md D-003..D-005).
def authenticate!(request)
  token = Redis.current.get("token:#{extract_token(request)}")
  ...
end
```

## Rules

- **One comment block per decision, at point of impact.** Not scattered across files.
- **Reference decision ID** (`D-NNN`). Full story lives in `decisions.md`.
- **State what NOT to do** and why. Prevent regression, not explain implementation.
- **Strip anchors for reverted code.** Anchors only live on surviving code.
- **Don't anchor trivial choices.** Only when real decision history exists.

## Formal Grammar

The validator and any tooling MUST recognize anchors via these regex patterns. The leading comment marker is language-driven (extension dispatch). The token after the marker is `DECISION`, then `D-` followed by exactly three digits, optionally followed by ` [STALE]`, then either end-of-line, whitespace, or `:`.

| Style | Comment marker | Regex (anchor first line) |
|---|---|---|
| Hash-comment (Python, Ruby, shell, YAML, TOML, R, Perl, Makefile) | `#` | `^\s*#\s+DECISION\s+D-\d{3}(\s+\[STALE\])?(:|\s|$)` |
| Slash-comment (JS, TS, Go, Rust, C, C++, Java, Swift, Kotlin, Scala, C#, PHP) | `//` | `^\s*//\s+DECISION\s+D-\d{3}(\s+\[STALE\])?(:|\s|$)` |
| Block-comment (C, C++, Java, JS, CSS, etc.) | `/* */` | `/\*\s*DECISION\s+D-\d{3}(\s+\[STALE\])?.*?\*/` |
| HTML / Markdown | `<!-- -->` | `<!--\s*DECISION\s+D-\d{3}(\s+\[STALE\])?.*?-->` |
| SQL | `--` | `^\s*--\s+DECISION\s+D-\d{3}(\s+\[STALE\])?(:|\s|$)` |

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

- The `D-NNN` identifier MUST appear on the **first** line.
- Subsequent comment lines extend the rationale until the first non-comment line or blank line.
- One block per decision. Multiple decisions at the same location → multiple blocks, each with its own first line.

## `[STALE]` Marker

When code is reverted but the anchor cannot be removed in the same pass (e.g. during PIVOT triage when scope is being narrowed before commit), mark the anchor as `[STALE]`:

```python
# DECISION D-007 [STALE]: Reverted during PIVOT to approach C — see decisions.md D-009.
```

- STALE anchors signal "this anchor's referenced code path no longer applies but the marker is preserved temporarily for traceability."
- All STALE anchors MUST be removed before CLOSE. The CLOSE audit lists them as blockers if any remain.
- The validator MAY downgrade STALE orphans (STALE anchor with no backing `D-NNN` entry) to WARN rather than ERROR — but plain (non-STALE) orphans remain ERROR.

## Expiration Handling

Anchors are permanent in code; their backing `D-NNN` context lives in per-plan `decisions.md` (ephemeral after CLOSE) and `plans/DECISIONS.md` (sliding-window trimmed to 8 plans). Once trimmed, an old anchor cannot be resolved from consolidated files alone — a known limitation.

**Mitigation (partial)**: at CLOSE, the archivist copies decision text for **critical-path anchors** (anchors on surviving production code) into a permanent `## Decision Anchors` registry block in `summary.md`. Each entry records file:line, `D-NNN`, the Trade-off line, and the "what NOT to do" line. This makes `summary.md` self-contained for its anchors after consolidated files rotate. Full cross-plan D-NNN globalization remains deferred (Theme 4).

## Audit at CLOSE

Before `summary.md`: scan `decisions.md` for failed alternatives / 3-strike pivots. Verify corresponding code has anchor comments. Plan directory is ephemeral — anchors in code outlive it.

In `summary.md`: list files with anchors and which `D-NNN` they reference.
