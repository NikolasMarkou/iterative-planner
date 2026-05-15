# Changelog

All notable changes to the Iterative Planner project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.17.2] - 2026-05-15

### Changed
- **`plans/INDEX.md` demoted from mandatory EXPLORE eager-read to on-demand lookup.** Aligns `src/SKILL.md` and `src/agents/orchestrator.md` to the already-canonical schema in `references/file-formats.md:705` ("Read during EXPLORE when cross-plan context doesn't contain what you need"). The orchestrator no longer loads `plans/INDEX.md` at every EXPLORE entry; it consults INDEX.md only when one of four explicit triggers fires: (a) goal mentions a topic absent from FINDINGS.md, (b) FINDINGS/LESSONS/SYSTEM contains a reference to a trimmed per-plan finding, (c) user references prior work, (d) goal touches files appearing in older plan dirs. File Lifecycle Matrix updated: `R` → `R?` for INDEX.md in EXPLORE column, with footnote explaining the convention.
- **Honest cost-benefit**: ~10K tokens saved per planning cycle at N=100 plans (~$0.03/cycle at $3/M input). Earlier chat-level analysis claimed ~125K tokens/cycle savings — that figure was wrong by ~10×, conflating "total agent invocations per cycle" (~25) with "cross-plan re-reads per cycle" (~1-3, only at EXPLORE entries). The correct multiplier is small. The change is still worth shipping because it eliminates a doctrinal drift between SKILL.md/orchestrator.md and file-formats.md, reduces orchestrator working-set noise, and provides headroom for N>>100 where INDEX.md grows linearly.
- **Edits**: `src/SKILL.md` (L148 matrix + L205-213 EXPLORE rule), `src/agents/orchestrator.md` (L47-55 EXPLORE Dispatch). No script changes. No test changes (122 tests still pass). No schema changes.

## [2.17.1] - 2026-05-15

### Changed
- **Sliding window for consolidated files tightened 8 → 4 plans.** `MAX_CONSOLIDATED_PLANS` in `bootstrap.mjs` reduced from 8 to 4. `plans/FINDINGS.md` and `plans/DECISIONS.md` now retain only the 4 most recent plan sections after each close (down from 8). Older sections remain intact in their per-plan `plans/plan_*/` directories; `plans/INDEX.md` keeps trimmed plans discoverable. Rationale: at steady state (N ≥ window size), each cross-plan re-read pays the full consolidated-file token cost; halving the window halves that per-invocation cost (~12K tokens saved per re-read across FINDINGS+DECISIONS, ~300K tokens per planning cycle at ~25 agent invocations). Driven by context-cost model in `analyses/analysis_2026-05-15_714f6273/phase_outputs/phase_1_context_cost.md`.
- **Doc + test updates** — `SKILL.md`, `README.md`, `references/file-formats.md`, `references/decision-anchoring.md` reflect new window size. `bootstrap.test.mjs` sliding-window tests updated (all 122 tests still pass).

## [2.17.0] - 2026-05-07

### Added
- **Presentation Contracts** — canonical, single-source-of-truth definition of the user-visible chat block the orchestrator MUST emit at every user-facing state transition. Six contracts: **PC-EXPLORE** (Findings Digest), **PC-PLAN** (Plan Presentation), **PC-EXECUTE-STEP** (Per-Step Status Report), **PC-EXECUTE-LEASH** (Autonomy Leash Failure Block), **PC-REFLECT** (Phase-3 Gate-Out 5-Item Block), **PC-PIVOT** (Pivot Options Block). Each contract specifies name, when emitted, required content (numbered, ordered), fidelity (verbatim vs digest), and minimum sections (the floor). Defined in `references/file-formats.md` "Presentation Contracts" section. Closes the user-presentation gap where the protocol used single-verb specs ("Present", "Report", "Surface") and the orchestrator defaulted to terse summaries that dropped the items the user most needed to see.
- **`agents/orchestrator.md` per-state User-Visible Presentation sub-blocks** — each dispatch block (EXPLORE / PLAN / EXECUTE / REFLECT / PIVOT) now opens with a "User-Visible Presentation" section inlining the contract's required content list at the point of dispatch, so the runtime LLM does not need to dereference `references/file-formats.md` to render. Critical Rule added: "NEVER substitute a terse summary for a presentation contract — emit the contract block in full per its floor".
- **`agents/ip-plan-writer.md` `## Output Format` section** — sub-agent must return plan.md path + section anchors + one-paragraph digest. The digest is for the orchestrator's pre-render summary only; the orchestrator renders plan.md verbatim per PC-PLAN floor (Steps, Success Criteria, Verification Strategy, Failure Modes, Assumptions).
- **`agents/ip-verifier.md` Relay Contract (PC-REFLECT item 3)** — the PASS/FAIL table is the literal payload for Item 3 of the orchestrator's PC-REFLECT 5-item Gate-Out block. Verbatim relay required.
- **`agents/ip-reviewer.md` Relay Contract (PC-REFLECT item 4)** — `## Concerns` block (CRITICAL/WARNING entries) folds verbatim into Item 4 of PC-REFLECT. Empty concerns require explicit `(none)` sentinel; never silently omit.
- **`agents/ip-executor.md` Output Format expansion + Relay Contract** — 5-field PC-EXECUTE-STEP payload on success (step / files / commit / surprises / next-preview); 5-field PC-EXECUTE-LEASH payload on leash hit (step intent / 2 attempts / root cause / checkpoint registry / orchestrator-owned prompt). Orchestrator pastes fields verbatim.
- **`validate-plan.mjs checkPresentationContractLog`** — WARN-only advisory `[presentation-contract-unlogged]` flagging gated transitions PLAN→EXECUTE / REFLECT→CLOSE / PIVOT→PLAN recorded in state.md without any PC-PLAN / PC-REFLECT / PC-PIVOT reference in state.md / decisions.md / progress.md. Best-effort metadata signal — cannot inspect chat content; never blocks CLOSE. The load-bearing fix is the agent-file rewrites.

