# CLAUDE.md

This file provides guidance for Claude (AI) when working with the Iterative Planner codebase.

## Project Purpose

**Iterative Planner v1.0** is a Claude Code skill that implements a state-machine driven iterative planning and execution protocol for complex coding tasks. It replaces linear plan-then-execute with a cycle of Explore, Plan, Execute, Reflect, Re-plan.

The skill uses the filesystem (`.claude/.plan_YYYY-MM-DD_XXXXXXXX/` directory) as persistent working memory to survive context rot, track decisions, and enable rollback.

Use cases include:
- Complex multi-file coding tasks
- Migration and refactoring projects
- Tasks that have failed before
- Debugging complex issues
- Any task touching 3+ files or spanning 2+ systems

## Repository Structure

```
iterative-planner/
├── SKILL.md                          # Core protocol (state machine, rules) - the main instruction set
├── README.md                         # User documentation
├── LICENSE                           # GNU GPLv3
├── CHANGELOG.md                      # Version history
├── CLAUDE.md                         # This file
├── Makefile                          # Unix/Linux/macOS build script
├── build.ps1                         # Windows PowerShell build script
├── scripts/
│   └── bootstrap.mjs                 # Initializes .claude/.plan_YYYY-MM-DD_XXXXXXXX/ directory (Node.js 18+)
└── references/                       # Knowledge base documents
    ├── complexity-control.md         # Anti-complexity protocol (revert-first, 3-strike, nuclear option)
    ├── code-hygiene.md               # Change manifest format, revert procedures, forbidden leftovers
    ├── decision-anchoring.md         # When/how to anchor decisions in code, format, audit rules
    └── file-formats.md               # Templates and examples for all plan directory files
```

## Key Commands

### Bootstrap

Initialize the plan directory in a project root:

```bash
node <skill-path>/scripts/bootstrap.mjs "goal description"
```

This creates `.claude/.plan_YYYY-MM-DD_XXXXXXXX/` with `state.md`, `plan.md`, `decisions.md`, `findings.md`, `progress.md`, `findings/`, and `checkpoints/`. It also writes `.claude/.current_plan` with the plan directory name for discovery.

The script is idempotent-safe: it refuses to run if `.claude/.current_plan` already points to an active plan.

### Activating the Protocol

Users activate the protocol by giving Claude a complex task, or saying things like:
- "plan this", "figure out", "help me think through"
- "I've been struggling with", "debug this complex issue"

## The State Machine

| State | Purpose | Allowed Actions |
|-------|---------|-----------------|
| EXPLORE | Gather context. Read code, search, ask questions. | Read-only on project files. Write ONLY to plan directory files. |
| PLAN | Design approach based on what's known. | Write/update plan.md. NO code changes. |
| EXECUTE | Implement the current plan step by step. | Edit files, run commands, write code. |
| REFLECT | Observe results. Did it work? Why not? | Read outputs, run tests. Update decisions.md. |
| RE-PLAN | Revise direction based on what was learned. | Log pivot in decisions.md. Propose new direction. Do NOT write plan.md — that happens in PLAN. |
| CLOSE | Done. Write summary. Audit decision comments. | Write summary.md. Verify code comments. Clean up. |

### Transition Rules

| From | To | Trigger |
|------|----|---------|
| EXPLORE | PLAN | Sufficient context gathered. Findings written. |
| PLAN | EXECUTE | User explicitly approves. |
| EXECUTE | REFLECT | A step completes, fails, surprises, or autonomy leash is hit. |
| REFLECT | CLOSE | All success criteria met. |
| REFLECT | RE-PLAN | Something failed or better approach found. |
| REFLECT | EXPLORE | Need more context before re-planning. |
| RE-PLAN | PLAN | New approach formulated. Decision logged. |

## Important Patterns

### Autonomy Leash

- 2 small autonomous fix attempts per plan step (revert, delete, or one-liner only)
- After 2 failed attempts: STOP completely. Present situation to user.
- Do NOT try a 3rd fix. Do NOT silently change approach.
- Track fix attempts in `state.md`

### Complexity Control

- **Revert-First Policy**: STOP → Revert? → Delete? → One-liner? → REFLECT
- **10-Line Rule**: If a fix needs >10 new lines, it's not a fix. Enter REFLECT.
- **3-Strike Rule**: Same area breaks 3 times = wrong approach. Enter RE-PLAN.
- **Complexity Budget**: Files added (0/3 max), new abstractions (0/2 max), lines (net-zero target)
- **Nuclear Option**: At iteration 5 + bloat > 2x scope = recommend full revert

See `references/complexity-control.md` for the full protocol.

### Mandatory Re-reads

| When | Read | Why |
|------|------|-----|
| Before starting any EXECUTE step | `state.md`, `plan.md` | Confirm current step, check change manifest |
| Before writing a fix | `decisions.md` | Don't repeat a failed approach |
| Before entering PLAN or RE-PLAN | `decisions.md`, `findings.md`, relevant `findings/*` | Ground plan in what's known |
| Before any REFLECT | `plan.md`, `progress.md` | Compare against defined criteria |
| Every 10 tool calls | `state.md` | Reorient against scope creep |

### Decision Anchoring

When code implements a choice that survived failed alternatives:
- Add a `# DECISION D-NNN` comment at the point of impact
- Reference the decision ID from `decisions.md`
- State what NOT to do and why
- Only anchor where the decision history is load-bearing

See `references/decision-anchoring.md` for format, examples, and audit rules.

### Git Integration

- EXPLORE/PLAN/REFLECT/RE-PLAN: no commits
- EXECUTE: commit after each successful step with `[iter-N/step-M] description`
- Failed step: revert all uncommitted changes
- Change manifest tracked in `state.md`

### Code Hygiene

- Track every change in the Change Manifest in `state.md`
- On failed step: revert all uncommitted changes immediately
- On RE-PLAN: decide explicitly to keep or revert committed work
- Forbidden leftovers: TODOs, debug statements, commented-out code, dead imports

See `references/code-hygiene.md` for manifest format, revert procedures, and forbidden leftovers checklist.

## Working with This Codebase

### File Modification Guidelines

- **SKILL.md** is the core protocol. Changes here affect all planning behavior. It is the complete skill specification that Claude Code loads.
- **references/** files provide supplementary knowledge. They are read on-demand by the skill, not loaded upfront. Add new reference files for expanded guidance.
- **scripts/bootstrap.mjs** requires Node.js 18+ (guaranteed by Claude Code). It is idempotent-safe (refuses if `.claude/.current_plan` already points to an active plan).
- When editing the protocol, keep the state machine diagram, transition rules table, file lifecycle matrix, and file format references in sync across SKILL.md and references/.

### Tech Stack

- Node.js/ESM (for bootstrap script)
- Markdown documentation
- PowerShell/Make for build scripts

### Build Commands

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

### Adding New Reference Material

Reference files should follow this pattern:
1. Clear section headers
2. Tables for quick reference
3. Code snippets where applicable
4. Cross-references to other reference files

### Validation Checklist

- [ ] `.\build.ps1 validate` passes (or `make validate`)
- [ ] SKILL.md has `name:` and `description:` in YAML frontmatter
- [ ] All cross-references in SKILL.md point to existing files in `references/`
- [ ] State machine diagram matches transition rules table
- [ ] File Lifecycle Matrix matches state machine states and plan directory file list
- [ ] `scripts/bootstrap.mjs` creates all files referenced in `references/file-formats.md`
- [ ] Plan directory structure in SKILL.md matches bootstrap.mjs output
