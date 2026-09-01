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
    │   ├── ip-explorer.md            # codebase-first research, with web fallback (EXPLORE phase)
    │   ├── ip-plan-writer.md         # Plan generation (PLAN phase)
    │   ├── ip-executor.md            # Code execution (EXECUTE phase)
    │   ├── ip-verifier.md            # Verification checks (REFLECT phase)
    │   ├── ip-reviewer.md            # Adversarial review (REFLECT phase, iteration >= 2 by default; earlier by orchestrator choice)
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
    │   ├── check-doc-parity.mjs      # README<->SKILL.md File Ownership table parity gate: path-keys both directions + owner-cell text (exact match after whitespace normalization; readers column not gated) + anti-vacuity floor EXPECTED_MIN_KEYS (either side parsing fewer keys → FAIL [doc-parity-floor]) (used by make/build.ps1 validate; Node.js 18+)
    │   ├── check-doc-parity.test.mjs # Test suite (node:test); also holds the six Makefile <-> build.ps1 lockstep tests (a home of convenience, not a claim that build-channel parity is doc parity)
    │   ├── check-readme-parity.mjs   # README version badge + TEST_COUNT parity gate; both matched as whole shields.io image badges, never as a bare version/count substring (used by make/build.ps1 validate; Node.js 18+)
    │   ├── check-readme-parity.test.mjs # Test suite (node:test)
    │   ├── check-changelog-parity.mjs # CHANGELOG.md top `## [X.Y.Z]` entry ↔ VERSION parity gate; missing/unparseable CHANGELOG is a FAIL, not a skip (used by make/build.ps1 validate; Node.js 18+)
    │   ├── check-changelog-parity.test.mjs # Test suite (node:test)
    │   ├── check-agent-wiring.mjs    # Prose-layer gate: script paths (`<skill-path>`; node options between `node` and the path do not exempt an invocation), reference citations (either the `references/x.md` or the `src/references/x.md` spelling), `§ <Code> <Title>` pointers, skill-path resolution across src/agents, src/scripts/modules, src/SKILL.md, src/references; anti-vacuity scan floor EXPECTED_MIN_PROSE_FILES (an emptied scan dir or a shrunken total → FAIL [scan-floor] before the scans run) (used by make/build.ps1 lint+test; opt-in `--emit-edges [path]` emits the verified cross-reference edge graph as JSONL — default `src/references/kg-edges.jsonl`, generated-only, gitignored, never committed/shipped, wired into make/build.ps1 validate; Node.js 18+)
    │   ├── check-agent-wiring.test.mjs # Test suite (node:test)
    │   ├── check-template-parity.mjs # Byte-parity gate: bootstrap.mjs's 12 `PLAN_TEMPLATES` vs the 12 `<!-- SKELETON:<slug> -->` regions in references/file-formats.md (parity, both-direction completeness, encodability, typing, line-endings, duplicate-region, coverage floor; plus header-copy — a BYTE COMPARISON forbidding any adjacent line-pair of any template's header from reappearing in any SERVED ARTIFACT, run over `resolveTemplate(slug).body` for all 17 VALID_TEMPLATES imported from emit-template.mjs (the exact bytes `emit-template --name <slug>` serves agents), so the thing checked IS the thing served — no boundary/region/grammar between them; a slug that fails to resolve is a LOUD served-resolve FAIL naming it; used by make/build.ps1 validate+lint+test; Node.js 18+)
    │   ├── check-template-parity.test.mjs # Test suite (node:test)
    │   ├── check-register.mjs        # Register-density ratchet gate: measures jargon-marker density (bracket-tags + coded refs + 3+-segment compounds per 1k words) of shipped docs (CLAUDE.md, README, SKILL.md, agents, references) against committed per-file ceilings in register-baseline.json; ERRORs [register-drift] on a rise past ceiling, [register-floor] on missing/empty/too-few docs (used by make/build.ps1 validate+lint+test; Node.js 18+)
    │   ├── check-register.test.mjs   # Test suite (node:test)
    │   ├── register-baseline.json    # Per-file jargon-density ceilings consumed by check-register.mjs (gate-data, not a script)
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
    │   ├── shared.mjs                # Shared helpers (field extraction, changelog field split, compression markers)
    │   └── shared.test.mjs           # Test suite (node:test)
    └── references/                   # Knowledge base documents
        ├── blast-radius.md           # Per-edit blast-radius signals + scoring spec
        ├── code-hygiene.md           # Change manifest format, revert procedures, forbidden leftovers
        ├── complexity-control.md     # Anti-complexity protocol (revert-first, 3-strike, nuclear option)
        ├── convergence-metrics.md    # Convergence score, momentum tracker, iteration health signals
        ├── decision-anchoring.md     # When/how to anchor decisions in code, format, audit rules
        ├── file-formats.md           # Templates and examples for all plan directory files
        ├── planning-rigor.md         # Assumption tracking, pre-mortem, falsification signals, prediction accuracy, root cause analysis
        ├── root-cause-analysis.md    # Structured RCA methods (5 Whys, fishbone, optional fault tree, Cynefin selector); methods extension of planning-rigor.md's canonical schema
        └── python-software.md        # software-engineering domain caveat, any language incl. Python (conditional; consulted only for software work)
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
node <skill-path>/scripts/bootstrap.mjs banner               # Print version + credit banner (no active plan needed)
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
- [ ] README.md and src/SKILL.md File Ownership tables agree (same co-ownership for `plan.md` and `changelog.md`); enforced automatically by `node src/scripts/check-doc-parity.mjs` (run via `make validate`): path-key parity in both directions AND owner-cell (column 2) text parity — exact match after whitespace normalization only (trim + collapse runs; no fuzzy matching), mismatch → `FAIL [doc-parity-owner]`. The readers column (col 3) is deliberately NOT gated. Anti-vacuity: either side parsing fewer than `EXPECTED_MIN_KEYS` keys (heading renamed/missing, BOM-prefixed, `<details>` without a real heading) → `FAIL [doc-parity-floor]`, never a vacuous PASS
- [ ] README.md version badge and test count match `VERSION` and `TEST_COUNT` files (enforced by `node src/scripts/check-readme-parity.mjs`, run via `make validate`). **Both checks are anchored to the badge itself** — the whole `![…](https://img.shields.io/badge/…)` image, in the named `VERSION_BADGE_RE` and `TEST_BADGE_RE`. They used to match a bare `Skill-v<VER>-` / `tests-<N>%20passing` substring anywhere in the file, so deleting a badge passed as long as some other line — a quoted sample, a changelog excerpt — still carried the string: the gate proved a string existed, not that a badge did. Do not loosen either one back to a substring match
- [ ] CHANGELOG.md's first `## [X.Y.Z]` entry matches the `VERSION` file (enforced by `node src/scripts/check-changelog-parity.mjs`, run via `make validate`; a missing or unparseable CHANGELOG is a FAIL, not a skip)
- [ ] Agent/module prose wiring is intact — every `node <skill-path>/scripts/<x>.mjs` invocation carries `<skill-path>` (never a bare `node src/scripts/…`, which is correct HERE but breaks in a consuming project), every `references/<file>.md` citation resolves, and every `§ <Code> <Title>` section pointer resolves to a heading whose title agrees (enforced by `node src/scripts/check-agent-wiring.mjs`, run via `make validate`; scope is `src/agents/*.md`, `src/scripts/modules/*.md`, `src/SKILL.md`, `src/references/*.md` — README.md and CLAUDE.md are deliberately OUT of scope). Anti-vacuity: each scanned dir must contribute ≥1 `.md` file and the total must reach `EXPECTED_MIN_PROSE_FILES`, else `FAIL [scan-floor]` before the scans run — a shrunken discovery can no longer pass silently

  Two things the script reads more widely than it once did, and one it still misses. **Node options no longer exempt an invocation**: the path used to have to be the very next token after `node`, so `node --experimental src/scripts/bootstrap.mjs` passed while the identical flag-less line failed. It now reads a small command grammar — `node`, a run of tokens starting with `-`, then the script argument. Keep the option run recognized by that leading `-`; widening it to "any run of tokens" makes the word `node` in ordinary prose reach forward and swallow an unrelated path later in the sentence. **Still uncaught**: an option whose value is a separate token (`node --loader ts-node/esm src/scripts/x.mjs`) consumes the path's slot and evades the check. Judged not worth a hand-maintained list of value-taking flags; recorded so nobody rediscovers it as a surprise. **Both spellings of a citation resolve**: `references/x.md` and `src/references/x.md` name the same file and both occur in shipped prose. One exported normalizer, `canonicalDocPath()`, strips a leading `src/`, and both the citation rule and the section-pointer rule's target resolution call it — do not reintroduce a `startsWith("references/")` prefix guard in either, or the `src/` spelling silently skips validation again
