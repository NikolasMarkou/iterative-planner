# File Formats Reference

Templates and examples for every `{plan-dir}` file.

<!-- TEMPLATE:state -->
## state.md

Single source of truth for "where am I?"

```markdown
# Current State: EXECUTE
*Skill: iterative-planner vX.Y.Z*
## Iteration: 3
## Current Plan Step: 2 of 5
## Pre-Step Checklist (reset before each EXECUTE step)
- [x] Re-read state.md (this file)
- [x] Re-read plan.md
- [x] Re-read progress.md
- [ ] Re-read decisions.md (if fix attempt)
- [x] Checkpoint created (if risky step or irreversible op)
## Fix Attempts (resets per plan step)
- (none yet for current step)
## Change Manifest (current iteration)
- [x] `lib/session/token_service.rb` — CREATED (step 1, committed abc123)
- [ ] `app/middleware/auth.rb` — MODIFIED lines 23-45 (step 2, uncommitted)
- [ ] `config/initializers/session.rb` — MODIFIED (step 2, uncommitted)
## Last Transition: PLAN → EXECUTE (approved by user)
## Transition History:
- EXPLORE → PLAN (gathered enough context on auth system)
- PLAN → EXECUTE (user approved approach A)
- EXECUTE → REFLECT (tests failing on edge case)
- REFLECT → PIVOT (approach A can't handle concurrent sessions)
- PIVOT → PLAN (switching to approach B: token-based)
- PLAN → EXECUTE (user approved revised plan)
```

Update on every state transition.

**Skill-version stamp** *(emitted by bootstrap for plans created on or after v2.36.0)*: the second line, immediately below the H1, records the skill version that minted the plan — `*Skill: iterative-planner v2.36.0*`. `vX.Y.Z` above is a placeholder; bootstrap substitutes the real value read from the packaged `VERSION` file, or `unknown` if that file is missing or unparseable. Informational only: never required, never validated, never hand-edited. Plans created before v2.36.0 simply have no such line.

**Fix Attempts**: tracks autonomous fixes on current step. After 2 fails → STOP. Resets on: user direction, new step, PIVOT. Leash hit example:

```markdown
## Fix Attempts (resets per plan step)
- Step 2, attempt 1: reverted middleware change — still fails (type mismatch)
- Step 2, attempt 2: deleted adapter, called service directly — new error (missing auth)
- Step 2: LEASH HIT. Transitioned to REFLECT. Waiting for user direction.
```

**Change Manifest**: `[x]` = committed, `[ ]` = uncommitted. On failed step / PIVOT → revert uncommitted. See `code-hygiene.md`.

<!-- TEMPLATE:plan -->
## plan.md

Living plan. **Rewritten** each iteration (old plans preserved via `decisions.md`).
Only recommended approach. Rejected alternatives → `decisions.md`.

**Goal** is mandatory — single sentence (or short paragraph) stating the outcome the plan exists to produce. Created by bootstrap from the `new "goal"` argument; refined during PLAN.
**Context** is mandatory — short pointer paragraph linking to relevant findings, prior decisions, and abandoned approaches (e.g. "See findings.md for X. See decisions.md for why approach v1 was abandoned."). Keeps the plan body focused on the chosen approach rather than re-explaining background.
**Problem Statement** is mandatory — expected behavior, invariants, edge cases. Can't write it clearly → go back to EXPLORE.
**Failure Modes** table is mandatory when plan touches external dependencies or integration points. "None identified" if genuinely none (proves you checked).

```markdown
# Plan v3: Token-Based Session Migration

## Goal
Migrate session handling from cookie-based to token-based auth.

## Problem Statement
**Expected behavior**: Users authenticate once, receive a token, and subsequent requests are validated statelessly without hitting the session store.
**Invariants**: (1) Active sessions must never be silently invalidated during migration. (2) Cookie-based clients must continue working until fully migrated. (3) Token validation must not depend on Redis availability.
**Edge cases**: Expired cookies with valid Redis sessions. Concurrent requests during token issuance. Clock skew on token expiry.

## Context
See findings.md for codebase analysis. See decisions.md for why
approaches v1 (in-place migration) and v2 (dual-write) were abandoned.

## Files To Modify
- `app/middleware/auth.rb` (modify: wire TokenService)
- `lib/session/token_service.rb` (new)
- `config/initializers/session.rb` (modify: add token config)
- `test/integration/token_auth_test.rb` (new)

## Steps
1. [x] Create TokenService abstraction [RISK: low] [deps: none]
2. [ ] Wire TokenService into auth middleware  ← CURRENT [RISK: high — format coupling] [deps: 1]
3. [ ] Add fallback path for legacy cookie sessions [RISK: medium — SSO flow] [deps: 2]
4. [ ] [IRREVERSIBLE] Migration script for existing sessions [RISK: high] [deps: 1]
5. [ ] Integration tests [deps: 2, 3]

## Assumptions
- Redis handles 80% of sessions (findings/auth-system.md) → steps 1-3 depend on this
- SessionSerializer can be extended without gem conflicts (findings/dependencies.md L12) → step 2 depends on this. Falsified if gem locks serializer interface.
- No external consumers of cookie format (findings/auth-system.md) → step 3 depends on this

## Failure Modes
| Dependency | Slow | Bad Data | Down | Blast Radius |
|---|---|---|---|---|
| Redis (legacy fallback) | Token path unaffected; cookie path degrades to timeouts | Corrupted session → force re-auth | Cookie clients lose sessions; token clients unaffected | Legacy users only |
| JWT signing key | N/A | Invalid tokens → all token clients locked out | Same as bad data | All new-auth users |

## Pre-Mortem & Falsification Signals
*Assume this plan failed. Most likely reasons → observable stop triggers:*
1. **Cookie fallback is more complex than expected** — SSO flow depends on cookie format details we haven't fully traced (step 3) → STOP IF >2 files need changes in SSO module
2. **Token validation has edge cases with clock skew** — distributed services may reject valid tokens near expiry (step 2) → STOP IF intermittent test failures on token expiry
3. **Interface is wrong** — new auth path requires too many mocks → STOP IF test suite needs >3 mocks for token flow

## Success Criteria
- All existing tests pass
- New integration tests for token flow pass
- Legacy sessions gracefully degrade

## Verification Strategy
### Required
- Tests: `bundle exec rspec` — all specs pass (exit 0)
- Integration: `bundle exec rspec spec/integration/token_auth_spec.rb` — new token flow tests pass

### Conditional
- [ ] Behavioral diff: compare `/api/auth/validate` response before/after (token field added)
- [ ] Smoke test: POST /login with test credential → 200 + valid token

### N/A
- Data fixtures (no data migration)
- Dry-run (no irreversible DB ops — migration script is separate step with own dry-run)

## Complexity Budget
- Files added: 1/3 max
- New abstractions (classes/modules/interfaces): 1/2 max
- Lines added vs removed: +45/-12 (target: net negative or neutral)
```

**Problem Statement** is mandatory. Can't state invariants and edge cases → go back to EXPLORE.
**Assumptions** is mandatory. Bullet list: what you assume, which finding grounds it, which steps depend on it. See `planning-rigor.md`.
**Failure Modes** table is mandatory when external dependencies exist. No dependencies → write "None identified".
**Pre-Mortem & Falsification Signals** is mandatory. 2-3 failure scenarios with concrete STOP IF triggers. Can't imagine failure → plan is underspecified. See `planning-rigor.md`.
**Verification Strategy** is mandatory. For each success criterion, define what check to run and what "pass" means. No testable criteria → write "N/A — manual review only".
**Files To Modify** is mandatory. Can't list them → go back to EXPLORE.
**Step annotations**: `[RISK: low/medium/high]` and `[deps: N,M]` are recommended on each step. Helps enforce risk-first ordering.
**`[IRREVERSIBLE]`** tag on steps with side effects that can't be undone via git (DB migrations, external API calls, service config, non-tracked file deletion). Requires: user confirmation, rollback plan in checkpoint, dry-run if available.

<!-- TEMPLATE:decisions -->
## decisions.md

Append-only. **Never edit or delete past entries.**
Every entry must include a **Trade-off** line: "X **at the cost of** Y".

**Plan-id preamble** *(required for plans created on or after v2.14.0)*: the second line of the file, immediately following the `# Decision Log` H1, MUST be `*Plan: <plan-id>*` where `<plan-id>` is the plan directory name (e.g. `plan-2026-05-07T091743-7556fb98`, or a legacy `plan_2026-05-07_7556fb98` for a plan created before v2.36.0 — both are accepted on read). The preamble lets the file self-identify after `plans/DECISIONS.md` sliding-window trim drops the wrapping `## <plan-id>` section. Bootstrap emits this line automatically. Validator: ERROR `[preamble-missing]` for plans whose `state.md` INIT timestamp is on or after the v2.14.0 release cutoff; WARN otherwise.

**Skill-version stamp** *(emitted by bootstrap for plans created on or after v2.36.0)*: `*Skill: iterative-planner v2.36.0*` on its **own line** directly below the `*Plan: …*` preamble. `vX.Y.Z` in the example below is a placeholder; bootstrap substitutes the real value read from the packaged `VERSION` file, or `unknown` if that file is missing or unparseable. Never fold it *into* the `*Plan: …*` line or into a `## D-NNN | PHASE | YYYY-MM-DD` header — both are matched by strict positional regexes. Informational only: never required, never validated. Plans created before v2.36.0 have no such line.

