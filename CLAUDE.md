# CLAUDE.md

Guidance for working with the Iterative Planner codebase.

## Project Purpose

Claude Code skill — state-machine driven iterative planning and execution. Cycle: Explore → Plan → Execute → Reflect → Re-plan. Filesystem (`.claude/.plan_YYYY-MM-DD_XXXXXXXX/`) as persistent memory.

Use cases: multi-file tasks, migrations, refactoring, failed tasks, debugging, anything 3+ files or 2+ systems.

## Repository Structure

```
iterative-planner/
├── README.md                         # User documentation
├── LICENSE                           # GNU GPLv3
├── VERSION                           # Single source of truth for version number
├── CHANGELOG.md                      # Version history
├── CLAUDE.md                         # This file
├── Makefile                          # Unix/Linux/macOS build script (reads VERSION)
├── build.ps1                         # Windows PowerShell build script (reads VERSION)
└── src/
    ├── SKILL.md                      # Core protocol (state machine, rules) - the main instruction set
    ├── scripts/
    │   └── bootstrap.mjs             # Initializes .claude/.plan_YYYY-MM-DD_XXXXXXXX/ directory (Node.js 18+)
    └── references/                   # Knowledge base documents
        ├── complexity-control.md     # Anti-complexity protocol (revert-first, 3-strike, nuclear option)
        ├── code-hygiene.md           # Change manifest format, revert procedures, forbidden leftovers
        ├── decision-anchoring.md     # When/how to anchor decisions in code, format, audit rules
        └── file-formats.md           # Templates and examples for all plan directory files
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
node <skill-path>/scripts/bootstrap.mjs list                 # Show all plan directories
```

`new` creates plan directory with all files + writes `.claude/.current_plan` pointer. Idempotent-safe: refuses if active plan exists.

### Activation Triggers

Complex task, or: "plan this", "figure out", "help me think through", "I've been struggling with", "debug this complex issue".

## Protocol Reference

Complete spec in **src/SKILL.md**. Key sections:

- **State Machine & Transitions**: src/SKILL.md "State Machine" and "Transition Rules" sections
- **Mandatory Re-reads**: src/SKILL.md "Mandatory Re-reads" section
- **Autonomy Leash**: src/SKILL.md "Autonomy Leash" section
- **Complexity Control**: src/SKILL.md "Complexity Control" section + `src/references/complexity-control.md`
- **Code Hygiene**: src/SKILL.md "Code Hygiene" section + `src/references/code-hygiene.md`
- **Decision Anchoring**: src/SKILL.md "Decision Anchoring" section + `src/references/decision-anchoring.md`
- **Git Integration**: src/SKILL.md "Git Integration" section

Do not duplicate protocol content here. Read src/SKILL.md directly.

## Working with This Codebase

### File Modification Guidelines

- **src/SKILL.md** — core protocol. Changes affect all planning behavior.
- **src/references/** — supplementary knowledge, read on-demand. Add new files for expanded guidance.
- **src/scripts/bootstrap.mjs** — requires Node.js 18+. Idempotent-safe (refuses if active plan exists).
- **VERSION** — single source of truth. `Makefile` + `build.ps1` read from it. Bump only `VERSION` + `CHANGELOG.md`.
- Keep state machine diagram, transition rules, file lifecycle matrix, and file format references in sync across src/SKILL.md and src/references/.

### Tech Stack

- Node.js/ESM (for bootstrap script)
- Markdown documentation
- PowerShell/Make for build scripts

### Build Commands

```bash
# Windows (PowerShell)
.\build.ps1 build            # Build skill package structure
.\build.ps1 build-combined   # Build single-file skill with inlined references
.\build.ps1 package          # Create zip package
.\build.ps1 package-combined # Create single-file skill in dist/
.\build.ps1 package-tar      # Create tarball package
.\build.ps1 validate         # Validate skill structure
.\build.ps1 lint             # Check script syntax
.\build.ps1 test             # Run tests (lint + round-trip)
.\build.ps1 clean            # Remove build artifacts
.\build.ps1 list             # Show package contents
.\build.ps1 help             # Show available commands

# Unix/Linux/macOS
make build                   # Build skill package structure
make build-combined          # Build single-file skill with inlined references
make package                 # Create zip package (default)
make package-combined        # Create single-file skill package
make package-tar             # Create tarball package
make validate                # Validate skill structure
make lint                    # Check script syntax
make test                    # Run tests (lint + round-trip)
make clean                   # Remove build artifacts
make list                    # Show package contents
make help                    # Show available targets
```

### Reference File Pattern

1. Clear section headers
2. Tables for quick reference
3. Code snippets where applicable
4. Cross-references to other reference files

### Validation Checklist

- [ ] `.\build.ps1 validate` passes (or `make validate`)
- [ ] src/SKILL.md has `name:` and `description:` in YAML frontmatter
- [ ] All cross-references in src/SKILL.md point to existing files in `src/references/`
- [ ] State machine diagram matches transition rules table
- [ ] File Lifecycle Matrix matches state machine states and plan directory file list
- [ ] `src/scripts/bootstrap.mjs` creates all files referenced in `src/references/file-formats.md`
- [ ] Plan directory structure in src/SKILL.md matches bootstrap.mjs output