- [ ] Register density of the shipped re-read docs (CLAUDE.md, README.md, src/SKILL.md, src/agents/*.md, src/references/*.md) stays at or below the committed per-file ceilings in `src/scripts/register-baseline.json` (enforced by `node src/scripts/check-register.mjs`, run via `make validate`): FAIL `[register-drift]` when a file's jargon-marker density rises past its ceiling (density may fall/hold freely; raising a ceiling is a deliberate, review-visible edit like bumping TEST_COUNT), FAIL `[register-floor]` (anti-vacuity) when a baseline-listed doc is missing, near-empty, or fewer files are scanned than baseline keys. The countermeasure to the register self-overfit loop; C1 setpoint lives in SKILL.md § Register Discipline, C3 actuator in ip-archivist Steps 4-5. **Every ceiling is the file's exact measured density, not a rounded-up allowance.** The first baseline was generated with a uniform allowance added to each measurement, which made the gate a loose ceiling with 17% to 100% headroom rather than a ratchet: density could rise a long way with the build staying green. Ceilings were re-measured at HEAD in v2.61.0 and every one of the 19 fell. So adding one marker to a doc turns the build red, and that is the intent — the reply is to write the sentence plainly, or, if the marker is genuinely earned, to raise that one ceiling in the same commit where a reviewer can see it. `EXPECTED_MIN_FILES` is pinned to the live scanned doc count by a `pin:` test in `check-register.test.mjs`, the same idiom the other three floor-carrying gates use, and the baseline key count is pinned to that number too — so a new agent or reference doc with no ceiling, or a ceiling left behind by a deleted doc, fails rather than passing quietly.
- [ ] Skill-bundled `~/.claude/skills/iterative-planner/agents/` mirrors `src/agents/` (`diff -rq --exclude='.claude' src/agents ~/.claude/skills/iterative-planner/agents` empty) — kept in sync by "Updating Local Skill"
- [ ] `node src/scripts/emit-state.mjs --state <explore|plan|execute|reflect|pivot>` emits the verbatim per-state rule body for each state; unknown/missing `--state` exits non-zero
- [ ] `node src/scripts/emit-template.mjs --name <slug>` emits the byte-faithful template slice from references/file-formats.md for each of the 17 slugs (incl. `lessons-synthesis`, the CLOSE structure guide for LESSONS.md synthesis); unknown/missing `--name` exits non-zero (2 for missing, 1 for unknown)
- [ ] **The plan-file templates live in TWO places on purpose, and both are checked against bootstrap's bytes — by different rules, for different reasons.** **Skeleton half** (the 12 `<!-- SKELETON:<slug> -->` regions in `file-formats.md`): the bytes `bootstrap.mjs new` actually writes, *byte-equal* to bootstrap (rule (a)). **Served artifacts** (`resolveTemplate(slug).body` for all 17 `VALID_TEMPLATES` slugs — the exact bytes `emit-template --name <slug>` hands an agent): must contain **no copy of any template's header bytes** (rule (h) — below). Bootstrap renders new plan files from its OWN exported `PLAN_TEMPLATES` map (raw strings + `{{TOKEN}}` placeholders, via `renderTemplate()`) and performs **zero** runtime reads of `file-formats.md` — deliberate and load-bearing, since bootstrap is the one script whose failure mode is "no plan can ever be created again" (the runtime-read alternative was rejected on risk, not feasibility). So the skeleton half's duplication is guarded, not removed: `src/scripts/check-template-parity.mjs` (`make validate`, plus `lint`/`test`) byte-compares the 12 `PLAN_TEMPLATES` entries against the 12 skeleton regions in **both directions**, and cannot pass vacuously (coverage floor `EXPECTED_SLUGS = 12`; duplicate `<!-- SKELETON:x -->` markers rejected first-wins; a non-string template reported, not thrown on; a CRLF doc gets one hint instead of 12 unexplained failures). **A template edit is two edits — `PLAN_TEMPLATES` and its `<!-- SKELETON:<slug> -->` region — and forgetting the second turns the build red naming the slug and the divergent line.**

  **The skeleton half and the served artifacts are NOT byte-compared to each other, and must not be** — for `system` they differ *deliberately*: the doc's `## plans/SYSTEM.md` section is the **populated-form schema** `ip-archivist` fills at CLOSE (which is why `ip-archivist.md:43` points there), while bootstrap writes an **unpopulated** skeleton (`(none yet)` sentinel, UNPOPULATED banner, every hint bullet italicized).

  **Rule (h) `[header-copy]` guards the SERVED ARTIFACTS — a BYTE COMPARISON, not a phrase list, and the thing it checks IS the thing served.** Every template has a HEADER: its leading lines up to its first blank line, the run bootstrap writes and agents never populate (10 of 12 are ≥2 lines). The check builds those header line-pairs from `PLAN_TEMPLATES`, then for **each of the 17 `VALID_TEMPLATES` slugs** resolves `resolveTemplate(slug, docBuf)` — the EXACT bytes `emit-template --name <slug>` serves that slug's agents — and forbids any header pair from appearing in that served body. **The substrate is `resolveTemplate`'s output**, the union of everything agents can receive; there is **no boundary, region, or grammar** between the checker and what `emit-template` serves, so the served-vs-scanned divergence that broke this gate five consecutive times (skeleton half, phrase set, first-of-two boundary, last-exact-END boundary, anchored-line grammar parallel to the slicer) is closed **by construction** — the check CALLS the slicer. A slug that fails to resolve — marker removed, renamed, or redirected — is a **LOUD `[served-resolve]` FAIL naming that slug**; a removed/redirected marker can never silently drop a slug from the check (that silent drop was the enabling half of the fifth break). The keys come from `PLAN_TEMPLATES` itself, so there is no intent to guess at and nothing to synonym around; the rule's prose-heuristic predecessor (`[byte-claim]`, v2.39.0) fell to one synonym and was **deleted, not extended**. The old served-region function, its `SLUG_MARKER_RE`, and the `template-markers` marker-grammar rule are **GONE** — the whole apparatus accreted across iters 3–4 was deleted (net −21 logic lines; D-009). The checker reads the doc **once as a raw Buffer** and passes those bytes to `resolveTemplate`, so its served substrate is byte-identical to `emit-template`'s own raw read even for a malformed doc.

  **What this still does NOT catch — five holes, named because a gate you cannot falsify is a gate you should not trust.** **(1) Skeleton lines *below* a header are un-gated.** They are still restated inside the served bodies (a markdown table cannot drop its header row; `progress` really does contain `## Completed`), and gating them needs a per-slug allowlist — rejected. If bootstrap changes one, the served body goes stale and **nothing goes red**. **(2) `plan` and `progress` have 1-line headers** (`# Plan v0`, `# Progress`) — below the 2-line threshold, which is not lowered because a 1-line rule would fire on every `# Progress` heading in the doc. **(3) The rule catches HEADER COPIES, not arbitrary false content.** It fires on a served body restating a template's *header* bytes; a fabricated NON-header line, a paraphrase, or an invented header restates no header pair and passes — it is a wrong-content defect, outside `[header-copy]`'s charter (which is: no served artifact restates bootstrap's header bytes). The same is true of a marker SWAP that makes one slug serve a valid-but-wrong template: the wrong body restates no header, so neither `[parity]` nor `[header-copy]` fires — a correctness defect, not a bootstrap-byte restatement, out of charter. Neither is guarded here (`emit-template`'s per-slug sentinel tests are smoke tests, not adversary-proof — a redirect can include the public sentinel string and pass both). **(4) A byte-different but VISUALLY IDENTICAL copy evades it** — a trailing space, an NBSP, a unicode look-alike, or a blank line / HTML comment interleaved *between* two header lines (breaking adjacency). More dangerous than (3), because a reader cannot *see* it is wrong and it can arrive **accidentally** through an editor or a paste. Deliberately not closed (D-007): a normalizing comparison (trim + NFKC) is a *different* rule with its own evasion surface, it weakens the byte-exactness that is the entire point of the category, and it cannot touch the interleave case at all. **(5) `CLAUDE.md` itself is gated by nothing mechanical** — no checker reads this file. This bullet has been wrong five times (v2.37.0–v2.40.0); it is more defensible now (no "boundary" claim to falsify — the check reads `emit-template`'s real output), but its only defense is that every clause is paired with a command that demonstrates it.
- [ ] `.md` HTML-comment anchors (the `<!-- DECISION … -->` opener form only) are scanned by `src/scripts/validate-plan.mjs` and stamped by `bootstrap.mjs retire` — both list `.md` in `ANCHOR_SOURCE_EXTS`; the block-comment scan is gated off for HTML-style extensions (`HTML_STYLE_EXTS`); and `src/references/*.md` doc examples produce zero anchor findings (guarded by the negative real-doc fixture test in `bootstrap.test.mjs`). Doc examples MUST use placeholder ids — see `src/references/decision-anchoring.md` § Writing About Anchors
- [ ] `plans/ANCHORS.md` is committed and stays committed. Bootstrap writes the plans glob plus a negation line for it into `.gitignore`, so `git ls-files plans/` prints exactly that one path and nothing else under it. The file is the durable tier of anchor resolution in `validate-plan.mjs`: every other source a `# DECISION` anchor can resolve against lives inside the ignored plans directory, so it is gone in a fresh clone. It is deliberately **not** a `PLAN_TEMPLATES` entry — a 13th key would drag in a new skeleton region, a bumped slug floor, an 18th served slug with its own test, and every "12 templates / 17 served" sentence in this file, all to publish a four-line header; a bootstrap test pins those header bytes instead. Format and rules: `src/references/file-formats.md` § plans/ANCHORS.md
- [ ] `src/scripts/modules/` is synced into the skill bundle (`diff -rq --exclude='.claude' src/scripts/modules ~/.claude/skills/iterative-planner/scripts/modules` empty) and re-inlined by `make build-combined` (each of the 5 module bodies present in the combined output)
- [ ] Changelog field shapes have exactly ONE definition — `CHANGELOG_SPEC` in `src/scripts/schema.mjs`. The six field regexes (ts / step / commit / op / radius / dref) stay **deleted**: none is re-declared in `validate-plan.mjs` or `bootstrap.mjs` (pinned by a source-grep test in `validate-plan.test.mjs`). `validate-plan.mjs` validates each `changelog.md` line by `splitChangelogFields()` → `entryFromFields()` → `validateElement()` against the spec
- [ ] **The changelog is markdown, and an append is ONE LINE** (`{plan-dir}/changelog.md`, pipe-delimited, 8 fields). It is not re-encoded and writes are not routed through a document library: the v2.33.0 XML encoding turned each append into a whole-file read-modify-write and lost entries under concurrency (reverted in v2.35.0, D-002). `maybeCompressChangelog` keeps its 5-key return shape and is byte-frozen by a golden-bytes test in `bootstrap.test.mjs`
- [ ] **A completion fix is numbered as a sub-step of the step it repairs: a fix to step 9 is `iter-1/step-9.1`, a second fix to step 9 is `iter-1/step-9.2`.** The iteration does not go up, because the fix finishes the same round of work. That is the whole rule, and it is what the changelog's `step` field must carry — never `iter-1/completion-fix`, which is tempting (the loop really does run REFLECT → EXECUTE without raising the iteration) but fails the `step` grammar in `schema.mjs` and comes back from `validate-plan.mjs` as a warning on every line. That has happened in two plans here (`plan-2026-07-31-de0ded98` and `plan-2026-08-04-3a5913b0`, 7 warned lines), which is why the rule exists. The commit subject may read however is clearest; only the changelog field is checked.
- [ ] **The two build channels fail on the same conditions.** `build.ps1` must not wrap a mandatory script or gate in a `Test-Path` skip: the Makefile greps those files directly and dies when one is gone, so a skip wrapper made a deleted gate pass validation silently on Windows only. A missing script is an error, never a skip. The file also declares `#Requires -Version 7` on its first line and names `-Encoding utf8` on every `Get-Content` and `Set-Content`; under Windows PowerShell 5.1 both default to the ANSI codepage, and SKILL.md is dense with em dashes, arrows and section signs that a round-trip would corrupt. Six lockstep tests bind the channels — same validate gate set, no skip-wrapped gate, same lint list, same test list, same build-combined rewrite pairs, and the version guard plus encoded round-trips. They live in `check-doc-parity.test.mjs` today, which is a home of convenience rather than a statement that build-channel parity is doc parity; move them if a better home appears. **No PowerShell runs in the usual development environment here, so every claim about that channel is verified by reading it, not by running it** — say so when you report on it
- [ ] **Both channels' `build-combined` rewrite the per-state and per-template pointers**, not just the reference citations. Neither router runs in a paste context, and the five module bodies are already inlined as `## State Module: <state>` sections, so a surviving `node <skill-path>/scripts/emit-state.mjs` line in the combined file tells a reader to run something they cannot run. The two rewrite maps are one fact in two places and a lockstep test compares them pair by pair. Acceptance: the combined output contains no `node <skill-path>/scripts/emit-` line
- [ ] **The state-machine consistency check asserts real diagram edges.** Both channels match the indented `FROM --> TO` line in SKILL.md's Mermaid diagram, for all ten transitions including `REFLECT --> EXECUTE`. The predecessor matched `FROM.*TO` anywhere in the file, which meant `PLAN.*PLAN` could not fail on any document that mentioned PLAN twice on one line. Removing an edge from the diagram must turn the build red; if it does not, the check is decorative
- [ ] **The validator fires only on non-conforming input**, and there is no Presentation Contract check. A `presentation-contract-unlogged` warning lived in `validate-plan.mjs` from v2.17.0 and demanded a contract name appear in a plan file, though no protocol file ever told an agent to write one there — so a correctly run plan was warned at every gated transition. It was deleted rather than made satisfiable, because an agent that logs a contract name proves only that it logged the name. Two sibling repairs go with it: `findings/` holds two artifact schemas, so `review-iter-N.md` and `review-iter-N-passM.md` are linted against the reviewer's own Concerns / Blind Spots / Verdict sections instead of the explorer's — the discriminator switches the required list, it does not exempt those files, and a review file missing its Verdict must still warn. And the verification-evidence check skips a row whose Criterion cell is still placeholder text, reusing the validator's existing placeholder patterns rather than growing a second exemption list. Do not widen that skip to the Evidence cell: an empty Evidence cell beside a real criterion is exactly what the check exists to report
- [ ] **The pre-step leash gate is reachable without agent definitions installed.** The imperative to run `validate-plan.mjs --pre-step` before starting an execute step lives in `src/scripts/modules/state-execute.md` — the one rule body that both the agent-driven and the single-threaded paths read. Stating it only in the orchestrator's prompt left a single-threaded run never reading it, and the hard leash silently degraded to advice. Related: the executor makes at most one fix try per spawn, so the two recorded attempts are the two spawns the orchestrator records, and the reachable worst case matches the cap SKILL.md states
- [ ] **`verification.md` is not written during EXECUTE.** The File Lifecycle Matrix is the single rule; the orchestrator is the sole writer, merging the verifier's returned results at REFLECT. Both restatements now agree — bootstrap's own template header and the matching skeleton region in `file-formats.md` (the mandatory pair of edits), plus that document's prose
- [ ] **A shipped `.md` file cannot carry a live decision anchor, and this contradicts the anchoring rule the executor is given.** A test pins every shipped Markdown file to produce zero anchor findings, and an anchor in shipped prose would point at a plan directory that does not exist in anyone else's clone — so writing one turns the build red, as it did once during this work. Meanwhile `references/decision-anchoring.md` and the executor's own protocol tell an agent to anchor a decision at the point of impact. Both rules are real and they disagree; nothing resolves it today. The working practice is: put the reasoning in a plain comment that names the decision without using the anchor form, and leave real anchors to source files. The full reasoning is recorded as decision D-015 in the plan directory for `plan-2026-09-01T100120-4f591469`, which is not committed — which is why the constraint is written out here instead of only cited
- [ ] `TEST_COUNT` matches the live `node --test` pass count (`node src/scripts/check-test-count.mjs`, run via `make test` — deliberately NOT in `make validate`, which must stay fast)
- [ ] Any change adding a full-corpus walk over `plans/` (an operation that reads every plan directory) carries a one-line cost note in its CHANGELOG entry — Big-O in plan-dir count, plus which validator/gate path triggers it and how often (this rule exists because `collectKnownDecisionIdsByPlan`, commit 9b8d405, shipped an unmodeled O(all-plan-dirs) scan — narrowed to O(referenced-plans) in v2.53.0)

## Updating Local Skill

When asked to "update local skill", run the sync target — THE procedure, not one option among several:

```bash
make sync-skill          # Unix/Linux/macOS
.\build.ps1 sync-skill   # Windows
```

`sync-skill` **prunes before copying**, copies everything (SKILL.md, scripts + modules, references, agents, README/LICENSE/CHANGELOG/VERSION — VERSION is required at runtime: bootstrap.mjs stamps it into new plans), then verifies every synced tree with `diff -rq` and fails loudly (`exit 1`) on any mismatch.

Prune-before-copy is the point: `cp` alone cannot remove a file that was DELETED from the repo, so a copy-only sync leaves orphans in the install forever — v2.35.0 removed `xml.mjs`/`changelog.mjs`, and a copy-only sync would have left both live in the install (the exact failure mode named by the Makefile's sync-skill prune comment). Prune scope matters: the skill's own install dirs (`~/.claude/skills/iterative-planner/{scripts,scripts/modules,references,agents}`) are wholly owned by this skill and safely glob-pruned, but the shared `~/.claude/agents/` dir is pruned ONLY of this skill's own `ip-*.md` files — never describe (or reimplement) that as delete-everything-and-copy: a glob prune there would delete other skills' agent definitions.

The Makefile `build` target bundles `src/agents/*.md` into the skill package's `agents/` dir, so the skill-bundled `agents/` is authoritative-by-build; `sync-skill` mirrors it (the manual fallback below must too, or the bundled copy drifts as it did pre-v2.21.0).

### Fallback (no prune) — use only if make/PowerShell is unavailable

This does NOT remove repo-deleted files: after copying, verify with `diff -rq` and delete orphans by hand.

```bash
cp src/SKILL.md ~/.claude/skills/iterative-planner/SKILL.md
# EXCLUDE test files: the raw `cp src/scripts/*.mjs` glob ships all *.test.mjs into the live install (D-008 regression). Copy only non-test scripts:
find src/scripts -maxdepth 1 -name '*.mjs' ! -name '*.test.mjs' -exec cp {} ~/.claude/skills/iterative-planner/scripts/ \;
cp src/scripts/*.json ~/.claude/skills/iterative-planner/scripts/   # gate-data files (register-baseline.json)
mkdir -p ~/.claude/skills/iterative-planner/scripts/modules && cp src/scripts/modules/*.md ~/.claude/skills/iterative-planner/scripts/modules/   # the *.mjs glob does NOT copy the modules/ subdir — copy it explicitly
cp src/references/*.md ~/.claude/skills/iterative-planner/references/
cp README.md LICENSE CHANGELOG.md VERSION ~/.claude/skills/iterative-planner/   # VERSION is required at runtime: bootstrap.mjs stamps it into new plans
mkdir -p ~/.claude/agents && cp src/agents/*.md ~/.claude/agents/               # shared dir: copy only — NEVER glob-delete here (other skills' agents live here too)
mkdir -p ~/.claude/skills/iterative-planner/agents && cp src/agents/*.md ~/.claude/skills/iterative-planner/agents/   # keep skill-bundled agents in sync (authoritative-by-build)
```

Always verify with `diff -rq` after the fallback. Every tree, every time — `diff -rq --exclude='.claude' src/agents ~/.claude/skills/iterative-planner/agents`, `diff -rq --exclude='.claude' src/scripts/modules ~/.claude/skills/iterative-planner/scripts/modules` (the modules/ subdir is easy to miss because the `*.mjs` glob skips it), plus `diff -rq --exclude='.claude' --exclude='*.test.mjs' src/scripts ~/.claude/skills/iterative-planner/scripts` (the `--exclude='*.test.mjs'` is mandatory — the fallback copy above deliberately excludes test files, so an unfiltered diff would false-flag every `*.test.mjs` as "only in src/scripts"; separately confirm `ls ~/.claude/skills/iterative-planner/scripts/*.test.mjs` is empty — a leaked test file is a D-008 regression) and `diff -rq --exclude='.claude' --exclude='kg-edges.jsonl' src/references ~/.claude/skills/iterative-planner/references` (`kg-edges.jsonl` is generated-only, never synced). All must be empty; any file present only in the install is an orphan the fallback cannot remove — delete it by hand.