### Changed
- **`SKILL.md` User Interaction table** — replaces single-verb cells with a per-state Contract column referencing the named Presentation Contracts. PLAN section now points to PC-PLAN; REFLECT Phase-3 Gate-Out maps the 5 items to the contract; PIVOT references PC-PIVOT.

## [2.16.0] - 2026-05-07

### Added
- **`plans/SYSTEM.md` system atlas** — new cross-plan persistent artifact: a curated, **domain-neutral** map of *what the system being planned against actually is*, distinct from goal-driven findings. Hard cap 300 lines. Rewritten by `ip-archivist` at CLOSE (mirrors LESSONS.md mechanics). Read by `orchestrator` at start of EXPLORE and start of PLAN, by `ip-plan-writer` as a mandatory-read, and provided to `ip-explorer` as the structural prior on the target system. Schema: Identity / Components / Boundaries / Invariants / Flows / Known Patterns + optional Codebase Specialization (omitted for non-code domains). Closes the comprehension gap identified in `analyses/analysis_2026-05-07_01cbdad7/` (H3 fix-shape, posterior 0.97).
- **`bootstrap.mjs` creates `plans/SYSTEM.md` skeleton on first `new`** — idempotent, sibling primitive to LESSONS.md/INDEX.md skeleton creation. `SYSTEM_ATLAS_SKELETON` constant in bootstrap.mjs is the single-source-of-truth lockstep partner of `references/file-formats.md ## plans/SYSTEM.md`.
- **`validate-plan.mjs checkSystemAtlasCap`** — ERROR `[atlas-cap]` on >300 lines (prevents silent truncation by writers; the cap forces curation, not truncation), INFO `[atlas-absent]` on missing file (legacy plans created before v2.16.0), silent when file exists and is in-cap.
- **`references/file-formats.md ## plans/SYSTEM.md` section** — canonical schema definition with usage rules: rewrite-not-append, demote-by-staleness, `[CONTRADICTED iter-N]` flag rule for EXPLORE-time atlas contradictions, hard-cap-not-truncate discipline.
- **`ip-archivist.md` Step 5** — full procedure for rewriting plans/SYSTEM.md at CLOSE, including domain-neutrality discipline and the Codebase Specialization section's optional status.
- **`ip-explorer.md` System-Atlas Awareness section** — explorer reads atlas as structural prior, writes system-shape findings using atlas-compatible primitive vocabulary, flags contradictions for archivist correction.
- **`bootstrap.test.mjs`** — new test "SYSTEM.md skeleton has correct schema and is under cap" verifies header, six core domain-neutral sections, optional Codebase Specialization, line count under cap. Test count 121 → 122.

### Changed
- **`SKILL.md`** — Cross-plan context paragraph, Filesystem Structure tree, Mandatory Re-reads table, File Lifecycle Matrix (one new row), EXPLORE rules (read SYSTEM.md at start + `[CONTRADICTED iter-N]` flag rule), CLOSE description (references archivist Step 5), File Ownership Model (one new row) — all updated to wire SYSTEM.md into the existing protocol surface. **Zero existing rules changed; all additions.**
- **`orchestrator.md`** — EXPLORE step 1 and PLAN step 1 read lists now include `plans/SYSTEM.md`.
- **`ip-plan-writer.md`** — mandatory-reads list now includes `plans/SYSTEM.md` with rationale for consulting it during decomposition and assumption-writing.
- **`bootstrap.mjs`** — `cmdNew` console output and `cmdResume` "Consolidated context" listing both mention plans/SYSTEM.md.
- **`README.md` + `CLAUDE.md`** — list `plans/SYSTEM.md` among the cross-plan files.

## [2.15.0] - 2026-05-07

### Added
- **Per-edit changelog ledger** (`{plan-dir}/changelog.md`) — append-only, one pipe-delimited line per file edit recording timestamp, iter/step, commit, path, op + LOC delta, blast-radius tier, optional decision-ref (`D-NNN` or `-`), and one-clause reason. Surfaces "tiny edit, big radius" outliers that plan-level Failure Modes miss. Owned by `ip-executor` (writes), read by `ip-reviewer` at REFLECT (informational only — never blocks CLOSE).
- **`scripts/blast-radius.mjs` deterministic per-file scorer** — six heuristic signals (LOC churn, reverse-dep count, shared-path flag, public-API touch, test-coverage delta, iteration history) → tier `LOW(score)` / `MED(score)` / `HIGH(score)` / `UNKNOWN(reason)`. Pure Node.js 18+, no AST, no LLM, no external deps. Always exits 0; graceful degradation when git is unavailable, file is binary, or file is untracked.
- **`references/blast-radius.md`** — tiers, signal definitions, scoring formula, CLI output spec, known limitations (dynamic dispatch, DI containers, generated code).
- **`references/file-formats.md` `## changelog.md` section** — full format spec (8 fields, regex shapes, op vocabulary, append-only rules, validator WARN behavior).
- **`bootstrap.mjs` writes empty `changelog.md`** with header on plan creation. Test coverage in `bootstrap.test.mjs` asserts the file exists with expected header text.
- **`validate-plan.mjs` `checkChangelogFormat`** — WARN-level checks: 8-field structure, ISO-8601 timestamp, `iter-N/step-M` step, commit-or-`uncommitted`, op shape, radius shape, `D-NNN`-or-`-` decision-ref, non-empty reason. Issues are advisory only; CLOSE is never blocked on changelog format.

