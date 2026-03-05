# File Formats Reference

Templates and examples for every `{plan-dir}` file.

## state.md

Single source of truth for "where am I?"

```markdown
# Current State: EXECUTE
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
- REFLECT → RE-PLAN (approach A can't handle concurrent sessions)
- RE-PLAN → PLAN (switching to approach B: token-based)
- PLAN → EXECUTE (user approved revised plan)
```

Update on every state transition.

**Fix Attempts**: tracks autonomous fixes on current step. After 2 fails → STOP. Resets on: user direction, new step, RE-PLAN. Leash hit example:

```markdown
## Fix Attempts (resets per plan step)
- Step 2, attempt 1: reverted middleware change — still fails (type mismatch)
- Step 2, attempt 2: deleted adapter, called service directly — new error (missing auth)
- Step 2: LEASH HIT. Transitioned to REFLECT. Waiting for user direction.
```

**Change Manifest**: `[x]` = committed, `[ ]` = uncommitted. On failed step / RE-PLAN → revert uncommitted. See `code-hygiene.md`.

## plan.md

Living plan. **Rewritten** each iteration (old plans preserved via `decisions.md`).
Only recommended approach. Rejected alternatives → `decisions.md`.

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

## decisions.md

Append-only. **Never edit or delete past entries.**
Every entry must include a **Trade-off** line: "X **at the cost of** Y".

```markdown
# Decision Log

## D-001 | EXPLORE → PLAN | 2025-01-15
**Context**: Auth system uses 3 different session stores (Redis, DB, in-memory)
**Decision**: Start with approach A (in-place migration of Redis sessions)
**Trade-off**: Fastest path to 80% coverage **at the cost of** ignoring DB/in-memory stores and risking format coupling issues
**Reasoning**: Redis sessions are 80% of traffic, smallest blast radius

## D-002 | REFLECT → RE-PLAN | 2025-01-15
**Context**: Approach A fails — Redis session format is coupled to cookie serializer
**What Failed**: Cannot deserialize existing sessions with new token format
**What Was Learned**: Session format tied to entire serialization pipeline in `lib/session/serializer.rb`
**Root Cause**: Tight coupling between cookie format and session store
**Complexity Assessment**:
- Lines added in failed attempt: 34
- New abstractions added: 1 (SessionAdapter — now deleted)
- Could the fix have been simpler? Yes — should have checked format coupling first
- Am I adding or removing complexity with the new plan? Removing (eliminates adapter)
**Decision**: Switch to approach B (dual-write with gradual migration)
**Trade-off**: Safe rollback and format decoupling **at the cost of** doubled storage for TTL duration
**Reasoning**: Decouples new format from legacy, allows rollback

## D-003 | REFLECT → RE-PLAN | 2025-01-15
**Context**: Approach B works but dual-write doubles Redis memory usage
**What Failed**: Memory spike in staging from 2GB to 4.1GB
**What Was Learned**: Session TTLs are 30 days, so dual-write accumulates fast
**Root Cause**: Dual-write inherently doubles storage for TTL duration
**Complexity Assessment**:
- Lines added in failed attempt: 89
- New abstractions added: 2 (DualWriter, MigrationTracker)
- Could the fix have been simpler? Yes — the problem is architectural, not code-level
- Am I adding or removing complexity with the new plan? Removing (stateless tokens)
**Decision**: Switch to approach C (token-based with cookie fallback)
**Trade-off**: Stateless validation and zero storage growth **at the cost of** maintaining two auth paths during migration
**Reasoning**: Tokens are stateless, eliminates Redis growth problem entirely
```

Complexity Assessment mandatory for all RE-PLAN entries.

## findings.md

Updated during EXPLORE. Corrected during RE-PLAN when earlier findings prove wrong. Always include **file paths with line numbers** and **code path traces**.

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

## progress.md

Flat checklist. Updated in: PLAN (populate Remaining), EXECUTE (move items), REFLECT (mark failed/blocked), RE-PLAN (annotate pivot).

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
| Lint | `rubocop --format simple` | PASS | 0 offenses |
| Behavioral diff | diff /api/auth/validate response | EXPECTED DIFF | Token field added (intentional) |
| Smoke test | POST /login with test credential | PASS | 200 + valid JWT returned |

## Prediction Accuracy
| Predicted (from plan.md) | Actual | Delta |
|--------------------------|--------|-------|
| 5 steps | 5 steps | on target |
| 4 files modified | 4 files modified | on target |
| +45/-12 lines | +45/-12 lines | on budget |
| 1 iteration (plan v3) | 1 iteration | on target |

