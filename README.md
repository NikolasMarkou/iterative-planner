# Iterative Planner

[![License](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Protocol](https://img.shields.io/badge/Protocol-v1.0-green.svg)](CHANGELOG.md)

**State-machine driven iterative planning and execution protocol for complex coding tasks.**

Replaces linear plan-then-execute with a cycle of Explore, Plan, Execute, Reflect, Re-plan. Uses the filesystem as persistent working memory to survive context rot, track decisions, and enable rollback.

---

## Install

**Option 1:** Download `iterative-planner-combined.md` from [Releases](https://github.com/NikolasMarkou/iterative-planner/releases) and paste into Claude's Custom Instructions

**Option 2:** Download zip and upload `SKILL.md` + `references/` folder to a Claude Project

Then give Claude a complex task, or say: **"plan this"**

---

## The Protocol

Context Window = RAM. Filesystem = Disk. Anything important gets written to disk immediately.

All state lives in a dynamic plan directory under `.claude/` in the project root (`.claude/.plan_YYYY-MM-DD_XXXXXXXX/`), discovered via the `.claude/.current_plan` pointer file.

### State Machine

```
              ┌──────────┐
              │  EXPLORE │──── enough context ────► ┌────────────┐
              └──────────┘                          │    PLAN    │
                    ▲                               └─────┬──────┘
                    │                                     │
                 need more                             approved
                  context                                 │
                    │                                     ▼
              ┌─────┴──────┐                        ┌──────────┐
              │  REFLECT   │◄──── observe result ───│  EXECUTE │
              └─────┬──────┘                        └──────────┘
                    │
              ┌─────┴──────────────────┐
              │                        │
           solved                  not solved
              │                        │
              ▼                        ▼
        ┌──────────┐            ┌──────────┐
        │  CLOSE   │            │ RE-PLAN  │───► back to PLAN
        └──────────┘            └──────────┘
```

### Phase Overview

| State | Purpose | Allowed Actions |
|-------|---------|-----------------|
| **EXPLORE** | Gather context. Read code, search, ask questions. | Read-only on project files. Write ONLY to plan directory files. |
| **PLAN** | Design approach based on what's known. | Write/update plan.md. NO code changes. |
| **EXECUTE** | Implement the current plan step by step. | Edit files, run commands, write code. |
| **REFLECT** | Observe results. Did it work? Why not? | Read outputs, run tests. Update decisions.md. |
| **RE-PLAN** | Revise direction based on what was learned. | Log pivot in decisions.md. Propose new direction. Do NOT write plan.md — that happens in PLAN. |
| **CLOSE** | Done. Write summary. Audit decision comments. | Write summary.md. Verify code comments. Clean up. |

---

## When to Use This

Use this skill whenever a task is:
- Complex or multi-file
- Involves migration or refactoring
- Has failed before
- Touches 3+ files or spans 2+ systems
- Has no obvious single solution

Or when the user says things like "plan", "figure out", "help me think through", "I've been struggling with", or "debug this complex issue".

---

## Core Principles

**Context Window = RAM. Filesystem = Disk.** Write discoveries to the plan directory immediately. The context window will rot. The files won't.

**Autonomy Leash.** After 2 failed fix attempts on a plan step, STOP completely. Present the situation to the user. Do not try a 3rd fix. Do not silently change approach.

**Revert-First.** When something breaks: Can I fix by reverting? By deleting? With a one-liner? If none apply, enter REFLECT.

**Simplify, Don't Add.** The default response to failure is to simplify. Never add complexity to fix complexity.

**Decision Anchoring.** When code implements a choice that survived failed alternatives, anchor a `# DECISION D-NNN` comment at the point of impact — stating what NOT to do and why. The code outlives the plan directory.

---

## Complexity Control

The #1 failure mode is adding complexity in response to failure.

**10-Line Rule** — If a "fix" needs >10 new lines, it's not a fix. Enter REFLECT.

**3-Strike Rule** — Same area breaks 3 times? The approach is wrong. Enter RE-PLAN with a fundamentally different approach.

**Complexity Budget** — Tracked in plan.md:
- Files added: 0/3 max
- New abstractions: 0/2 max
- Lines: target net-zero or net-negative

**Nuclear Option** — At iteration 5, if bloat > 2x scope: recommend full revert. `decisions.md` preserves all knowledge for the clean restart.

See `references/complexity-control.md` for the full anti-complexity protocol. See also `references/code-hygiene.md` and `references/decision-anchoring.md`.

---

## Bootstrapping

Initialize the plan directory in a project root:

```bash
node <skill-path>/scripts/bootstrap.mjs "goal description"
```

This creates `.claude/.plan_YYYY-MM-DD_XXXXXXXX/` (date + 8-char hex seed) with all plan files, and writes `.claude/.current_plan` pointing to it:

```
.claude/
├── .current_plan              # Points to the active plan directory name
└── .plan_2026-02-14_a3f1b2c9/ # Dynamic plan directory
    ├── state.md               # Current state + transition log
    ├── plan.md                # Living plan (rewritten each iteration)
    ├── decisions.md           # Append-only log of decisions and pivots
    ├── findings.md            # Summary + index of all findings
    ├── findings/              # Individual finding files
    ├── progress.md            # What's done vs remaining
    ├── checkpoints/           # Snapshots before risky changes
    └── summary.md             # Written at CLOSE
```

See `references/file-formats.md` for detailed templates and examples.

---

## Git Integration

- **EXPLORE/PLAN/REFLECT/RE-PLAN**: No commits.
- **EXECUTE**: Commit after each successful step with `[iter-N/step-M] description`.
- **EXECUTE (failed step)**: Revert all uncommitted changes. Codebase must match last commit.
- **RE-PLAN**: Decide to keep successful commits or revert to checkpoint.
- **CLOSE**: Final commit with summary.

---

## Build & Package

```bash
# Windows (PowerShell)
.\build.ps1 package          # Create zip package
.\build.ps1 package-combined # Create single-file skill
.\build.ps1 validate         # Validate structure
.\build.ps1 clean            # Clean artifacts

# Unix/Linux/macOS
make package                 # Create zip package
make package-combined        # Create single-file skill
make validate                # Validate structure
make clean                   # Clean artifacts
```

---

## When NOT to Use This

- Simple single-file changes
- Tasks with obvious, well-known solutions
- Quick bug fixes with known root cause
- When the user says "just do it"

---

## License

[GNU General Public License v3.0](LICENSE)
