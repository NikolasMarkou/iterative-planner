# Changelog

All notable changes to the Iterative Planner project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.1.0] - 2026-02-19

### Added
- **Verification feedback loop** — new `verification.md` per-plan artifact for recording objective verification results during REFLECT. Ensures REFLECT and CLOSE transitions are grounded in evidence (test results, lint output, behavioral diffs, smoke tests) rather than subjective assessment.
- **Verification Strategy in PLAN** — mandatory section in `plan.md` mapping each success criterion to a test/check method and expected result. Plans with no testable criteria must write "N/A — manual review only" (proves you checked). Documented in SKILL.md PLAN rules and file-formats.md template.
- **REFLECT verification gate** — REFLECT rules now require running each check from the Verification Strategy and recording results in `verification.md` (criterion, method, command, result PASS/FAIL, evidence). REFLECT → CLOSE transition strengthened from "All success criteria met" to "All criteria verified PASS in `verification.md`".
- **File Lifecycle Matrix expanded** — added `verification.md` row: W in PLAN (initial template), W in EXECUTE (per-step results), W in REFLECT (full verification pass), R in RE-PLAN and CLOSE.
- **Structured Simplification Checks** — `complexity-control.md` Simplification Checks now have a recording template with blocker flag. If any check reveals a blocker, it must be addressed before CLOSE.
- **Bootstrap creates verification.md** — `bootstrap.mjs` `new` command creates `verification.md` with initial template (criteria table, additional checks, verdict sections).
- **Build validation expanded** — Makefile and build.ps1 now validate that `bootstrap.mjs` creates `verification.md`.

## [2.0.0] - 2026-02-19

### Changed (BREAKING)
- **Plan storage moved from `.claude/` to `plans/`** — plan directories are now visible (not hidden) and decoupled from Claude Code's own `.claude/` config directory. Directory prefix changed from `.plan_` to `plan_` (no leading dot). Pointer file moved from `.claude/.current_plan` to `plans/.current_plan`. Gitignore pattern simplified from `.claude/.plan_*` + `.claude/.current_plan` to `plans/`.