**Entry header rule**: every entry begins with `## D-NNN | PHASE | YYYY-MM-DD` where:
- `D-NNN` is sequential per plan starting at D-001 (D-001, D-002, ..., no gaps). Each plan directory has its own counter.
- `PHASE` is the originating state or transition (e.g. `EXPLORE → PLAN`, `REFLECT → PIVOT`, `REFLECT`, `PIVOT`).
- `YYYY-MM-DD` is the ISO 8601 date the entry was written.

### Entry Schema by Type

Required vs optional fields per entry type. Every entry, regardless of type, has the header above and a `**Trade-off**:` line ("X **at the cost of** Y").

All entry types accept `Anchor-Refs` as optional. For PIVOT entries that are 2nd-onward in a sequence, also include `Pivot Direction`, `Direction History`, `Momentum` (see `convergence-metrics.md`).

| Entry Type | Required Fields |
|---|---|
| `EXPLORE → PLAN` (initial approach) | Context, Decision, Trade-off, Reasoning |
| `REFLECT → PIVOT` (failure pivot) | Context, What Failed, What Was Learned, Root Cause Analysis (4-part), Complexity Assessment, Decision, Trade-off, Reasoning |
| `REFLECT` (no pivot, EXTENDED — iter 2+) | Context, Devil's Advocate Note, Decision, Trade-off, Reasoning |
| Scope-drift justification | Context, Unplanned Files, Justification, Decision, Trade-off |
| Falsification-signal log | Context, Signal Fired (pre-mortem item #), Observation, Decision, Trade-off |
| Ghost-constraint discovery | Context, Constraint, Why No Longer Applies, Solution-Space Change, Decision, Trade-off |
| 3-strike trigger | Context, "3-STRIKE TRIGGERED on [file/module]", Three Attempts, Decision, Trade-off |
| Simplification-check failure | Context, 6 Check Answers, Blocker Found (Y/N), Decision, Trade-off |
| Devil's-Advocate (EXTENDED) | Context, Strongest Counter-argument, Why Pursuing Anyway, Decision, Trade-off |

**Anchor-Refs** *(required whenever a matching `# DECISION <plan-id>/D-NNN` anchor exists in source — for plans created on or after v2.14.0; recommended otherwise)*: file:line back-links from the decision entry to placed anchors. Format:

```markdown
**Anchor-Refs**: `app/middleware/auth.rb:23`, `lib/session/token_service.rb:1-15`
```

Multiple file:line refs are comma-separated; ranges use `LL-MM`. Maintained at EXECUTE-time when anchors are created or moved; verified at CLOSE during the reverse anchor audit. Validator: ERROR `[anchor-refs-missing]` for post-v2.14.0 plans whose decisions.md entry has a matching source anchor but no `**Anchor-Refs**:` line; WARN otherwise. Pre-v2.14.0 entries (legacy) keep WARN-only enforcement.

```markdown
# Decision Log
*Plan: plan-2026-01-15T084512-a3f1b2c9*
*Skill: iterative-planner vX.Y.Z*

## D-001 | EXPLORE → PLAN | 2025-01-15
**Context**: Auth system uses 3 different session stores (Redis, DB, in-memory)
**Decision**: Start with approach A (in-place migration of Redis sessions)
**Trade-off**: Fastest path to 80% coverage **at the cost of** ignoring DB/in-memory stores and risking format coupling issues
**Reasoning**: Redis sessions are 80% of traffic, smallest blast radius

## D-002 | REFLECT → PIVOT | 2025-01-15
**Context**: Approach A fails — Redis session format is coupled to cookie serializer
**What Failed**: Cannot deserialize existing sessions with new token format
**What Was Learned**: Session format tied to entire serialization pipeline in `lib/session/serializer.rb`
**Root Cause Analysis**:
1. **Immediate cause**: Redis session format uses MessagePack tied to the cookie serializer
2. **Contributing factor**: EXPLORE didn't trace serialization path beyond storage layer
3. **Failed defense**: No assumption check on storage/format independence; Failure Modes table didn't include serializer coupling
4. **Prevention**: Always trace format coupling through full pipeline, not just storage endpoints
**Complexity Assessment**:
- Lines added in failed attempt: 34
- New abstractions added: 1 (SessionAdapter — now deleted)
- Could the fix have been simpler? Yes — should have checked format coupling first
- Am I adding or removing complexity with the new plan? Removing (eliminates adapter)
**Decision**: Switch to approach B (dual-write with gradual migration)
**Trade-off**: Safe rollback and format decoupling **at the cost of** doubled storage for TTL duration
**Reasoning**: Decouples new format from legacy, allows rollback

## D-003 | REFLECT → PIVOT | 2025-01-15
**Context**: Approach B works but dual-write doubles Redis memory usage
**What Failed**: Memory spike in staging from 2GB to 4.1GB
**What Was Learned**: Session TTLs are 30 days, so dual-write accumulates fast
**Root Cause Analysis**:
1. **Immediate cause**: Dual-write inherently doubles storage for TTL duration
2. **Contributing factor**: PLAN didn't model storage growth as a function of TTL × write rate
3. **Failed defense**: Failure Modes covered Redis availability but not capacity; no staging memory budget check
4. **Prevention**: For any dual-write strategy, project storage cost = retention × write rate before committing
**Complexity Assessment**:
- Lines added in failed attempt: 89
- New abstractions added: 2 (DualWriter, MigrationTracker)
- Could the fix have been simpler? Yes — the problem is architectural, not code-level
- Am I adding or removing complexity with the new plan? Removing (stateless tokens)
**Decision**: Switch to approach C (token-based with cookie fallback)
**Trade-off**: Stateless validation and zero storage growth **at the cost of** maintaining two auth paths during migration
**Reasoning**: Tokens are stateless, eliminates Redis growth problem entirely
**Anchor-Refs**: `app/middleware/auth.rb:23`, `lib/session/token_service.rb:1-15`
```

When this entry's anchor is later read in source it appears as `# DECISION plan-2026-01-15T084512-a3f1b2c9/D-003: ...` (the plan-id prefix matches the preamble line above).

Complexity Assessment mandatory for all PIVOT entries.

**Pivot Direction Log** *(EXTENDED — 2nd PIVOT onward)* — track direction consistency across PIVOTs. Add to PIVOT entries: `**Pivot Direction**: [summary]`, `**Direction History**: [all directions]`, `**Momentum**: [ratio]`. See `convergence-metrics.md` for decision rules.

**Root Cause Analysis** is mandatory for REFLECT entries that follow failure (EXECUTE → REFLECT due to failure, leash hit, or surprise). The canonical block has **four parts** — keep in sync with `references/planning-rigor.md`:

```markdown
**Root Cause Analysis**:
1. **Immediate cause**: Redis session format uses MessagePack tied to cookie serializer
2. **Contributing factor**: EXPLORE didn't trace serialization path beyond storage layer
3. **Failed defense**: No assumption check on storage/format independence; Failure Modes table didn't include serializer coupling
4. **Prevention**: Always trace format coupling through full pipeline, not just storage endpoints
```

### Intra-plan compression

Mirrors the cross-plan `<!-- COMPRESSED-SUMMARY -->` pattern (see `SKILL.md` "Consolidated File Management"). Cross-plan files use a 4-plan sliding window to stay bounded; intra-plan `decisions.md` has no such window, so a threshold-triggered compression runs mid-plan.

- **Trigger**: file >300 lines, evaluated at PLAN gate-in. Orchestrator dispatch is wired in step 10 of plan_2026-05-15_71ab18dd (see `agents/ip-orchestrator.md` PLAN State Dispatch).
- **Implementation**: `maybeCompressDecisions(planDir, { threshold, dryRun })` exported from `src/scripts/bootstrap.mjs`. Mechanical layer only — parses raw `## D-NNN` entries and emits a lookup-table block. Never invents content.
- **Insertion position**: after the leading schema-example HTML comment block (if present) and the `*Plan: <plan-id>*` preamble, BEFORE the first `## D-NNN` entry. When an existing block is found, it is REPLACED in-place (never summarize a summary — failsafe mirrors the cross-plan rule).
- **Append-only safety**: raw `## D-NNN` entries below the block are NEVER touched. Compression only writes the metadata block above them.
- **Idempotency**: `<!-- entries-at-compress: N -->` records the entry count at last compression. Re-running with no new entries (`parsed.entries.length === entriesAtCompress`) is a no-op.
- **Block cap**: 100 lines between markers (mirrors the cross-plan convention from `SKILL.md` "Consolidated File Management").
- **Preserve-verbatim rules**: `## D-NNN` headers, `**Anchor-Refs**:` lines, `*Plan: <plan-id>*` preamble, and the schema-example HTML comment block all survive unchanged because they live OUTSIDE the marker block (the compressor never edits them).

**Format** — emitted between the preamble and the first raw `## D-NNN` entry:

```markdown
<!-- COMPRESSED-SUMMARY -->
<!-- entries-at-compress: 12 -->
## Summary (compressed)
*Auto-compressed from 347 lines (12 entries). Raw entries preserved below.*

### Decision lookup
- **D-001** | EXPLORE → PLAN | 2026-05-07 — Chose approach X.  (anchors: src/foo.rb:42)
- **D-002** | EXECUTE | 2026-05-08 — Fixed Y by Z.  (anchors: none)
...

### Things NOT to do (from PIVOT entries)
- D-004: approach A failed; do not revisit until B changes.

### Anchored decisions
- D-001 → src/foo.rb:42
<!-- /COMPRESSED-SUMMARY -->
```

No-op return reasons (no file write): `missing`, `empty`, `under-threshold`, `no-preamble`, `too-few-entries`, `no-new-entries`. Compression returns `{ compressed, beforeLines, afterLines, reason }`.

<!-- TEMPLATE:findings -->
## findings.md

Updated during EXPLORE. Corrected during PIVOT when earlier findings prove wrong. Always include **file paths with line numbers** and **code path traces**.

`findings.md` = summary + index. Detailed findings → `findings/` as individual files. **Main agent** owns the index — subagents write to `findings/` only.

### findings.md (summary/index)

```markdown
# Findings

## Index
- [Auth System Architecture](findings/auth-system.md) — entry points, session stores, serialization coupling
- [Test Coverage](findings/test-coverage.md) — coverage gaps, missing integration tests
- [Dependencies](findings/dependencies.md) — gem constraints, Rails version pins

## Key Constraints
- SessionSerializer shared between cookie middleware AND API auth (see auth-system.md)
- rack-session gem pins cookie-compatible format (see dependencies.md)
- No integration tests for session migration (see test-coverage.md)

## Corrections
- [CORRECTED iter-2] Redis session format is coupled to serialization pipeline, not just storage (see auth-system.md) — original finding assumed isolated storage format
```

### findings/ directory

Self-contained research artifacts. Subagents write directly to `{plan-dir}/findings/` — never rely on context-only results.

**Naming**: `findings/{topic-slug}.md` — kebab-case, descriptive. Examples: `auth-system.md`, `test-coverage.md`, `db-schema.md`. Prevents collisions when multiple subagents run in parallel.

**Required sections** (every `findings/{topic}.md` file must contain all five):

| Section | Purpose | Required content |
|---|---|---|
| `## Summary` | One-paragraph overview | Plain prose, 2-5 sentences |
| `## Key Findings` | Discrete observations | Each item must include `file:line` reference |
| `## Constraints` | Limits on solution space | Each constraint classified `HARD` / `SOFT` / `GHOST` |
| `## Code Patterns` | Recurring shapes worth knowing | file:line for at least one occurrence per pattern |
| `## Risks & Unknowns` | What's unclear or risky | What was not determinable; what to verify next |

`HARD` = cannot be relaxed (language/runtime/external API). `SOFT` = strong convention but negotiable. `GHOST` = thought to apply but doesn't on closer inspection (document so it's not re-discovered).

