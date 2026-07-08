# Changelog

All notable changes to the Iterative Planner project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.32.0] - 2026-07-09

Closes a blind spot in which the anchor system could not see part of its own domain (`plans/plan_2026-07-08_32b9cfcf/`). Two orphan `DECISION` anchors sat in `src/agents/ip-orchestrator.md` citing deleted plan directories with no `[STALE]` marker — invisible to `validate-plan.mjs` and un-stampable by `bootstrap.mjs retire`, because `.md` was outside `ANCHOR_SOURCE_EXTS`. The HTML/Markdown row had been in the grammar table all along, simply unimplemented. This release retires the orphans, implements that row (HTML-comment opener form only), and tidies the pre-existing `[STALE]` anchors. Note the scanner change is **preventive**, not protective: after this release the repo contains zero anchors, so its value is guarding future anchors, not any live one.

### Fixed
- Two orphan anchors in `src/agents/ip-orchestrator.md` (cited `plan_2026-05-15_9ae230f7/D-007` and `plan_2026-05-15_71ab18dd/D-004`, both deleted directories), plus two dead `decisions.md` prose pointers in the same file. Rationale preserved verbatim as `NOTE` text.
- Two more dead pointers in `validate-plan.mjs` `NOTE:` comments that had begun resolving to **the wrong entries** (a live plan's real `D-002` / `D-004`) rather than merely dangling. Reworded to state the contract inline.
- `README.md`'s test-verification line claimed 273 tests (actual 299) and omitted `shared.test.mjs` from its command — a drift no gate covered.
- `src/references/decision-anchoring.md` § Formal Grammar: the Block-comment row misdescribed the scanner. Its inner match carries no `/*` marker; the anchor may appear anywhere inside the block, not adjacent to the opener. Corrected, and the sentence above the table qualified accordingly. The HTML / Markdown row was likewise rewritten to the two-stage form it now shares with the block scan.
- The `.md`/HTML anchor scan now finds **every** anchor in a multi-anchor comment, not only the first. The single-pass HTML matcher stopped at the first `DECISION … D-NNN` in a `<!-- … -->` span; it now mirrors the block-comment scan's marker-less inner `/g` loop and reports them all. The repo holds no live HTML anchors, so this hardens a preventive path nothing currently exercises rather than fixing a live breakage.
- `validate-plan.mjs` and `bootstrap.mjs retire` now agree on the close-required HTML grammar: an anchor must live inside a **closed** `<!-- … -->` span. `retire` no longer stamps `[STALE]` into an unclosed comment the validator cannot see — restoring, for the `.md` path, the invariant that `retire` stamps exactly the anchors the validator scans.

### Added
- `.md` in `ANCHOR_SOURCE_EXTS` for both `validate-plan.mjs` and `bootstrap.mjs`. In Markdown, **only** the `<!-- DECISION … -->` opener form is recognized — fenced `#`/`//` examples remain prose.
- `HTML_STYLE_EXTS`. The previously-unconditional `/* … */` block-comment scan is now **gated off** for HTML-style extensions, so Markdown block-comment delimiters in prose are not misread as anchors.
- `cmdRetire` gains an HTML-scoped `.md` matcher, restoring the `bootstrap.mjs` invariant that `retire` stamps exactly the anchors the validator scans. The `.tmp` + `renameSync` atomicity is preserved.
- 7 CLI-level tests (295 → 302), including a **negative fixture that scans the real `decision-anchoring.md`, `file-formats.md`, and `state-execute.md`** and asserts zero anchor findings — a live regression guard on future doc edits — plus multi-anchor and unclosed-comment fixtures asserting that `validate-plan.mjs` and `bootstrap.mjs retire` agree.
- A documented rule: anchor examples, in Markdown **or** in source comments, must use placeholder ids. A bare `D-` plus three digits inside any scanned comment becomes a real anchor. Discovered the hard way — `CHANGELOG.md:331`, a release note quoting an illustrative block comment that holds two bare three-digit decision ids, turned into a blocking `ERROR [anchor-orphan]` the instant `.md` entered scope, before the HTML-extension gate landed.

### Changed
- 13 `[STALE]` anchors in `src/scripts/*.mjs` converted to plain `// NOTE:` comments. Every rationale body is preserved byte-for-byte; only the dead `DECISION <plan-id>/D-NNN [STALE]` token was removed. Validator warnings dropped 24 → 11.

## [2.31.0] - 2026-06-27

Implements the F18 "3-stage agent memory" audit finding (`plans/plan_2026-06-27_c881d945/`) as two high-value, filesystem-backed memory-system upgrades: importance scoring on `plans/LESSONS.md` and an automatic synthesis-at-CLOSE template. Deeper machinery like vector search was deliberately left out of scope as over-engineering for a filesystem-backed design. Test suite stays at 295 (the new template slug is auto-covered by the existing emit-template loop tests; no new `test()` blocks).

### Added
- Importance scoring on `plans/LESSONS.md`: optional `[I:N]` tag (1-5; omitted = 3). The CLOSE archivist now trims the 200-line cap by importance-then-recency and never drops `[I:5]` lessons (was demote-by-staleness, which actually applied to SYSTEM.md).
- New `lessons-synthesis` emit-template slug (16 → 17 templates): a structured CLOSE-time reflection guide (Recurring Patterns / Failed Approaches / Successful Strategies / Codebase Gotchas, each `[I:N]`-tagged) the archivist uses to promote recurring per-plan findings/decisions into LESSONS.md.

### Fixed
- Corrected SKILL.md File Lifecycle/CLOSE wording that conflated LESSONS.md trimming with SYSTEM.md's demote-by-staleness rule.

## [2.30.0] - 2026-06-27

Fixes the confirmed-real defects from a re-verified audit of the repo source (`plans/plan_2026-06-27_e830e67d/`): two dead imports, an inverted `--help` string, a path-normalization bug, stale docs/tree, a missing `.gitignore` entry, missing build/release gates, and an untested `shared.mjs`. Test suite grows 273 → 295; 8 test files. The audit's import-linter recommendation was deliberately dropped as infeasible — the repo is dependency-free (no `package.json`, all-builtin imports), so a manual fix plus a documenting `lint:` comment is the proportionate remedy.

### Fixed
- **Dead imports removed.** `blast-radius.mjs` dropped unused `dirname, sep`; `validate-plan.mjs` dropped unused `statSync` (no call sites).
- **`--help` iteration-cap text corrected.** The help string said `Iteration < 6` while the enforcing code uses `iter >= 6`; the string now reads `>= 6`.
- **`validate-plan.mjs` path normalization.** A `plans/plan_XXX`-form CLI argument no longer produces a false `preamble-mismatch`: the logical plan-id used for identity comparison is now `basename()`-normalized while the filesystem path is preserved intact. Added a regression test.

### Added
- **`src/scripts/shared.test.mjs`** — `node:test` coverage of `shared.mjs`'s exports (`extractField`, `splitChangelogFields`, `blankCompressedSummaryBlock`, and the `COMPRESSED_SUMMARY_OPEN`/`COMPRESSED_SUMMARY_CLOSE`/`CHANGELOG_COMPRESSED_INLINE_RE` markers); 21 tests, total 273 → 295.
- **Build/release gates.** `package`, `package-tar`, and `package-combined` now run `validate` first (Makefile prerequisite + `Invoke-Validate` in build.ps1). Added an opt-in `sync-skill` target/function mirroring the CLAUDE.md "Updating Local Skill" copy sequence (not run automatically). A `lint:` comment documents that unused-import detection is intentionally not automated (dependency-free repo).

### Docs
- README combined-build note now discloses that `src/agents/*.md` (not just `bootstrap.mjs`) are absent from the single-file build; matching disclosure added to the generated combined-build footer.
- `.gitignore` now ignores `.idea/`.
- CLAUDE.md Repository Structure tree lists `check-readme-parity.{mjs,test.mjs}`; SKILL.md validator-sections parenthetical names the real plan section "Steps" (was "decomposition").
- README test-count badge, version badge, and per-file breakdown reconciled to the measured suite (295: bootstrap 176, validate-plan 45, blast-radius 23, check-doc-parity 4, emit-state 12, emit-template 10, check-readme-parity 4, shared 21).

## [2.29.0] - 2026-06-11

### Added
- `src/references/python-software.md` — a new conditional reference: the Python / software-engineering domain caveat (~479 lines, 3 sections: A. universal software-design mental models not already in the protocol, B. condensed Python architecture patterns, C. Python style + a 20-item anti-pattern checklist). It cross-references (does not restate) the concepts the planner already owns: Kleppmann "X at the cost of Y", Brooks essential/accidental complexity + rule-of-three + Forbidden Fix Patterns (`complexity-control.md`), and Hohpe hard/soft/ghost constraints (`planning-rigor.md`).
- Domain-gated pointers to the new caveat from `src/SKILL.md` `## References`, the `state-plan` and `state-reflect` rule modules, and the `ip-plan-writer` and `ip-reviewer` agents. Every pointer is phrased "For Python/software-engineering tasks, ..." so the domain-neutral default path is unchanged for non-software plans.
- `Makefile` and `build.ps1` combined-build rewrite maps now normalize the `python-software.md` backtick link.

## [2.28.0] - 2026-06-11

### Added
- `src/SKILL.md` YAML frontmatter now includes `version:`, `released:`, and `commit:` placeholder keys; `make build` / `build.ps1 build` substitutes live values (version, UTC date, short git hash) into the built artifact via `sed -i` / PowerShell `-replace`. Source file retains placeholders.

### Fixed
- `bootstrap.mjs` `cmdResetAttempts` and `cmdCloseInner`: rewrites of `state.md` are now atomic (`.tmp` + `renameSync`), matching the convention used by all other source-mutating paths.

### Docs
- README "Running tests" code block and validation checklist now include `check-readme-parity.test.mjs` and show correct test count (273).
- README project structure tree now lists `check-readme-parity.mjs` and `check-readme-parity.test.mjs`.
- CLAUDE.md validation checklist now includes a bullet for `check-readme-parity.mjs`.

## [2.27.0] - 2026-06-11

Second-generation deep-dive review fixes (`plans/plan_2026-06-11_8e311f61/`): three latent correctness bugs in `bootstrap.mjs`, two protocol-consistency gaps (orchestrator EXPLORE dispatch, File Lifecycle Matrix), four test-coverage additions (check-doc-parity reverse direction, blast-radius hist signal, validate-plan "at the cost of" check + test), two documentation cleanups, and a new executable parity gate for README version/test-count drift. Test suite grows 266 → 273; 7 test files.

### Fixed
- **`mergeToConsolidated` no longer orphans compression close-marker (#1).** When a per-plan `decisions.md` had been compressed (`maybeCompressDecisions` fired), `stripHeader` sliced from `## Summary (compressed)` inside the block, leaving `<!-- /COMPRESSED-SUMMARY -->` without its open marker in `plans/DECISIONS.md`. The `blankCompressedSummaryBlock` helper (already in `shared.mjs`) is now applied before `stripHeader`, ensuring both markers are stripped together.
- **`--force` error-recovery pointer restore is now atomic (#2).** The catch block in `cmdNewInner` was restoring `.current_plan` with a bare `writeFileSync`; replaced with the `.tmp`+`renameSync` idiom used everywhere else in `bootstrap.mjs`.
- **`cmdResetAttempts` section-boundary no longer clips on inner `## ` headings (#3).** Changed `state.indexOf("\n## ", bodyStart)` to a regex search for `\n## [^#]`, preventing an agent-written `## `-prefixed sub-line inside the Fix Attempts body from clipping the section early and leaving stale attempt records.
- **`checkDecisionsSchema` now validates "at the cost of" phrasing.** The `**Trade-off**:` field was only checked for presence; added a `WARN [decisions-schema]` when the phrase "at the cost of" is absent from the field value.
- **`ip-orchestrator.md` EXPLORE dispatch now reads `plans/DECISIONS.md` (#7).** Step 1 of the EXPLORE dispatch was missing `plans/DECISIONS.md (limit: 600)` — present in `state-explore.md` and the File Lifecycle Matrix but not in the orchestrator dispatch, so sub-agent mode silently skipped cross-plan decisions context.
- **File Lifecycle Matrix `plans/FINDINGS.md` PLAN annotation corrected (#8).** Changed `R(600)` to `R?` to align with the Mandatory Re-reads PLAN row and actual orchestrator/plan-writer behaviour (on-demand, not mandatory).

### Added
- **`check-readme-parity.mjs` — README version/test-count parity gate (#11).** Exports `checkVersionBadge` and `checkTestCount`; CLI reads `VERSION` and `TEST_COUNT` and asserts the README badges match. Wired into `make validate` and both harnesses (Makefile + build.ps1). Closes the GHOST candidate logged in LESSONS.md.
- **`TEST_COUNT` file.** Single-integer authoritative test count; replaces the manual README badge annotation. Must be bumped alongside `TEST_COUNT` when tests are added.

### Tests
- `check-doc-parity.test.mjs`: added reverse-direction test (README row absent from SKILL.md); extended `comparison()` to return `{ missing, extra }` and report extras as failures.
- `blast-radius.test.mjs`: added explicit `hist` signal test with a plan manifest fixture (`hist.score === 1, prior === true`).
- `validate-plan.test.mjs`: added negative test for `checkDecisionsSchema` "at the cost of" requirement.
- `check-readme-parity.test.mjs`: 4 tests (real-repo exit 0, wrong-version unit, wrong-count unit, CLI exit 1 on mismatch).

### Docs
- `README.md`: removed misleading `(266 tests total across 6 files)` annotation from `blast-radius.test.mjs` tree line (#9).
- `CLAUDE.md`: removed ghost-constraint parenthetical `(round-trip fidelity vs the SKILL.md "Per-State Rules" bodies before extraction)` from the `emit-state` checklist item (#13).

## [2.26.0] - 2026-06-11

Fixes the actionable findings from a comprehensive deep-dive review of the codebase (`plans/plan_2026-06-11_4ecd09f7/`): four latent code bugs, one protocol-drift omission, the highest-value test-coverage gaps, and stale documentation. All edits are surgical and pattern-mirroring — no new scripts, test files, or abstractions. Test suite grows 255 → 266; all green.

### Fixed
- **`validate-plan.mjs` is now import-safe (#1).** The CLI dispatch block (arg parsing, `--help`/`--pre-step` handlers, and all `process.exit` calls) was running at module scope, so any `import` of the module fired the CLI logic and could kill the host process. Wrapped it in the `isEntryPoint` IIFE guard already used by `bootstrap.mjs`/`emit-state.mjs`/`emit-template.mjs`. CLI exit-code contract (0/1/2, `--pre-step`, `--help`) is byte-unchanged. Anchored `# DECISION .../D-002` at the guard.
- **`checkVerificationVerdict` order-check no longer swallowed (#5).** An `else if (orderBroken)` meant a Verdict section with both missing bullets AND wrong ordering reported only the "missing" error; the order violation is now an independent `if` so both report.
- **`checkStateTransitions` no longer false-ERRORs on `STATE → PLAN(ts)` (#6).** The destination capture `\S+` swallowed trailing punctuation; tightened to a state-token capture (`[A-Za-z_]+`). The canonical spaced `STATE → STATE (reason)` form still validates.
- **`cmdRetire` writes source files atomically (#4).** Replaced a bare `writeFileSync` on source paths with the `.tmp`+`renameSync` idiom used everywhere else in `bootstrap.mjs`, so a kill mid-write cannot corrupt source.
- **`parseChangelogFile` compression-detection window widened (#10).** The metadata-block scan stopped at a fixed `header+8` line budget, missing a block pushed to line 13+ and triggering a redundant re-compression pass. Now scans to the first changelog entry / `## ` heading (the real structural boundary), preserving idempotency.
- **`state-pivot.md` PIVOT module gains the `reset-attempts` step (#2).** The operative module body that monolithic mode follows was missing the `bootstrap.mjs reset-attempts` step that `ip-orchestrator.md` PIVOT dispatch already had; without it the leash counter carried across a pivot and HARD-failed the pre-step gate (`leash-cap`) on the first post-pivot step.
- **`check-doc-parity.mjs` `isEntryPoint` aligned to the IIFE try/catch pattern (#11)** used by the other four CLI scripts (cosmetic uniformity; behavior unchanged).

### Added
- **blast-radius tier-boundary + signal tests (#9).** `blast-radius.test.mjs` gains 8 cases covering the tier mapping at its exact boundaries (score 2→LOW, 3→MED, 5→MED, 6→HIGH) and non-zero `deps`/`tests` signal contributions via `--json` — previously the scorer's tier thresholds had no test, so a regression could silently feed a wrong tier to the executor.
- **Error-path tests (#12).** `reset-attempts` with no `## Fix Attempts` section (exit 1), `retire` with no plan-id (exit 1), and validator iteration=5 emitting a WARN (not ERROR) `[iteration]`.

### Changed
- **Documentation sync (#3, #7).** `README.md` badges → v2.26.0 / 266 tests; Contributing command, checklist, and Project Structure tree now list all 6 test files and the previously-omitted scripts (`check-doc-parity`, `emit-template`, `shared`). `CLAUDE.md`'s "987-line file-formats.md" phrase made count-agnostic so it does not re-stale as the file grows. (Review finding #8 — a stale `orchestrator.md` name in the gitignored `plans/SYSTEM.md` atlas — is reconciled by the CLOSE archivist rewrite, not a source edit.)

## [2.25.0] - 2026-06-11

Renames `src/agents/orchestrator.md` → `src/agents/ip-orchestrator.md` so the orchestrator definition follows the same `ip-*` filename convention as the other six sub-agents (`ip-explorer`, `ip-plan-writer`, `ip-executor`, `ip-verifier`, `ip-reviewer`, `ip-archivist`). Purely an organizational/file-layout change: the agent's frontmatter `name:` stays `iterative-planner-orchestrator` (agents register by `name:`, not filename), so `claude --agent iterative-planner-orchestrator` and the SKILL.md "Orchestrator Role Assumption" identity are unchanged. Build scripts bundle `src/agents/*.md` by glob, so packaging picks up the new filename automatically with no Makefile/build.ps1 edits.

### Changed
- **File rename** `src/agents/orchestrator.md` → `src/agents/ip-orchestrator.md` (via `git mv`; content byte-unchanged — no self-referential paths inside the file).
- **Path-reference propagation.** Updated every `agents/orchestrator.md` / `orchestrator.md` file-path reference to `ip-orchestrator.md` across `src/SKILL.md` (9), `src/references/file-formats.md` (3), `src/scripts/modules/state-plan.md` (1), `CLAUDE.md` (3, incl. Repository Structure tree + validation checklist), and `README.md` (2, incl. tree). Tree-diagram comment alignment preserved.
- **Untouched (intentionally):** prior CHANGELOG entries retain the historical `orchestrator.md` filename (rewriting them would falsify release history); `.mjs` scripts and the other `ip-*.md` agents reference "orchestrator" only as a role word, not the file path; `Makefile` / `build.ps1` use the `src/agents/*.md` glob.

## [2.24.0] - 2026-06-11

Adds a second script-emission router, `emit-template.mjs`, extending the "script provides the instructions" pattern to the plan-file templates. Chosen after an explicit net-positive audit (`plans/plan_2026-06-11_5f128570/`) that rejected five other candidate surfaces as pattern-for-its-own-sake; this one clears the bar because `references/file-formats.md` is genuinely large (987 lines) and only one ~20-50 line template is needed per fetch. Unlike the per-state migration, this router is a **slicer over the canonical file** — it does NOT extract content into modules, so file-formats.md remains the single source of truth and no build-combined re-inline is needed. The change is purely additive with a graceful fallback: every rewired pointer keeps its file-formats.md reference, so if the router fails or a pointer is missed, agents read the file exactly as before (no hard failure mode).

### Added
- **`src/scripts/emit-template.mjs` per-template router.** `--name <slug>` emits one template, byte-faithfully sliced from `references/file-formats.md` between `<!-- TEMPLATE:<slug> -->` boundary markers (16 slugs: state, plan, decisions, findings, progress, verification, checkpoints, findings-consolidated, decisions-consolidated, lessons, system, index, lessons-snapshot, changelog, summary, presentation-contracts). Buffer-level slicing preserves multibyte content exactly. Exports `VALID_TEMPLATES` and a pure `resolveTemplate(slug, fileFormatsUrl?)` DI tagged-result seam, mirroring emit-state's `resolveModuleBody`. Exit-code contract matches emit-state v2.23.1: missing/absent `--name` → 2 (USAGE); unknown slug / unreadable file / missing marker / empty slice → 1 (diagnostic); valid → 0.
- **`src/scripts/emit-template.test.mjs`.** node:test suite: 16-slug registry, marker completeness, per-slug sentinels, CLI byte-fidelity against the marker-delimited file region, exit-code contract, and `resolveTemplate` failure paths via injected temp fixtures. Registered in lint + test of BOTH Makefile and build.ps1.
- **16 `<!-- TEMPLATE:<slug> -->` boundary markers + 1 `<!-- TEMPLATE:END -->` terminator in `references/file-formats.md`** (HTML comments, invisible in rendered Markdown; template text byte-unchanged).

### Changed
- **Additive emit-template pointers at 7 template-fetch sites** (state-plan/reflect/execute modules; ip-plan-writer/executor/archivist/explorer agents): each now points to `emit-template --name <slug>` for a single template AND keeps its `references/file-formats.md` reference as the canonical fallback. Presentation-Contracts and intra-plan-compression pointers untouched.
- **`CLAUDE.md`** Repository Structure tree + validation checklist document the new router.

## [2.23.1] - 2026-06-11

Patch hardening of the script-emission layer's error paths, found in a post-refactor audit of the v2.23.0 migration (`plans/plan_2026-06-11_26c6bdc6/`). No behavior change on the happy path — all five states still emit byte-identically; only failure modes and one fallback-mode doc clause changed. The audit otherwise confirmed the migration correct and complete (byte-faithful modules, all pointers resolve, build/validate green).

### Changed
- **`emit-state.mjs` CLI exit-code split (F6a).** A missing/absent `--state` flag is now a usage error → exit `2` (POSIX convention, USAGE on stderr); an unknown-but-provided state value (including `close`) stays a value error → exit `1`. Previously both exited `1`, distinguishable only by message text.
- **`emit-state.mjs` fail-loud module reads (F6b).** New exported pure helper `resolveModuleBody(state, modulesBaseUrl)` returns a tagged `{ ok, code, message }` result: a missing/unreadable module yields a friendly `cannot read module for <state>` diagnostic instead of a raw `readFileSync` stack trace, and a zero-byte/whitespace-only module is rejected as `empty/corrupt` (exit `1`) instead of silently emitting nothing with exit `0`. `emitState(state, modulesBaseUrl?)` gains an optional injectable base-URL param (dependency injection for testability — the default preserves the production read path byte-for-byte, not a config toggle).
- **SKILL.md mode-3 monolithic fallback (F6c).** Tightened the bullet so the operative per-state rules unambiguously come from the `emit-state` router on state entry, not from the inline Per-State Rules section (which is summaries + pointers only).

### Added
- **`emit-state.test.mjs`** gains direct `resolveModuleBody` unit tests for the empty-module and missing-module paths (temp-dir fixtures via `mkdtempSync` + `pathToFileURL`); the no-flag CLI test now asserts exit `2`.

## [2.23.0] - 2026-06-11

Moves the five per-state rule bodies out of `src/SKILL.md` into on-demand emitted modules (`plans/plan_2026-06-11_f2637f3b/`, the LIGHTER variant of a script-emission migration). SKILL.md keeps its spine — state machine, transition rules, File Ownership table, autonomy leash, complexity control — and the per-state rule text is relocated **verbatim** behind a router, fidelity-proven byte-for-byte. This is a content-conserving structural change, not a protocol behavior change; `check-doc-parity` is unaffected because the File Ownership table stays in SKILL.md.

### Added
- **`src/scripts/emit-state.mjs` per-state rule router.** Emits `scripts/modules/state-<state>.md` on demand via `--state explore|plan|execute|reflect|pivot`; unknown / `close` / missing state → stderr message + exit 1. Module resolution is `import.meta.url`-relative, and an `isEntryPoint` dual-mode guard lets the file serve as both CLI and importable API.
- **`src/scripts/modules/state-*.md`.** Five new module files holding the per-state rule bodies excised from SKILL.md verbatim.
- **`src/scripts/emit-state.test.mjs`.** node:test suite covering the API surface, CLI byte-fidelity against the module files, and the error paths; registered in the `lint`/`test` lists of both the `Makefile` and `build.ps1`.

### Changed
- **`src/SKILL.md` "Per-State Rules" reduced to summaries + pointers (504→397 lines).** Each per-state block is now a one-line summary plus an `emit-state --state <s>` pointer; the spine is unchanged.
- **State-entry wiring.** `agents/orchestrator.md` and the SKILL.md mode-3 monolithic fallback now invoke the router on entering each state.
- **Combined build re-inlines the modules.** `make build-combined` / `build.ps1` re-inline the five module bodies under a `# Bundled State Modules` section so the single-file distribution stays self-contained.

### Docs
- `CLAUDE.md` Repository Structure tree, "Updating Local Skill" procedure, and Validation Checklist document `scripts/modules/` + `emit-state.mjs`; README Project Structure tree updated to match (File Ownership table untouched).

## [2.22.0] - 2026-06-01

Resolves five findings from an epistemic-deconstructor audit double-check (`plans/plan_2026-06-01_dfe2202a/`): two contract-path footguns in the Node scripts (F1, F2), a doc-ownership-table gap (F4), and a new executable parity gate (MF-1/F3) plus a CLAUDE.md nit. Riskiest/contract-sensitive fixes landed first; F4 (README rows) landed before the parity gate so the gate is green at introduction.

### Added
- **`src/scripts/check-doc-parity.mjs` parity gate (MF-1 / F3).** New executable gate enforcing that every File Ownership path in `src/SKILL.md` is also present in README's table. Exports a pure `comparison(skillText, readmeText)` (parses both tables, splits comma-merged cells, strips the `(index)` suffix) used by both the CLI wrapper and `check-doc-parity.test.mjs`; CLI exits 0 on parity, 1 with a missing-row diff. Wired by name into `make`/`build.ps1` `lint`/`test`/`validate`.

### Fixed
- **bootstrap.mjs typo-subcommand footgun (F1).** A single bare token within edit distance 2 of a known subcommand (e.g. `staus`) is now rejected with a "did you mean" suggestion plus a `new "..."` escape hatch, instead of silently becoming a plan goal. Multi-word and empty bare-goal invocations are unchanged (still tested byte-for-byte).
- **validate-plan.mjs standard-path absolute/relative path handling (F2).** `validate()` now resolves absolute/relative path args (mirroring the existing `--pre-step` guard) and reports the resolved path in not-found / PASS / Validation messages, instead of a misleading `plans//...` prefix. Bare plan-id names still resolve under `plans/`; `--pre-step` exit codes untouched.

### Docs
- **README File Ownership table parity (F4).** Added the 6 rows present in `src/SKILL.md` but missing from README (`findings.md` index, `findings/review-iter-N.md`, `checkpoints/*`, `plans/FINDINGS.md`, `plans/DECISIONS.md`, `plans/INDEX.md`).
- CLAUDE.md `diff -rq` mirror-check commands now use `--exclude='.claude'`; the File Ownership validation-checklist item references the new parity gate.

## [2.21.0] - 2026-05-31

Hardens the skill→orchestrator→sub-agent wiring that v2.20.0 introduced. Investigation (`plans/plan_2026-05-30_fa6267aa/`, findings W0–W3) confirmed via a **live dispatch test** that the v2.20.0 bridge already works on the skill-trigger path — the in-thread orchestrator resolved `agents/orchestrator.md` against the harness-announced base dir and spawned sub-agents successfully. The residual defect was that the wiring is *soft*: nothing distinguishes a working dispatch from the (explicitly allowed) monolithic fallback, so a degraded run looked identical to "agents not wired in." No state-machine, transition, or `.mjs` changes.

### Added
- **User-visible mode announcement (headline, W1).** `src/SKILL.md` "Orchestrator Role Assumption" now requires a one-line announcement of the live mode: condition 2 (agents installed) announces sub-agent dispatch is engaged; condition 3 (monolithic fallback) announces the degraded single-thread mode. Silent degradation becomes a visible signal — a user expecting sub-agents who sees the monolithic line immediately knows why. Mirrored as a positive announcement in `agents/orchestrator.md` "Your Role".
- **Canonical dispatch example (W1).** Added one literal clarification under `agents/orchestrator.md` "Sub-Agent Dispatch Rules": the prose "Spawn ip-X" throughout the section means an actual agent-tool call with that named subagent type (e.g. `Agent(subagent_type: "ip-explorer", ...)`), not doing the work in-thread. One example only — the five per-state "Spawn" lines are unchanged and the section stays a pointer, not a per-state narrative.

### Fixed
- **Install drift between the two sync paths (W2).** The Makefile `build` target bundles `src/agents/*.md` into the skill package's `agents/` dir, but CLAUDE.md "Updating Local Skill" copied agents only to `~/.claude/agents/` — never the skill-bundled copy — so the bundled `agents/` silently went ~5 versions stale. The manual procedure now also `cp`s into `~/.claude/skills/iterative-planner/agents/` (authoritative-by-build), with a `diff -rq` verify and a Validation-Checklist bullet enforcing parity.

### Changed
- `src/SKILL.md` condition 2 now states explicitly that `agents/orchestrator.md` is resolved against the harness-announced skill base directory (removes an implicit assumption).

### Docs
- Sync the `--pre-step` `--help` leash-cap text to the actual `>= 2` condition (was `< 2`); refresh the README skill badge to v2.21.0.

## [2.20.0] - 2026-05-31

Closes a structural wiring gap: skill activation never engaged the orchestrator. `src/SKILL.md` (the file loaded on activation) had no instruction to read or assume `agents/orchestrator.md`, so the rich runtime dispatch (inlined Presentation Contract floors, PLAN compression gate, EXECUTE pre-step gate exit-code handling, PIVOT reset-attempts) was never reached on the skill-trigger path — only when the orchestrator was launched directly as a main thread. The dependency arrow pointed one way only (orchestrator.md declares `skills: [iterative-planner]`; nothing pointed back). No script changes.

### Fixed
- **Skill→orchestrator bridge (headline).** Added an "Orchestrator Role Assumption" section at the top of `src/SKILL.md` (mirroring the sibling epistemic-deconstructor skill). Three-way conditional: (1) already-orchestrator guard — short-circuits the `skills: [iterative-planner]` reload loop, checked first; (2) agents installed → Read `agents/orchestrator.md` and assume the role **in-thread** (never spawn a second orchestrator); (3) monolithic fallback → run single-threaded with `Task` subagents. Idempotent: the role is read at most once per conversation.
- **File Ownership Model contradiction.** The model assigned `plan.md`→Plan-writer and `changelog.md`→Executor under "only the owner writes", but the orchestrator's EXECUTE Post-Step Gate writes both. Amended both rows to co-ownership (the established idiom already used for `decisions.md`/`progress.md`), with a note that orchestrator co-owned writes are confined to Post-Step Gate cursor/ledger updates. Synced in SKILL.md and README.md.

### Changed
- **De-duplicated dispatch into a single source of truth.** `agents/orchestrator.md` is now authoritative for runtime dispatch sequencing. SKILL.md's "Dispatch Rules by State" subsection collapsed from a per-state spawn narrative to a pointer; SKILL.md retains the protocol/state-machine spec. Removed the stale "(orchestrator.md update lands in step 10 of v2.18.0)" drift note at the PLAN compression-gate bullet.
- `agents/orchestrator.md` `description:` now documents both load paths (main thread via `claude --agent iterative-planner-orchestrator`, or procedure read in-thread per "Orchestrator Role Assumption") and the reload-loop guard; added a "Your Role" line anchoring that the installed agent name is `iterative-planner-orchestrator`.

### Docs
- README.md Sub-Agent Architecture: ownership table synced + role-assumption sentence added. CLAUDE.md validation checklist: +3 items (role-assumption naming, no dispatch duplication, README/SKILL ownership-table agreement).

## [2.19.3] - 2026-05-31

Resolves the two remaining HIGH-severity findings from the deep self-review (`plans/plan_2026-05-30_fa6267aa/`): both "anchor graveyard" and "stuck leash counter" failure modes that could block the REFLECT→CLOSE gate of an unrelated, current plan. Two new `bootstrap.mjs` subcommands. Tests 218 → 225.

### Added
- **`bootstrap.mjs retire <plan-id>` (P1 / OBS-004).** When a plan dir is deleted or obsoleted while its qualified `# DECISION <plan>/D-NNN` anchors still live in source, `validate-plan.mjs` reported the orphan as a blocking `ERROR [anchor-unknown-plan]` — jamming the *current* plan's CLOSE gate, recoverable only by hand-editing every anchor. `retire` walks the same source set the validator scans (`ANCHOR_SOURCE_EXTS` / skip-dirs), stamps `[STALE]` on that plan's anchors (orphan ERROR → WARN, idempotent via negative lookahead), and drops the plan dir. Works whether or not the dir still exists; refuses the active plan and malformed ids.
- **`bootstrap.mjs reset-attempts` (P2 / OBS-016).** The pre-step gate HARD-blocks at 2 recorded fix attempts, but nothing automated the "resets on new step | PIVOT" rule, so a stale counter jammed the first step after a pivot (`GATE:FAIL [leash-cap]`), recoverable only by hand-editing `state.md` — the exact surgery the gate exists to avoid. `reset-attempts` mechanically rewrites the active plan's `## Fix Attempts` section to placeholder.

### Changed
- Protocol wiring: SKILL.md (Bootstrapping list, Autonomy Leash, Decision Anchoring), `agents/orchestrator.md` (PIVOT dispatch now runs `reset-attempts`), README and CLAUDE.md command lists updated for both subcommands.

### Tests
- +7 regression tests (retire: stamp/dir-absent/idempotent/refuse-active/bad-id; reset-attempts: placeholder rewrite + no-active-plan). Count 225 (bootstrap 172 + validate-plan 39 + blast-radius 14).

## [2.19.2] - 2026-05-31

Bug-fix release from a deep self-review (`plans/plan_2026-05-30_fa6267aa/`). Fixes a producer/validator parity defect where the protocol's own intra-plan compression output failed its own validator, plus an idempotent-close transition glitch and doc drift. No protocol behavior changes. Tests 214 → 218.

### Fixed
- **Validator rejected the compressor's own decisions.md output (B1).** `validate-plan.mjs parseDecisionsEntries` stripped the `<!-- COMPRESSED-SUMMARY -->` markers individually but left the `## Summary (compressed)` heading inside, which registered as a non-conforming decision entry → blocking `ERROR [decisions-schema]` once any plan's `decisions.md` crossed the 300-line compression threshold. Now blanks the whole marker block (preserving line count) before parsing. Markers + the inline changelog recognizer moved to `shared.mjs` so producer (`bootstrap.mjs`) and validator import one source of truth.
- **Validator flagged the compressor's own changelog.md output (B3).** `checkChangelogFormat` had no skip for the `- (compressed: N low-decision-impact edits…)` summary line `maybeCompressChangelog` writes → `WARN [changelog-malformed]`. Now skipped via the shared `CHANGELOG_COMPRESSED_INLINE_RE`.
- **`cmdClose` recorded an invalid `CLOSE→CLOSE` transition (B2).** Closing from the documented CLOSE flow (Current State already `CLOSE`) appended a `CLOSE → CLOSE` history bullet that `validate-plan.mjs` rejected. `cmdClose` now skips the history write when already CLOSE; the validator also accepts `CLOSE→CLOSE` as idempotent for legacy `state.md` files.

### Docs
- SKILL.md PLAN rules now list all 11 validator-required `plan.md` sections (previously omitted `Goal` and `Context`).
- SKILL.md pre-step gate now documents all four `GATE:FAIL` slugs (`no-plan`, `wrong-state`, `leash-cap`, `iteration-cap`), not just `leash-cap`.
- README: validate-plan REFLECT step 16 → 18; version badge 2.19.0 → 2.19.2; test counts updated to 218.

### Tests
- +4 regression tests (validate-plan +3 for B1/B3/B2 validator-tolerance; bootstrap +1 for the B2 generation guard). Count 218 (bootstrap 165 + validate-plan 39 + blast-radius 14).

## [2.19.1] - 2026-05-30

Bug-fix and test-hardening release from a deep self-review (`plans/plan_2026-05-30_eb9b4fee/`). No protocol behavior changes; one concurrency fix, doc-drift cleanup, and a large test-coverage expansion.

### Fixed
- **`cmdClose` held no lock (concurrency).** Standalone `bootstrap.mjs close` performed all consolidated-file writes (merge/trim/index/snapshot/pointer-unlink) without `plans/.lock`, so concurrent closes could double-merge into `FINDINGS.md`/`DECISIONS.md`/`INDEX.md`. `cmdClose` now acquires the lock (skipped on the `--force` path, which already holds it) and acquires it *before* reading the pointer to close a TOCTOU; the no-plan exit routes through a structured error so the lock is released before exit (L-014). New 5-process concurrent-close test.
- **`make test` / `build.ps1 test` ran only `bootstrap.test.mjs`** (157 of 214 tests) — `validate-plan.test.mjs` and `blast-radius.test.mjs` never ran in CI. Both targets now run all three suites.
- **`make lint` / `build.ps1` lint skipped `blast-radius.mjs` and `shared.mjs`.** Both now `node --check` all four scripts.
- **`build.ps1` combined-build refMap keys used double backticks** in single-quoted strings (literal), so they never matched SKILL.md's single-backtick reference spans — the Windows combined build left dangling `references/*.md` links. Keys switched to single backticks, matching the Makefile sed (verified 0 dangling via the equivalent Unix build).
- **Misleading Autonomy-Leash validator text.** The full-validator ERROR said "hard cap is 2" but only fires at 4+ attempts. Reworded both leash messages to describe the two enforcement tiers accurately (no threshold change); added an "Enforcement tiers" note to SKILL.md §Autonomy Leash documenting why the `--pre-step` gate (cap 2) and the retrospective audit (WARN 3 / ERROR 4+) intentionally differ.
- **`bootstrap.mjs` vs `validate-plan.mjs` preamble-scan mismatch.** bootstrap scanned the whole `decisions.md` for the `*Plan:` preamble; the validator only the first 10 non-blank lines, so a late preamble compressed in one tool but ERRORed in the other. bootstrap now uses the same 10-non-blank-line window.
- **REFLECT step-numbering collision.** Phase 1 ended at step 7 and Phase 2 restarted at 7 (with an odd `8a`). Phase 2 renumbered contiguously 8–22, Phase 3 23–26.
- **Cross-surface doc drift:** `code-hygiene.md` stale-anchor grep now matches qualified `plan-id/D-NNN` anchors (was bare-only); `ip-reviewer.md` uses the qualified anchor format; `plans/SYSTEM.md` added to the SKILL.md Recovery list and CLAUDE.md validation checklist; `ip-explorer.md` findings section name aligned to `file-formats.md` (`Risks & Unknowns`).

### Removed
- Dead code in `validate-plan.mjs`: unused `collectKnownDecisionIds` (no callsite since v2.14.0) and the `ANCHOR_PATTERNS` constant (`findAnchorsInFile` rebuilds patterns inline); plus a duplicated `a !== "-h"` condition in `--pre-step` arg parsing.

### Added
- **Test coverage 190 → 214.** `shared.mjs:extractField` (5 direct tests, was untested); `blast-radius.mjs` (3 → 14: all UNKNOWN exit paths, `--json` schema, per-signal scoring, `--verbose`); 4 high-risk `validate-plan.mjs` check functions (`checkChangelogFormat`, `checkPresentationContractLog`, `checkComplexityBudget`, `checkVerificationEvidence`); concurrent-close and preamble-window tests.

### Notes
- Test count 214 (bootstrap 164 + validate-plan 36 + blast-radius 14); all suites + `make validate` pass.

## [2.19.0] - 2026-05-30

### Added
- **Simplicity & reusability principles integrated into the protocol surfaces (DRY/KISS/YAGNI).** Six extend-in-place edits, no new files — each composes with an existing section:
  - `references/complexity-control.md` § Complexity Budget: **earned-abstraction rule** (an abstraction is earned only at ≥2 concrete call sites; single-use → inline). [YAGNI / use before reuse]
  - `agents/ip-plan-writer.md` § Decomposition Rules: use-before-reuse bullet at PLAN time, cross-referencing the earned-abstraction rule (no restating).
  - `agents/ip-explorer.md` § Code Patterns + Rules: `[REUSE] path:line` tag mandate so the planner extends existing assets instead of rebuilding (centralize knowledge).
  - `references/code-hygiene.md`: new **Interface Contracts for Shared Assets** subsection — shared (≥2-caller) assets carry a contract; robustness scales with reuse / blast-radius.
  - `agents/ip-executor.md` § Pre-Step Checklist item 7: **reuse-before-write** (grep for an existing impl before adding; 2+ copies = duplication smell). [DRY keystone]
  - `SKILL.md` § Complexity Control: one line naming KISS (Simplification Checks #3-4), YAGNI (Complexity Budget + earned-abstraction rule), DRY (Pre-Step Checklist #7 + Interface Contracts).
  - Design note (lesson L-015): the generality gate was placed in the Complexity Budget rather than as a 7th Simplification Check, because "6 Simplification Checks" is duplicated in SKILL.md + CLAUDE.md — a 7th would force a multi-place count edit (the exact cross-surface invariant the principles fight).

### Fixed
- **Combined-build shipped dangling `references/blast-radius.md` links (live defect).** `make build-combined` emitted 4 un-rewritten cross-references because `blast-radius.md` was missing from the refMap in both `Makefile` and `build.ps1` (and one un-backticked prose mention in `file-formats.md`). All now rewrite correctly; verified by running the build (0 dangling).

### Changed
- **Extracted `src/scripts/shared.mjs` (DRY).** `extractField` (was byte-identical in `bootstrap.mjs` and `validate-plan.mjs`) and `splitChangelogFields` (was exported by bootstrap but reimplemented inline in validate-plan with a "kept in lockstep" comment) now live in one module imported by both. `bootstrap.mjs` re-exports `splitChangelogFields` so the test import surface is unchanged. Placed flat in `src/scripts/` so the existing `*.mjs` copy glob ships it with no build change.
- **`changelog.md` added to the build `validate` file-list** (`Makefile`, `build.ps1`) — closes a latent regression-assertion gap (bootstrap creates it but the validate check omitted it).

### Notes
- Test count unchanged at 190 (bootstrap 157 + validate-plan 30 + blast-radius 3) — no tests added; both suites + `make validate` pass.
- Driven by the epistemic-deconstructor audit (`analyses/analysis_2026-05-30_9f4059f2/summary.md`) and executed via the iterative-planner (`plans/plan_2026-05-30_b6e2f5a3/`).

## [2.18.2] - 2026-05-15

### Fixed
- **D-002: F5 `isPivotPhase` missed PIVOT-as-source phase (`validate-plan.mjs:180`).** Pass 2 OBS-001. F5's `isPivotPhase` matched PIVOT only as DESTINATION (`X → PIVOT`) or bare. The state machine's documented `PIVOT → PLAN` (PIVOT-as-source) phase was missed — a decisions.md entry with that phase column escaped the mandatory Complexity Assessment requirement. LATENT in current corpus (0 hits per FN-001 audit) but justified by L-012 pattern discipline. Helper now matches both arrow directions; guards against substring false-positives like `PIVOT-PLAN` (hyphen qualifier). 2 new tests `(n)`, `(o)` in `validate-plan.test.mjs`.
- **D-003: blast-radius.mjs shell injection via filename (`blast-radius.mjs:40-58, all callsites`).** Pass 2 OBS-002 / Pass 1 L2 (deferred). `tryExec(cmd-string)` used `execSync(string)` → `/bin/sh -c` → `$()` and backticks in interpolated `repoRel`/`pat` expanded. Live probe FN-004: filename `bad$(touch /tmp/PWNED).js` created `/tmp/PWNED` even when the file didn't exist on disk (`git diff ... -- "${repoRel}"` runs before existence check). New `tryExecArgs(cmd, args[], opts)` uses `spawnSync(cmd, args, {shell:false})`. All 6 callsites converted. New file `src/scripts/blast-radius.test.mjs` with 3 cases: `$()` blocked, backtick blocked, clean filename regression.
- **D-004: bootstrap.mjs concurrent `new` race + unsafe catch (`bootstrap.mjs:24-91, 953-1003, 1207-1234`).** Pass 2 OBS-003 / Pass 1 H5 (deferred). FN-005: 5 parallel `bootstrap.mjs new` produced 2 plan dirs + 0 pointers (loser's catch handler unconditionally `unlinkSync(pointerFile)`'d the winner's pointer). Three-layer fix: (1) `acquireLock()` via `openSync('plans/.lock', 'wx')` writes PID; stale-PID detection (`process.kill(pid, 0)`) reclaims dead-process locks. (2) `cmdNew` wraps try/finally; `cmdNewInner` throws structured EACTIVE/ECREATE errors instead of `process.exit(1)` (which skips finally blocks and leaks the lock). (3) `wePersistedPointer` boolean gate: pointer cleanup only fires when this process wrote it (defense-in-depth). 2 new tests `D-004` suite.
- **D-005: Iteration cap bypass — agent-written counter (`validate-plan.mjs:385-422`).** Pass 2 OBS-005. `checkIterationLimits` only read `^## Iteration:` field; an agent that never bumps it bypasses the 5/6 caps. New `deriveIterationFromHistory(state)` counts `EXECUTE → REFLECT` arrows in Transition History; final iter = `max(declared, derived)`. Error message includes both numbers when they differ. 2 new tests `(p)`, `(q)` in `validate-plan.test.mjs`.
- **D-006: `checkCompressionMarkers` substring-matched prose (`validate-plan.mjs:553-579`).** Pass 2 OBS-010 (NEW — discovered during this plan's validation). `content.indexOf(OPEN)` substring match counted prose mentions of the marker (e.g. a finding documenting the compression spec) as real markers — false-positive `ERROR [compress-markers] unbalanced` for any plan that documents its own machinery. Fix: line-anchored detection (`trimmed === MARKER`); position offsets computed from line iteration. Real on-its-own-line markers still detected; real unbalanced still ERRORs. 3 new tests `(r)`, `(s)`, `(t)` in `validate-plan.test.mjs`.
- **D-007: Orchestrator compression dispatch failure-silent (`orchestrator.md:75-93`).** Pass 2 OBS-007 / Pass 1 H6 (deferred). Dispatch had no `.catch()`, no exit-code check, no stdout capture; helpers return `{reason: "missing"}` instead of throwing, so even the (absent) catch was moot. Updated dispatch chains `.then(r => console.log(JSON.stringify({decisions: r[0], changelog: r[1]})))` and `.catch(e => console.log(JSON.stringify({error: e.message})))`. Orchestrator stores `$COMPRESS_OUT` and appends a `- Compression: …` line to state.md Transition History. Per L-007, anchor in `.md` is recorded in summary.md Decision Anchors Registry (not validator-scanned).
- **D-008: `stripCrossPlanNote` over-stripped body content (`bootstrap.mjs:250-279`).** Pass 2 OBS-008. Global regex replace fired wherever the boilerplate appeared; a finding entry quoting the line had its quoted line silently elided at merge. Fix: anchor strip to file PREAMBLE (first 10 lines) AND require trimmed-line-equals-note (`^...$`). Body quotes preserved. Adjacent blank lines consumed to avoid double-blank seams. `stripCrossPlanNote` now `export`-ed for test access. 3 new tests `D-008` suite.

### Notes
- Driven by the epistemic-deconstructor Pass 2 review of v2.18.1 at `analyses/analysis_2026-05-15_173c37c2/summary.md`. Falsification audit (`plans/plan_2026-05-15_9ae230f7/findings/falsification-audit.md`) recalibrated OBS-001 (LATENT not active — kept for L-012 pattern discipline), OBS-006 (F1-F5 ARE tested — gap is architectural invariants), and DEFERRED OBS-004 (requires `bootstrap.mjs requalify` migration) and OBS-009 (architectural — out-of-band user_approvals + audit.jsonl, separate plan). OBS-010 was discovered DURING plan validation when `checkCompressionMarkers` false-positive-ERROR'd against this plan's own FINDINGS.md (which documents the marker pattern).
- Test count: 187 (was 175 — net +12 across `bootstrap.test.mjs` +5, `validate-plan.test.mjs` +5, new `blast-radius.test.mjs` +3).
- Per "no barren decisions" discipline: every D-NNN in `plans/plan_2026-05-15_9ae230f7/decisions.md` has `**Anchor-Refs**` pointing to the modified source (D-007 anchor in `.md` per L-007 mitigation).

## [2.18.1] - 2026-05-15

### Fixed
- **F1: Leash regex format-fragility (`validate-plan.mjs:346, :1488`).** The previous regex `/^-\s+(Step\s+\d+,\s+attempt\s+\d+|Attempt\s+\d+)/i` required either the literal `Step N, attempt M` form (comma mandatory) or bare `Attempt N`. A natural-English write like `- Step 1 attempt 1` (no comma) matched NEITHER alternative, silently bypassing both the full validator's leash check and the `--pre-step` GATE:FAIL [leash-cap]. Relaxed to `/^-\s+(Step\s+\d+[,\s]+attempts?\s+\d+|Attempts?\s+\d+)/i` — comma optional, `attempts?` plural accepted. Re-instances of D-002 ("leash check never ran in production") for non-canonical writes are now impossible. 4 new tests in `validate-plan.test.mjs`.
- **F2: Decisions compression idempotency drift on add+delete (`bootstrap.mjs:526` and surrounding).** `maybeCompressDecisions` used entry-count-only idempotency (`entries-at-compress: N`). Adding one new entry while deleting any older entry yields identical count → `no-new-entries` no-op → the compressed summary block continues referencing the deleted entry and never mentions the added one. Drift between fast-path summary and raw entries goes undetected. New: `computeEntriesFingerprint(ids)` (sha1 of sorted IDs, first 12 hex) + `<!-- entries-fingerprint: <hash> -->` marker. Idempotency check prefers fingerprint match over count. Back-compat: legacy blocks with count-only marker still no-op when count unchanged. 2 new tests in `bootstrap.test.mjs`.
- **F3: Pipe in changelog reason corrupts every consumer (`bootstrap.mjs:613`, `validate-plan.mjs:1316`).** A legitimate reason like `fix race: a | b condition` produced 9 pipe-separated fields → validator emitted WARN [changelog-malformed] AND `classifyChangelogLine` returned `kind:"non-entry"`, hiding the line from compression and from `ip-reviewer`'s HIGH-radius / tiny-edit-big-radius scans. New exported helper `splitChangelogFields(line)` splits on the FIRST 7 ` | ` separators only; everything after the 7th belongs to `reason`. Validator uses an identical inline implementation to keep parsing rules in lockstep. `references/file-formats.md` § changelog.md updated to note pipes in reason are tolerated. 3 new tests across both test files.
- **F4: INDEX.md topics column not pipe-escaped (`bootstrap.mjs:879`).** `appendToIndex` escaped pipes in the Goal column (`safeGoal`) but not in the Topics column. A finding link like `[auth | session](findings/auth.md)` injected a raw `|` into the table row, producing 6 delimiter pipes where the table expects 5 — Markdown renderers silently misaligned the cells. Now mirrors `safeGoal` with `safeTopics = topics.replace(/\|/g, "\\|")`. 1 new test in `bootstrap.test.mjs`.
- **F5: Decisions-schema PIVOT detection inconsistent with state-transition normalization (`validate-plan.mjs:195, :699`).** `checkStateTransitions` normalized `Re-Plan`/`RE_PLAN`/`REPLAN` to `PIVOT` before validating transitions, but `checkDecisionsSchema` used raw `phase.includes("PIVOT")` — same protocol concept handled two ways. Consequences: (a) a `## D-NNN | REPLAN | ...` entry escaped the mandatory `**Complexity Assessment**` block because "REPLAN".includes("PIVOT") is false, (b) a `## D-NNN | PIVOT-RECOVERY | ...` entry false-positive-tripped the requirement because "PIVOT-RECOVERY".includes("PIVOT") is true. New shared helpers `normalizePhase(s)` + `isPivotPhase(s)` applied at both call sites. Strict PIVOT detection: bare `PIVOT` or arrow-terminus `* → PIVOT`. 2 new tests in `validate-plan.test.mjs`.

### Notes
- Driven by the epistemic-deconstructor review of v2.18.0 in `analyses/analysis_2026-05-15_554e9373/` and the fix plan in `plans/plan_2026-05-15_bb80e2f3/`. The review surfaced 14 candidate defects across script bugs, scaling concerns, and protocol-compliance gaps. After a false-positive audit (re-calibrating severity for A1 framing, H2 timeline, H5 frequency), 5 fixes shipped here. Deferred to a future plan: A1/A2/A3 architectural (LESSONS.md SPOF, PC-* enforcement, convention drift), H2 anchor-graveyard retire flow, H5 concurrent-session lockfile, H6 orchestrator dispatch logging, H7 per-step Fix Attempts scoping, M2 hardcoded cutover constant, M3 line-num precompute, L2 blast-radius shell-arg-array.
- Test count: 175 (was 146 — net +29 across `bootstrap.test.mjs` and `validate-plan.test.mjs`).

## [2.18.0] - 2026-05-15

### Added
- **Intra-plan compression for `{plan-dir}/decisions.md` (>300 lines) and `{plan-dir}/changelog.md` (>200 lines).** New exports from `src/scripts/bootstrap.mjs`: `maybeCompressDecisions`, `maybeCompressChangelog`. Append-only safe — raw entries preserved verbatim below the marker; `<!-- COMPRESSED-SUMMARY -->` block inserted after the `*Plan: <plan-id>*` preamble (decisions) or inline summary lines replace LOW-radius `-`-decision-ref groups (changelog, min group size 5). Idempotent across re-compression passes via `entries-at-compress` metadata. See `references/file-formats.md` § Intra-plan compression.
- **Checkpoint lockfile snapshot procedure.** Sibling `{plan-dir}/checkpoints/cp-NNN-iterN.lockfiles/` directory holds copies of manifest-touching steps' lockfiles. New `## Lockfiles snapshotted:` section in the checkpoint template; `## Rollback:` extended with a `npm ci`-style strict-fidelity reinstall step (cargo / poetry / bundle equivalents documented). Security-gated: never snapshots `.env` or `.gitignore`d files. Sibling-directory convention is backward-compatible with `checkCheckpoints()` flat `.md` scan.
- **`validate-plan.mjs --pre-step` mode** — mechanical Autonomy Leash enforcement. Exit code **2** (mode-exclusive) on hard fail. Output contract: `GATE:PASS` or `GATE:FAIL [slug] [...details]` where slug ∈ `{no-plan, wrong-state, leash-cap, iteration-cap}`. Wired into orchestrator EXECUTE dispatch (step 1.5) before every `ip-executor` spawn; halts on exit 2. Skips anchor walk + findings scan for sub-50ms latency.
- **New test file `src/scripts/validate-plan.test.mjs`** — 16 cases covering `checkLeashCount` regex reconciliation (8) and `--pre-step` gate semantics (8).

### Changed
- **Orchestrator EXECUTE dispatch** now invokes `node <skill-path>/scripts/validate-plan.mjs --pre-step` before every `ip-executor` spawn; halts on exit 2, writes `- Step N: LEASH HIT.` to state.md Fix Attempts, and transitions to REFLECT via PC-EXECUTE-LEASH.
- **Orchestrator PLAN dispatch** now invokes `maybeCompressDecisions` + `maybeCompressChangelog` at gate-in (parallel dynamic-import; idempotent; failure-tolerant).
- **`src/agents/ip-executor.md`** documents the lockfile snapshot procedure for manifest-touching steps (`package.json`, `Cargo.toml`, `pyproject.toml`, `Gemfile`).
- **`src/references/code-hygiene.md`** revert procedures (Failed step / PIVOT revert / Nuclear option) now include a `Post-git restore` reinstall step for manifest-touching reverts.
- **`src/SKILL.md`** documents intra-plan compression triggers + pre-step gate forward-reference across Mandatory Re-reads, PLAN per-state rules, File Lifecycle Matrix, Autonomy Leash, and Consolidated File Management sections.
- **`src/scripts/bootstrap.mjs` CLI dispatch** gated behind `isEntryPoint` (`fileURLToPath(import.meta.url) === process.argv[1]`) so the module can be safely imported by tests. CLI behavior preserved (D-003).

### Fixed
- **`checkLeashCount` in `src/scripts/validate-plan.mjs`** now matches the documented `- Step N, attempt M` Fix Attempts format (`src/references/file-formats.md`). Regex was previously `/^-\s+Attempt\s+\d+/i`; now matches both documented and legacy `- Attempt N` styles via alternation.
- **`extractSection` in `src/scripts/validate-plan.mjs`** now accepts headings with a trailing parenthetical comment (e.g. `## Fix Attempts (resets per plan step)`). The previous strict-trailing-whitespace anchor silently caused `checkLeashCount` to no-op on every real plan; the leash check has effectively never run in production until v2.18.0 (D-002).

## [2.17.4] - 2026-05-15

### Fixed
- **`validate-plan.mjs` RADIUS regex grouping** — `^radius:(LOW|MED|HIGH)\(-?\d+\)|radius:UNKNOWN\([^)]+\)$` lacked an outer group, so the `^` anchored only `LOW/MED/HIGH` and the `$` only `UNKNOWN`. Lines like `radius:LOW(2)trailing` and `garbage radius:UNKNOWN(x)` slipped through `checkChangelogFormat`. Now grouped: `^(radius:(LOW|MED|HIGH)\(-?\d+\)|radius:UNKNOWN\([^)]+\))$`.
- **`validate-plan.mjs` block-comment DECISION anchor scan** — `findAnchorsInFile` ran `blockInnerRe.exec(body)` once per block, so a `/* … DECISION D-001 … DECISION D-002 … */` reported only `D-001`. Now loops over every match in the block using a `/g`-flagged clone, with per-anchor line numbers computed from the file-relative offset.
- **`validate-plan.mjs` CRLF normalization in `readFile`** — silently broke every state-gated check on Windows-saved plan files. `currentState.toUpperCase()` returned `"EXECUTE\r"` and never matched `"EXECUTE"`. Now `\r\n` → `\n` at point of read.
- **`bootstrap.mjs trimConsolidatedWindow`** — `/\n## plan_/g` missed a section starting at byte 0 (pathological consolidated file with no H1 boilerplate). The miss made the sliding window count one section short and skip trimming when exactly `MAX_CONSOLIDATED_PLANS` headed-by-newline sections existed alongside one byte-0 section. Now also checks `/^## plan_/` and records position 0.
- **`bootstrap.mjs appendToIndex` Goal column** — `goal.split("\n")[0]` produced an empty INDEX.md cell when the Goal section started with a blank line. Now strips leading blank lines before taking the first content line.
- **`bootstrap.mjs appendToIndex` Topics column** — `\[([^\]]+)\]` extracted any bracketed text from the findings.md Index, so annotations like `[CORRECTED iter-2]`, `[TODO]`, `[WIP]` leaked into INDEX.md as fake topics. Now matches only Markdown link form `[label](target)`.
- **`bootstrap.mjs cmdClose` state.md transition append** — the new `- prevState → CLOSE (bootstrap close)` line was concatenated at EOF, so it landed in the wrong section when an agent had added trailing sections after `## Transition History:`. Now inserted at the end of the Transition History section explicitly, with a legacy EOF fallback when the section heading is absent.

### Documentation
- **`references/file-formats.md` Root Cause Analysis** — canonical block was 3 parts (Immediate, Contributing, Prevention), contradicting its own D-002 example (4 parts including Failed defense) and `references/planning-rigor.md` (4 parts). Now 4 parts in all three places. `planning-rigor.md` already designated `file-formats.md` as the SoT; the SoT no longer contradicts itself.
- **`references/convergence-metrics.md`** — total `convergence_score` range corrected `-3 to +3` → `-2 to +3` (scope_stability is clamped 0..1 and cannot push the floor below -2). Documents the `files_planned == 0` degenerate case to prevent NaN propagation.
- **`references/decision-anchoring.md` `[STALE]` policy** — internal contradiction (L103 "blockers" vs L106 "MAY downgrade to WARN") resolved in favor of WARN, matching the validator's actual `severityForOrphan` behavior. The agent now explicitly owns disposition at CLOSE (remove / preserve with rationale / convert).
- **`references/blast-radius.md`** — Public-API regex documents Go's `func\s+[A-Z]`; output format example updated to match the impl's verbose breakdown (signal counts in parens); UNKNOWN reasons list completed (`is-directory`, `no-file-arg`); `--json` flag noted.
- **`SKILL.md` Mandatory Re-reads table** — REFLECT row adds `changelog.md` (was missing since v2.15.0 introduced the per-edit ledger, which the Phase-1 Gate-In step list already required).
- **`README.md`** — stale "8-plan sliding window" reference updated to "4-plan" (window shrunk in v2.17.3).

### Added
- **4 new tests in `bootstrap.test.mjs`** — coverage for cmdClose Transition History anchor (B7), trimConsolidatedWindow byte-0 leading section (B11), appendToIndex Goal leading-blank handling, and appendToIndex Topics link-only filter. Test count 126 → 130.

### Notes
- Driven by the epistemic-deconstructor review of v2.17.3 (analyses/analysis_2026-05-15_5edfc9e7/) and the corresponding fix-plan in plans/plan_2026-05-15_9ec9850b/. Two review claims were verified as false positives during EXPLORE and skipped: (1) decisions-schema H2 false-positive — the validator correctly forbids non-`## D-NNN` H2s in decisions.md; (2) Windows path split in `checkAnchorRefsValidity` — `lastIndexOf(":")` is correct for `path:line` regardless of Windows drive letters.

## [2.17.3] - 2026-05-15

### Added
- **`validate-plan.mjs checkLessonsCap`** — ERROR `[lessons-cap]` when `plans/LESSONS.md` exceeds 200 lines (the hard cap stated in SKILL.md L42, L198); INFO `[lessons-absent]` on missing file (legacy plans). Mirrors `checkSystemAtlasCap`. Closes the asymmetry where SYSTEM.md's 300-line cap was validator-enforced but LESSONS.md's 200-line cap was prose-only.
- **`validate-plan.mjs checkCompressionMarkers`** — ERROR `[compress-markers]` on unbalanced, nested, out-of-order, or duplicate `<!-- COMPRESSED-SUMMARY -->` blocks in `plans/FINDINGS.md` / `plans/DECISIONS.md`. WARN when the block sits after the first `## plan_` section. Enforces SKILL.md §Consolidated File Management — Compression invariants (matched pairs, replace-not-append, position before first plan section).
- **`validate-plan.mjs checkLeashCount`** — Autonomy Leash enforcement (SKILL.md §Autonomy Leash). Counts `- Attempt N` entries under `## Fix Attempts` in state.md during EXECUTE/REFLECT. WARN `[leash]` at 3 attempts, ERROR at 4+. Conservative pattern silently ignores the template placeholder `- (none yet)` and missing sections, so legacy plans don't false-fire. Closes a CORE-rule enforcement gap: SKILL.md L344-354 said "No exceptions" but had zero validator coverage.
- **`validate-plan.mjs`** `Context` added to `PLAN_SECTIONS` — Context is mandatory per `references/file-formats.md:54` and is already scaffolded by `bootstrap.mjs:382`. Plans could previously pass validation without it.
- **`bootstrap.mjs PLAN_ID_RE`** — defense-in-depth regex `/^plan_\d{4}-\d{2}-\d{2}_[0-9a-f]{8}$/` applied in `readPointer` after trim. Rejects malformed pointer content (path traversal sequences, wrong-format dates, non-hex seeds) before `join()` is reached. `existsSync` was fail-safe in practice but trusted the pointer's shape.
- **4 new tests in `bootstrap.test.mjs`** — path-traversal pointer rejection, wrong-format-date rejection, non-hex-seed rejection, whitespace-trim survives. Test count 122 → 126.

### Fixed
- **`validate-plan.mjs` finding-count off-by-one** — `Math.max(findingLinks, findingItems, numberedItems)` undercounted indexes that mixed bullet links and numbered items because `findingItems` is a superset of `findingLinks` (every `- [foo](bar)` line also matches `^- `). With 2 bullet links + 2 numbered = 4 actual items, max returned 2 and falsely warned "Only 2 indexed findings". Now `findingItems + numberedItems`.
- **`bootstrap.mjs stripCrossPlanNote`** — regex tightened from `[^*]*` to `[^*\n]*` between asterisks so a note that accidentally loses its closing asterisk cannot eat the file body. Single-line is the only documented format.
- **`CLAUDE.md`** Repository Structure tree — added `src/scripts/blast-radius.mjs` and `src/references/blast-radius.md` (both are functional and cited from SKILL.md L262, L481 and ip-executor.md L47-50 since v2.15.0 but were absent from the documented tree).
- **`README.md`** badge — synced to `v2.17.3` (was `v2.17.0`, lagged behind VERSION since v2.17.1).

### Notes
- All changes are doc + validator + bootstrap-pointer hardening. No protocol changes to SKILL.md state machine, file ownership, or presentation contracts. No new dependencies.
- Driven by `analyses/analysis_2026-05-15_61ded372/` epistemic-deconstructor review. 7 verified findings remain deferred for a future iteration (Windows path-sep in blast-radius.mjs, --force partial-failure recovery, close-from-anywhere shortcut design review, EXTENDED-check parsers, manifest-vs-git cross-check, goal-extraction dedup, goal-truncation UX in resume).

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
