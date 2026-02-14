# Changelog

All notable changes to the Iterative Planner project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.1.0] - 2026-02-14

### Changed
- Plan directory moved from `.plan/` in project root to `.claude/.plan_YYYY-MM-DD_XXXXXXXX/`
  - Dynamic naming with date + 8-char hex seed (e.g. `.plan_2026-02-14_a3f1b2c9`)
  - Only one plan directory allowed at a time
  - Discovery via `.claude/.current_plan` pointer file (contains the plan directory name)
  - Bootstrap writes pointer; protocol reads it to find the active plan
  - `.gitignore` patterns: `.claude/.plan_*` and `.claude/.current_plan`

## [1.0.0] - 2026-02-14

### Added
- **Core Protocol (SKILL.md)**: Complete state-machine driven iterative planning and execution protocol
  - EXPLORE: Context gathering with parallel subagent support
  - PLAN: Structured approach design with complexity budgets
  - EXECUTE: Step-by-step implementation with change manifests
  - REFLECT: Result evaluation against written success criteria
  - RE-PLAN: Evidence-based pivoting with decision logging
  - CLOSE: Summary writing with decision-anchored comment auditing
- **State Machine**: Full transition rules with mandatory re-read protocol
- **Autonomy Leash**: 2-attempt limit per plan step, then STOP and present to user
- **Complexity Control** (`references/complexity-control.md`):
  - Revert-First Policy (revert → delete → one-liner → REFLECT)
  - 10-Line Rule (>10 lines = not a fix)
  - 3-Strike Rule (same area breaks 3x = wrong approach)
  - Complexity Budget tracking (files, abstractions, lines)
  - Forbidden Fix Patterns (wrapper cascades, config toggles, exception swallowing, etc.)
  - Nuclear Option (full revert at iteration 5 if bloat > 2x scope)
- **File Formats Reference** (`references/file-formats.md`):
  - Templates for state.md, plan.md, decisions.md, findings.md, progress.md
  - Checkpoint and summary file formats
  - Examples for each file type
- **Bootstrap Script** (`scripts/bootstrap.sh`):
  - Initializes `.plan/` directory structure in project root
  - Creates state.md, plan.md, decisions.md, findings.md, progress.md
  - Idempotent-safe (refuses if `.plan/` exists)
- **Code Hygiene Protocol**:
  - Change manifest tracking in state.md
  - Revert-on-failure with forbidden leftover checks
  - Clean state guarantees between iterations
- **Decision Anchoring**:
  - Code comments referencing decisions.md entries
  - Rules for when to anchor and when not to
  - Format guidelines with decision IDs
- **Git Integration**: Commit conventions (`[iter-N/step-M]`), checkpoint support
- **Recovery Protocol**: Full session recovery from `.plan/` files
- **Build Scripts**: Makefile (Unix/Linux/macOS) and build.ps1 (Windows)
- **CLAUDE.md**: AI assistant guidance for working with the codebase
- **README.md**: User documentation with install instructions and protocol overview
