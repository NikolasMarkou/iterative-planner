# File Formats Reference

Templates and examples for every `{plan-dir}` file.

## state.md

Single source of truth for "where am I?"

```markdown
# Current State: EXECUTE
## Iteration: 3
## Current Plan Step: 2 of 5
## Last Transition: PLAN → EXECUTE (approved by user)
## Fix Attempts (resets per plan step)
- (none yet for current step)
## Change Manifest (current iteration)
- [x] `lib/session/token_service.rb` — CREATED (step 1, committed abc123)
- [ ] `app/middleware/auth.rb` — MODIFIED lines 23-45 (step 2, uncommitted)
- [ ] `config/initializers/session.rb` — MODIFIED (step 2, uncommitted)
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
1. [x] Create TokenService abstraction
2. [ ] Wire TokenService into auth middleware  ← CURRENT
3. [ ] Add fallback path for legacy cookie sessions
4. [ ] Migration script for existing sessions
5. [ ] Integration tests

## Failure Modes
| Dependency | Slow | Bad Data | Down | Blast Radius |
|---|---|---|---|---|
| Redis (legacy fallback) | Token path unaffected; cookie path degrades to timeouts | Corrupted session → force re-auth | Cookie clients lose sessions; token clients unaffected | Legacy users only |
| JWT signing key | N/A | Invalid tokens → all token clients locked out | Same as bad data | All new-auth users |

## Risks
- Step 3 might break SSO flow (see findings.md line 47)

## Success Criteria
- All existing tests pass
- New integration tests for token flow pass
- Legacy sessions gracefully degrade

## Complexity Budget
- Files added: 1/3 max
- New abstractions (classes/modules/interfaces): 1/2 max
- Lines added vs removed: +45/-12 (target: net negative or neutral)
```

**Problem Statement** is mandatory. Can't state invariants and edge cases → go back to EXPLORE.
**Failure Modes** table is mandatory when external dependencies exist. No dependencies → write "None identified".
**Files To Modify** is mandatory. Can't list them → go back to EXPLORE.

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
