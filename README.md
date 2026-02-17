# Iterative Planner

[![License](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Skill](https://img.shields.io/badge/Skill-v1.3.0-green.svg)](CHANGELOG.md)
[![Sponsored by Electi](https://img.shields.io/badge/Sponsored%20by-Electi-red.svg)](https://www.electiconsulting.com)

**Stop watching Claude go off the rails on complex tasks.**

AI coding agents fail in predictable ways. They plan once, execute linearly, and when something breaks, they pile on fixes until the codebase is buried under wrappers, adapters, and "temporary" workarounds. By the time context rot kicks in, they've forgotten what they were even trying to do.

Iterative Planner is a Claude Code skill that replaces this pattern with a disciplined cycle: **Explore, Plan, Execute, Reflect, Re-plan.** It uses the filesystem as persistent working memory -- so when the context window inevitably fills up, nothing is lost. Every decision, every failed approach, every discovery is written to disk and available for recovery.

The result: Claude handles multi-file refactors, complex migrations, and gnarly debugging sessions the way a senior engineer would -- methodically, with full awareness of what has already been tried and why it failed.

---

## Quick Start

**Option 1 -- Single file (fastest)**
Download `iterative-planner-combined.md` from [Releases](https://github.com/NikolasMarkou/iterative-planner/releases) and paste it into Claude's Custom Instructions.

**Option 2 -- Full package**
Download the zip from Releases. Upload `src/SKILL.md` and the `src/references/` folder to a Claude Project.

Then give Claude a complex task, or just say: **"plan this"**

---

## The Problem This Solves

Without structure, AI agents working on non-trivial tasks tend to:

- **Lose context** mid-task and repeat work or contradict earlier decisions
- **Compound failures** by adding complexity on top of broken code instead of reverting
- **Go rogue** after a failure, silently switching approaches without telling you
- **Leave debris** -- dead code, orphaned imports, debug statements -- from failed attempts scattered across the codebase
- **Forget what was tried** and cycle through the same failed approaches

Iterative Planner prevents all of this through a formal state machine, mandatory filesystem checkpoints, and strict rules about what the agent can and cannot do when things go wrong.

---

## How It Works

The skill is a six-state machine. Every transition is logged. Every decision is recorded. The filesystem is the source of truth -- not the context window.

```
              +----------+
              |  EXPLORE  |---- enough context ---->+-----------+
              +----------+                          |   PLAN    |
                    ^                               +-----+-----+
                    |                                     |
                 need more                             approved
                  context                                 |
                    |                                     v
              +-----+------+                        +----------+
              |  REFLECT   |<---- observe result ---|  EXECUTE  |
              +-----+------+                        +----------+
                    |
              +-----+-----------------+
              |                       |
           solved                 not solved
              |                       |
              v                       v
        +----------+           +----------+
        |  CLOSE   |           | RE-PLAN  |----> back to PLAN
        +----------+           +----------+
```

| State | What happens | Boundaries |
|-------|-------------|------------|
| **EXPLORE** | Read code, search, ask questions, map the problem. | Read-only on project files. All notes go to the plan directory. |
| **PLAN** | Design the approach. List every file to touch. Set success criteria. | No code changes. User must approve before execution begins. |
| **EXECUTE** | Implement one step at a time. Commit after each success. | 2 fix attempts max per step. Revert-first on any failure. |
| **REFLECT** | Compare results against written success criteria. | Evidence-based. No "it seems fine" -- check the criteria. |
| **RE-PLAN** | Pivot based on what was learned. Log the decision. | Must explain what failed and why. User approves new direction. |
| **CLOSE** | Write summary. Audit decision anchors in code. Clean up. | Verify no leftover debug code or orphaned imports. |

---

## What Makes This Different

### Persistent Memory That Survives Context Rot

Everything important is written to a plan directory on disk (`.claude/.plan_YYYY-MM-DD_XXXXXXXX/`). When the context window fills up and earlier messages are compressed or lost, the agent re-reads its own notes. State, decisions, findings, progress -- all on disk, all recoverable, even across sessions.

```
.claude/
+-- .current_plan
+-- .plan_2026-02-14_a3f1b2c9/
    +-- state.md          # Where am I? What step? What iteration?
    +-- plan.md           # The living plan (rewritten each iteration)
    +-- decisions.md      # Append-only log of every decision and pivot
    +-- findings.md       # Index of all discoveries
    +-- findings/         # Detailed research files
    +-- progress.md       # Done vs remaining
    +-- checkpoints/      # Snapshots before risky changes
    +-- summary.md        # Written at close
```

### The Autonomy Leash

When a plan step fails, the agent gets exactly **2 small fix attempts** -- each constrained to reverting, deleting, or a one-line change. If neither works, it **stops completely** and presents the situation to you. No silent rewrites. No runaway fix chains. You stay in control of every pivot.

### Revert-First Complexity Control

The default response to failure is to simplify, never to add. When something breaks:

1. Can I fix by **reverting**? Do that.
2. Can I fix by **deleting**? Do that.
3. **One-line** fix? Do that.
4. None of the above? **Stop.** Enter REFLECT.

Additional guardrails:
- **10-Line Rule** -- if a "fix" needs more than 10 new lines, it is not a fix. It needs to go through PLAN.
- **3-Strike Rule** -- same area breaks 3 times? The approach is wrong. Mandatory RE-PLAN with a fundamentally different strategy.
- **Complexity Budget** -- every plan tracks files added (max 3), new abstractions (max 2), and net line count (target: net-zero or negative).
- **Nuclear Option** -- at iteration 5, if scope has doubled, recommend full revert. The decision log preserves everything learned for a clean restart.

### Decision Anchoring

When code survives failed alternatives, the agent leaves a `# DECISION D-NNN` comment at the point of impact -- documenting what *not* to do and why. This prevents the next session (or the next developer) from blindly "fixing" a deliberate choice back into a known-broken state.

```python
# DECISION D-003: Using stateless tokens instead of dual-write.
# Dual-write doubled Redis memory due to 30-day TTLs (see decisions.md D-002, D-003).
# Do NOT switch back to session-store-based approach without addressing memory growth.
def create_token(user):
    ...
```

### Clean Code Hygiene

Every file change is tracked in a change manifest. Failed steps are reverted immediately -- no half-applied changes, no commented-out experiments, no orphaned imports. The codebase is always in a known-good state before any new plan begins.

---

## When to Use This

- Multi-file changes (3+ files)
- Migrations and refactors
- Tasks that have already failed once
- Cross-system work (2+ systems)
- Problems with no obvious single solution
- Debugging sessions where the root cause is unclear

Trigger phrases: *"plan this"*, *"figure out"*, *"help me think through"*, *"I've been struggling with"*, *"debug this complex issue"*

## When NOT to Use This

- Single-file, obvious fixes
- Tasks with a well-known, straightforward solution
- Quick bug fixes where you already know the root cause
- When you just want to say "do it"

---

## Bootstrapping

Manage plan directories from your project root:

```bash
node <skill-path>/scripts/bootstrap.mjs "goal"              # Create new plan (backward-compatible)
node <skill-path>/scripts/bootstrap.mjs new "goal"           # Create new plan
node <skill-path>/scripts/bootstrap.mjs new --force "goal"   # Close active plan, create new one
node <skill-path>/scripts/bootstrap.mjs resume               # Output current plan state for re-entry
node <skill-path>/scripts/bootstrap.mjs status               # One-line state summary
node <skill-path>/scripts/bootstrap.mjs close                # Close active plan (preserves directory)
```

`new` creates the plan directory under `.claude/`, writes the pointer file (`.claude/.current_plan`), and drops the agent into the EXPLORE state. If an active plan already exists, it refuses -- use `resume` to continue, `close` to end it, or `new --force` to close and start fresh.

`resume` outputs the current plan state (state, iteration, step, goal, progress) for quick re-entry into the protocol. `status` prints a single-line summary. `close` removes the pointer file but preserves the plan directory for reference.

### Git Integration

The skill integrates cleanly with git:

| Phase | Git behavior |
|-------|-------------|
| EXPLORE, PLAN, REFLECT, RE-PLAN | No commits. |
| EXECUTE (success) | Commit after each step: `[iter-N/step-M] description` |
| EXECUTE (failure) | Revert all uncommitted changes to last clean commit. |
| RE-PLAN | Decide: keep successful commits or revert to checkpoint. |
| CLOSE | Final commit with summary. |

Add `.claude/.plan_*` and `.claude/.current_plan` to `.gitignore` -- unless your team wants decision logs for post-mortems.

---

## Build and Package

```bash
# Windows (PowerShell)
.\build.ps1 package          # Create zip package
.\build.ps1 package-combined # Create single-file skill
.\build.ps1 validate         # Validate structure
.\build.ps1 clean            # Clean build artifacts

# Unix / Linux / macOS
make package                 # Create zip package
make package-combined        # Create single-file skill
make validate                # Validate structure
make clean                   # Clean build artifacts
```

---

## Project Structure

```
iterative-planner/
+-- README.md              # This file
+-- CLAUDE.md              # AI assistant guidance for contributing
+-- CHANGELOG.md           # Version history
+-- LICENSE                # GNU GPLv3
+-- VERSION                # Single source of truth for version number
+-- Makefile               # Unix/Linux/macOS build
+-- build.ps1              # Windows PowerShell build
+-- src/
    +-- SKILL.md              # Core protocol -- the complete skill specification
    +-- scripts/
    |   +-- bootstrap.mjs      # Plan directory initializer (Node.js 18+)
    +-- references/
        +-- complexity-control.md   # Anti-complexity protocol and forbidden patterns
        +-- code-hygiene.md         # Change manifests, revert procedures, cleanup rules
        +-- decision-anchoring.md   # When and how to anchor decisions in code
        +-- file-formats.md         # Templates for every plan directory file
```

---

## License

[GNU General Public License v3.0](LICENSE)
