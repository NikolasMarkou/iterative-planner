# CLAUDE.md

Guidance for working with the Iterative Planner codebase.

## Project Purpose

Claude Code skill — state-machine driven iterative planning and execution. Cycle: Explore → Plan → Execute → Reflect → Re-plan. Filesystem (`.claude/.plan_YYYY-MM-DD_XXXXXXXX/`) as persistent memory.

Use cases: multi-file tasks, migrations, refactoring, failed tasks, debugging, anything 3+ files or 2+ systems.

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

`new` creates plan directory with all files + writes `.claude/.current_plan` pointer. Idempotent-safe: refuses if active plan exists.

### Activation Triggers

Complex task, or: "plan this", "figure out", "help me think through", "I've been struggling with", "debug this complex issue".

## Protocol Reference

Complete spec in **SKILL.md**. Key sections:

- **State Machine & Transitions**: SKILL.md "State Machine" and "Transition Rules" sections
- **Mandatory Re-reads**: SKILL.md "Mandatory Re-reads" section
- **Autonomy Leash**: SKILL.md "Autonomy Leash" section
- **Complexity Control**: SKILL.md "Complexity Control" section + `references/complexity-control.md`
- **Code Hygiene**: SKILL.md "Code Hygiene" section + `references/code-hygiene.md`
- **Decision Anchoring**: SKILL.md "Decision Anchoring" section + `references/decision-anchoring.md`
- **Git Integration**: SKILL.md "Git Integration" section

Do not duplicate protocol content here. Read SKILL.md directly.

## Working with This Codebase

### File Modification Guidelines

- **SKILL.md** — core protocol. Changes affect all planning behavior.
- **references/** — supplementary knowledge, read on-demand. Add new files for expanded guidance.
- **scripts/bootstrap.mjs** — requires Node.js 18+. Idempotent-safe (refuses if active plan exists).
- **VERSION** — single source of truth. `Makefile` + `build.ps1` read from it. Bump only `VERSION` + `CHANGELOG.md`.
- Keep state machine diagram, transition rules, file lifecycle matrix, and file format references in sync across SKILL.md and references/.

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

### Reference File Pattern

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
