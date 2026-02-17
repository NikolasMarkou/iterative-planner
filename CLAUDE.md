# CLAUDE.md

This file provides guidance for Claude (AI) when working with the Iterative Planner codebase.

## Project Purpose

**Iterative Planner v1.1** is a Claude Code skill that implements a state-machine driven iterative planning and execution protocol for complex coding tasks. It replaces linear plan-then-execute with a cycle of Explore, Plan, Execute, Reflect, Re-plan.

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
├── VERSION                           # Single source of truth for version number
├── CHANGELOG.md                      # Version history
├── CLAUDE.md                         # This file
├── Makefile                          # Unix/Linux/macOS build script (reads VERSION)
├── build.ps1                         # Windows PowerShell build script (reads VERSION)
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

Manage plan directories from a project root:

```bash
node <skill-path>/scripts/bootstrap.mjs "goal"              # Create new plan (backward-compatible)
node <skill-path>/scripts/bootstrap.mjs new "goal"           # Create new plan
node <skill-path>/scripts/bootstrap.mjs new --force "goal"   # Close active plan, create new one
node <skill-path>/scripts/bootstrap.mjs resume               # Output current plan state for re-entry
node <skill-path>/scripts/bootstrap.mjs status               # One-line state summary
node <skill-path>/scripts/bootstrap.mjs close                # Close active plan (preserves directory)
```

`new` creates `.claude/.plan_YYYY-MM-DD_XXXXXXXX/` with `state.md`, `plan.md`, `decisions.md`, `findings.md`, `progress.md`, `findings/`, and `checkpoints/`. It also writes `.claude/.current_plan` with the plan directory name for discovery.

The script is idempotent-safe: it refuses to run if `.claude/.current_plan` already points to an active plan.

### Activating the Protocol

Users activate the protocol by giving Claude a complex task, or saying things like:
- "plan this", "figure out", "help me think through"
- "I've been struggling with", "debug this complex issue"

## Protocol Reference

The complete protocol specification lives in **SKILL.md** — the file Claude Code loads as the skill. Key sections:

- **State Machine & Transitions**: SKILL.md "State Machine" and "Transition Rules" sections
- **Mandatory Re-reads**: SKILL.md "Mandatory Re-reads" section
- **Autonomy Leash**: SKILL.md "Autonomy Leash" section
- **Complexity Control**: SKILL.md "Complexity Control" section + `references/complexity-control.md`
- **Code Hygiene**: SKILL.md "Code Hygiene" section + `references/code-hygiene.md`
- **Decision Anchoring**: SKILL.md "Decision Anchoring" section + `references/decision-anchoring.md`
- **Git Integration**: SKILL.md "Git Integration" section

Do not duplicate protocol content here. If you need to understand the protocol, read SKILL.md directly.

## Working with This Codebase

### File Modification Guidelines

- **SKILL.md** is the core protocol. Changes here affect all planning behavior. It is the complete skill specification that Claude Code loads.
- **references/** files provide supplementary knowledge. They are read on-demand by the skill, not loaded upfront. Add new reference files for expanded guidance.
- **scripts/bootstrap.mjs** requires Node.js 18+ (guaranteed by Claude Code). It is idempotent-safe (refuses if `.claude/.current_plan` already points to an active plan).
- **VERSION** is the single source of truth for the version number. Both `Makefile` and `build.ps1` read from it. When bumping the version, edit only `VERSION` (and `CHANGELOG.md`).
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
