# Blast Radius Reference

Per-edit informational signal. Surfaces how far an individual file edit reaches. Never blocks execution. Computed by `scripts/blast-radius.mjs` and recorded in `{plan-dir}/changelog.md` field 6.

## Goal

A small change in a shared module can ripple to dozens of callers. A large change in an isolated leaf is local. The plan-level Failure Modes table sees this only at coarse grain. Blast radius surfaces it **per file edit** so the per-edit changelog tells the truth: "tiny edit, big radius" stops being invisible.

## Tiers

| Tier | Score | Meaning |
|---|---|---|
| `LOW(N)` | 0–2 | Localized, safe to interpret as low-risk on its own |
| `MED(N)` | 3–5 | Reaches multiple callers or shared paths; warrants a glance at REFLECT |
| `HIGH(N)` | ≥6 | Wide reach (shared module, public API, many reverse deps); reviewer must surface it |
| `UNKNOWN(reason)` | — | Could not score (no git, binary file, script unavailable). Inform-only. |

The numeric score is the sum of signal weights below. Tier is for triage; the score lets reviewers compare two HIGH edits.

## Signals

| Signal | Range | Source / heuristic |
|---|---|---|
| LOC churn | 0–3 | `git diff --numstat` (added + removed): ≤20 → 0, 21–80 → 1, 81–200 → 2, >200 → 3 |
| Reverse-dep count | 0–3 | grep across repo for imports/requires of this file. 0 → 0, 1–5 → 1, 6–20 → 2, >20 → 3 |
| Shared-path flag | 0 or 2 | path matches `(^|/)(lib|core|shared|common|utils|types)/` (case-insensitive) |
| Public-API touch | 0 or 2 | diff added line matches `^\+\s*(export\b|pub\s|public\s|def\s+[a-z])` (extension-aware) |
| Test coverage delta | 0 or -1 | tests in same iteration added/modified for this file (subtracts 1 — testing reduces effective radius) |
| Iteration history | 0 or 1 | file appeared in a previous iteration's manifest in the same plan (proximity to 3-strike) |

Signals are intentionally cheap. No AST, no language server, no LLM. False negatives on dynamic dispatch are accepted.

## Output format

CLI:
```
node scripts/blast-radius.mjs <file>
```
Stdout (single line, exit 0):
```
radius:LOW(2) loc=1 deps=1 shared=0 api=0 tests=0 hist=0
```
Field 1 is what the executor pastes into changelog.md field 6. Remaining fields are the per-signal breakdown for `--verbose`.

Failure modes:
- No git → `radius:UNKNOWN(no-git)`
- Binary / unreadable → `radius:UNKNOWN(unreadable)`
- File not in repo (deleted prior, untracked) → `radius:UNKNOWN(not-tracked)`

## Limitations (known false negatives)

- Dynamic dispatch (Ruby metaprogramming, Python decorators, Go interface satisfaction) under-counts reverse deps.
- Dependency injection containers and string-based references (e.g. `service_locator.get("foo")`) are invisible to grep.
- Re-exports through barrel files inflate or hide reverse-dep count depending on grep pattern.
- Generated code: a small change in a generator template can have huge ripple invisible to git diff (only the template is in diff).

These limitations are documented but not patched. Radius is **informative**, not authoritative.

## When to read radius

- **Reviewer at REFLECT** (iter ≥ 2): scan changelog for HIGH and "tiny+broad" outliers (LOW LOC + HIGH overall = small fix in a hot file). Surface in `findings/review-iter-N.md`.
- **Executor mid-step**: not used to gate. May log in commit message footer.
- **CLOSE summary**: optional — if any HIGH edits, list them in `summary.md` for posterity.

## Anti-patterns

- Treating radius as a hard rule. It's a heuristic. Tier hopping every iteration is fine.
- Tuning thresholds to game the score. The point is surfacing outliers, not optimizing a number.
- Computing radius for plan-level decisions. That's what Failure Modes already does.