### Added
- **Consolidated cross-plan files** — `plans/FINDINGS.md` and `plans/DECISIONS.md` persist across plans. Created on first `new`, updated on each `close`. Enables cross-plan knowledge transfer: findings and decisions from previous plans are available to subsequent plans.
- **Merge-on-close** — when `close` is run, per-plan `findings.md` and `decisions.md` are merged into consolidated files. Content is prepended (newest first) so the most recent context is immediately accessible. Headings are demoted (## → ###) and nested under a `## plan_YYYY-MM-DD_XXXXXXXX` section. Relative `findings/` links are rewritten to include the plan directory name.
- **Cross-plan context seeding** — when consolidated files exist, new per-plan `findings.md` and `decisions.md` include a cross-plan context reference note.
- **Consolidated files in resume output** — `resume` command now shows `plans/FINDINGS.md` and `plans/DECISIONS.md` paths.
- **EXPLORE reads consolidated files** — EXPLORE rules now include reading consolidated files at start for cross-plan context.
- **PLAN gate check expanded** — PLAN gate check now includes `plans/FINDINGS.md` and `plans/DECISIONS.md`.
- **File Lifecycle Matrix expanded** — added `plans/FINDINGS.md` and `plans/DECISIONS.md` rows: R in EXPLORE/PLAN/RE-PLAN, W(merge) in CLOSE.
- **Recovery protocol expanded** — added step 8 for consolidated cross-plan context files.
- **Consolidated file templates** — `file-formats.md` now documents `plans/FINDINGS.md` and `plans/DECISIONS.md` formats.
- **Build script validation** — Makefile and build.ps1 validate that bootstrap.mjs references `FINDINGS.md` and `DECISIONS.md`.
- **Build script tests** — round-trip test verifies consolidated files exist after `close`.

## [1.9.0] - 2026-02-18

### Fixed
- **Goal regex first-line capture** — removed `m` flag from goal extraction regex in bootstrap.mjs; `^` could match mid-content. Changed to `\n` anchor. `resume` and `status` now truncate goal to first line (matching `list` behavior).
- **EXECUTE → REFLECT trigger clarification** — Mermaid diagram and transition table wording updated from "step done" to "phase ends" to reflect that REFLECT triggers when all steps complete, not after each individual step.
- **File Lifecycle Matrix legend incomplete** — expanded R/W/— legend to define R+W (distinct read and write operations), removing ambiguity.
- **Makefile test cleanup on failure** — wrapped round-trip test in `bash -c` with `trap` for guaranteed temp directory cleanup even on test failure.
- **CLI `close` vs protocol CLOSE confusion** — added note to `cmdClose` output and SKILL.md bootstrapping section clarifying that `close` is administrative (pointer removal only) and protocol CLOSE (summary.md, decision audit) should happen first.
- **Recovery protocol missing pointer fallback** — added step 0 to Recovery from Context Loss: if `.current_plan` is missing, use `bootstrap.mjs list` to find plan directories and recreate the pointer.
- **Silent error swallowing in cmdNew cleanup** — added `WARNING:` messages to the three catch blocks in cmdNew's error path. Added explanatory comments to two other intentional empty catches (checkpoints dir, TOCTOU-safe unlink).
- **CLAUDE.md missing build commands** — replaced incomplete 4-command list with all 11 commands for both PowerShell and Make (build, build-combined, package, package-combined, package-tar, validate, lint, test, clean, list, help).
- **Orphaned plan directory warning** — `cmdNew` now detects plan directories with no active pointer and emits a non-blocking warning suggesting `list` to inspect.

## [1.8.0] - 2026-02-18

### Fixed
- **CRITICAL: ensureGitignore failure no longer destroys plan** — `ensureGitignore()` moved outside the plan-creation try/catch. Failure is now a warning, not a rollback. Also cleans up the pointer file on creation failure.
- **make test is no longer a no-op** — replaced `|| true` swallowed exit code with actual round-trip test (new → status → close in temp directory). Help command exit code now checked.
- **SKILL.md Mermaid diagram now has initial/terminal state markers** — added `[*] --> EXPLORE` and `CLOSE --> [*]` to match README diagram.
- **Validation now checks PLAN → PLAN self-transition** — both Makefile and build.ps1 validate all 9 transition table entries (was 8).
- **Validation now checks checkpoints/ and findings/ directory creation** — bootstrap.mjs directory creation verified by both build scripts.
- **RE_PLAN/RE-PLAN validation regex tightened** — `RE.PLAN` (matches anything) → `RE[-_]PLAN` (matches only hyphen or underscore).
- **cmdClose TOCTOU race** — `unlinkSync(pointerFile)` wrapped in try/catch to handle concurrent removal.
- **ensureGitignore now uses atomic write** — temp file + rename, consistent with pointer file write.
- **Empty goal prevented on backward-compat path** — `node bootstrap.mjs ""` now defaults to "No goal specified".
- **Goal extraction regex handles ## Goal as last section** — lookahead changed from `(?=\n## )` to `(?=\n## |$)`.
- **build.ps1 path separator portability** — `Invoke-List` now uses `[IO.Path]::DirectorySeparatorChar` instead of hardcoded backslash.

### Added
- **build.ps1 `test` command** — mirrors Makefile test target with lint + round-trip test.
- **build.ps1 `package-tar` command** — mirrors Makefile package-tar target. Closes parity gap.
- **Combined package bootstrap limitation documented** — combined single-file build now appends a note about missing `bootstrap.mjs`. README Quick Start also notes this.

### Changed
- **Iteration limits clarified** — replaced ambiguous "If iteration > 5 → STOP" with explicit two-tier: iteration 5 = Nuclear Option if bloated, iteration 6+ = unconditional hard stop.

## [1.7.0] - 2026-02-17

### Added
- **`list` subcommand** — `bootstrap.mjs list` shows all plan directories under `.claude/` (active and closed) with state, goal, and active marker. Useful for reviewing plan history. Documented in SKILL.md, CLAUDE.md, and README.md.
- **Findings subagent naming convention** — `findings/{topic-slug}.md` (kebab-case, descriptive). Prevents filename collisions when parallel subagents write simultaneously. Documented in SKILL.md EXPLORE rules and file-formats.md.

### Changed
- **Atomic pointer write** — `bootstrap.mjs` now writes `.current_plan` via temp file + rename, preventing partial pointer on crash between directory creation and pointer write.
- **Multi-line goal support** — `extractField` regex for `## Goal` now captures until the next heading, not just the first line. `resume` and `status` display the first line; full goal preserved in plan.md.
- **Enhanced `validate` target** — Both Makefile and build.ps1 now verify: (1) all `references/` cross-references in SKILL.md resolve to actual files, (2) bootstrap.mjs creates all expected plan directory files, (3) state machine transition pairs appear in SKILL.md.

## [1.6.0] - 2026-02-17

### Added
- **Pre-Step Checklist in state.md** — New `## Pre-Step Checklist` section in state.md, reset before each EXECUTE step. Converts memory-dependent mandatory re-read rules into file-based enforcement: re-read state.md, plan.md, progress.md, decisions.md (if fix), checkpoint (if risky/irreversible). Bootstrap creates it; file-formats.md documents it.
- **Minimum EXPLORE depth** — ≥3 indexed findings required in `findings.md` before EXPLORE → PLAN transition. Findings must cover: problem scope, affected files, existing patterns/constraints. PLAN gate check also enforces this — <3 findings sends you back to EXPLORE.
- **Post-Step Gate failure case clarified** — Gate heading changed from "MANDATORY — all 3" to "successful steps only — all 3". Added explicit line: on failed step, skip gate and follow Autonomy Leash.
- **Irreversible-operation protocol** — Steps with side effects git cannot undo (DB migrations, external API calls, service config, non-tracked file deletion) must be tagged `[IRREVERSIBLE]` in plan.md. Before executing: (1) explicit user confirmation, (2) rollback plan in checkpoint, (3) dry-run if available. Added to SKILL.md EXECUTE rules, file-formats.md plan.md template, and code-hygiene.md as new section.

## [1.5.1] - 2026-02-17

### Fixed
- **Missing state transitions formalized** — Added PLAN → EXPLORE (can't state problem, can't list files, insufficient findings) and PLAN → PLAN (user rejects, revise and re-present) to both Mermaid diagram and transition table. Prose already described these behaviors but the formal spec omitted them.
- **File Lifecycle Matrix CLOSE column corrected** — `findings.md`, `findings/*`, and `progress.md` changed from `—` to `R` during CLOSE. Writing summary.md requires reading these files.
- **`.gitignore` update moved from CLOSE to bootstrap** — `bootstrap.mjs` now idempotently ensures `.claude/.plan_*` and `.claude/.current_plan` patterns in `.gitignore` on plan creation. Prevents plan files from being committed during EXECUTE step commits. Previously this was a manual instruction at CLOSE — by which point plan files may have already been committed.

## [1.5.0] - 2026-02-17

### Changed
- **Checkpoint lifecycle expanded** — File Lifecycle Matrix: REFLECT gains R (read checkpoints to know rollback options before deciding transition)
- **Checkpoint naming encodes iteration** — `cp-NNN.md` → `cp-NNN-iterN.md` (e.g. `cp-001-iter2.md`). NNN increments globally.
- **Checkpoint "Git State" clarified** — explicitly documented as the commit BEFORE changes (the restore point), not after
- **RE-PLAN keep-vs-revert decision criteria** — keep when steps are valid under new approach + tests pass; revert when fundamentally different approach or commits would conflict; default when unsure = revert to latest checkpoint
- **REFLECT reads checkpoints** — notes available restore points in `decisions.md` when transitioning to RE-PLAN
- **Autonomy leash includes checkpoints** — on leash hit: revert uncommitted first, present available checkpoints to user
- **3-strike rule specifies rollback** — revert to checkpoint covering the struck area
- **Nuclear option allows later checkpoint** — default is `cp-000` but user may choose a later checkpoint if partial progress is worth keeping
- **Recovery protocol includes checkpoints** — `checkpoints/*` now listed as step 7 (rollback points and git hashes)
- **Git integration RE-PLAN line expanded** — clarifies keep/revert logic and requires logging choice in `decisions.md`
- **code-hygiene.md RE-PLAN section** — added decision criteria, "read checkpoints first", default-to-revert guidance
- **complexity-control.md** — 3-strike adds checkpoint rollback step; nuclear option clarifies checkpoint selection
- **file-formats.md checkpoint template** — updated naming, clarified git state semantics, added parenthetical examples for risky change triggers

## [1.4.0] - 2026-02-17

### Changed
- **findings.md lifecycle expanded** — File Lifecycle Matrix updated: REFLECT gains R (read to check contradictions), RE-PLAN gains R+W (can now correct wrong findings)
- **EXPLORE subagent coordination** — main agent owns `findings.md` index; subagents write only to `findings/`. Correction format: `[CORRECTED iter-N]`
- **PLAN gate check enforced** — "read first" → explicit gate: "If not read → read now. No exceptions."
- **EXECUTE surprise discovery rule** — unexpected findings noted in `state.md`, step finishes or reverts, then transitions to REFLECT. No silent findings updates during EXECUTE.
- **REFLECT reads findings** — explicitly reads `findings.md` + `findings/*` to detect contradictions from EXECUTE. EXPLORE transition now triggers on contradicted findings.
- **RE-PLAN can correct findings** — if earlier findings proved wrong, update with `[CORRECTED iter-N]` + reason. Append-only (don't delete original text).
- **file-formats.md updated** — findings.md template adds `## Corrections` section and documents index ownership

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