### Changed
- **`ip-executor.md`** — new MANDATORY "Per-Edit Changelog" section detailing post-edit append protocol with blast-radius script invocation and graceful fallbacks; on-failure step instructs `REVERT(file)` lines per reverted file.
- **`ip-reviewer.md`** — review checklist item 9: scan changelog for HIGH-radius edits, "tiny edit big radius" outliers, missing decision-refs on HIGH edits, and REVERT line consistency with `decisions.md` failure narrative.
- **`SKILL.md`** — Filesystem Structure tree, File Lifecycle Matrix, EXECUTE rules, Post-Step Gate (now 4 items), REFLECT Phase 1 Gate-In (now seven CORE reads), REFLECT Phase 2 step 8a, File Ownership Model, References list — all updated for changelog.md.
- **`references/code-hygiene.md`** — On Failed Step now requires appending `REVERT(file)` lines to `changelog.md`.

## [2.14.0] - 2026-05-07

### Changed
- **In-code DECISION anchors are now plan-qualified** (`src/references/decision-anchoring.md`, `src/SKILL.md`, `src/scripts/validate-plan.mjs`, agent prompts) — canonical anchor form is `# DECISION <plan-id>/D-NNN` (e.g. `# DECISION plan_2026-05-07_7556fb98/D-003`). The plan-id prefix is the active plan's directory name and makes anchors globally unambiguous and resolvable after `plans/DECISIONS.md` sliding-window trim drops the originating plan section. Closes the L-007 / Theme 4 orphan gap explicitly deferred from v2.13.0. Formal Grammar table extends 5 regex rows with optional plan-id prefix capture matching `plan_\d{4}-\d{2}-\d{2}_[0-9a-f]+`. Bare `D-NNN` anchors remain accepted with WARN [anchor-unqualified] as a migration nudge.
- **summary.md Decision Anchors registry section name reconciled** to `## Decision Anchors Registry` across `decision-anchoring.md`, `file-formats.md`, and `ip-archivist.md` (matches v2.13.0 actual usage in plan_2026-05-07_9560e49b).
- **Anchor-Refs field in decisions.md schema promoted from optional-but-recommended to required-when-matching-anchor-exists-in-source** (`src/references/file-formats.md`) — gated by `state.md` INIT timestamp. Plans with INIT >= 2026-05-07T09:00:00Z get strict ERROR [anchor-refs-missing]; pre-cutover plans keep WARN-only enforcement.

### Added
- **`*Plan: <plan-id>*` preamble line in decisions.md and summary.md** (`src/scripts/bootstrap.mjs` decisions.md template + `src/agents/ip-archivist.md` summary.md instruction) — appears as second line directly after the H1. Lets the per-plan file self-identify after `plans/DECISIONS.md` sliding-window trim drops the wrapping `## <plan-id>` section. Validator: ERROR [preamble-missing] post-cutover, WARN otherwise; ERROR [preamble-mismatch] always when preamble plan-id does not match directory name.
- **Validator anchor subsystem rewritten for plan-qualified IDs** (`src/scripts/validate-plan.mjs`):
  - `findAnchorsInFile` returns `{file, line, planName, id, qualified, stale}` — captures the optional plan-id prefix in all 4 anchor regexes (hash / slash / SQL / block).
  - `collectKnownDecisionIdsByPlan` returns `Map<planName, Set<id>>`. Walks every `plans/<plan-id>/decisions.md` (covers archived plans whose sections have been trimmed from the consolidated file) and parses `plans/DECISIONS.md` section-aware (`## <plan-id>` wrapper attributes nested `### D-NNN` to that plan).
  - New `checkReverseAnchors` routes by anchor qualification: qualified+unknown-plan → ERROR [anchor-unknown-plan]; qualified+orphan-id → ERROR [anchor-orphan]; bare → WARN [anchor-unqualified] always + same orphan logic against active plan; STALE downgrades orphan severity to WARN.
  - New `checkPlanIdPreamble` enforces the `*Plan: <plan-id>*` preamble in decisions.md and summary.md.
  - New `checkAnchorRefsRequired` (replaces `checkAnchorRefsCrossLink`) gates Anchor-Refs enforcement by state.md INIT timestamp.
  - New `checkAnchorRefsValidity` emits WARN [anchor-refs-stale] when a `**Anchor-Refs**` reference points to a missing file or a file containing no matching DECISION anchor for the entry's id.
- **bootstrap.mjs decisions.md template emits the preamble** automatically and references the qualified anchor form `# DECISION <plan-id>/D-NNN` in the schema-example comment so agents see the canonical form on first read.
- **bootstrap.test.mjs +14 tests** — preamble present and ordered before schema example; qualified anchor in schema example; qualified anchor matching active plan resolves silently; bare D-NNN → WARN [anchor-unqualified] (resolution still works); qualified unknown-plan → ERROR; qualified orphan-id → ERROR; STALE qualified orphan → WARN; preamble missing post-cutover → ERROR; preamble missing pre-cutover → WARN; preamble plan-id mismatch → ERROR; Anchor-Refs missing post-cutover → ERROR; Anchor-Refs missing pre-cutover → WARN; Anchor-Refs validity → WARN [anchor-refs-stale]; two-plan disambiguation regression (D-001 in plan A vs plan B do not collide).
- **Agent prompts updated** — `ip-executor.md` Pre-Step Checklist requires plan-qualified anchors and adds explicit Anchor-Refs back-link item with cutover-aware ERROR/WARN note; `ip-archivist.md` audit description rewritten for qualified-aware validator output and Decision Anchors Registry naming.

## [2.13.0] - 2026-05-07

### Changed
- **Spec contradictions resolved across SKILL.md, file-formats.md, decision-anchoring.md, code-hygiene.md, planning-rigor.md, ip-executor.md** — example-only conventions promoted to enforceable rules: `## D-NNN | PHASE | YYYY-MM-DD` decisions.md entry header is now stated as a rule (sequential per plan starting at D-001); canonical Root Cause Analysis format unified to the 4-part block in `planning-rigor.md`; verification.md Additional Checks "Optional" placeholder replaced with three required pre-populated rows (Regression / Scope drift / Diff review); anchor trigger phrasing reconciled to a single canonical phrase ("where any of the 5 trigger conditions in `references/decision-anchoring.md` apply") in SKILL.md and ip-executor.md.

