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

`Score = Σ(signal weights)`. Tier = triage label; score = comparison within tier.

## Signals

| Signal | Range | Source / heuristic |
|---|---|---|
| LOC churn | 0–3 | `git diff --numstat` (added + removed): ≤20 → 0, 21–80 → 1, 81–200 → 2, >200 → 3 |
| Reverse-dep count | 0–3 | grep across repo for imports/requires of this file. 0 → 0, 1–5 → 1, 6–20 → 2, >20 → 3 |
| Shared-path flag | 0 or 2 | path matches `(^|/)(lib|core|shared|common|utils|types)/` (case-insensitive) |
| Public-API touch | 0 or 2 | diff added line matches `^\+\s*(export\b|pub\s|public\s|def\s+[a-z]|func\s+[A-Z])` (extension-aware; `func\s+[A-Z]` covers Go exported funcs) |
| Test coverage delta | 0 or -1 | tests in same iteration added/modified for this file (subtracts 1 — testing reduces effective radius) |
| Iteration history | 0 or 1 | file appeared in a previous iteration's manifest in the same plan (proximity to 3-strike) |

Signals are intentionally cheap. No AST, no language server, no LLM. False negatives on dynamic dispatch are accepted.

## Untracked / new files (the `CREATE` case)

**A file does not need to be staged or committed to be scored.** Score a file the moment you write it; the result is identical to the score after `git add`.

`git diff HEAD` excludes untracked files by design, so the diff-driven signals would report `0` for a brand-new file — the `OP=CREATE(+N)` case, and usually the riskiest edit. The scorer therefore probes tracked-ness (`git ls-files --error-unmatch`) and, for an untracked-but-existing file, **synthesizes the CREATE diff from the file's content**:

| Signal | Untracked (new file) behavior |
|---|---|
| LOC churn | `added` = the file's line count, `removed` = 0 (a trailing newline is a terminator, not a line; an empty file is `added = 0`). Same 0–3 thresholds. |
| Public-API touch | Scans the file **body** instead of diff `+` lines — every line of a new file is an added line. Same pattern, same 0-or-2 score. |
| Test coverage delta | The changed-file set unions `git diff --name-only` with the untracked entries of `git status --porcelain`, so a **new** test file written alongside a new module still counts. |
| Reverse-dep / shared-path / iteration-history | Unchanged — none of them read the diff. |

Tracked files keep the exact diff-driven path: their scores are unaffected by this synthesis (pinned by a regression test). Untracked files that are binary, a directory, or nonexistent still fall through to the `UNKNOWN(...)` guards below.

**Do not** `git add` a file just to score it — the scorer is advisory and never mutates the index.

## Output format

CLI:
```
node <skill-path>/scripts/blast-radius.mjs <file>              # default — single line
node <skill-path>/scripts/blast-radius.mjs <file> --verbose    # add per-signal breakdown
node <skill-path>/scripts/blast-radius.mjs <file> --json       # machine-readable JSON
```
Stdout (default, single line, exit 0):
```
radius:LOW(2)
```
With `--verbose`:
```
radius:LOW(2) loc=1(+12,-3) deps=1(2) shared=0 api=0(0) tests=0 hist=0
```
Field 1 (`radius:TIER(score)`) is what the executor pastes into changelog.md field 6. Remaining fields are the per-signal breakdown; counts in parens are LOC added/removed, reverse-dep count, public-API hit count.

`--json` mode emits a structured object with `tier`, `score`, `file`, and a `signals` map.

Failure modes (all exit 0; informational):
- No git in tree → `radius:UNKNOWN(no-git)`
- Binary / unreadable → `radius:UNKNOWN(unreadable)`
- File not on disk and not in the diff (deleted prior, never existed) → `radius:UNKNOWN(not-tracked)`
- Target path is a directory → `radius:UNKNOWN(is-directory)`
- No file argument supplied → `radius:UNKNOWN(no-file-arg)`

## Limitations (known false negatives)

- Dynamic dispatch (Ruby metaprogramming, Python decorators, Go interface satisfaction) under-counts reverse deps.
- Dependency injection containers and string-based references (e.g. `service_locator.get("foo")`) are invisible to grep.
- Re-exports through barrel files inflate or hide reverse-dep count depending on grep pattern.
- Generated code: a small change in a generator template can have huge ripple invisible to git diff (only the template is in diff).

These limitations are documented but not patched. Radius is **informative**, not authoritative.

## Usage

| Actor | When | Action |
|---|---|---|
| Reviewer (iter ≥ 2) | REFLECT | Scan changelog for HIGH + tiny-LOC/HIGH-score outliers → surface in `findings/review-iter-N.md` |
| Executor | mid-step | Informational only; may log in commit footer. Never gates. |
| CLOSE | optional | List HIGH edits in `summary.md` |

## Anti-patterns

- Treating tier as a hard gate — radius is informational.
- Tuning thresholds — the point is outlier surfacing, not score optimization.
- Plan-level decisions from radius — that's Failure Modes' job.