**Optional sixth section** — `## Atlas Contradictions`: when a finding contradicts an existing `plans/SYSTEM.md` entry, an explorer appends this section (SYSTEM.md file path + line, what the new evidence says). The orchestrator promotes it to a `[CONTRADICTED iter-N]` line in `findings.md` for archivist reconciliation at CLOSE. See `agents/ip-explorer.md` § System-Atlas Awareness.

Example skeleton:

```markdown
# Auth System Architecture

## Summary
Three session stores (Redis/DB/in-memory) wired via a shared `SessionSerializer`. Cookie middleware and API auth both depend on it, widening blast radius for format changes.

## Key Findings
- Entry point: `app/middleware/auth.rb:23` dispatches to SessionStore
- Format coupling: `lib/session/serializer.rb:34-89` shared by cookie + token paths

## Constraints
| Constraint | Class | Source |
|---|---|---|
| `rack-session` pins cookie-compat format | HARD | `Gemfile.lock:142` |
| Auth changes behind feature flag | SOFT | `docs/conventions.md:18` |
| "Sessions must hit Redis" — disproved | GHOST | `lib/session/redis_store.rb:12` |

## Code Patterns
- `SessionStore#find` (`lib/session/store.rb:8`) used by 4 callers

## Risks & Unknowns
- Clock skew across nodes not investigated
- SSO re-entry into auth middleware not traced
```

Example subagent prompt:
> Explore the authentication system. Write your findings to `{plan-dir}/findings/auth-system.md`.
> Include file paths with line numbers and code path traces showing execution flow.

```markdown
# Auth System Architecture

## Entry Points
- `app/middleware/auth.rb:authenticate!` (line 23)

## Execution Flow
authenticate! → SessionStore#find (line 45) → RedisStore#get (line 12) → Redis

## Session Stores
- `lib/session/redis_store.rb` (primary)
- `lib/session/db_store.rb` (fallback)

## Cookie Format
- Base64-encoded MessagePack, signed with HMAC-SHA256

## Key Coupling
- `SessionSerializer` used by both cookie middleware AND API auth
  - Cookie middleware: `SessionSerializer.load` (line 34)
  - API auth: `SessionSerializer.load` via `ApiAuth#from_token` (line 67)
  - Changing format affects BOTH flows
  - File: lib/session/serializer.rb:34-89

## Dependencies
- `rack-session` gem pins cookie-compatible session format
- Upgrading rack-session requires Rails 7.1+ (currently on 7.0.4)
```

<!-- TEMPLATE:progress -->
## progress.md

Flat checklist. Updated in: PLAN (populate Remaining), EXECUTE (move items), REFLECT (mark failed/blocked), PIVOT (annotate pivot).

```markdown
# Progress

## Completed
- [x] Mapped auth system architecture (EXPLORE, iteration 1)
- [x] Identified session format coupling (EXPLORE, iteration 1)
- [x] Attempted in-place migration — FAILED (EXECUTE, iteration 1)
- [x] Attempted dual-write — FAILED (memory) (EXECUTE, iteration 2)
- [x] Created TokenService abstraction (EXECUTE, iteration 3)

## In Progress
- [ ] Wire TokenService into middleware (EXECUTE, iteration 3, step 2)

## Remaining
- [ ] Cookie fallback path
- [ ] Migration script
- [ ] Integration tests

## Blocked
- Nothing currently
```

<!-- TEMPLATE:verification -->
## verification.md

Written during PLAN (initial template with criteria), updated during EXECUTE (per-step results), completed during REFLECT (full verification pass). Rewritten each iteration (not append-only — each REFLECT cycle produces a fresh verification).

```markdown
# Verification Results (Iteration 3)

## Criteria Verification
| # | Criterion (from plan.md) | Method | Command/Action | Result | Evidence |
|---|--------------------------|--------|----------------|--------|----------|
| 1 | All existing tests pass | Automated | `bundle exec rspec` | PASS | 47/47 specs, 0 failures |
| 2 | New integration tests pass | Automated | `bundle exec rspec spec/integration/token_auth_spec.rb` | PASS | 3/3 specs |
| 3 | Legacy sessions degrade gracefully | Manual | Tested 5 legacy cookie sessions via curl | PASS | All responded < 1s, no errors |

## Additional Checks
| Check | Command/Action | Result | Details |
|-------|----------------|--------|---------|
| Regression | `bundle exec rspec` (full suite re-run) | PASS | 47/47 specs, same as pre-iteration |
| Scope drift | Compare state.md manifest vs plan.md Files To Modify | CLEAN | 4 files changed, all planned |
| Diff review | Review git diff for artifacts | CLEAN | No debug code, no TODOs |
| Lint | `rubocop --format simple` | PASS | 0 offenses |
| Behavioral diff | diff /api/auth/validate response | EXPECTED DIFF | Token field added (intentional) |
| Smoke test | POST /login with test credential | PASS | 200 + valid JWT returned |

## Not Verified
| What | Why |
|------|-----|
| Clock skew handling in token validation | No multi-node test environment available |
| Concurrent session limits | Out of scope for this iteration |

## Prediction Accuracy
| Predicted (from plan.md) | Actual | Delta |
|--------------------------|--------|-------|
| 5 steps | 5 steps | on target |
| 4 files modified | 4 files modified | on target |
| +45/-12 lines | +45/-12 lines | on budget |
| 1 iteration (plan v3) | 1 iteration | on target |

## Convergence Metrics
| Metric | Previous | Current | Delta |
|--------|----------|---------|-------|
| Pass rate | 2/5 (40%) | 4/5 (80%) | +0.40 |
| Scope (files planned vs changed) | 3 vs 4 | 3 vs 3 | stable (1.0) |
| New issues found | 3 | 1 | improving (+1) |
| **Convergence score** | — | **+2.4** | **Converging** |

