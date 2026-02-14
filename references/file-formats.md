# File Formats Reference

Detailed templates and examples for every file in the `.plan/` directory.

---

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

Update this file on every state transition. The transition history is the
complete audit trail of the task.

The Fix Attempts section tracks autonomous fix attempts on the current plan step.
After 2 failed attempts, you MUST stop and wait for user direction. The counter
resets when: the user gives direction, you move to a new step, or you enter RE-PLAN.

Example of a leash hit:

```markdown
## Fix Attempts (resets per plan step)
- Step 2, attempt 1: reverted middleware change — still fails (type mismatch)
- Step 2, attempt 2: deleted adapter, called service directly — new error (missing auth)
- Step 2: LEASH HIT. Transitioned to REFLECT. Waiting for user direction.
```

The Change Manifest tracks every file created, modified, or deleted during the
current iteration. Mark committed changes with `[x]` and uncommitted with `[ ]`.
On failed step or RE-PLAN, revert all uncommitted changes. On nuclear option,
revert everything. See the Code Hygiene section in SKILL.md.

---

## plan.md

The living plan. Gets **rewritten** each iteration, not appended.
Old plans are preserved via `decisions.md` entries.

Include **only the recommended approach**. Rejected alternatives and prior
failed approaches belong in `decisions.md`, not here.

```markdown
# Plan v3: Token-Based Session Migration

## Goal
Migrate session handling from cookie-based to token-based auth.

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

The **Files To Modify** section is mandatory. If you can't list the files,
you haven't explored enough — go back to EXPLORE.

---

## decisions.md

Append-only. **Never edit or delete past entries.** This is institutional memory.

```markdown
# Decision Log

## D-001 | EXPLORE → PLAN | 2025-01-15
**Context**: Auth system uses 3 different session stores (Redis, DB, in-memory)
**Decision**: Start with approach A (in-place migration of Redis sessions)
**Reasoning**: Redis sessions are 80% of traffic, smallest blast radius

## D-002 | REFLECT → RE-PLAN | 2025-01-15
**Context**: Approach A fails — Redis session format is coupled to cookie serializer
**What Failed**: Cannot deserialize existing sessions with new token format
**What Was Learned**: Session format is not just storage, it's tied to the entire
  serialization pipeline in `lib/session/serializer.rb`
**Root Cause**: Tight coupling between cookie format and session store
**Complexity Assessment**:
- Lines added in failed attempt: 34
- New abstractions added: 1 (SessionAdapter — now deleted)
- Could the fix have been simpler? Yes — should have checked format coupling first
- Am I adding or removing complexity with the new plan? Removing (eliminates adapter)
**Decision**: Switch to approach B (dual-write with gradual migration)
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
**Reasoning**: Tokens are stateless, eliminates Redis growth problem entirely
```

The Complexity Assessment block is mandatory for all RE-PLAN entries.

---

## findings.md

Updated during EXPLORE phases. Structured discoveries about the codebase and problem.
Always include **file paths with line numbers** and **code path traces** showing
how execution flows through the system.

`findings.md` is the **summary and index**. Detailed findings go in `findings/` as
individual files — one per topic or subagent research task.

### findings.md (summary/index)

```markdown
# Findings

## Index
- [Auth System Architecture](findings/auth-system.md) — entry points, session stores, serialization coupling
- [Test Coverage](findings/test-coverage.md) — coverage gaps, missing integration tests
- [Dependencies](findings/dependencies.md) — gem constraints, Rails version pins

## Key Constraints
- SessionSerializer is shared between cookie middleware AND API auth (see auth-system.md)
- rack-session gem pins us to cookie-compatible format (see dependencies.md)
- No integration tests for session migration (see test-coverage.md)
```

### findings/ directory (detailed files)

Each file is a self-contained research artifact. When using subagents, **instruct
each subagent to write its output directly to a file in `.plan/findings/`**. Do not
rely on subagent results living only in the context window — they will be lost to
compaction.

Example subagent prompt:
> Explore the authentication system. Write your findings to `.plan/findings/auth-system.md`.
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
  - Cookie middleware calls `SessionSerializer.load` (line 34)
  - API auth calls `SessionSerializer.load` via `ApiAuth#from_token` (line 67)
  - Changing session format affects BOTH web and API flows
  - File: lib/session/serializer.rb:34-89

## Dependencies
- `rack-session` gem pins us to cookie-compatible session format
- Upgrading rack-session requires Rails 7.1+ (currently on 7.0.4)
```

Write findings as you discover them. Include file paths and line numbers.
This file is your "notes" — structure is flexible but should be scannable.

---

## progress.md

Flat checklist. **Updated in every phase that changes task status:**
- PLAN: populate "Remaining" from plan steps.
- EXECUTE: move items to "In Progress" → "Completed" after each step.
- REFLECT: mark items as failed/blocked if step didn't succeed.
- RE-PLAN: annotate items affected by the pivot.

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

---

## checkpoints/cp-NNN.md

Created before risky EXECUTE steps.

```markdown
# Checkpoint 003

## Created: Before wiring TokenService into middleware
## Git State: commit abc123f
## Files That Will Change:
- app/middleware/auth.rb
- config/initializers/session.rb
- lib/session/token_service.rb (new)

## Rollback:
git checkout abc123f -- app/middleware/auth.rb config/initializers/session.rb
rm lib/session/token_service.rb
```

### When to Checkpoint
- **Before iteration 1 EXECUTE begins**: create `cp-000.md` recording the clean starting state. This is the nuclear option fallback.
- Before modifying 3+ files simultaneously
- Before changing any shared/core module
- Before destructive operations (migrations, deletions)
- When the user says "I'm not sure about this"

---

## summary.md

Written at CLOSE. Final outcome and lessons learned.

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
- Critical insight: session format was coupled to serialization pipeline,
  not just storage. This invalidated the first two approaches.

## Files Changed
- app/middleware/auth.rb (modified)
- lib/session/token_service.rb (new)
- config/initializers/session.rb (modified)
- test/integration/token_auth_test.rb (new)

## Decision-Anchored Comments
Files containing comments that explain non-obvious choices from failed iterations:
- `app/middleware/auth.rb:23` — why token-based instead of cookie migration (D-003)
- `lib/session/token_service.rb:15` — why stateless over dual-write (D-002, D-003)

## Decision Anchors in Code
- `lib/session/token_service.rb:1` — D-003: stateless tokens over dual-write
- `app/middleware/auth.rb:23` — D-005: direct Redis call, not SessionStore

## Lessons
- Check format coupling before assuming storage changes are isolated
- Stateless > stateful when migrating session systems
- Dual-write is only viable when TTLs are short
```