### Added
- **Structured schema fields in file-formats.md** — canonical decisions.md entry-schema table by type (EXPLORE→PLAN, REFLECT→PIVOT, REFLECT-only, scope drift, falsification signal, ghost constraint, 3-strike, simplification check, devil's advocate) with per-type required vs optional fields; optional `**Anchor-Refs**:` field on decisions.md entries for file:line back-links to placed code anchors; `findings/{topic}.md` template with five required sections (Summary / Key Findings / Constraints / Code Patterns / Risks & Unknowns); explicit five required Verdict bullets in verification.md (Criteria passed, Regressions, Scope drift, Simplification blockers, Recommended transition) in fixed order; Evidence format constraint accepting only test-output count, exit-code+excerpt, or `manual review — observed X` (rejects `looks good`, `seems to work`, etc.).
- **Formal anchor grammar in decision-anchoring.md** — regex patterns for hash, slash, block, HTML, and SQL comment styles; extension dispatch matrix (Python/Ruby/Shell/YAML/TOML/R/Perl/Make/Terraform → Hash; JS/TS/Go/Rust/C-family/Java/Swift/Kotlin/Scala/C#/PHP → Slash and Block; CSS → Block; HTML/Markdown/Vue/Svelte → HTML; SQL → Double-dash and Block); multi-line anchor rules (D-NNN on first line; subsequent comment lines extend rationale); optional `[STALE]` marker for revert/expiration handling (must be removed before CLOSE); cross-plan expiration handling via summary.md `## Decision Anchors` registry block at CLOSE for critical-path anchors.
- **Validator gains 7 ERROR checks + 4 WARN checks** (`src/scripts/validate-plan.mjs`):
  - ERROR: decisions.md entry header format `^## D-\d{3} \| .+ \| \d{4}-\d{2}-\d{2}$` with HTML-comment example skipped; D-NNN sequential numbering with no gaps starting at D-001; `**Trade-off**:` line presence in every entry; `**Complexity Assessment**` block in every PIVOT entry; verification.md Verdict 5 required bullets in order; findings.md Index links resolve to existing files under `findings/`; reverse anchor scan walks source by extension allowlist (`.py .js .mjs .cjs .ts .tsx .rb .go .rs .c .h .cpp .hpp .java .kt .sql`), skips `node_modules/`, `.git/`, `dist/`, `build/`, `plans/`, `target/`, `__pycache__/`, and Markdown — orphan anchors fail with file:line; STALE orphans downgraded to WARN per spec.
  - WARN: Evidence column empty/single-word/`looks good`-style; findings/{topic}.md missing required sections; state.md Transition History `EXPLORE → PLAN` line missing `confidence:` sub-line; decisions.md entries with matching code anchor missing `**Anchor-Refs**:` line.
- **Agent prompts strengthened** — `ip-executor.md` Pre-Step Checklist promotes anchor planning to an explicit checklist item with all 5 trigger conditions inlined and Anchor-Refs back-link reminder; `ip-reviewer.md` adversarial review checklist gains anchor-quality and decisions.md-schema items; `ip-archivist.md` CLOSE procedure now runs both forward (decisions → code) and reverse (code → decisions) anchor audits, invokes `validate-plan.mjs` for the reverse scan, and treats remaining `[STALE]` anchors as blockers.
- **bootstrap.mjs templates updated** — `verification.md` ships with three required Additional Checks rows (Regression / Scope drift / Diff review, all PENDING) and a Verdict bullet skeleton matching the 5-bullet rule; `findings.md` ships with a `## Corrections` section skeleton; `decisions.md` ships with a commented schema example block (D-001 stub) so agents see expected format on first write; `state.md` Transition History gains an Exploration Confidence sub-line slot.

## [2.12.2] - 2026-04-14

### Changed
- **Root Cause Analysis section expanded** (`src/references/planning-rigor.md`) — added fourth question "Failed defense" (barrier analysis: which test/assumption check should have caught this and why didn't it), Change Analysis prepend for regressions ("what changed since last passing state?"), explicit "multiple roots are normal" rule to prevent suspiciously clean single-cause chains, stop rule against premature closure, and "no prevention without verification" rule requiring the next REFLECT to confirm proposed defenses actually work.
- **SKILL.md REFLECT step 14** — pointer updated to match the 4-question structure and reference the regression-specific Change Analysis and multi-root guidance.

## [2.12.1] - 2026-04-06

### Added
- **5 new validator checks** — change manifest presence during EXECUTE/REFLECT, iteration limits (5 = decomposition warning, 6+ = hard stop error), progress.md structure validation (Completed/In Progress/Remaining sections), checkpoint existence for iteration 2+, complexity budget population during EXECUTE+.
- **Sub-agent install instructions in README** — added agent installation steps and sub-agent section to "Get Started" guide.

### Fixed
- **README Option 3 (clone) broken install path** — `git clone` directly to `~/.claude/skills/` placed SKILL.md under `src/`, breaking skill discovery. Changed to clone + build + copy workflow.
- **cmdClose newline bug** (`bootstrap.mjs:602`) — transition history append could join the previous line if `state.md` lacked a trailing newline. Now ensures leading newline before appending.
- **cmdClose silent error swallowing** (`bootstrap.mjs:604`) — empty `catch {}` block now logs non-ENOENT errors as warnings instead of silently discarding them.
- **Combined build broken cross-references** — single-file `iterative-planner-combined.md` retained ~40 `references/foo.md` paths that don't resolve in single-file mode. Build now rewrites them to inline anchor text ("the X Reference section below"). Both Makefile and build.ps1 updated.
- **docs/ directory in limbo** — untracked design documents now excluded via `.gitignore`.

## [2.12.0] - 2026-04-06

### Added
- **Sub-agent architecture** — 7 specialized agent definitions in `src/agents/`: orchestrator, ip-explorer, ip-plan-writer, ip-executor, ip-verifier, ip-reviewer, ip-archivist. Optional optimization layer; monolithic skill works without them.
- **Sub-Agent Architecture section in SKILL.md** — agent definitions table, file ownership model, dispatch rules by state, conflict prevention rules.
- **Agent packaging in build scripts** — Makefile and build.ps1 now package `src/agents/*.md` and validate agent frontmatter (name, description, tools).
- **Agent install instructions in CLAUDE.md** — `cp src/agents/*.md ~/.claude/agents/` added to "Updating Local Skill" section.

### Fixed
- **Agent tool permissions mismatch** — orchestrator, ip-explorer, ip-verifier, and ip-reviewer were missing Write tool needed to fulfill their documented file ownership responsibilities. Added Write to all four; removed Write from disallowedTools on explorer, verifier, and reviewer.
- **Validator no-op dash normalization** — `validate-plan.mjs` had `.replace(/-/g, "-")` (ASCII hyphen to ASCII hyphen, a no-op). Changed to `.replace(/[–—‐]/g, "-")` to actually normalize en-dash, em-dash, and Unicode hyphen variants.
- **File Ownership table inaccuracy** — SKILL.md listed Explorer as reader of `plans/FINDINGS.md` and `plans/INDEX.md`, but orchestrator reads these and passes context to explorers via prompts. Corrected readers to Orchestrator.

## [2.11.1] - 2026-03-18

### Fixed
- **Convergence metrics WARN check was a no-op** — `validate-plan.mjs` checked for `## Convergence Metrics` and `Convergence score` strings, but the bootstrap template already contains both. Added placeholder value detection: now warns when the convergence score row still has all-dash values at iteration 2+.
- **`appendToIndex` topic extraction was greedy** — `bootstrap.mjs` matched `[text]` across the entire `findings.md` file, causing `[CORRECTED iter-N]` annotations to leak into INDEX.md topics. Now scoped to `## Index` section only.
- **No build-time validation of validator transitions** — if a transition was added to SKILL.md but not to `validate-plan.mjs` `VALID_TRANSITIONS`, no build step caught it. Added cross-check to both Makefile and build.ps1 `validate` targets.
- **Test count stale in CLAUDE.md and README.md** — both said "99 tests"; actual was 100 (after v2.11.0). Now 102 tests.
- **`convergence-metrics.md` missing from file trees** — CLAUDE.md and README.md project structure listings omitted the file. Added in alphabetical order.

## [2.11.0] - 2026-03-18

### Changed
- **REFLECT state restructured into 3-phase sequence** — replaced unordered bullet list with Gate-In (6 mandatory reads), Evaluate (14 checks), Gate-Out (4 mandatory writes + structured user presentation). 24 numbered steps total. Steps 1-16 are CORE, steps 17-20 are EXTENDED.
- **REFLECT → CLOSE transition strengthened** — now requires no regressions and no simplification blockers in addition to all criteria PASS + user confirmation.
- **Mandatory Re-reads table updated** — REFLECT row aligned with Phase 1 Gate-In: now reads `plan.md` (criteria + verification strategy + assumptions), `progress.md`, `verification.md`, `findings.md`, `checkpoints/*`, `decisions.md`.

### Added
- **Diff review check in REFLECT** (step 8) — review actual code changes for debug artifacts, commented-out code, TODO/FIXME/HACK leftovers, unintended modifications to files not in the plan. Checks code quality; verification checks correctness.
- **Regression check in REFLECT** (step 10) — re-run previously-passing tests. Regressions recorded in Additional Checks and block CLOSE.
- **Scope drift check in REFLECT** (step 11) — compare change manifest (state.md) against Files To Modify (plan.md). Unplanned file changes must be justified in decisions.md or reverted.
- **Root cause analysis in REFLECT** (step 14) — 3-question technique: immediate cause, contributing factor, prevention. Required when REFLECT follows failure, skip when all criteria PASS first attempt. New section in `planning-rigor.md`, format example in `file-formats.md` decisions.md template.
- **Iteration pattern check in REFLECT** (step 19, EXTENDED) — compare across REFLECT cycles on iteration 3+: recurring failures, growing scope, worsening predictions signal structural problems.
- **Required rows in verification.md Additional Checks** — Regression, Scope drift, and Diff review are now required rows every REFLECT cycle. Updated `file-formats.md` documentation and example table.
- **Verdict section expanded** — now includes regressions, scope drift, and simplification blockers fields.

## [2.10.0] - 2026-03-14

### Changed
- **Rename REPLAN state to PIVOT** — the REPLAN state is now called PIVOT across the entire codebase. PIVOT better describes the state's function: diagnosing failure, choosing a new strategic direction, and justifying the change. Updated state machine diagram, transition rules, file lifecycle matrix, per-state rules, git integration, user interaction, all reference files, validator, build scripts, README, and CLAUDE.md. Validator maintains backward compatibility by normalizing old `REPLAN`/`RE-PLAN`/`RE_PLAN` entries in existing plan files to `PIVOT`.

## [2.9.2] - 2026-03-14

### Changed
- **Normalize REPLAN naming** — all variants (`RE-PLAN`, `RE_PLAN`, `Re-plan`, `re-plan`) unified to `REPLAN`/`Replan`/`replan` across all files. Mermaid diagrams, prose, validator, references, and changelog all use the same form. Removed mermaid naming convention notes (no longer needed).

## [2.9.1] - 2026-03-14

### Fixed
- **build.ps1 silent success on unknown commands** — unknown commands now exit with code 1 instead of silently showing help and exiting 0. Cherry-picked from PR #1.

### Added
- **README merge edge case docs** — documented consolidated file merge behavior (heading extraction, boilerplate stripping, link rewriting). Cherry-picked from PR #1.

## [2.9.0] - 2026-03-06

### Fixed
- **stripHeader H1 injection** — `stripHeader()` in bootstrap.mjs could inject a stale H1 heading into consolidated files. Fixed heading removal logic.
- **verification.md template** — corrected the verification.md bootstrap template formatting.
- **INDEX.md pipe escaping** — pipe characters in INDEX.md table entries are now properly escaped to prevent broken markdown tables.
- **Validator numbered findings** — `validate-plan.mjs` now correctly parses numbered findings lists instead of only bullet-style findings.
- **Test counts and README project tree updated** — CLAUDE.md and README.md now reflect accurate test count and project structure.

## [2.8.0] - 2026-03-06

### Fixed
- **extractSection() only captured first line** — regex `([\\s\\S]*?)(?=\\n## |$)` with multiline flag caused `$` to match end-of-line, making lazy quantifier stop after first line. Replaced with indexOf-based approach. This broke the findings count gate (≥3 before PLAN) — `checkFindings()` always reported ≤1 finding regardless of actual count.

### Added
- **Bootstrap transition shortcuts documented** — SKILL.md Transitions section now documents that `bootstrap close` allows any-state→CLOSE (EXPLORE→CLOSE, PLAN→CLOSE, EXECUTE→CLOSE, PIVOT→CLOSE).
- **Mermaid naming convention note** — SKILL.md and README.md added note about `RE_PLAN` vs `RE-PLAN` naming (later removed in v2.9.2 when all variants were normalized to `REPLAN`, then renamed to `PIVOT` in v2.10.0).
- **7 new validator tests** — extractSection multi-line capture, findings count thresholds (0/2/3/5), summary.md at CLOSE, iteration/version mismatch, last-section edge case. 97 tests total (was 90).

## [2.7.2] - 2026-03-06

### Fixed
- **CRITICAL: Validator regex mis-parsed PIVOT transitions** — `validate-plan.mjs` line 122 regex `[→\->]` char class included literal `-`, causing `PIVOT → PLAN` to be split as `RE` + `-` (arrow) + `PLAN` and flagged as invalid. Fixed with `\s+(?:→|->)\s+`.
- **Orphan warning false positive** — `bootstrap.mjs new` warned about "orphaned directories from a previous crash" whenever closed plans existed without an active pointer (normal state after `close`). Now only warns when pointer file exists but points to a non-existent directory.
- **Validator missing summary.md check** — added WARN-level check for `summary.md` existence when plan state is CLOSE.
- **Resume missing verification.md** — `bootstrap.mjs resume` now lists `verification.md` in recovery files output.
- Updated orphan warning test to simulate corrupted pointer (correct scenario) + added test for no false warning after normal close. 90 tests total.

## [2.7.1] - 2026-03-06

### Changed
- **REFLECT → CLOSE requires user confirmation** — agent no longer auto-closes. Must present completed items, remaining work, verification summary, and recommendation, then wait for user to confirm close. Transition rule, REFLECT routing table, and User Interaction table updated.

## [2.7.0] - 2026-03-06

### Added
- **Protocol compliance validator** (`src/scripts/validate-plan.mjs`) — new script that checks state transition validity, mandatory plan.md sections, findings count, cross-file consistency (state/plan/progress/verification), and consolidated files existence. Read-only and advisory. Exit 0 on pass, exit 1 on errors. Warnings are non-blocking. Run during REFLECT or at any time. 12 new tests added (89 total).
- **Plan topic index** (`plans/INDEX.md`) — topic-to-directory mapping file, created on first `new`, updated on each `close`. Survives sliding window trim. Extracted topics come from findings.md index entries. Enables finding old plan data when consolidated files have been trimmed.
- **Lessons snapshot** (`lessons_snapshot.md`) — `close` now copies `plans/LESSONS.md` to `plans/{plan-dir}/lessons_snapshot.md` before removing the pointer. Makes old lesson states recoverable — previously, LESSONS.md rewrites were lossy and irrecoverable.
- **Protocol tiering** — checks marked *(EXTENDED)* in SKILL.md per-state rules may be skipped for iteration 1 single-pass plans. EXTENDED checks: prediction accuracy, devil's advocate, adversarial subagent review, ghost constraint scan. All other checks are CORE (always enforced).
- **Build validation expanded** — Makefile and build.ps1 now validate INDEX.md reference in bootstrap.mjs and validate-plan.mjs syntax.

### Changed
- **SKILL.md Filesystem Structure** updated with `INDEX.md` and `lessons_snapshot.md`.
- **SKILL.md Recovery** expanded with step 10 for INDEX.md.
- **SKILL.md Bootstrapping** expanded with validate-plan.mjs command.
- **SKILL.md EXPLORE** now includes INDEX.md in cross-plan context reads.
- **file-formats.md** now documents INDEX.md template and lessons_snapshot.md.
- **CLAUDE.md** updated: validation checklist expanded, tree includes validate-plan.mjs, test count updated to 89.

## [2.6.0] - 2026-03-06

### Added
- **Criteria adequacy check in REFLECT** — before running verification, ask: do these criteria test what matters, or what was easy to test? Notes gaps in `verification.md` Not Verified section.
- **Not-verified list in REFLECT** — mandatory "Not Verified" section in `verification.md`: what wasn't tested and why (no coverage, out of scope, untestable). Forces honesty about coverage gaps. Template and explanatory note added to `file-formats.md`.
- **Devil's advocate in REFLECT** — before routing to CLOSE, name one reason this might still be wrong despite passing verification. Recorded in `decisions.md`. Combats confirmation bias and sunk cost.
- **Adversarial subagent review in REFLECT** — for iteration ≥ 2, optional Task subagent reviews `verification.md`, `plan.md` criteria, and `decisions.md` for adequacy and blind spots. Main agent must address concerns before CLOSE. Adds genuine independence from anchoring bias on multi-iteration plans.
- **Phase Balance Heuristic expanded** — REFLECT warning in `planning-rigor.md` now requires justification in `decisions.md` when routing CLOSE after <5% REFLECT effort.

## [2.5.0] - 2026-03-05

### Added
- **Planning rigor reference** (`src/references/planning-rigor.md`) — new reference file with 7 techniques: assumption tracking, pre-mortem & falsification signals, exploration confidence, prediction accuracy, ghost constraint hunting, phase balance heuristic, decomposition at iteration limit.
- **Assumptions in plan.md** — mandatory bullet list: what you assume, which finding grounds it, which steps depend on it. On surprise discovery during EXECUTE, check assumptions first to identify invalidated steps. Template added to bootstrap and file-formats.
- **Pre-Mortem & Falsification Signals in plan.md** — mandatory section combining "assume the plan failed, why?" with concrete STOP IF triggers checked during EXECUTE. Covers approach validity (distinct from Failure Modes which cover dependencies). Template added to bootstrap and file-formats.
- **Exploration Confidence gate** — quality check before EXPLORE → PLAN transition: problem scope, solution space, risk visibility must each be at least "adequate." Recorded in state.md transition log, not as a separate file section.
- **Prediction Accuracy in verification.md** — during REFLECT, compare plan.md predictions (step count, file count, line delta) against actuals. Builds calibration data for LESSONS.md. Template added to bootstrap and file-formats.
- **Ghost constraint scan in PIVOT** — before designing a new approach, actively check if the constraint that led to the failed approach is still valid. 3-question checklist in SKILL.md, detailed guidance in planning-rigor.md.
- **Decomposition analysis at iteration 5** — mandatory analysis in decisions.md identifying 2-3 independent sub-goals before the iteration 6 hard stop. Gives users actionable next steps.
- **Step risk/dependency annotations** — `[RISK: low/medium/high]` and `[deps: N,M]` recommended on each plan step. Enforces risk-first ordering and reveals parallelization opportunities.
- **Phase balance heuristic** — rough effort distribution guideline (EXPLORE 20-30%, EXECUTE 40-50%, etc.) with warning signs for imbalance.

### Changed
- **"Risks" section removed from plan.md** — subsumed by Failure Modes (dependencies) and Pre-Mortem (approach validity). No unique purpose remaining. Removed from bootstrap template, file-formats template, and test assertions.

## [2.4.0] - 2026-03-05

### Added
- **Constraint classification in EXPLORE** — guidance to classify findings as hard constraints (non-negotiable), soft constraints (negotiable preferences), or ghost constraints (past constraints that no longer apply). Sourced from Hohpe's constraint identification framework, generalized for any domain.
- **Problem decomposition in PLAN** — 5-point process for breaking goals into steps: understand the whole first, identify natural boundaries, minimize dependencies, start with riskiest part, split/merge criteria.
- **Essential vs accidental complexity in Simplification Checks** — new check #3: "Is this inherent in the problem, or did we create it?" Adds analytical depth to REFLECT. Simplification Checks now 6 (was 5). Sourced from Brooks' essential/accidental complexity model.

## [2.3.0] - 2026-03-03

### Added
- **Sliding window for consolidated files** — bootstrap auto-trims `plans/FINDINGS.md` and `plans/DECISIONS.md` to the 8 most recent plan sections on each close. Keeps files naturally bounded at ~300-450 lines. Old plan data remains in per-plan directories. Compression rarely triggers. 3 new tests added.

### Fixed
- **Consolidated merge corrupted files after compression** — `prependToConsolidated()` inserted new plan content inside `<!-- COMPRESSED-SUMMARY -->` markers when a compressed summary existed, because `indexOf("\n## ")` found `## Summary (compressed)` before `## plan_*`. Now skips past the closing marker before finding the insertion point.
- **`stripCrossPlanNote` regex mismatch** — regex matched old format (`...and plans/DECISIONS.md`) but not current format (`...plans/DECISIONS.md, and plans/LESSONS.md`). Updated to wildcard match `[^*]*` after `plans/FINDINGS.md`.
- **No deduplication guard on close** — closing the same plan twice produced duplicate sections. Added existence check in `prependToConsolidated()`.
- **Blank line accumulation in consolidated files** — each prepend cycle added an extra blank line to the header area. Fixed by trimming header whitespace before insertion.

## [2.2.0] - 2026-03-02

### Added
- **Cross-plan institutional memory (`plans/LESSONS.md`)** — new consolidated file for capturing user corrections, recurring mistakes, and workflow preferences across plans. Bootstrap creates it on first `new`. Referenced in SKILL.md at 5 protocol points: EXPLORE (read at start), PLAN gate check, PIVOT (review before pivot), CLOSE (merge lessons learned), and Recovery. 9 new tests added (73 total).

### Fixed
- **README badge updated** — was `v2.1.2`, now matches VERSION.
- **Test count corrected** — CLAUDE.md and README.md said "64 tests"; actual is 73.
- **build.ps1 header comment completed** — listed 7 of 11 commands; now lists all 11.
- **Test file excluded from packages** — `*.mjs` glob in Makefile and build.ps1 was including `bootstrap.test.mjs` (~58KB) in distribution packages. Now explicitly copies only `bootstrap.mjs`.
- **LESSONS.md added to build validation** — Makefile and build.ps1 now check that `bootstrap.mjs` references `LESSONS.md`, matching existing checks for `FINDINGS.md` and `DECISIONS.md`.

## [2.1.4] - 2026-02-24

### Fixed
- **Read-before-write coverage completed** — v2.1.3 missed `plan.md` and other files on first write after bootstrap. Now: (1) bootstrap section requires reading all 6 plan files before starting EXPLORE, (2) PLAN gate check expanded to include `state.md`, `plan.md`, `progress.md`, `verification.md` alongside existing findings/decisions reads, (3) EXPLORE reads `state.md` at start. Covers every bootstrap-created file.

## [2.1.3] - 2026-02-24

### Fixed
- **Read-before-write rule added** — Claude Code's Write tool rejects writes to files not yet read in the current session. Added explicit "read-before-write" rule to File Lifecycle Matrix, EXPLORE (`findings.md`), PLAN (`verification.md`, `state.md`, `progress.md`), and REFLECT (`verification.md`). Prevents "failed to write file" errors on first update after bootstrap.
- **Mandatory re-reads expanded** — added `verification.md` to the "Before any REFLECT" row in the Mandatory Re-reads table.

## [2.1.2] - 2026-02-24

### Fixed
- **`.gitignore` cleaned** — removed ~200 lines of Python boilerplate from a non-Python project. Only project-relevant entries remain (build/, dist/, .claude/, plans/, nul).
- **SKILL.md `close` description corrected** — previously said "removes pointer only"; now accurately describes the full behavior (merge findings/decisions to consolidated files, update state.md, remove pointer).
- **Revert-First step count aligned** — `complexity-control.md` had 6 steps while SKILL.md had 5. Harmonized to 5.
- **SKILL.md duplication trimmed** — PIVOT keep-vs-revert decision tree and irreversible operations procedure now summarize and point to `references/code-hygiene.md` instead of duplicating full content.
- **Iteration 5 / Nuclear Option consolidated** — removed duplicate from "Iteration Limits" section; single definition in "Complexity Control" section.
- **`build.ps1` default command** — changed from `help` to `package` to match Makefile behavior.
- **`build.ps1` combined build ordering** — added `Sort-Object Name` for deterministic reference file ordering (Makefile already sorted).
- **Redundant tests removed** — removed 2 tests that were strict subsets of other tests; added `## Verification Strategy` to `requiredSections` validation array; removed unused `before` import. Test count: 66 → 64.

### Added
- **`bootstrap.test.mjs` in project trees** — README.md and CLAUDE.md now include the test file in their project structure listings.

## [2.1.1] - 2026-02-19

### Changed
- **Quick Start reordered** — Option 1 is now zip package install to `~/.claude/skills/` (recommended). Single-file moved to Option 2.
- **README badge** bumped to v2.1.0.

## [2.1.0] - 2026-02-19

### Added
- **Verification feedback loop** — new `verification.md` per-plan artifact for recording objective verification results during REFLECT. Ensures REFLECT and CLOSE transitions are grounded in evidence (test results, lint output, behavioral diffs, smoke tests) rather than subjective assessment.
- **Verification Strategy in PLAN** — mandatory section in `plan.md` mapping each success criterion to a test/check method and expected result. Plans with no testable criteria must write "N/A — manual review only" (proves you checked). Documented in SKILL.md PLAN rules and file-formats.md template.
- **REFLECT verification gate** — REFLECT rules now require running each check from the Verification Strategy and recording results in `verification.md` (criterion, method, command, result PASS/FAIL, evidence). REFLECT → CLOSE transition strengthened from "All success criteria met" to "All criteria verified PASS in `verification.md`".
- **File Lifecycle Matrix expanded** — added `verification.md` row: W in PLAN (initial template), W in EXECUTE (per-step results), W in REFLECT (full verification pass), R in PIVOT and CLOSE.
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
- **File Lifecycle Matrix expanded** — added `plans/FINDINGS.md` and `plans/DECISIONS.md` rows: R in EXPLORE/PLAN/PIVOT, W(merge) in CLOSE.
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
- **RE_PLAN/RE-PLAN validation regex tightened** — `RE.PLAN` (matches anything) → `RE[-_]PLAN` (matches only hyphen or underscore). Later normalized to `REPLAN` in v2.9.2, then renamed to `PIVOT` in v2.10.0.
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
- **PIVOT keep-vs-revert decision criteria** — keep when steps are valid under new approach + tests pass; revert when fundamentally different approach or commits would conflict; default when unsure = revert to latest checkpoint
- **REFLECT reads checkpoints** — notes available restore points in `decisions.md` when transitioning to PIVOT
- **Autonomy leash includes checkpoints** — on leash hit: revert uncommitted first, present available checkpoints to user
- **3-strike rule specifies rollback** — revert to checkpoint covering the struck area
- **Nuclear option allows later checkpoint** — default is `cp-000` but user may choose a later checkpoint if partial progress is worth keeping
- **Recovery protocol includes checkpoints** — `checkpoints/*` now listed as step 7 (rollback points and git hashes)
- **Git integration PIVOT line expanded** — clarifies keep/revert logic and requires logging choice in `decisions.md`
- **code-hygiene.md PIVOT section** — added decision criteria, "read checkpoints first", default-to-revert guidance
- **complexity-control.md** — 3-strike adds checkpoint rollback step; nuclear option clarifies checkpoint selection
- **file-formats.md checkpoint template** — updated naming, clarified git state semantics, added parenthetical examples for risky change triggers

## [1.4.0] - 2026-02-17

### Changed
- **findings.md lifecycle expanded** — File Lifecycle Matrix updated: REFLECT gains R (read to check contradictions), PIVOT gains R+W (can now correct wrong findings)
- **EXPLORE subagent coordination** — main agent owns `findings.md` index; subagents write only to `findings/`. Correction format: `[CORRECTED iter-N]`
- **PLAN gate check enforced** — "read first" → explicit gate: "If not read → read now. No exceptions."
- **EXECUTE surprise discovery rule** — unexpected findings noted in `state.md`, step finishes or reverts, then transitions to REFLECT. No silent findings updates during EXECUTE.
- **REFLECT reads findings** — explicitly reads `findings.md` + `findings/*` to detect contradictions from EXECUTE. EXPLORE transition now triggers on contradicted findings.
- **PIVOT can correct findings** — if earlier findings proved wrong, update with `[CORRECTED iter-N]` + reason. Append-only (don't delete original text).
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
  - PIVOT: Evidence-based pivoting with decision logging
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