## Verdict
- Criteria passed: 3/3
- Regressions: none
- Scope drift: none
- Simplification blockers: none
- Recommendation: → CLOSE
```

**Criteria Verification table** is mandatory — one row per success criterion from `plan.md`. **Result** must be PASS or FAIL. **Evidence** must be concrete and follow one of these accepted formats:

- **(a) Test output count** — e.g. `47/47 passed, 0 failures`, `3/3 specs`
- **(b) Exit code + stdout excerpt** — e.g. `exit 0; "Build succeeded in 12.4s"`
- **(c) Manual review** — explicit `manual review — observed X` stating what was observed (e.g. `manual review — observed token field present in /api/auth/validate response`)

**Reject** these Evidence patterns: `looks good`, `seems to work`, `LGTM`, empty cells, single-word answers (`yes`, `ok`, `done`). The validator flags these as WARN.

**Additional Checks** — optional (lint, type checks, behavioral diffs, smoke tests) plus required rows every REFLECT:
- **Regression**: re-run previously-passing tests. PASS or FAIL (blocks CLOSE).
- **Scope drift**: change manifest (state.md) vs Files To Modify (plan.md). CLEAN or DRIFT (justify in decisions.md or revert).
- **Diff review**: debug artifacts, commented-out code, TODO/FIXME/HACK leftovers. CLEAN or ISSUES (list).

**Not Verified** is mandatory — list what you didn't test and why (no coverage, out of scope, untestable, no environment). Forces honesty about coverage gaps. Even if empty, write "None — all criteria have automated verification."

**Verdict required bullets**: every Verdict section MUST contain these 5 bullets in order:
1. **Criteria passed (count: N/M)** — e.g. `Criteria passed: 3/3`
2. **Regressions (yes/no — list)** — `Regressions: none` or `Regressions: yes — <list>`
3. **Scope drift (yes/no — list)** — `Scope drift: none` or `Scope drift: yes — <list>`
4. **Simplification blockers (yes/no — list)** — `Simplification blockers: none` or `Simplification blockers: yes — <list>`
5. **Recommended transition (CLOSE / PIVOT / EXPLORE / EXECUTE)** — `Recommendation: → CLOSE` (or PIVOT, or EXPLORE, or EXECUTE)

Plans with no testable criteria: write "N/A — manual review only" in Method column. Still record the manual review outcome in Result + Evidence.

**Convergence Metrics** *(EXTENDED — iteration 2+ only)* — quantitative convergence signal. Iteration 1: write "N/A — first iteration, no previous data to compare." Iteration 2+: compute pass rate delta, scope stability, issue trend. See `convergence-metrics.md` for formula and decision rules.

<!-- TEMPLATE:checkpoints -->
## checkpoints/cp-NNN-iterN.md

Name: `cp-NNN-iterN.md` — NNN increments globally, iterN = iteration when created. Example: `cp-000-iter1.md`, `cp-001-iter2.md`.

**"Git State" = commit BEFORE changes** (the restore point). This is the hash you use in `git checkout` to roll back.

```markdown
# Checkpoint 001 (iteration 2)

## Created: Before wiring TokenService into middleware
## Git State: commit abc123f  ← commit BEFORE these changes (restore point)
## Files That Will Change:
- app/middleware/auth.rb (modify)
- config/initializers/session.rb (modify)
- lib/session/token_service.rb (create)

## Lockfiles snapshotted:
- checkpoints/cp-001-iter2.lockfiles/package-lock.json
- checkpoints/cp-001-iter2.lockfiles/Gemfile.lock
<!-- OR, when no package manager touched: -->
<!-- - none (no package manager touched) -->