## Verdict
- Criteria passed: 3/3
- Blockers: none
- Recommendation: → CLOSE
```

**Criteria Verification table** is mandatory — one row per success criterion from `plan.md`. **Result** must be PASS or FAIL. **Evidence** must be concrete (counts, output excerpts, log references) — not "looks good" or "seems to work".

**Additional Checks** is optional — for lint, type checks, behavioral diffs, smoke tests, or other verification not directly tied to a success criterion.

**Verdict** is mandatory — count of pass/fail, blockers, and recommended transition.

Plans with no testable criteria: write "N/A — manual review only" in Method column. Still record the manual review outcome in Result + Evidence.

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

## Rollback:
git checkout abc123f -- app/middleware/auth.rb config/initializers/session.rb
rm lib/session/token_service.rb
```

### When to Checkpoint
- **Iteration 1, first EXECUTE**: `cp-000-iter1.md` = clean starting state (nuclear fallback)
- Before modifying 3+ files simultaneously
- Before changing shared/core modules (used by multiple callers or multiple systems)
- Before destructive operations (schema changes, file deletions, config overwrites)
- User expresses uncertainty

## plans/FINDINGS.md (consolidated)

Cross-plan findings archive. Entries merged from per-plan `findings.md` on close. Per-plan headings demoted one level (## → ###) and nested under a `## plan_YYYY-MM-DD_XXXXXXXX` section. Relative `findings/` links rewritten to `plan_YYYY-MM-DD_XXXXXXXX/findings/`.

**Newest first** — most recently closed plan appears at the top (after the header). This keeps the most relevant context immediately accessible without reading the entire file.

**Sliding window**: Auto-trimmed to the **8 most recent** plan sections on each close. Old plan data remains in per-plan directories (`plans/plan_*/findings.md`). Keeps file naturally bounded at ~300-450 lines.

**Read limit**: Always read with `limit: 600`. Compressed summary + recent plan sections fit within this.

**Compression**: When >500 lines (rare with sliding window), a compressed summary (≤100 lines) is inserted between `<!-- COMPRESSED-SUMMARY -->` markers after the header. See "Consolidated File Management" in SKILL.md.

Created automatically by bootstrap on first `new`. Updated on each `close`.

### Without compression (<500 lines)

```markdown
# Consolidated Findings
*Cross-plan findings archive. Entries merged from per-plan findings.md on close. Newest first.*

## plan_2026-02-20_b4e2c3d0
### Index
- [Database Schema](plan_2026-02-20_b4e2c3d0/findings/db-schema.md) — table relationships
### Key Constraints
- Foreign key constraints prevent cascade delete on users table

## plan_2026-02-19_a3f1b2c9
### Index
- [Auth System](plan_2026-02-19_a3f1b2c9/findings/auth-system.md) — entry points, session stores
### Key Constraints
- SessionSerializer shared between cookie middleware AND API auth
```

### With compression (>500 lines)

```markdown
# Consolidated Findings
*Cross-plan findings archive. Entries merged from per-plan findings.md on close. Newest first.*

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

## plan_2026-02-20_b4e2c3d0
### Index
- [Database Schema](plan_2026-02-20_b4e2c3d0/findings/db-schema.md) — table relationships
### Key Constraints
- Foreign key constraints prevent cascade delete on users table

## plan_2026-02-19_a3f1b2c9
### Index
...
```

Usage:
- Read (limit: 600) at start of EXPLORE and during PLAN gate check for cross-plan context
- Do not edit directly — content is merged automatically on `close`
- Agent/user can curate (remove stale sections) manually if needed
- When compressing: only summarize `## plan_*` sections, SKIP content between `<!-- COMPRESSED-SUMMARY -->` markers

## plans/DECISIONS.md (consolidated)

Cross-plan decision archive. Entries merged from per-plan `decisions.md` on close. Decision IDs (D-NNN) are scoped to their plan section — no cross-plan deduplication.

**Newest first** — most recently closed plan appears at the top (after the header).

**Sliding window**: Auto-trimmed to the **8 most recent** plan sections on each close. Old plan data remains in per-plan directories (`plans/plan_*/decisions.md`). Keeps file naturally bounded at ~300-450 lines.

**Read limit**: Always read with `limit: 600`. Compressed summary + recent plan sections fit within this.

**Compression**: When >500 lines (rare with sliding window), a compressed summary (≤100 lines) is inserted between `<!-- COMPRESSED-SUMMARY -->` markers after the header. See "Consolidated File Management" in SKILL.md.

Created automatically by bootstrap on first `new`. Updated on each `close`.

### Without compression (<500 lines)

```markdown
# Consolidated Decisions
*Cross-plan decision archive. Entries merged from per-plan decisions.md on close. Newest first.*

## plan_2026-02-20_b4e2c3d0
### D-001 | EXPLORE → PLAN | 2025-01-20
**Context**: Users table migration needed
**Decision**: Use reversible migration with dual-column approach
**Trade-off**: Zero-downtime migration **at the cost of** temporary schema complexity

## plan_2026-02-19_a3f1b2c9
### D-001 | EXPLORE → PLAN | 2025-01-15
**Context**: Auth system uses 3 different session stores
**Decision**: Start with approach A (in-place migration)
**Trade-off**: Fastest path **at the cost of** ignoring DB/in-memory stores

### D-002 | REFLECT → RE-PLAN | 2025-01-15
**Context**: Approach A fails — format coupling
**Decision**: Switch to approach B (dual-write)
**Trade-off**: Safe rollback **at the cost of** doubled storage
```

### With compression (>500 lines)

```markdown
# Consolidated Decisions
*Cross-plan decision archive. Entries merged from per-plan decisions.md on close. Newest first.*

<!-- COMPRESSED-SUMMARY -->
## Summary (compressed)
*Auto-compressed from 623 lines. Read full content below line 600 if needed.*

### Key Decisions
- Auth: Token-based sessions chosen over cookie migration (format coupling) and dual-write (memory doubling)
- DB: Reversible migration with dual-column approach for zero-downtime
- DO NOT: In-place Redis session migration (format coupled to serializer pipeline)
- DO NOT: Dual-write sessions (30-day TTLs cause 2x memory)
<!-- /COMPRESSED-SUMMARY -->

## plan_2026-02-20_b4e2c3d0
### D-001 | EXPLORE → PLAN | 2025-01-20
...
```

Usage:
- Read (limit: 600) at start of EXPLORE and during PLAN gate check — learn what was tried before
- Do not edit directly — content is merged automatically on `close`
- Decision IDs are scoped per plan section (each plan starts at D-001)
- When compressing: only summarize `## plan_*` sections, SKIP content between `<!-- COMPRESSED-SUMMARY -->` markers

## plans/LESSONS.md

Cross-plan institutional memory. **Rewritten** (not appended) at CLOSE to stay ≤200 lines. Read before PLAN.

```markdown
# Lessons Learned
*Cross-plan lessons. Updated and consolidated on close. Max 200 lines — rewrite, don't append forever.*
*Read before any PLAN state. This is institutional memory.*

## Patterns That Work
- Token-based auth is simpler than session migration — prefer stateless when possible
- Always check format coupling before assuming storage changes are isolated
- Checkpoint before any 3+ file change — rollback cost is near zero, re-work cost is high

## What To Avoid
- Dual-write strategies with long TTLs (storage grows unbounded)
- In-place format migrations when serializer is shared across subsystems
- Adapters/wrappers as fixes — they accumulate and obscure the real problem

## Codebase Gotchas
- SessionSerializer is shared between cookie middleware AND API auth — changes affect both
- rack-session gem pins cookie-compatible format; upgrading requires Rails 7.1+
- Foreign key constraints on users table prevent cascade delete

## Recurring Traps
- "Just add an adapter" → 3-strike pattern. Simplify instead.
- Skipping EXPLORE because "I already know this" → missed constraints every time
```

Usage:
- Read at start of EXPLORE, before PLAN gate check, and before RE-PLAN
- At CLOSE: read current file, integrate significant lessons from this plan, rewrite entire file ≤200 lines
- Consolidate aggressively — merge related lessons, drop low-value or stale entries
- Focus on: recurring patterns, failed approaches, successful strategies, codebase gotchas
- Drop: one-off findings, detailed decision reasoning, plan-specific details
- Created automatically by bootstrap on first `new`

## summary.md

Written at CLOSE.

```markdown
# Summary: Auth Session Migration

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

## Decision Anchors in Code
- `app/middleware/auth.rb:23` — D-003 (token-based over cookie migration), D-005 (direct Redis call)
- `lib/session/token_service.rb:1` — D-003 (stateless tokens over dual-write)
- `lib/session/token_service.rb:15` — D-002, D-003 (stateless over dual-write)

## Lessons
- Check format coupling before assuming storage changes are isolated
- Stateless > stateful when migrating session systems
- Dual-write only viable with short TTLs
```
