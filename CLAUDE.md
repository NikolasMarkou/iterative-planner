# CLAUDE.md

Guidance for working with the Iterative Planner codebase.

## Project Purpose

Claude Code skill — state-machine driven iterative planning and execution. Cycle: Explore → Plan → Execute → Reflect → Pivot. Filesystem (`plans/plan-YYYY-MM-DDTHHMMSS-XXXXXXXX/`; legacy `plans/plan_YYYY-MM-DD_XXXXXXXX/` dirs are still read, never written) as persistent memory.

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
    ├── agents/                       # Sub-agent definitions (installed to ~/.claude/agents/)
    │   ├── ip-orchestrator.md        # State machine owner, spawns all other agents
    │   ├── ip-explorer.md            # Read-only codebase research (EXPLORE phase)
    │   ├── ip-plan-writer.md         # Plan generation (PLAN phase)
    │   ├── ip-executor.md            # Code execution (EXECUTE phase)
    │   ├── ip-verifier.md            # Verification checks (REFLECT phase)
    │   ├── ip-reviewer.md            # Adversarial review (REFLECT phase, iteration >= 2)
    │   └── ip-archivist.md           # CLOSE phase housekeeping
    ├── scripts/
    │   ├── bootstrap.mjs             # Initializes plans/plan-YYYY-MM-DDTHHMMSS-XXXXXXXX/ directory (Node.js 18+)
    │   ├── bootstrap.test.mjs        # Test suite (node:test)
    │   ├── validate-plan.mjs         # Protocol compliance validator (Node.js 18+)
    │   ├── validate-plan.test.mjs    # Test suite (node:test)
    │   ├── blast-radius.mjs          # Per-edit blast-radius scorer (used by ip-executor; Node.js 18+)
    │   ├── blast-radius.test.mjs     # Test suite (node:test)
    │   ├── schema.mjs                # CHANGELOG_SPEC — the ONE declarative definition of the changelog's field shapes + validateElement()/entryFromFields(); consumed by validate-plan.mjs (Node.js 18+)
    │   ├── schema.test.mjs           # Test suite (node:test)
    │   ├── check-test-count.mjs      # TEST_COUNT vs live `node --test` pass-count gate (used by make/build.ps1 test, NOT validate; Node.js 18+)
    │   ├── check-test-count.test.mjs # Test suite (node:test)
    │   ├── check-doc-parity.mjs      # README<->SKILL.md File Ownership table parity gate (used by make/build.ps1 validate; Node.js 18+)
    │   ├── check-doc-parity.test.mjs # Test suite (node:test)
    │   ├── check-readme-parity.mjs   # README version badge + TEST_COUNT parity gate (used by make/build.ps1 validate; Node.js 18+)
    │   ├── check-readme-parity.test.mjs # Test suite (node:test)
    │   ├── check-agent-wiring.mjs    # Prose-layer gate: script paths (`<skill-path>`), reference citations, `§ <Code> <Title>` pointers, skill-path resolution across src/agents, src/scripts/modules, src/SKILL.md, src/references (used by make/build.ps1 lint+test; Node.js 18+)
    │   ├── check-agent-wiring.test.mjs # Test suite (node:test)
    │   ├── emit-state.mjs            # Per-state rule router; emits scripts/modules/state-<s>.md on demand (used by SKILL.md per-state pointers / orchestrator dispatch; Node.js 18+)
    │   ├── emit-state.test.mjs       # Test suite (node:test)
    │   ├── emit-template.mjs         # Per-template slicer; emits one plan-file template sliced from references/file-formats.md via --name <slug> (used by agents/modules to fetch a single template instead of the full file-formats.md file; Node.js 18+)
    │   ├── emit-template.test.mjs    # Test suite (node:test)
    │   ├── modules/                  # Verbatim per-state rule bodies, emitted on demand by emit-state.mjs
    │   │   ├── state-explore.md      # EXPLORE per-state rules
    │   │   ├── state-plan.md         # PLAN per-state rules
    │   │   ├── state-execute.md      # EXECUTE per-state rules (incl. Post-Step Gate)
    │   │   ├── state-reflect.md      # REFLECT per-state rules (all 3 phases)
    │   │   └── state-pivot.md        # PIVOT per-state rules
    │   └── shared.mjs                # Shared helpers (field extraction, changelog field split, compression markers)
    └── references/                   # Knowledge base documents
        ├── blast-radius.md           # Per-edit blast-radius signals + scoring spec
        ├── code-hygiene.md           # Change manifest format, revert procedures, forbidden leftovers
        ├── complexity-control.md     # Anti-complexity protocol (revert-first, 3-strike, nuclear option)
        ├── convergence-metrics.md    # Convergence score, momentum tracker, iteration health signals
        ├── decision-anchoring.md     # When/how to anchor decisions in code, format, audit rules
        ├── file-formats.md           # Templates and examples for all plan directory files
        ├── planning-rigor.md         # Assumption tracking, pre-mortem, falsification signals, prediction accuracy, root cause analysis
        └── python-software.md        # Python/software-engineering domain caveat (conditional; consulted only for software work)
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
node <skill-path>/scripts/bootstrap.mjs retire <plan-id>     # Mark a removed plan's DECISION anchors [STALE], drop its dir
node <skill-path>/scripts/bootstrap.mjs reset-attempts       # Clear active plan's Fix Attempts (unjam stale leash counter)
```

`new` creates plan directory (`plan-YYYY-MM-DDTHHMMSS-XXXXXXXX`, UTC, colon-free; the legacy `plan_YYYY-MM-DD_XXXXXXXX` shape is still accepted on every read path but never generated again) with all files + writes `plans/.current_plan` pointer. Creates `plans/FINDINGS.md`, `plans/DECISIONS.md`, `plans/LESSONS.md`, `plans/SYSTEM.md` (system atlas, max 300 lines, rewritten by ip-archivist at CLOSE), and `plans/INDEX.md` if they don't exist. Idempotent-safe: refuses if active plan exists.

### Activation Triggers

Complex task, or: "plan this", "figure out", "help me think through", "I've been struggling with", "debug this complex issue".

## Protocol Reference

Complete spec in **src/SKILL.md**. Key sections:

- **State Machine & Transitions**: src/SKILL.md "State Machine" and "Transition Rules" sections
- **Mandatory Re-reads**: src/SKILL.md "Mandatory Re-reads" section
- **Autonomy Leash**: src/SKILL.md "Autonomy Leash" section
- **Complexity Control**: src/SKILL.md "Complexity Control" section + `src/references/complexity-control.md` (6 Simplification Checks including essential vs accidental complexity)
- **Code Hygiene**: src/SKILL.md "Code Hygiene" section + `src/references/code-hygiene.md`
- **Decision Anchoring**: src/SKILL.md "Decision Anchoring" section + `src/references/decision-anchoring.md`
- **Planning Rigor**: src/SKILL.md PLAN/EXPLORE/REFLECT/PIVOT sections + `src/references/planning-rigor.md` (assumptions, pre-mortem, falsification signals, exploration confidence, prediction accuracy, ghost constraints, decomposition)
- **Git Integration**: src/SKILL.md "Git Integration" section
- **Sub-Agent Architecture**: src/SKILL.md "Sub-Agent Architecture" section (agent definitions, file ownership, dispatch rules)

Do not duplicate protocol content here. Read src/SKILL.md directly.

## Working with This Codebase

### File Modification Guidelines

- **src/SKILL.md** — core protocol. Changes affect all planning behavior.
- **src/agents/** — sub-agent definitions. Each file uses YAML frontmatter (name, description, tools, model) + Markdown system prompt. Installed to `~/.claude/agents/`.
- **src/references/** — supplementary knowledge, read on-demand. Add new files for expanded guidance.
- **src/scripts/bootstrap.mjs** — requires Node.js 18+. Idempotent-safe (refuses if active plan exists).
- **src/scripts/emit-state.mjs + src/scripts/modules/** — the per-state emission layer. SKILL.md "Per-State Rules" keeps only summaries + `emit-state --state <s>` pointers; the verbatim rule bodies live in `modules/state-<s>.md` and are emitted on demand. Edit a rule body in its module, not in SKILL.md.
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
- [ ] `src/scripts/bootstrap.mjs` creates all files referenced in `src/references/file-formats.md` (including `verification.md`)
- [ ] Plan directory structure in src/SKILL.md matches bootstrap.mjs output (including `verification.md`)
- [ ] `src/scripts/bootstrap.mjs` creates and references `FINDINGS.md`, `DECISIONS.md`, and `LESSONS.md` consolidated files
- [ ] Consolidated files contain merged content after `close`
- [ ] `plans/LESSONS.md` referenced in SKILL.md (EXPLORE, PLAN gate check, PIVOT, CLOSE, Recovery)
- [ ] `plans/SYSTEM.md` created by bootstrap and referenced in SKILL.md (EXPLORE, PLAN re-reads, Recovery)
- [ ] `plans/INDEX.md` created by bootstrap and updated on close
- [ ] `lessons_snapshot.md` created in plan directory on close
- [ ] `src/scripts/validate-plan.mjs` passes syntax check
- [ ] All agent definitions in `src/agents/` have `name:`, `description:`, and `tools:` in YAML frontmatter
- [ ] Agent definitions in src/SKILL.md "Sub-Agent Architecture" section match files in `src/agents/`
- [ ] File Ownership Model table in src/SKILL.md matches agent tool permissions
- [ ] src/SKILL.md "Orchestrator Role Assumption" section names `iterative-planner-orchestrator` and matches `src/agents/ip-orchestrator.md` frontmatter `name:`
- [ ] src/SKILL.md does not duplicate ip-orchestrator.md dispatch sequencing (pointer only — "Dispatch Rules by State" is a pointer, not a per-state spawn narrative)
- [ ] README.md and src/SKILL.md File Ownership tables agree (same co-ownership for `plan.md` and `changelog.md`); full row parity between the two File Ownership tables is now enforced automatically by `node src/scripts/check-doc-parity.mjs` (run via `make validate`)
- [ ] README.md version badge and test count match `VERSION` and `TEST_COUNT` files (enforced by `node src/scripts/check-readme-parity.mjs`, run via `make validate`)
- [ ] Agent/module prose wiring is intact — every `node <skill-path>/scripts/<x>.mjs` invocation carries `<skill-path>` (never a bare `node src/scripts/…`, which is correct HERE but breaks in a consuming project), every `references/<file>.md` citation resolves, and every `§ <Code> <Title>` section pointer resolves to a heading whose title agrees (enforced by `node src/scripts/check-agent-wiring.mjs`, run via `make validate`; scope is `src/agents/*.md`, `src/scripts/modules/*.md`, `src/SKILL.md`, `src/references/*.md` — README.md and CLAUDE.md are deliberately OUT of scope)
- [ ] Skill-bundled `~/.claude/skills/iterative-planner/agents/` mirrors `src/agents/` (`diff -rq --exclude='.claude' src/agents ~/.claude/skills/iterative-planner/agents` empty) — kept in sync by "Updating Local Skill"
- [ ] `node src/scripts/emit-state.mjs --state <explore|plan|execute|reflect|pivot>` emits the verbatim per-state rule body for each state; unknown/missing `--state` exits non-zero
- [ ] `node src/scripts/emit-template.mjs --name <slug>` emits the byte-faithful template slice from references/file-formats.md for each of the 17 slugs (incl. `lessons-synthesis`, the CLOSE structure guide for LESSONS.md synthesis); unknown/missing `--name` exits non-zero (2 for missing, 1 for unknown)
- [ ] **There is NO byte-parity test between `bootstrap.mjs` and `references/file-formats.md`, and no `bootstrap.mjs` copy of the `emit-template` slices — do not go looking for either, and do not add one without a plan.** The two are wired differently: `emit-template.mjs` *slices* `file-formats.md` at runtime (so a template edit there propagates automatically, and its tests assert the slice against `file-formats.md` itself), while `bootstrap.mjs` writes new plan files from its OWN inline string literals and never reads `file-formats.md`. Nothing mechanically enforces that those literals agree with `file-formats.md` — the lockstep is hand-maintained (see the `schema must match … exactly` comment at `bootstrap.mjs:246`), so editing a template in `file-formats.md` does NOT fail `emit-template`'s tests on account of `bootstrap.mjs` drift. Drift here is silent; the checker is your eyes
- [ ] `.md` HTML-comment anchors (the `<!-- DECISION … -->` opener form only) are scanned by `src/scripts/validate-plan.mjs` and stamped by `bootstrap.mjs retire` — both list `.md` in `ANCHOR_SOURCE_EXTS`; the block-comment scan is gated off for HTML-style extensions (`HTML_STYLE_EXTS`); and `src/references/*.md` doc examples produce zero anchor findings (guarded by the negative real-doc fixture test in `bootstrap.test.mjs`). Doc examples MUST use placeholder ids — see `src/references/decision-anchoring.md` § Writing About Anchors
- [ ] `src/scripts/modules/` is synced into the skill bundle (`diff -rq --exclude='.claude' src/scripts/modules ~/.claude/skills/iterative-planner/scripts/modules` empty) and re-inlined by `make build-combined` (each of the 5 module bodies present in the combined output)
- [ ] Changelog field shapes have exactly ONE definition — `CHANGELOG_SPEC` in `src/scripts/schema.mjs`. The six field regexes (ts / step / commit / op / radius / dref) stay **deleted**: none is re-declared in `validate-plan.mjs` or `bootstrap.mjs` (pinned by a source-grep test in `validate-plan.test.mjs`). `validate-plan.mjs` validates each `changelog.md` line by `splitChangelogFields()` → `entryFromFields()` → `validateElement()` against the spec
- [ ] **The changelog is markdown, and an append is ONE LINE** (`{plan-dir}/changelog.md`, pipe-delimited, 8 fields). It is not re-encoded and writes are not routed through a document library: the v2.33.0 XML encoding turned each append into a whole-file read-modify-write and lost entries under concurrency (reverted in v2.35.0, D-002). `maybeCompressChangelog` keeps its 5-key return shape and is byte-frozen by a golden-bytes test in `bootstrap.test.mjs`
- [ ] `TEST_COUNT` matches the live `node --test` pass count (`node src/scripts/check-test-count.mjs`, run via `make test` — deliberately NOT in `make validate`, which must stay fast)

## Updating Local Skill

When asked to "update local skill", copy **everything** from the repo to `~/.claude/skills/iterative-planner/` — no exceptions, no partial copies:

```bash
# Full sync — mirrors repo structure exactly
cp src/SKILL.md ~/.claude/skills/iterative-planner/SKILL.md
cp src/scripts/*.mjs ~/.claude/skills/iterative-planner/scripts/
mkdir -p ~/.claude/skills/iterative-planner/scripts/modules && cp src/scripts/modules/*.md ~/.claude/skills/iterative-planner/scripts/modules/   # the *.mjs glob does NOT copy the modules/ subdir — copy it explicitly
cp src/references/*.md ~/.claude/skills/iterative-planner/references/
cp README.md LICENSE CHANGELOG.md VERSION ~/.claude/skills/iterative-planner/   # VERSION is required at runtime: bootstrap.mjs stamps it into new plans

# Install agent definitions (optional — skill works without them)
mkdir -p ~/.claude/agents
cp src/agents/*.md ~/.claude/agents/

# Keep the skill-bundled agents/ dir in sync too (authoritative-by-build)
mkdir -p ~/.claude/skills/iterative-planner/agents
cp src/agents/*.md ~/.claude/skills/iterative-planner/agents/   # keep skill-bundled agents in sync with the Makefile-bundled package
```

The Makefile `build` target bundles `src/agents/*.md` into the skill package's `agents/` dir, so the skill-bundled `agents/` is authoritative-by-build and this manual procedure must mirror it — otherwise the bundled copy drifts (as it did pre-v2.21.0).

Always verify with `diff -rq` after copying. Every file, every time — including `diff -rq --exclude='.claude' src/agents ~/.claude/skills/iterative-planner/agents` and `diff -rq --exclude='.claude' src/scripts/modules ~/.claude/skills/iterative-planner/scripts/modules` (both must be empty — the modules/ subdir is easy to miss because the `*.mjs` glob skips it).