## Rollback:
git checkout abc123f -- app/middleware/auth.rb config/initializers/session.rb
rm lib/session/token_service.rb
# If checkpoints/cp-001-iter2.lockfiles/ exists, restore + reinstall:
cp checkpoints/cp-001-iter2.lockfiles/* .   # adjust per detected lockfile
npm ci                                       # or: cargo build / poetry install / bundle install / go mod download
```

**Sibling-directory convention**: lockfile copies live in `{plan-dir}/checkpoints/cp-NNN-iterN.lockfiles/` — a sibling directory next to the `cp-NNN-iterN.md` file, NOT inside the markdown. The `.md` file only lists the relative paths under `## Lockfiles snapshotted:`.

**Validator safety**: `checkCheckpoints()` in `src/scripts/validate-plan.mjs` does a non-recursive top-level scan filtered to `.md` files only (`readdirSync(cpDir).filter((f) => f.endsWith(".md"))`). Sibling directories like `cp-NNN-iterN.lockfiles/` are invisible to it — no validator change needed.

**Scope**: lockfile snapshotting only happens when the step touches a manifest (`package.json`, `Cargo.toml`, `pyproject.toml`, `Gemfile`, `go.mod`, `composer.json`, etc.). For pure code edits that don't run a package manager, the `## Lockfiles snapshotted:` section contains the single line `- none (no package manager touched)`. The section is mandatory — present in every checkpoint — so its absence signals a malformed checkpoint.

**Security**: never snapshot `.env`, `.env.local`, or any file matched by `.gitignore` that may carry secrets. Only `.env.example` / `.env.template` (explicitly git-tracked, secret-free) are eligible, and even then prefer `git checkout -- .env.example` over manual copy.

**Restore order**: (1) `git checkout <hash> -- .` first — this automatically restores any git-tracked lockfile to its pre-step state; (2) optionally `cp checkpoints/cp-NNN-iterN.lockfiles/* .` — only needed when the original lockfile was `.gitignore`d (rare; Cargo library pattern, some CI setups); (3) run the package manager's restore command (`npm ci`, `cargo build`, `poetry install`, `bundle install`, `go mod download`) to materialize `node_modules/` / `target/` / `.venv/` from the restored lockfile. `npm ci` (not `npm install`) is correct — it installs exactly from the lockfile and errors on mismatch.

### When to Checkpoint
- **Iteration 1, first EXECUTE**: `cp-000-iter1.md` = clean starting state (nuclear fallback)
- Before modifying 3+ files simultaneously
- Before changing shared/core modules (used by multiple callers or multiple systems)
- Before destructive operations (schema changes, file deletions, config overwrites)
- User expresses uncertainty

<!-- TEMPLATE:findings-consolidated -->
## plans/FINDINGS.md (consolidated)

Cross-plan findings archive. Entries merged from per-plan `findings.md` on close. Per-plan headings demoted one level (## → ###) and nested under a `## <plan-id>` section. Relative `findings/` links rewritten to `<plan-id>/findings/`.

**Newest first** — most recently closed plan appears at the top (after the header). This keeps the most relevant context immediately accessible without reading the entire file.

**Sliding window**: Auto-trimmed to the **4 most recent** plan sections on each close. Old plan data remains in per-plan directories (`plans/<plan-id>/findings.md`). Keeps file naturally bounded at ~150-250 lines.

**Read limit**: Always read with `limit: 600`. Compressed summary + recent plan sections fit within this.

**Compression**: When >500 lines (rare with sliding window), a compressed summary (≤100 lines) is inserted between `<!-- COMPRESSED-SUMMARY -->` markers after the header. See "Consolidated File Management" in SKILL.md.

Created automatically by bootstrap on first `new`. Updated on each `close`.

*Both examples below show the file **below its header** — the header lines are elided. Bootstrap's header bytes are stated exactly once, in the `<!-- SKELETON:findings-consolidated -->` region under "Bootstrap Skeletons (machine-checked)". Restating them here would be a second, un-gated copy (gate rule `[header-copy]`).*

### Without compression (<500 lines)

```markdown
## plan-2026-02-20T141005-b4e2c3d0
### Index
- [Database Schema](plan-2026-02-20T141005-b4e2c3d0/findings/db-schema.md) — table relationships
### Key Constraints
- Foreign key constraints prevent cascade delete on users table

## plan-2026-02-19T092233-a3f1b2c9
### Index
- [Auth System](plan-2026-02-19T092233-a3f1b2c9/findings/auth-system.md) — entry points, session stores
### Key Constraints
- SessionSerializer shared between cookie middleware AND API auth
```

### With compression (>500 lines)

```markdown
<!-- COMPRESSED-SUMMARY -->
## Summary (compressed)
*Auto-compressed from 847 lines. Read full content below line 600 if needed.*

### Key Findings
- Auth system uses cookie-based sessions with Redis backing (3 stores: Redis, DB, in-memory)
- SessionSerializer is shared between cookie middleware AND API auth — changing format affects both
- Foreign key constraints prevent cascade delete on users table
- rack-session gem pins cookie-compatible format, requires Rails 7.1+ to upgrade
- No integration tests existed for session migration paths
<!-- /COMPRESSED-SUMMARY -->

## plan-2026-02-20T141005-b4e2c3d0
### Index
- [Database Schema](plan-2026-02-20T141005-b4e2c3d0/findings/db-schema.md) — table relationships
### Key Constraints
- Foreign key constraints prevent cascade delete on users table

## plan-2026-02-19T092233-a3f1b2c9
### Index
...
```

Usage:
- Read (limit: 600) at start of EXPLORE and during PLAN gate check for cross-plan context
- Do not edit directly — content is merged automatically on `close`
- Agent/user can curate (remove stale sections) manually if needed
- When compressing: only summarize `## <plan-id>` sections, SKIP content between `<!-- COMPRESSED-SUMMARY -->` markers

<!-- TEMPLATE:decisions-consolidated -->
## plans/DECISIONS.md (consolidated)

Cross-plan decision archive. Entries merged from per-plan `decisions.md` on close. Decision IDs (D-NNN) are scoped to their plan section — no cross-plan deduplication.

**Newest first** — most recently closed plan appears at the top (after the header).

**Sliding window**: Auto-trimmed to the **4 most recent** plan sections on each close. Old plan data remains in per-plan directories (`plans/<plan-id>/decisions.md`). Keeps file naturally bounded at ~150-250 lines.

**Read limit**: Always read with `limit: 600`. Compressed summary + recent plan sections fit within this.

**Compression**: When >500 lines (rare with sliding window), a compressed summary (≤100 lines) is inserted between `<!-- COMPRESSED-SUMMARY -->` markers after the header. See "Consolidated File Management" in SKILL.md.

Created automatically by bootstrap on first `new`. Updated on each `close`.

*Both examples below show the file **below its header** — the header lines are elided. Bootstrap's header bytes are stated exactly once, in the `<!-- SKELETON:decisions-consolidated -->` region under "Bootstrap Skeletons (machine-checked)". Restating them here would be a second, un-gated copy (gate rule `[header-copy]`).*

### Without compression (<500 lines)

```markdown
## plan-2026-02-20T141005-b4e2c3d0
### D-001 | EXPLORE → PLAN | 2025-01-20
**Context**: Users table migration needed
**Decision**: Use reversible migration with dual-column approach
**Trade-off**: Zero-downtime migration **at the cost of** temporary schema complexity

## plan-2026-02-19T092233-a3f1b2c9
### D-001 | EXPLORE → PLAN | 2025-01-15
**Context**: Auth system uses 3 different session stores
**Decision**: Start with approach A (in-place migration)
**Trade-off**: Fastest path **at the cost of** ignoring DB/in-memory stores

### D-002 | REFLECT → PIVOT | 2025-01-15
**Context**: Approach A fails — format coupling
**Decision**: Switch to approach B (dual-write)
**Trade-off**: Safe rollback **at the cost of** doubled storage
```

### With compression (>500 lines)

```markdown
<!-- COMPRESSED-SUMMARY -->
## Summary (compressed)
*Auto-compressed from 623 lines. Read full content below line 600 if needed.*

### Key Decisions
- Auth: Token-based sessions chosen over cookie migration (format coupling) and dual-write (memory doubling)
- DB: Reversible migration with dual-column approach for zero-downtime
- DO NOT: In-place Redis session migration (format coupled to serializer pipeline)
- DO NOT: Dual-write sessions (30-day TTLs cause 2x memory)
<!-- /COMPRESSED-SUMMARY -->

## plan-2026-02-20T141005-b4e2c3d0
### D-001 | EXPLORE → PLAN | 2025-01-20
...
```

Usage:
- Read (limit: 600) at start of EXPLORE and during PLAN gate check — learn what was tried before
- Do not edit directly — content is merged automatically on `close`
- Decision IDs are scoped per plan section (each plan starts at D-001)
- When compressing: only summarize `## <plan-id>` sections, SKIP content between `<!-- COMPRESSED-SUMMARY -->` markers

<!-- TEMPLATE:lessons -->
## plans/LESSONS.md

Cross-plan institutional memory. **Rewritten** (not appended) at CLOSE to stay ≤200 lines. Read before PLAN.

*The example below shows the file **below its header** — the header lines are elided. Bootstrap's header bytes are stated exactly once, in the `<!-- SKELETON:lessons -->` region under "Bootstrap Skeletons (machine-checked)". Restating them here would be a second, un-gated copy (gate rule `[header-copy]`).*

```markdown
## Recurring Patterns
- Always check format coupling before assuming storage changes are isolated [I:4]
- Checkpoint before any 3+ file change — rollback cost is near zero, re-work cost is high [I:5]

## Failed Approaches (+ why)
- Dual-write strategies with long TTLs — storage grows unbounded [I:3]
- In-place format migrations when the serializer is shared across subsystems [I:4]
- Adapters/wrappers as fixes — they accumulate and obscure the real problem; "just add an adapter" is a 3-strike signal — simplify instead [I:5]

## Successful Strategies
- Token-based auth is simpler than session migration — prefer stateless when possible [I:3]
- Run EXPLORE even when "I already know this" — it surfaces missed constraints every time [I:4]

## Codebase Gotchas
- SessionSerializer is shared between cookie middleware AND API auth — changes affect both [I:5]
- rack-session gem pins cookie-compatible format; upgrading requires Rails 7.1+ [I:3]
- Foreign key constraints on users table prevent cascade delete
```

Usage:
- Read at start of EXPLORE, before PLAN gate check, and before PIVOT
- At CLOSE: read current file, integrate significant lessons from this plan, rewrite entire file ≤200 lines
- Consolidate aggressively — merge related lessons, drop low-value or stale entries
- Importance tag `[I:N]` (1-5): 5=critical (caused a failure / blocked a plan — must never be dropped); 4=saved significant time or avoided a known trap; 3=useful recurring pattern (the default); 2=contextual, apply with judgment; 1=one-off / low-signal. A bullet with no tag is treated as implicit `[I:3]` (backward-compatible).
- At the 200-line cap, trim by importance then recency: drop lowest-`[I:N]` entries first, and within the same importance tier drop oldest first. Never drop an `[I:5]` entry — tighten or merge wording instead. Assign an `[I:N]` to each lesson when adding it.
- Focus on: recurring patterns, failed approaches, successful strategies, codebase gotchas
- Drop: one-off findings, detailed decision reasoning, plan-specific details
- Created automatically by bootstrap on first `new`

<!-- TEMPLATE:system -->
## plans/SYSTEM.md

Cross-plan **system atlas** — a curated map of *what the system being planned against actually is*, distinct from goal-driven findings. **Rewritten** (not appended) by `ip-archivist` at CLOSE to stay ≤300 lines. Read at start of EXPLORE and start of PLAN. Schema is **domain-neutral** — works for codebases, research pipelines, ops runbooks, strategy systems. The optional `## Codebase Specialization` section is the only codebase-specific content.

```markdown
# System Atlas
*Last refreshed: <plan-id> | <YYYY-MM-DD>*
*Domain-neutral system map. Rewritten at CLOSE — max 300 lines. Read before PLAN/EXPLORE.*

## Identity
- What the system is (1-2 sentences). Domain (codebase / research / ops / strategy / other).

## Components
- Top-level building blocks. 5-15 entries. One line each: `name` — role.

## Boundaries
- In scope vs out of scope.
- External dependencies (services, APIs, files).
- Boundary inputs the planner reads but does not own (e.g. CLAUDE.md, config files).

## Invariants
- Properties that must always hold (security, data, contracts, performance budgets).
- Each grounded in a finding-id or decision-id reference (e.g. `see <plan-id>/D-002`).

## Flows
- 3-7 named end-to-end flows: trigger → path → terminus.

## Known Patterns
- Architectural archetypes the system instantiates (e.g. "stateless HTTP API + Redis cache", "FSM-driven CLI", "compiler", "research pipeline", "agent workflow").

## Codebase Specialization
*Optional — present only when domain=codebase. Omit entirely for non-code systems.*
- Module map: top-level directories and their purpose.
- Key files (by frequency-of-relevance).
- Build / test / run commands.
```

Usage:
- Read: EXPLORE start + PLAN start (orchestrator + ip-plan-writer). Structural prior — avoids re-deriving system shape every plan.
- CLOSE: ip-archivist Step 5 rewrites under 300-line cap. **Demote-by-staleness, not by recency** — drop entries not referenced or reaffirmed by recent plans. Truncating most-recent defeats curation.
- Contradictions: EXPLORE finding contradicts SYSTEM.md entry → mark in `findings.md` with `[CONTRADICTED iter-N]` → archivist corrects at CLOSE (mirrors `[CORRECTED iter-N]`).
- Hard cap 300 lines enforced by `validate-plan.mjs` ERROR `[atlas-cap]`. Truncation by writers forbidden.
- Created by bootstrap on first `new` — but the bytes it writes are **not** the schema above. They are the `<!-- SKELETON:system -->` region under **Bootstrap Skeletons (machine-checked)**, which `check-template-parity.mjs` pins to `PLAN_TEMPLATES.system` byte-for-byte. That is the only gated pair; go there for the literal bytes.
- The schema above is the **populated form** — what `ip-archivist` fills in at CLOSE, and what `emit-template --name system` serves it. It differs from the skeleton **deliberately**, and the difference is the point: the skeleton keeps the `*Last refreshed: (none yet)*` sentinel and marks every bullet as an unpopulated schema hint, because a fresh atlas is read at EXPLORE/PLAN start and must not be mistaken for established fact. Do not "sync" the two.

<!-- TEMPLATE:index -->
## plans/INDEX.md

Topic-to-directory mapping. Updated automatically on `close`. Survives sliding window trim — use this to locate old findings when they've been removed from consolidated files.

*The example below shows the file **below its header** — the header lines are elided. Bootstrap's header bytes are stated exactly once, in the `<!-- SKELETON:index -->` region under "Bootstrap Skeletons (machine-checked)". Restating them here would be a second, un-gated copy (gate rule `[header-copy]`).*

```markdown
| Plan | Date | Goal | Key Topics |
|------|------|------|------------|
| plan-2026-02-20T141005-b4e2c3d0 | 2026-02-20 | Database migration | db schema, foreign keys, cascade |
| plan-2026-02-19T092233-a3f1b2c9 | 2026-02-19 | Auth session migration | auth, sessions, redis, tokens |
```

Usage:
- Read during EXPLORE when cross-plan context (FINDINGS.md) doesn't contain what you need
- Helps find per-plan findings that have been trimmed by the sliding window
- Created automatically by bootstrap on first `new`. Updated on each `close`.
- Topics extracted from findings.md index entries

<!-- TEMPLATE:lessons-snapshot -->
## lessons_snapshot.md

Automatic snapshot of `plans/LESSONS.md` taken at close, saved to the plan directory. Allows recovery of lesson state at any point in the project's history.

- Created automatically by `close` in `plans/{plan-dir}/lessons_snapshot.md`
- Read-only reference — not updated after creation

<!-- TEMPLATE:changelog -->
## changelog.md

Per-edit, append-only ledger of every file edit during EXECUTE. One line per (file, edit). Owner: `ip-executor`. Reader: `ip-reviewer` at REFLECT. Lives at `{plan-dir}/changelog.md`. Reset per plan (not consolidated cross-plan).

Format: pipe-delimited single line per edit:

```
2026-05-07T10:23:45Z | iter-1/step-3 | abc1234 | src/foo.ts | EDIT(+45,-12) | radius:LOW(2) | D-007 | rename for clarity
```

| # | Field | Required | Notes |
|---|---|---|---|
| 1 | UTC timestamp (ISO-8601 Z, second precision) | yes | monotonically increasing |
| 2 | `iter-N/step-M` | yes | from state.md |
| 3 | short commit hash, or `uncommitted` | yes | the commit this edit belongs to |
| 4 | repo-relative file path | yes | one entry per file per edit |
| 5 | op + LOC | yes | `CREATE(+N)`, `EDIT(+N,-M)`, `DELETE(-N)`, `RENAME(old→new)`, `REVERT(file)` |
| 6 | radius score | yes | `LOW(score)` / `MED(score)` / `HIGH(score)` / `UNKNOWN(reason)` — from `blast-radius.mjs` |
| 7 | decision-ref | optional | `D-NNN` (resolves against active plan's `decisions.md`), or `-` if none |
| 8 | reason | yes | one short clause |

Field shapes have **one definition**: `CHANGELOG_SPEC` in `src/scripts/schema.mjs`. The validator checks each line against it (split → synthetic entry → `validateElement`). Do not re-declare a changelog field regex anywhere.

Header: the exact bytes are **deliberately not restated here** — read them in the `<!-- SKELETON:changelog -->` region under **Bootstrap Skeletons (machine-checked)** below, the one copy `check-template-parity.mjs` enforces against `bootstrap.mjs`. A second copy in this section would be an ungated copy, free to drift, and `emit-template --name changelog` would then serve the drifted one to every agent.

Rules:
- **Append-only**. Never edit existing lines. Mistakes get a correction line with op `EDIT(+0,-0)` and reason `correction: <what>`.
- **Multi-file step** → one line per file, all sharing the same iter/step/commit.
- **Failed step revert** → append `REVERT(file)` lines for each reverted file. Do not delete the original lines.
- **Decision-ref optional** — most edits don't have an anchored decision. Use `-` freely. The 5 `# DECISION` trigger conditions remain unchanged.
- **Reason is mandatory** but should be terse (one clause, no period needed).
- **Pipes (`|`) in reason are tolerated**: parsers split on the first 7 ` | ` separators, so the reason field absorbs any trailing ` | ` sequences. No escaping required — write the reason as natural prose.

Failure modes:
- `blast-radius.mjs` missing or errors → executor writes `radius:UNKNOWN(script-missing)` or `radius:UNKNOWN(script-error)` and proceeds.
- Plan dir lacks changelog.md (older plans) → executor creates it idempotently with the header.

Validator (`validate-plan.mjs`):
- WARN `[changelog-malformed]` on lines not matching the 8-field shape, or on a field violating `CHANGELOG_SPEC` (the message names the offending field).
- WARN `[changelog-drift]` if a commit produced files absent from changelog.
- Never blocks CLOSE. Changelog issues are advisory only.

### Intra-plan compression

Same marker lineage as `decisions.md` compression (see `SKILL.md` "Consolidated File Management"), but structurally different — chronology MUST be preserved, so the summary lives INLINE at each elided group's original position rather than in a single top-of-file block. The top-of-file `<!-- COMPRESSED-SUMMARY -->` block is metadata only (counts, not content).

- **Trigger**: file >200 lines, evaluated at PLAN gate-in (lower threshold than decisions.md — changelog grows faster per step).
- **Implementation**: `maybeCompressChangelog(planDir, { threshold, dryRun })` exported from `src/scripts/bootstrap.mjs`.
- **Elidable rules** (a line is elidable if and only if ALL three hold):
  - radius tier ∈ {`LOW`, `MED`} per `references/blast-radius.md`
  - op field does NOT start with `REVERT(`
  - decision-ref field is `-` (no anchor)
- **Preserve-verbatim rules** (always survive compression):
  - tier `HIGH` or `UNKNOWN` (unknown is preserve-by-default — safer)
  - op starting with `REVERT(` (e.g. `REVERT(src/foo.js)`)
  - decision-ref field other than `-` (any `D-NNN` ref)
  - previously-elided inline summary lines (`- (compressed: …)` — idempotent re-compression)
  - the 4-line file header
- **Group threshold**: only runs of **5+ consecutive elidable lines** collapse. Smaller groups stay verbatim — eliding 2-3 lines is not worth the round-trip cost.
- **Idempotency**: `<!-- entries-at-compress: N -->` records the entry count at last compression. The N value counts BOTH live well-formed entry lines AND the entry-equivalents recorded in surviving inline summaries (each `- (compressed: K …)` contributes K). Without this dual count, a second pass after the first would see fewer "entries" and diverge.

**Format** — two pieces emitted in a single pass:

(a) Top-of-file metadata block, inserted immediately after the 4-line file header:

```markdown
<!-- COMPRESSED-SUMMARY -->
<!-- entries-at-compress: 187 -->
<!-- elided-groups: 3, elided-lines: 42 -->
<!-- /COMPRESSED-SUMMARY -->
```

(b) One inline summary line replacing each consecutive elidable group, AT the group's original chronological position:

```
- (compressed: 14 low-decision-impact edits, iter-1/step-3..iter-1/step-7, files: 4)
```

The `iter-X/step-Y..iter-X/step-Z` range collapses to a single `iter-X/step-Y` when start equals end. `files: N` counts distinct paths across the elided group.

No-op return reasons: `missing`, `empty`, `under-threshold`, `no-elidable-groups`, `no-new-entries`. Compression returns `{ compressed, beforeLines, afterLines, elidedCount, reason }`.

<!-- TEMPLATE:summary -->
## summary.md

Written at CLOSE.

```markdown
# Summary: Auth Session Migration
*Plan: plan-2026-01-15T084512-a3f1b2c9*

## Outcome
Successfully migrated from cookie-based sessions to JWT tokens with
cookie fallback for legacy clients.

## Iterations: 3
- v1: In-place Redis migration — failed (format coupling)
- v2: Dual-write — failed (memory doubling)
- v3: Token-based with fallback — succeeded

## Key Decisions
- See decisions.md for full log
- Critical insight: session format coupled to serialization pipeline,
  not just storage. Invalidated first two approaches.

## Files Changed
- app/middleware/auth.rb (modified)
- lib/session/token_service.rb (new)
- config/initializers/session.rb (modified)
- test/integration/token_auth_test.rb (new)

## Decision Anchors Registry
- `app/middleware/auth.rb:23` — `plan-2026-01-15T084512-a3f1b2c9/D-003` (token-based over cookie migration), `plan-2026-01-15T084512-a3f1b2c9/D-005` (direct Redis call)
- `lib/session/token_service.rb:1` — `plan-2026-01-15T084512-a3f1b2c9/D-003` (stateless tokens over dual-write)
- `lib/session/token_service.rb:15` — `plan-2026-01-15T084512-a3f1b2c9/D-002`, `plan-2026-01-15T084512-a3f1b2c9/D-003` (stateless over dual-write)

## Lessons
- Check format coupling before assuming storage changes are isolated
- Stateless > stateful when migrating session systems
- Dual-write only viable with short TTLs
```

<!-- TEMPLATE:presentation-contracts -->
## Presentation Contracts

**Canonical, single-source-of-truth definition** of the user-visible chat block the orchestrator MUST emit at each user-facing state transition. Sub-agents are invisible — only the orchestrator's chat text reaches the user. Disk artifacts (plan.md, verification.md, findings/*) are persistent memory, not user-facing channels. Every state transition that requires user input MUST be preceded by the corresponding presentation contract in the same assistant turn.

Each contract specifies: **name**, **when emitted**, **required content** (numbered, ordered), **fidelity** (verbatim vs digest), **minimum sections** (the floor — must always render even when token cost is high).

Agent files (`agents/ip-orchestrator.md` and contributing sub-agent files) inline these minimum-content lists at the point of dispatch — proximate instructions are followed more reliably than indirect references. This file is the canonical definition; agent files mirror the floor.

### PC-EXPLORE — Findings Digest

- **When emitted**: at EXPLORE → PLAN handoff, before transitioning state.
- **Required content** (in order):
  1. Findings index (file → topic → key takeaway), copied from `findings.md` Index table.
  2. Key constraints, classified as HARD / SOFT / GHOST, copied from `findings.md` Key Constraints.
  3. Exploration confidence self-assessment: scope [shallow/adequate/deep], solutions [narrow/open/constrained], risks [blind/partial/clear].
  4. One-paragraph synthesis: what the findings collectively imply for the plan.
- **Fidelity**: digest. Index and constraints rendered verbatim from disk; synthesis is the orchestrator's prose.
- **Minimum sections** (floor): items 1 and 2 (index + constraints) MUST render. Items 3-4 may be condensed but must appear.

### PC-PLAN — Plan Presentation

- **When emitted**: at PLAN → EXECUTE handoff, before requesting user approval.
- **Required content** (in order):
  1. Goal (verbatim from `plan.md` Goal section).
  2. Problem Statement (verbatim — expected behavior, invariants, edge cases).
  3. Context (verbatim — environment, constraints, pre-made decisions).
  4. Files To Modify (verbatim table).
  5. Steps (verbatim — every step, with risk/dependency annotations).
  6. Assumptions (verbatim table).
  7. Failure Modes (verbatim table).
  8. Pre-Mortem & Falsification Signals (verbatim).
  9. Success Criteria (verbatim table).
  10. Verification Strategy (verbatim table).
  11. Complexity Budget (verbatim).
  12. Explicit prompt: "Approve to enter EXECUTE, or request revisions."
- **Fidelity**: verbatim for items 1-11. Plan re-presentation after revision uses the same contract.
- **Minimum sections** (floor — must always render even on token-cost grounds): Steps, Success Criteria, Verification Strategy, Failure Modes, Assumptions. Longer prose sections (Context, Pre-Mortem) may be condensed by reference if and only if the floor is rendered in full.

### PC-EXECUTE-STEP — Per-Step Status Report

- **When emitted**: after each successful EXECUTE step's Post-Step Gate, before starting the next step.
- **Required content** (in order):
  1. Step number and one-line description.
  2. Files modified / created / deleted (paths only).
  3. Commit hash + commit message.
  4. Surprises encountered (or "none").
  5. Next step preview (one line).
- **Fidelity**: digest, but fields are mandatory (no field may be silently dropped).
- **Minimum sections** (floor): all 5 fields. None are optional.

### PC-EXECUTE-LEASH — Autonomy Leash Failure Block

- **When emitted**: after 2 failed fix attempts on the same step (leash hit), before transitioning EXECUTE → REFLECT.
- **Required content** (in order):
  1. What the step was supposed to do (verbatim from `plan.md`).
  2. What actually happened (per attempt, 2 attempts).
  3. Root-cause guess (one paragraph).
  4. Available checkpoints (id + git hash + reason) for rollback, copied from `checkpoints/*`.
  5. Explicit prompt: requesting user direction (continue / pivot / rollback).
- **Fidelity**: verbatim for items 1 and 4 (plan text and checkpoint registry); digest for items 2-3.
- **Minimum sections** (floor): all 5 items. None may be omitted.

### PC-REFLECT — REFLECT Phase-3 Gate-Out 5-Item Block

- **When emitted**: after REFLECT Phase-2 evaluation, before requesting user routing decision (CLOSE / PIVOT / EXPLORE / EXECUTE).
- **Required content** (exactly 5 items, in order):
  1. **What was completed** — copied from `progress.md` Completed section.
  2. **What remains** — copied from `progress.md` Remaining + In Progress sections (or "none").
  3. **Verification results summary** — PASS/FAIL counts plus the per-criterion table from `verification.md` Criteria Verification, rendered verbatim.
  4. **Issues found** — regressions, scope drift, unverified areas, simplification blockers; **plus** any CRITICAL/WARNING items from `findings/review-iter-N.md` (iteration ≥ 2) folded in verbatim; **plus** any verifier **Concerns** (suspicious-but-PASS observations, per the Relay Contract in `ip-verifier.md`) folded in verbatim.
  5. **Recommendation** — one of CLOSE / PIVOT / EXPLORE / EXECUTE (EXECUTE only for a same-iteration completion-fix remediation loop — small fixes to finish the current iteration's work; `iter` does not increment), with one-sentence justification, then explicit prompt for user confirmation.
- **Fidelity**: verbatim for items 1-3 (progress + verification table + reviewer + verifier concerns); digest for items 4-5 commentary, but the underlying lists must be enumerated (no rolling-up into prose).
- **Minimum sections** (floor): all 5 items. The block is defined by its 5-item structure; collapsing to fewer items violates the contract.

### PC-PIVOT — Pivot Options Block

- **When emitted**: at REFLECT → PIVOT routing decision, before transitioning to PLAN.
- **Required content** (in order):
  1. Pivot reason — what failed, what was learned (digest of `decisions.md` PIVOT entry).
  2. Available checkpoints (id + git hash + reason), copied from `checkpoints/*`. Default-revert recommendation if uncertain.
  3. Ghost constraints surfaced (if any) — copied from `decisions.md` Ghost Constraint Scan.
  4. Candidate new directions — 1-3 options with one-sentence trade-off framing each ("X at the cost of Y").
  5. Explicit prompt: which direction + keep-vs-revert decision.
- **Fidelity**: verbatim for items 2-3 (checkpoint registry + ghost constraints); digest for items 1, 4-5.
- **Minimum sections** (floor): all 5 items. Items 2 and 4 are non-negotiable: the user cannot make the routing decision without checkpoint visibility and concrete options.

### Cross-references

- `agents/ip-orchestrator.md` — inlines the minimum-content list of each contract at the point of dispatch.
- `agents/ip-plan-writer.md` — Output Format references PC-PLAN.
- `agents/ip-verifier.md` — Relay Contract references PC-REFLECT item 3.
- `agents/ip-reviewer.md` — Relay Contract references PC-REFLECT item 4.
- `agents/ip-executor.md` — Output Format references PC-EXECUTE-STEP and PC-EXECUTE-LEASH.
- `SKILL.md` — User Interaction table cell references the contract by name.

<!-- TEMPLATE:lessons-synthesis -->
## lessons-synthesis.md

*Structured CLOSE-time reflection. The archivist fills this to promote recurring per-plan findings/decisions into plans/LESSONS.md. Each entry carries an `[I:N]` importance tag (1-5; see the LESSONS.md template). This is a synthesis GUIDE — its output feeds the LESSONS.md rewrite; persisting the filled form is optional.*

### Recurring Patterns
- <pattern seen across ≥2 plans> [I:N]

### Failed Approaches (+ why)
- <approach that failed and the reason it failed> [I:N]

### Successful Strategies
- <strategy that worked and is worth repeating> [I:N]

### Codebase Gotchas
- <surprising constraint / sharp edge discovered> [I:N]

<!-- TEMPLATE:END -->

## Bootstrap Skeletons (machine-checked)

The regions below are the **exact bytes `bootstrap.mjs` writes** for each plan file on `bootstrap.mjs new` — one region per key of `PLAN_TEMPLATES` in `src/scripts/bootstrap.mjs`, with its `{{TOKEN}}` placeholders left unsubstituted. `check-template-parity.mjs` (run by `make validate`) enforces byte-equality between each region and its template **in both directions**: a template with no region, or a region with no template, is a FAIL. Editing one without the other turns `make validate` red — that is the whole point of this section.

**These are not the worked examples above.** Everything before this section shows a *populated* file — a filled-in `plan.md`, a `decisions.md` with real entries — so a human can see what "good" looks like. The regions here show the *empty skeleton bootstrap actually writes* into a fresh plan directory. Both are true; they answer different questions. Do not copy example content into a skeleton region: a fresh `INDEX.md` must not ship with two fake rows.

**Region↔bytes contract** (encoded in `check-template-parity.mjs`; read it before editing a region):

- A region opens with `<!-- SKELETON:<slug> -->` on its own line, followed immediately by a fenced `markdown` block.
- The region **body** is the lines strictly between the opening fence line and its closing fence line, joined with `\n`, **plus a trailing `\n`**. Every template ends with exactly one newline, so this round-trips byte-exactly.
- `{{TOKEN}}` placeholders are content. Leave them literal — they are substituted at plan-creation time by `renderTemplate()`, never here.
- No skeleton body may contain a triple-backtick fence (it would close the block early) or the literal `<!-- TEMPLATE:` (it would truncate the last template slice emitted by `emit-template.mjs`). The checker enforces both.
- The set is terminated by `<!-- SKELETON:END -->`. Nothing between the markers is prose — a region is bytes, not documentation.
- **A template's HEADER belongs to this half alone.** HEADER = a template's leading lines up to its first blank line (the run bootstrap writes and agents never populate — they append below it). Rule `[header-copy]` FAILs the build if **any 2 consecutive header lines** reappear anywhere **before `<!-- TEMPLATE:END -->`**, in prose or in a fenced block: that would be a second, un-gated copy of bootstrap's bytes, and `emit-template` serves *that* half to agents. Worked examples therefore show each file **below its header** and point here. It is a byte comparison against `PLAN_TEMPLATES`, so there is no phrase to reword around — and no allowlist: if it fires on something a worked example genuinely needs, the rule's scope is wrong, not the line. Two gaps are known and deliberate: structural lines *below* a header (a table header, a `## Completed` heading) are legitimately reused and are **not** gated, and `plan`/`progress` have 1-line headers, below the 2-line threshold.

<!-- SKELETON:state -->
```markdown
# Current State: EXPLORE
*Skill: iterative-planner v{{VERSION}}*
## Iteration: 0
## Current Plan Step: N/A
## Pre-Step Checklist (reset before each EXECUTE step)
- [ ] Re-read state.md (this file)
- [ ] Re-read plan.md
- [ ] Re-read progress.md
- [ ] Re-read decisions.md (if fix attempt)
- [ ] Checkpoint created (if risky step or irreversible op)
## Fix Attempts (resets per plan step)
- (none yet)
## Change Manifest (current iteration)
- (no changes yet)
## Last Transition: INIT → EXPLORE ({{TIMESTAMP}})
## Transition History:
- INIT → EXPLORE (task started)
<!-- When logging EXPLORE → PLAN, add Exploration Confidence on the line below the transition entry, e.g.:
- EXPLORE → PLAN (gathered enough context, YYYY-MM-DDTHH:MM:SSZ)
  - confidence: scope=deep|partial|shallow, solutions=adequate|thin, risks=clear|unclear
See references/planning-rigor.md for definitions. -->
```

<!-- SKELETON:plan -->
```markdown
# Plan v0

## Goal
{{GOAL}}

## Problem Statement
*To be defined during PLAN. (1) Expected behavior, (2) invariants, (3) edge cases.*

## Context
*Pending EXPLORE phase. Findings will inform the approach.*

## Files To Modify
*To be determined after EXPLORE. List every file that will be touched.*

## Steps
*To be determined after EXPLORE. Annotate each with [RISK: low/medium/high] and [deps: N,M].*

## Assumptions
*To be populated during PLAN. Each: what you assume, which finding grounds it, which steps depend on it.*

## Failure Modes
*To be determined during PLAN. For each dependency/integration: what if slow, garbage, down?*

## Pre-Mortem & Falsification Signals
*To be determined during PLAN. Assume the plan failed — 2-3 scenarios with concrete STOP IF triggers.*

## Success Criteria
*To be defined before first EXECUTE.*

## Verification Strategy
*To be defined during PLAN. For each success criterion, define what check to run and what "pass" means.*

## Complexity Budget
- Files added: 0/3 max
- New abstractions (classes/modules/interfaces): 0/2 max
- Lines added vs removed: +0/-0 (target: net negative or neutral)
```

<!-- SKELETON:decisions -->
```markdown
# Decision Log
*Plan: {{PLAN_ID}}*
*Skill: iterative-planner v{{VERSION}}*
*Append-only. Never edit past entries.*
{{CROSS_PLAN_NOTE}}
<!-- Schema example — DO NOT REMOVE. Real entries follow this shape.
     See references/file-formats.md "Entry Schema by Type" for required fields per entry type.
     In-code anchors carry the plan-id prefix: `# DECISION {{PLAN_ID}}/D-NNN` (see references/decision-anchoring.md).

## D-001 | EXPLORE → PLAN | YYYY-MM-DD
**Context**: <one-paragraph background — what was discovered in EXPLORE>
**Decision**: <chosen approach in one sentence>
**Trade-off**: <X> **at the cost of** <Y>
**Reasoning**: <why this trade-off is acceptable; what alternatives were rejected>
**Anchor-Refs**: `path/to/file.ext:LL`, `other/file.ext:LL-MM`  (required when a matching `# DECISION {{PLAN_ID}}/D-NNN` anchor exists in source)
-->
```

<!-- SKELETON:findings -->
```markdown
# Findings
*Summary and index of all findings. Detailed files go in findings/ directory.*
{{CROSS_PLAN_NOTE}}
## Index
*To be populated during EXPLORE.*

## Key Constraints
*To be populated during EXPLORE.*

## Corrections
*Append [CORRECTED iter-N] entries here when earlier findings prove wrong. Reference the original finding file and what changed.*
```

<!-- SKELETON:progress -->
```markdown
# Progress

## Completed
*Nothing yet.*

## In Progress
- [ ] EXPLORE: Initial context gathering

## Remaining
*To be populated from plan.md after PLAN phase.*

## Blocked
*Nothing currently.*
```

<!-- SKELETON:verification -->
```markdown
# Verification Results
*Populated during PLAN (template), updated during EXECUTE (per-step), completed during REFLECT (full pass).*
*Rewritten each iteration — not append-only.*

## Criteria Verification
| # | Criterion (from plan.md) | Method | Command/Action | Result | Evidence |
|---|--------------------------|--------|----------------|--------|----------|
| 1 | *To be populated during PLAN* | - | - | PENDING | - |

## Additional Checks
*Required rows below are pre-populated every REFLECT cycle. Append optional rows (lint, type checks, behavioral diffs, smoke tests) as needed.*

| Check | Command/Action | Result | Details |
|-------|----------------|--------|---------|
| Regression | *To be populated during REFLECT (re-run previously-passing tests)* | PENDING | - |
| Scope drift | *To be populated during REFLECT (compare state.md manifest vs plan.md Files To Modify)* | PENDING | - |
| Diff review | *To be populated during REFLECT (review git diff for debug artifacts, TODOs, commented-out code)* | PENDING | - |

## Not Verified
| What | Why |
|------|-----|
| *To be populated during REFLECT* | - |

## Prediction Accuracy
*Compare plan.md predictions against actual results during REFLECT.*

| Predicted (from plan.md) | Actual | Delta |
|--------------------------|--------|-------|
| *To be populated during REFLECT* | - | - |

## Convergence Metrics
*EXTENDED — iteration 2+. First iteration: write "N/A — first iteration." See references/convergence-metrics.md.*

| Metric | Previous | Current | Delta |
|--------|----------|---------|-------|
| Pass rate | - | - | - |
| Scope (planned vs changed) | - | - | - |
| New issues found | - | - | - |
| **Convergence score** | - | - | - |

## Verdict
*To be completed during REFLECT. All 5 bullets required, in order. See references/file-formats.md.*

- Criteria passed: PENDING (N/M)
- Regressions: PENDING
- Scope drift: PENDING
- Simplification blockers: PENDING
- Recommendation: PENDING (→ CLOSE / PIVOT / EXPLORE / EXECUTE)
```

<!-- SKELETON:changelog -->
```markdown
# Changelog
*Append-only per-edit ledger. One line per file edit. Owner: ip-executor (writes). Reader: ip-reviewer at REFLECT.*
*Format: `UTC | iter-N/step-M | commit | path | OP(+N,-M) | radius:TIER(score) | D-NNN-or-dash | reason`*
*See references/blast-radius.md for radius scoring. Decision-ref optional — `-` means no `# DECISION` anchor governs this edit.*
```

<!-- SKELETON:system -->
```markdown
# System Atlas
*Last refreshed: (none yet) | (no plan closed yet)*
*Domain-neutral system map. Rewritten at CLOSE — max 300 lines. Read before PLAN/EXPLORE.*
*UNPOPULATED SKELETON — every bullet below is a schema hint, not an established fact. Rewritten wholesale by ip-archivist at first CLOSE.*

## Identity
- *What the system is (1-2 sentences). Domain (codebase / research / ops / strategy / other).*

## Components
- *Top-level building blocks. 5-15 entries. One line each: `name` — role.*

## Boundaries
- *In scope vs out of scope.*
- *External dependencies (services, APIs, files).*
- *Boundary inputs the planner reads but does not own (e.g. CLAUDE.md, config files).*

## Invariants
- *Properties that must always hold (security, data, contracts, performance budgets).*
- *Each grounded in a finding-id or decision-id reference (e.g. `see <plan-id>/D-002`).*

## Flows
- *3-7 named end-to-end flows: trigger → path → terminus.*

## Known Patterns
- *Architectural archetypes the system instantiates (e.g. "stateless HTTP API + Redis cache", "FSM-driven CLI", "compiler", "research pipeline", "agent workflow").*

## Codebase Specialization
*Optional — present only when domain=codebase. Omit entirely for non-code systems.*
- *Module map: top-level directories and their purpose.*
- *Key files (by frequency-of-relevance).*
- *Build / test / run commands.*
```

<!-- SKELETON:findings-consolidated -->
```markdown
# Consolidated Findings
*Cross-plan findings archive. Entries merged from per-plan findings.md on close. Newest first.*
```

<!-- SKELETON:decisions-consolidated -->
```markdown
# Consolidated Decisions
*Cross-plan decision archive. Entries merged from per-plan decisions.md on close. Newest first.*
```

<!-- SKELETON:lessons -->
```markdown
# Lessons Learned
*Cross-plan lessons. Updated and consolidated on close. Max 200 lines — rewrite, don't append forever.*
*Read before any PLAN state. This is institutional memory.*
```

<!-- SKELETON:index -->
```markdown
# Plan Index
*Topic-to-directory mapping. Updated on close. Survives sliding window trim.*

| Plan | Date | Goal | Key Topics |
|------|------|------|------------|
```

<!-- SKELETON:END -->
