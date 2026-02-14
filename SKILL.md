---
name: iterative-planner
description: >
  State-machine driven iterative planning and execution protocol for complex coding tasks.
  Replaces linear plan-then-execute with a cycle of Explore → Plan → Execute → Reflect → Re-plan.
  Uses the filesystem as persistent working memory in the project root (.plan/ directory) to survive
  context rot, track decisions, and enable rollback. Use this skill whenever a task is complex,
  multi-file, involves migration or refactoring, has failed before, or when the user says things
  like "plan", "figure out", "help me think through", "I've been struggling with", or "debug this
  complex issue". Also use when a task touches 3+ files, spans 2+ systems, or has no obvious
  single solution. Err on the side of using this skill for anything non-trivial.
---

# Iterative Planner

A protocol for complex coding tasks where the first plan is never the final plan.

**Core Principle**: Context Window = RAM. Filesystem = Disk.
Anything important gets written to disk immediately. The context window will rot. The files won't.

All state lives in `.plan/` in the **project root directory** (never the user's home).

## State Machine

```
              ┌──────────┐
              │  EXPLORE  │──── enough context ────►┌────────────┐
              └──────────┘                          │    PLAN     │
                    ▲                               └─────┬──────┘
                    │                                     │
                 need more                             approved
                  context                                 │
                    │                                     ▼
              ┌─────┴──────┐                        ┌──────────┐
              │  REFLECT   │◄──── observe result ───│  EXECUTE  │
              └─────┬──────┘                        └──────────┘
                    │
              ┌─────┴──────────────────┐
              │                        │
           solved                  not solved
              │                        │
              ▼                        ▼
        ┌──────────┐            ┌──────────┐
        │  CLOSE   │            │ RE-PLAN   │───► back to PLAN
        └──────────┘            └──────────┘
```

| State   | Purpose | Allowed Actions |
|---------|---------|-----------------|
| EXPLORE | Gather context. Read code, search, ask questions. | Read-only on project files. Write ONLY to `.plan/` files. |
| PLAN    | Design approach based on what's known. | Write/update plan.md. NO code changes. |
| EXECUTE | Implement the current plan step by step. | Edit files, run commands, write code. |
| REFLECT | Observe results. Did it work? Why not? | Read outputs, run tests. Update decisions.md. |
| RE-PLAN | Revise direction based on what was learned. | Log pivot in decisions.md. Propose new direction. Do NOT write plan.md — that happens in PLAN. |
| CLOSE   | Done. Write summary. Audit decision comments. | Write summary.md. Verify code comments. Clean up. |

### Transition Rules

| From    | To      | Trigger |
|---------|---------|---------|
| EXPLORE | PLAN    | Sufficient context gathered. Findings written. |
| PLAN    | EXECUTE | User explicitly approves. |
| EXECUTE | REFLECT | A step completes, fails, surprises, or autonomy leash is hit. |
| REFLECT | CLOSE   | All success criteria met. |
| REFLECT | RE-PLAN | Something failed or better approach found. |
| REFLECT | EXPLORE | Need more context before re-planning. |
| RE-PLAN | PLAN    | New approach formulated. Decision logged. |

**At CLOSE**, audit decision anchors in code (see `references/decision-anchoring.md`).

Every transition gets logged in `state.md`. Direction changes (RE-PLAN) MUST be
logged in `decisions.md` with: what failed, what was learned, why the new direction.

### Mandatory Re-reads (CRITICAL)

The `.plan/` files are not just for session recovery — they are your active working
memory. **Re-read them during the conversation, not just at the start.**

| When | Read | Why |
|------|------|-----|
| Before starting any EXECUTE step | `state.md`, `plan.md` | Confirm what step you're on, check change manifest and fix attempts |
| Before writing a fix | `decisions.md` | Don't repeat a failed approach. Check if this area hit 3-strike. |
| Before modifying code with `DECISION` comments | The referenced `decisions.md` entry | Understand why the code is this way before changing it |
| Before entering PLAN or RE-PLAN | `decisions.md`, `findings.md`, relevant `findings/*` | Ground the new plan in what's actually known, not stale context |
| Before any REFLECT | `plan.md` (success criteria), `progress.md` | Compare against defined criteria, not vibes |
| Every 10 tool calls | `state.md` | Reorient. Am I still on the right step? Has scope crept? |

**If the conversation is long (>50 messages), re-read `state.md` and `plan.md`
before every response.** Context rot is real. The files are the source of truth,
not your memory of what they say.

## Bootstrapping

On a complex task, run the bootstrap script to initialize `.plan/` in the project root:

```bash
node <skill-path>/scripts/bootstrap.mjs "goal description"
```

This creates the full `.plan/` directory structure. If `.plan/` already exists, it refuses
(resume from existing state instead).

After bootstrap, begin EXPLORE immediately.

If the user provides context upfront (files, errors, constraints), write it into
`findings.md` before starting EXPLORE.

## Filesystem Structure

All files live in `.plan/` at the project root:

```
.plan/
├── state.md           # Current state + transition log
├── plan.md            # Living plan (rewritten each iteration)
├── decisions.md       # Append-only log of decisions and pivots
├── findings.md        # Summary + index of all findings
├── findings/          # Individual finding files (from subagents and manual exploration)
│   ├── auth-system.md
│   └── test-coverage.md
├── progress.md        # What's done vs remaining
├── checkpoints/       # Snapshots before risky changes
│   └── cp-001.md      # Description + rollback instructions
└── summary.md         # Written at CLOSE
```

Read `references/file-formats.md` for detailed templates and examples of each file.

### File Lifecycle Matrix

Quick reference: when each file is read (R) and written (W) in each state.

| File | EXPLORE | PLAN | EXECUTE | REFLECT | RE-PLAN | CLOSE |
|------|---------|------|---------|---------|---------|-------|
| state.md | W (transition) | W (transition, step=N/A) | R+W (step, manifest, fix attempts) | W (transition) | W (transition) | W (transition) |
| plan.md | — | W (rewrite) | R+W (mark steps, update budget) | R (success criteria) | R (review) | R (audit anchors) |
| decisions.md | — | R+W (read rejected approaches, log chosen) | R (before fixes) | R+W (log findings) | R+W (log pivot + complexity) | R (audit anchors) |
| findings.md | W (flush every 2 reads) | R | — | — | R | — |
| findings/* | W (subagents) | R | — | — | R | — |
| progress.md | — | W (populate remaining) | W (update per step) | R+W (update status) | W (mark pivot) | — |
| checkpoints/* | — | — | W (before risky steps) | — | R (revert targets) | — |
| summary.md | — | — | — | — | — | W |

**"—" means the file should not be touched in that state.** If you find yourself
reading or writing a file in a state marked "—", question whether you're in the
right state.

## The Cycle

```
EXPLORE → PLAN → [user approves] → EXECUTE → REFLECT
                                                 │
                                          ┌──────┴──────┐
                                       solved?       not solved?
                                          │              │
                                        CLOSE        RE-PLAN → PLAN → ...
```

### During EXPLORE
- Read code, grep, glob, search. Ask focused questions, one at a time.
- **Write** to `findings.md` and `findings/` after every 2 read operations. Flush discoveries immediately.
- **Write** to `state.md`: update transition log on entry.
- Include **file paths and code path traces** (e.g. "request enters at `app/middleware/auth.rb:authenticate!` → calls `SessionStore#find` → reads from Redis via `redis_store.rb:get`").
- DO NOT skip EXPLORE even if you think you know the answer.
- If available, use **Task subagents** to parallelize codebase research (e.g. one subagent explores the auth system while another maps the test coverage).
- **All subagent findings MUST be written to `.plan/findings/`** as separate files (e.g. `.plan/findings/auth-system.md`, `.plan/findings/test-coverage.md`). Do not rely on subagent results living only in the context window. The main `findings.md` should reference and summarize these files.
- For complex problems, prompt with "think hard" or "ultrathink" to activate extended thinking during analysis.
- **On REFLECT → EXPLORE loops**: append new findings to existing `findings.md` and `findings/` files. Do not overwrite — prior findings are still valid unless explicitly contradicted.

### During PLAN
- **Read** `findings.md` and relevant `findings/` files to ground the plan.
- **Read** `decisions.md` to avoid repeating rejected approaches.
- **Write** `plan.md`: steps, risks, success criteria, complexity budget.
- **Write** `decisions.md`: log the chosen approach and why (e.g. "D-001 | EXPLORE → PLAN | Chose approach A because..."). This is mandatory even on the first plan — the initial decision matters.
- **Write** `state.md`: update transition log, set "Current Plan Step: N/A" (not yet executing).
- **Write** `progress.md`: populate "Remaining" section from plan steps.
- Include a **Complexity Budget** (read `references/complexity-control.md`).
- List **every file that will be modified or created** in the plan. If you can't list them, you haven't explored enough — go back to EXPLORE.
- Include **only the recommended approach**. Alternatives and rejected approaches belong in `decisions.md`, not in the plan.
- Wait for explicit user approval before EXECUTE.

### During EXECUTE
- **Before each step, re-read `state.md` and `plan.md`** to confirm the current step, change manifest, and fix attempt count.
- **Before writing any fix, re-read `decisions.md`** to avoid repeating failed approaches.
- **On first EXECUTE of iteration 1**: create an initial checkpoint in `checkpoints/cp-000.md` recording the clean starting state. This is the nuclear option fallback.
- One plan step at a time. Reflect after each.
- **After each step**:
  - **Write** `plan.md`: mark the completed step `[x]`, advance current step marker.
  - **Write** `progress.md`: move completed item to "Completed", update "In Progress".
  - **Write** `state.md`: update "Current Plan Step" and change manifest.
  - **Write** `plan.md` complexity budget: update file/abstraction/line counts.
- Checkpoint before risky changes (3+ files, shared modules, destructive ops).
- Commit after each successful step: `[iter-N/step-M] description`.
- **Decision Anchoring**: Add `# DECISION D-NNN` comments on code with significant
  decision history. Read `references/decision-anchoring.md` for when and how.
- If something breaks: **STOP. Do not write new code.** Follow the Revert-First Policy
  in `references/complexity-control.md`.
- **Autonomy Leash**: See below.

### During REFLECT
- **Read** `plan.md` (success criteria) and `progress.md` before evaluating.
- **Read** `decisions.md` to check for 3-strike patterns in the area that failed.
- Compare what happened vs what was expected against the **written criteria**, not memory.
- Answer the 5 Simplification Checks (see `references/complexity-control.md`).
- **Write** `decisions.md`: log what happened, what was learned, root cause analysis.
- **Write** `progress.md`: update status of current step (completed/failed/blocked).
- **Write** `state.md`: update transition log.

### During RE-PLAN
- **Read** `decisions.md` and `findings.md` before formulating a new approach.
- **Read** relevant `findings/` files if the failure relates to a specific area.
- Reference the decision log. Explain what failed and why.
- **Write** `decisions.md`: log the pivot with full Complexity Assessment (mandatory).
- **Write** `state.md`: update transition log.
- **Write** `progress.md`: mark failed items, note the pivot.
- Present options to user. Get approval, then transition to PLAN to write the revised plan.

## Complexity Control (CRITICAL)

The #1 failure mode is adding complexity in response to failure. The default
response to failure MUST be to simplify, not to add.

Read `references/complexity-control.md` for the full protocol. Key rules:

**Revert-First Policy** — When something breaks:
1. STOP. Do not write new code.
2. Can I fix by REVERTING? → revert.
3. Can I fix by DELETING? → delete.
4. ONE-LINE fix? → do it.
5. None of the above → STOP. Enter REFLECT.

**10-Line Rule** — If a "fix" needs >10 new lines, it's not a fix. Enter REFLECT.

**3-Strike Rule** — Same area breaks 3 times → approach is wrong.
Do not attempt fix #4. Enter RE-PLAN with fundamentally different approach.

**Complexity Budget** — Tracked in plan.md:
- Files added: 0/3 max
- New abstractions: 0/2 max
- Lines: target net-zero or net-negative

**Forbidden Fix Patterns**: wrapper cascades, config toggles, copy-paste duplication,
exception swallowing, type escape hatches, adapter layers, "temporary" workarounds.

**Nuclear Option** — At iteration 5, if bloat > 2x scope: recommend full revert.
decisions.md preserves all knowledge for the clean restart.

## Autonomy Leash (CRITICAL)

You are NOT allowed to go off on your own when things break. The user steers.

When a plan step **fails** during EXECUTE:

1. You get **2 small autonomous fix attempts** (each must follow the Revert-First Policy
   and the 10-Line Rule — revert, delete, or one-liner only).
2. After those 2 attempts, if the step still fails: **STOP. COMPLETELY.**
   Do NOT try a 3rd fix, silently try a different approach, rewrite surrounding code,
   or skip to the next step.
3. Present the user with: what the step should do, what happened, what the 2 attempts
   were, and your best guess at root cause.
4. **Transition to REFLECT.** Log the leash hit in `state.md`. Wait for user direction.

Track fix attempts in `state.md` (see format in `references/file-formats.md`).
Counter resets when: user gives direction, you move to a new step, or you enter RE-PLAN.

**This rule has no exceptions.** Unguided fix chains are how projects go off the rails.

## Code Hygiene (CRITICAL)

Failed code must not survive into the next iteration. Track every file change in
a **change manifest** in `state.md`. On failed step: revert all uncommitted changes.
On RE-PLAN: decide explicitly what to keep vs revert. Codebase must be known-good
before any new PLAN begins.

Read `references/code-hygiene.md` for manifest format, revert procedures, nuclear
option steps, and forbidden leftovers checklist.

## Decision Anchoring (CRITICAL)

Code that survived failed iterations carries invisible context. Anchor a `# DECISION D-NNN`
comment at the point of impact — stating what NOT to do and why. Audit all anchors at CLOSE.

Read `references/decision-anchoring.md` for format, examples, triggers, and rules.

## Iteration Limits

Every PLAN → EXECUTE → REFLECT cycle increments the iteration counter.
**Increment on the PLAN → EXECUTE transition** (when user approves the plan).
The first real iteration is iteration 1. Iteration 0 is the EXPLORE-only phase
before the first plan exists.

If iteration > 5, STOP and meta-reflect:
- Am I going in circles?
- Is this harder than initially scoped?
- Should this be broken into smaller independent tasks?

## Recovery from Context Loss

If the conversation is compacted or a new session starts:

1. Read `.plan/state.md` — where you are
2. Read `.plan/plan.md` — current plan
3. Read `.plan/decisions.md` — what was tried and why it failed
4. Read `.plan/progress.md` — done vs remaining
5. Read `.plan/findings.md` — index of what's been discovered
6. Read relevant files in `.plan/findings/` — detailed exploration results
7. Resume from current state. Never start over.

## Git Integration

- EXPLORE/PLAN/REFLECT/RE-PLAN: no commits.
- EXECUTE: commit after each successful step with `[iter-N/step-M] description`.
- EXECUTE (failed step): revert all uncommitted changes. Codebase must match last commit.
- RE-PLAN: decide to keep successful commits or revert to checkpoint. No partial state.
- CLOSE: final commit with summary. Tag if appropriate.
- Add `.plan/` to `.gitignore` (unless team wants decision logs for post-mortems).
- Track all file changes in the Change Manifest in `state.md` (see Code Hygiene).

## User Interaction

- EXPLORE: Ask focused questions, one at a time. Present findings for validation.
- PLAN: Present plan. Wait for explicit approval. If user modifies, update and re-present.
- EXECUTE: Report per step. Surface unexpected results. Ask before deviating.
- REFLECT: Show expected vs actual. Propose: continue, re-plan, or close.
- RE-PLAN: Reference decision log. Explain the pivot. Get approval.

## When NOT to Use This

- Simple single-file changes
- Tasks with obvious, well-known solutions
- Quick bug fixes with known root cause
- When the user says "just do it"

## References

Read these as needed — they contain detailed templates, examples, and expanded rules:

- `references/file-formats.md` — Templates for every `.plan/` file with examples
- `references/complexity-control.md` — Full anti-complexity protocol, forbidden patterns, nuclear option
- `references/code-hygiene.md` — Change manifest format, revert procedures, forbidden leftovers
- `references/decision-anchoring.md` — When/how to anchor decisions in code, format, audit rules
