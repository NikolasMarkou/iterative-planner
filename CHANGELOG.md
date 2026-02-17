# Changelog

All notable changes to the Iterative Planner project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.3.1] - 2026-02-17

### Fixed
- **Build scripts now include `src/scripts/` in packages** — both `Makefile` and `build.ps1` were globbing for `*.sh` instead of `*.mjs`, causing `bootstrap.mjs` to be missing from release artifacts
- **Lint/test targets updated** — replaced `bash -n src/scripts/bootstrap.sh` with `node --check src/scripts/bootstrap.mjs` in both build scripts
- **Fixed Makefile target conflict** — removed directory rules that shadowed the phony `build` target, eliminating "overriding recipe" warnings

## [1.3.0] - 2026-02-17

### Changed
- **Restructured project to use `src/` directory** — moved `SKILL.md`, `references/`, and `scripts/` into `src/` to separate skill source files from project-level files (README, build scripts, etc.)
  - Updated all cross-references in `Makefile`, `build.ps1`, `README.md`, `CLAUDE.md`, `CHANGELOG.md`
  - Internal relative paths within `src/` (SKILL.md ↔ references/ ↔ scripts/) unchanged
- **README badge**: "Protocol v1.1" → "Skill v1.3.0"; replaced "protocol" wording with "skill"

## [1.2.3] - 2026-02-17

### Changed
- **Unified language style across all agent-facing files** to match SKILL.md's terse, imperative, operator-manual voice
  - `src/references/complexity-control.md`: conversational phrasing → imperative fragments (5 edits)
  - `src/references/code-hygiene.md`: explanatory sentences → compressed directives (7 edits)
  - `src/references/decision-anchoring.md`: narrative intro → arrow-notation style (2 edits)
  - `src/references/file-formats.md`: redundant prose → compressed phrasing (3 edits)
  - `CLAUDE.md`: verbose prose sections → terse fragments (8 sections rewritten)
  - Net result: −12 lines, zero semantic changes

## [1.2.2] - 2026-02-17

### Added
- **Problem Statement requirement in PLAN**: Before designing steps, plan.md must now define expected behavior, invariants (what must always be true), and edge cases. Can't state the problem clearly → back to EXPLORE.
- **Failure Mode Analysis in PLAN**: For each external dependency or integration point, plan.md now requires a Failure Modes table (Slow / Bad Data / Down / Blast Radius). "None identified" if no dependencies.
- **Trade-off framing in decisions.md**: Every decision entry must now state "X at the cost of Y" — never recommend without stating what it costs.
- **Updated file-formats.md templates**: plan.md template includes Problem Statement and Failure Modes sections; decisions.md template includes Trade-off lines with examples across all three sample entries.

## [1.2.1] - 2026-02-17

### Changed
- **Reference files compressed**: 621 → 480 lines (−23%), 3,520 → 2,482 words (−29%)
  - `src/references/complexity-control.md`: −34% lines / −45% words — removed motivational preambles, tightened rule descriptions
  - `src/references/code-hygiene.md`: −30% lines / −34% words — compressed procedure steps, removed redundant explanations
  - `src/references/decision-anchoring.md`: −29% lines / −30% words — tightened trigger list and rules
  - `src/references/file-formats.md`: −14% lines / −17% words — trimmed prose around templates (code blocks preserved)
  - All rules, thresholds, code templates, procedures, and cross-references preserved

## [1.2.0] - 2026-02-17

### Changed
- **src/SKILL.md compressed**: 386 → 244 lines (−37%), 3,007 → 1,697 words (−44%)
  - ASCII state diagram replaced with mermaid `stateDiagram-v2`
  - Per-state prose sections replaced with terse bullet lists
  - Post-Step Gate compressed to 3-line numbered checklist
  - Bootstrapping prose eliminated (code comments suffice)
  - Complexity Control and Autonomy Leash compressed to bold one-liner rules
  - User Interaction section converted to table
  - File Lifecycle Matrix simplified to R/W/— notation
  - YAML frontmatter description shortened to 3 lines
  - All protocol semantics preserved, zero functional changes

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
- **Core Protocol (src/SKILL.md)**: Complete state-machine driven iterative planning and execution protocol
  - EXPLORE: Context gathering with parallel subagent support
  - PLAN: Structured approach design with complexity budgets
  - EXECUTE: Step-by-step implementation with change manifests
  - REFLECT: Result evaluation against written success criteria
  - RE-PLAN: Evidence-based pivoting with decision logging
  - CLOSE: Summary writing with decision-anchored comment auditing
- **State Machine**: Full transition rules with mandatory re-read protocol
- **Autonomy Leash**: 2-attempt limit per plan step, then STOP and present to user
- **Complexity Control** (`src/references/complexity-control.md`):
  - Revert-First Policy (revert → delete → one-liner → REFLECT)
  - 10-Line Rule (>10 lines = not a fix)
  - 3-Strike Rule (same area breaks 3x = wrong approach)
  - Complexity Budget tracking (files, abstractions, lines)
  - Forbidden Fix Patterns (wrapper cascades, config toggles, exception swallowing, etc.)
  - Nuclear Option (full revert at iteration 5 if bloat > 2x scope)
- **File Formats Reference** (`src/references/file-formats.md`):
  - Templates for state.md, plan.md, decisions.md, findings.md, progress.md
  - Checkpoint and summary file formats
  - Examples for each file type
- **Bootstrap Script** (`src/scripts/bootstrap.mjs`):
  - Initializes `.claude/.plan_YYYY-MM-DD_XXXXXXXX/` directory structure under `.claude/`
  - Creates state.md, plan.md, decisions.md, findings.md, progress.md
  - Writes `.claude/.current_plan` pointer file for plan directory discovery
  - Idempotent-safe (refuses if `.claude/.current_plan` already points to an active plan)
- **Code Hygiene Protocol**:
  - Change manifest tracking in state.md
  - Revert-on-failure with forbidden leftover checks
  - Clean state guarantees between iterations
- **Decision Anchoring**:
  - Code comments referencing decisions.md entries
  - Rules for when to anchor and when not to
  - Format guidelines with decision IDs
- **Git Integration**: Commit conventions (`[iter-N/step-M]`), checkpoint support
- **Recovery Protocol**: Full session recovery from plan directory files
- **Build Scripts**: Makefile (Unix/Linux/macOS) and build.ps1 (Windows)
- **CLAUDE.md**: AI assistant guidance for working with the codebase
- **README.md**: User documentation with install instructions and protocol overview
