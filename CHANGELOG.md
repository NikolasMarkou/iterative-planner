# Changelog

All notable changes to the Iterative Planner project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.57.1] - 2026-07-23

**Packaging fix — ship the register gate's data file.** `check-register.mjs` (added in 2.57.0) reads its committed per-file ceilings from `src/scripts/register-baseline.json`, but the build/sync/package copy globs matched only `*.mjs`, so the gate shipped without its baseline and `make sync-skill` failed its own `diff -rq` self-check. Fixed by copying `src/scripts/*.json` alongside the scripts in every path.

### Fixed

- **`register-baseline.json` now ships with the skill bundle.** `Makefile` (`SCRIPT_FILES` build glob + `sync-skill` prune/copy) and `build.ps1` (`Invoke-Build` + `Invoke-SyncSkill`) now copy `src/scripts/*.json` next to `src/scripts/*.mjs`, in lockstep. The fix is glob-based, so any future gate data file is covered automatically. No runtime behavior change — `check-register.mjs` is a build-time gate; this only restores bundle completeness and unblocks `make sync-skill`.

## [2.57.0] - 2026-07-23

**Register self-overfit countermeasures — a 3-part controller that adds a damping term to the codebase's rising jargon-density loop: a setpoint doc, a ratchet gate, and a CLOSE-time actuator.** Suite **688** (was 677; 11 new tests), 0 failures; **3 files added (the new gate, its baseline, its test), 0 new abstractions.**

### Added

- **C2 — New gate `check-register.mjs` (jargon-density ratchet).** Measures register density — bracket-tags (`[kebab-tag]`), coded refs (`PC-*` / `D-\d\d` / `[UFWNS]\d`), and 3+-hyphen compounds per 1000 words — of the shipped register-carrying docs (`CLAUDE.md`, `README.md`, `src/SKILL.md`, `src/agents/*.md`, `src/references/*.md`) against committed per-file ceilings in `src/scripts/register-baseline.json`. Two non-fuzzy numeric ERROR conditions only, exactly like `TEST_COUNT`: `[register-drift]` when a file's measured density exceeds its ceiling (density may fall/hold freely; a rise requires deliberately bumping the review-visible baseline), and `[register-floor]` anti-vacuity when a baseline-listed file is missing/empty or fewer files scan than baseline keys. Pure exported `jargonMarkers`/`density`/`compareToBaseline` above an `isEntryPoint` guard reading `IP_CHECK_REGISTER_ROOT` only inside it (D-003 idiom). Wired lockstep into make/build.ps1 validate + lint + test. 11 tests: pure-function units (side-effect-free import) + real-CLI spawns for both FAIL branches and a real-repo PASS.
- **C1 — `## Register Discipline (CRITICAL)` setpoint in `src/SKILL.md`.** A self-contained section (no new references file, no `§` pointer, no File Ownership text) naming the jargon-density anti-goal and pointing at the ratchet gate as the mechanism.
- **C3 — Register-normalization actuator on `ip-archivist` CLOSE.** Plainness / plain-first objective bullets on Steps 2 (summary.md), 3 (LESSONS rewrite), and 4 (SYSTEM rewrite) — an orthogonal editing-quality rule that leaves the 200/300-line caps and the `[lessons-eviction]`/`[atlas-cap]`/`[I:5]` gates untouched.

## [2.56.0] - 2026-07-21

**Gate-trustworthiness release from a deep review of the mechanical gate suite — vacuous green passes made impossible, every `check-*` CLI now spawned both ways by its own tests, one new zero-judgment parity gate, and one documented overpromise fixed at the source.** The vacuous-pass asymmetry is closed: only `check-template-parity` had an anti-vacuity floor (`EXPECTED_SLUGS = 12`); now `check-doc-parity` fails loud below `EXPECTED_MIN_KEYS = 10` and `check-agent-wiring` below per-dir ≥1 + `EXPECTED_MIN_PROSE_FILES = 15`, instead of passing green on a discovery step that found nothing. The File Ownership tables are gated on owner-cell TEXT, not just keys (the exact v2.55.0 F2-DRIFT class); the CHANGELOG's top release entry is mechanically checked against `VERSION` (this very entry is that gate's first live exercise); and `decision-anchoring.md`'s extension matrix no longer promises scanning for ~24 extensions no scanner visits. No full-corpus `plans/` walk was added by any change in this release — the one new gate reads exactly 2 files (`CHANGELOG.md` + `VERSION`) at repo root. Suite **677** (was 652; 25 new tests), 0 failures; **2 files added (the new gate + its test), 0 new abstractions.**

### Added

- **New gate `check-changelog-parity.mjs` — CHANGELOG.md top release entry ↔ VERSION (ERROR).** The FIRST `## [X.Y.Z]` heading must equal `VERSION`; a missing or unparseable CHANGELOG is a FAIL, not a skip. Modeled on `check-readme-parity`'s shape: pure exported `checkChangelogVersion()` + `isEntryPoint` CLI with the opt-in `IP_CHECK_CHANGELOG_PARITY_ROOT` override (D-003 pattern, read only inside `isEntryPoint`). Wired lockstep into all six Makefile/build.ps1 sites in one commit (`lint`, `validate`, `test` × both build scripts). 8 tests: 4 pure + 4 real-CLI spawns (repo PASS; mismatch, no-entry, and missing-file FAILs — no stack trace).
- **Owner-cell text parity in `check-doc-parity.mjs` (ERROR `[doc-parity-owner]`).** The README ↔ SKILL.md File Ownership tables are now compared on keys AND column-2 owner-cell text — exact match after whitespace normalization only (trim + collapse runs; no other normalization, no fuzzy matching; merged-cell rows inherit the row's owner cell). The readers column (col 3) is deliberately not gated. New `parseOwnershipTable()` widens the existing parser in place; `parseOwnershipKeys()` delegates, so importers and existing tests are untouched.
- **Anti-vacuity floors `[doc-parity-floor]` + `[scan-floor]` — mirroring the `EXPECTED_SLUGS` precedent.** `check-doc-parity`: either side parsing fewer than `EXPECTED_MIN_KEYS = 10` keys (observed 16) fails naming the side and count, converting the heading-regex-miss / BOM / `<details>`-without-heading silent-pass class into a loud fail. `check-agent-wiring`: each of the three scanned dirs must contribute ≥1 `.md` file AND the total must reach `EXPECTED_MIN_PROSE_FILES = 15` (observed 22), else FAIL naming the empty source. Both constants carry the "bump deliberately when the real count changes" comment. Folded in: CRLF/BOM tolerance pins for doc-parity (a CRLF fixture parses the same keys as LF; a BOM-prefixed fixture behaves deterministically — hits the floor loudly rather than passing silently).
- **Real-CLI FAIL/PASS spawn tests family-complete.** `IP_CHECK_TEMPLATE_PARITY_ROOT` and `IP_CHECK_AGENT_WIRING_ROOT` env overrides added (D-003 pattern; importers and default env-unset CLI paths byte-identical) — every `check-*.test.mjs` now spawns its REAL CLI for both an exit-0 and an exit-1 branch (`grep -L "spawnSync" src/scripts/check-*.test.mjs` returns empty). Template-parity's fixture FAIL tampers a SKELETON region and asserts the slug on stderr, with rule (h)'s substrate and `checkParity`/`resolveTemplate` signatures untouched (D-009 honored).
- **dref double-WARN contract pinned.** An 8-field changelog line whose dref is shape-invalid and non-`-` (`D-1`) draws BOTH `WARN [changelog-malformed]` AND `WARN [changelog-dref-orphan]` on the same line — the v2.51.0 accepted double-report, previously a real contract with zero pinning tests.

### Fixed

- **`--emit-edges` write failure is a named FAIL, not a stack trace.** `check-agent-wiring.mjs --emit-edges <path>` with an unwritable target (e.g. missing parent directory) now prints `FAIL [emit-edges-write-failed] <path> (<err.code>)` and exits 1 — and deliberately does NOT `mkdirSync` (a user typo must fail loud, not silently create directories). No-flag and default-path behavior untouched; the no-flag byte-identity pin stays green.
- **`decision-anchoring.md` extension matrix shrunk to the truth.** The matrix rows now list exactly the 17 implemented `ANCHOR_SOURCE_EXTS` members; every previously-listed-but-never-scanned extension moved into one explicit "Not scanned — anchors in these files are ghosts" note. A doc fix, deliberately NOT a parity gate: the table's only legitimate change driver is `ANCHOR_SOURCE_EXTS` itself (rare, and that edit is already a 2-file lockstep a test pins). Repo-wide sweeps confirm no other site still promises scanning for the removed extensions.

## [2.55.0] - 2026-07-21

**Deep src/ review remediation across three fronts — one reproduced scoring bug, one ordering inversion against the skill's own reference, and the last hand-copied test reimplementation deleted.** F1: `blast-radius.mjs` scored the shared-path signal (and anchored its self-exclude pathspec, resolved its `plans/` history lookup, and read test-delta candidates) in the shell's CWD frame while its contract assumes the repo-root frame — reproduced live, fixed by deriving the root once and repointing all four consumers (the fourth, `testDelta()`, was missed by the first pass and caught by the iteration-1 adversarial review — the exact N-place-fix-missed-sibling class). F2: `ip-archivist.md` wrote summary.md's Decision Anchors Registry BEFORE running the audit that produces it, inverting `decision-anchoring.md` § Audit at CLOSE — Steps 1↔2 swapped (audit-then-summary), 6 stale step citations swept by pattern, and PC-PIVOT item 3 repointed from the undefined "Ghost Constraint Scan" field to the schema-defined "Ghost-constraint discovery" entry type. F3: both parity gates' real CLI FAIL branches are now spawned by tests via opt-in `IP_CHECK_*_ROOT` overrides, and readme-parity's hand-copied wrapper reimplementation is deleted, not kept alongside. No full-corpus `plans/` walk added. Suite **652** (was 643; 4 CWD regressions + 6 real-CLI FAIL tests, minus the deleted wrapper test), 0 failures; **0 files added, 0 new abstractions**.

### Fixed

- **F1 — `blast-radius.mjs` scores CWD-invariantly.** The repo root is derived once via `git rev-parse --show-toplevel` (falling back to the CWD frame on failure — today's exact behavior, exit-0 preserved), and the four root-frame consumers are repointed to `rootRel`: the `shared` signal's path-prefix regex, the `:(top,exclude)` self-match pathspec, `iterationHistory()`'s `plans/` lookup + manifest match, and `testDelta()`'s self-skip + candidate file reads (`git diff --name-only` / `git status --porcelain` emit root-relative paths from any cwd; the pre-fix `join(cwd, f)` threw from a subdir and silently dropped the -1 test-coverage credit — the fourth consumer, found by the iteration-1 review after the first pass fixed only three). A live probe during the fix falsified the three-substitution premise: `git grep` given ONLY exclude pathspecs never widens its search past the cwd subtree, so an explicit inclusive `:(top)` pathspec joins the argv to make the whole pathspec set root-framed (D-002, anchored) — output stays cwd-relative, so root-invoked scores are byte-identical to before (all pre-existing test expectations unchanged; the JS-side self-filter kept as defense in depth). 4 regression tests: root-vs-subdir verbose-line identity, module+untracked-test `tests=` identity root-vs-subdir, subdir-invoked `hist`, exit 0 under a shimmed failing `rev-parse`. Contract prose in `ip-executor.md` + `references/blast-radius.md` now states CWD-independence explicitly.
- **F2-BUG — archivist audit-then-summary reorder.** `ip-archivist.md` Steps 1↔2 swapped: Step 1 is now the decision-anchor audit (both directions + validator run), Step 2 writes summary.md with its Decision Anchors Registry populated FROM the audit's output — matching `decision-anchoring.md` § Audit at CLOSE ("Before `summary.md`: scan…") instead of writing the registry before it exists. Steps 3–6 bodies and numbers untouched; batch-safety and Step-5 once-only rules remain valid as written.
- **F2-DRIFT — archivist step-citation sweep to post-reorder ground truth.** Pattern sweep (`grep -rn "archivist" src/ README.md | grep -iE "step[s]? [0-9]"`), not a named-site list: 6 stale citations fixed across `SKILL.md` (Step 5→4 atlas, owner-cell Step 2→1), `README.md` (owner cell, hand-mirrored same commit — the keys-only doc-parity gate cannot see owner-cell text), `state-explore.md`, `state-reflect.md`, and `file-formats.md`. Zero stale hits remain.
- **F2-GAP — PC-PIVOT item 3 names a schema-defined source.** `ip-orchestrator.md` and `file-formats.md`'s PC-PIVOT contract pointed ghost-constraint reporting at a `decisions.md` "Ghost Constraint Scan" field no schema defines; both consumers now cite the existing "Ghost-constraint discovery" entry type (Entry Schema by Type), whose fields already match `planning-rigor.md` § Ghost Constraint Hunting's log-content list exactly. `grep -rn "Ghost Constraint Scan" src/ README.md` → 0 hits; no schema added.
- **README per-suite prose counts refreshed from a live run.** The Contributing section's hand-maintained breakdown had drifted (643 total / blast-radius 37 / both parity suites 4); now 652 total — blast-radius 41, check-doc-parity 7, check-readme-parity 6 — matching the machine-checked badge and `TEST_COUNT`.

### Added

- **F3 — real-CLI FAIL-branch tests for both parity gates.** `check-doc-parity.mjs` and `check-readme-parity.mjs` accept opt-in `IP_CHECK_DOC_PARITY_ROOT` / `IP_CHECK_README_PARITY_ROOT` env overrides read ONLY inside their `isEntryPoint` blocks (importers and the default CLI path byte-identical; Makefile/build.ps1 untouched — post-change `make validate` output differs only by the deliberate 646→651 count line). Tests now spawn the REAL scripts against temp fixture roots (the `check-test-count.test.mjs` model): doc-parity missing-row / extra-row / both-simultaneously, readme-parity version-mismatch / count-mismatch / both (two FAIL lines, exit 1) — and the `wrapper.mjs` hand-copied reimplementation test is DELETED, replaced rather than kept alongside (D-003, anchored).

## [2.54.0] - 2026-07-17

**Fifth adversarial pass over the 7 sub-agent definitions — three parallel explorers (contract/ordering, residuals/freshness, interruption/resume), one live HIGH ordering bug, one live-incident-confirmed protocol blind spot, and the cheap half of the recorded-residual backlog swept.** The headline pair: (1) the archivist's SYSTEM.md rewrite (Step 4) had NO post-rewrite `[atlas-cap]` validation — the exact sibling of the LESSONS.md ordering bug v2.53.0 fixed, missed on the structurally-identical step while `plans/SYSTEM.md` sat at 298/300 lines; and (2) the protocol modeled FAILURE-that-reports richly (leash, revert-first, 3-strike) but DEATH-that-reports-nothing not at all — proven live when an archivist was killed mid-CLOSE and the orchestrator had to improvise re-entry (this release's own step 1 then hit the same class: 5 executor spawns died on API 529s, resumed monolithically via the artifact checks this release codifies). Deferred, recorded in D-001/D-002: AskUserQuestion contract modernization, moving the state.md CLOSE write pre-spawn (document-the-lag chosen instead), N9. The `file-formats.md` PC-REFLECT sibling was initially deferred as "byte-gated" — the iteration-1 review FALSIFIED that premise (no SKELETON region exists there; `[header-copy]` cannot trip on a parenthetical) and the completion-fix loop fixed the line directly. Suite **643** (was 641; 2 interrupted-CLOSE fixtures), 0 failures; **0 committed files added, 0 new abstractions**.

### Added

- **Interrupted-CLOSE anomaly detection in `bootstrap.mjs resume`/`status`.** Both commands only run while `plans/.current_plan` exists, so `state.md` = CLOSE is the crisp signature of a close that died between its state.md write and the pointer unlink: `resume` now prints a 2-line `ANOMALY … INCOMPLETE CLOSE — re-run \`bootstrap.mjs close\` once` block, `status` appends ` | INCOMPLETE CLOSE: re-run close` to its single line (one-line pipe-clean contract preserved, no exit-code changes, ENOCLOSE untouched). Two regression fixtures pin both outputs.
- **`SKILL.md` § Sub-Agent Non-Response** — the missing failure-taxonomy dimension. A sub-agent killed/interrupted mid-procedure reports nothing; detection is artifact-based (expected artifact absent or partial), and the rule routes each state to its existing partial-state check (EXPLORE re-spawn-once, PLAN section-verify, EXECUTE Recovery step 12, REFLECT Gate-In partial-evidence, CLOSE pointer check) instead of re-running a state from zero.
- **Recovery item 13 — CLOSE re-entry.** Pointer gone = close completed; pointer present with CLOSE-shaped artifacts = archivist interrupted → archivist Steps 1-4 are batch-safe to re-run (new ip-archivist Rules bullet: verify LESSONS/SYSTEM don't already contain this plan's synthesis first), then `bootstrap.mjs close` exactly once. Documents the state.md lag: the CLOSE transition is written INSIDE `bootstrap.mjs close` (Step 5), so a kill during Steps 1-4 leaves a pre-CLOSE state.md next to CLOSE-shaped artifacts.
- **Recovery step 12 — uncommitted-partial-edit branch.** When no step commit exists, check `git status --porcelain` before re-executing (dirty tree = executor died mid-step: revert first), and cross-check `changelog.md`'s trailing lines against `git log` for logged-but-uncommitted limbo lines.

### Fixed

- **F1/BUG-1 — archivist Step-4 post-rewrite `[atlas-cap]` gate (HIGH).** Step 2's validator run predates the SYSTEM.md rewrite, and `bootstrap.mjs close` never validates — no code path checked the atlas cap against the file Step 4 actually writes. Step 4 now re-runs `validate-plan.mjs` after the rewrite; unlike Step 3's `[lessons-eviction]` WARN (decision-support, never blocks), an `[atlas-cap]` ERROR is a genuine blocker: Step 5 MUST NOT run until the re-run is clean (curate by demote-by-staleness, never truncate). Zero validator code needed — same fix shape as Step 3's v2.53.0 gate.
- **GAP-1/DRIFT-1 — ordering honesty at the two validator-consumer sites.** The orchestrator's CLOSE verify-list is now explicitly unordered ("confirm all of", naming both post-rewrite gates) instead of implying a sequence that contradicted archivist Steps 1-6; `state-reflect.md` item 18 now names the archivist's Step 2 + post-rewrite re-runs as the authoritative pre-close validator gate, so a future edit can't turn item 18 into a hard gate that reproduces the ordering-bug class a third time.
- **Residual sweep (N5/N6/N8 + pass-2 NOTEs).** `-passM` re-review naming now appears at ALL consuming pointers — the 5 free-prose sites, +1 found by the pattern sweep (`state-reflect.md` item 10), and the PC-REFLECT contract line in `file-formats.md` itself (initially deferred as byte-gated; premise falsified by the iteration-1 review, fixed in the completion-fix loop) — leaving `grep -rn 'review-iter-N' src/ CLAUDE.md README.md | grep -v passM` at zero hits; ALL 5 fold-in/verdict "(iteration ≥ 2)" parentheticals (4 planned + the file-formats.md 5th the verifier's criterion-8 sweep caught) are reworded to "(when a review ran)" so an iteration-1-by-choice review's Concerns/Verdict are unambiguously in-scope — every remaining `iter≥2` grep hit is a spawn-default threshold carrying the carve-out, including CLAUDE.md:30 (N8, fixed on this CLAUDE.md touch per its own next-touch convention); EXPLORE dispatch step 5's gap-record branch says "still missing or empty"; the File Ownership `findings/{topic}.md` row carries the empty-file-deletion carve-out word-identically in SKILL.md and README; ip-orchestrator.md documents WHY only the orchestrator declares `memory: project`. The completion-fix loop also hardened this release's own recovery clauses per the review's WARNINGs: the archivist re-entry rule and Recovery item 13 now state the Step-3/4 post-rewrite validator gates re-run even over rewrites the interrupted run completed, and Recovery item 0 checks for close evidence before resurrecting a missing pointer (items 0/13 no longer conflict).

## [2.53.0] - 2026-07-16

**Six confirmed findings from the epistemic-deconstructor review session (`analyses/analysis_2026-07-16_49c49eba`), each independently re-verified against live source before fixing — one unmodeled O(N) scan narrowed, one silent-eviction blind spot gated, four doc fixes.** The headline pair guards the knowledge substrate itself: the reverse-anchor decisions scan no longer reads every plan directory ever created, and LESSONS.md curation at CLOSE is no longer invisible — a WARN-only count-invariant gate diffs each close's `[I:5]` set against the previous close's snapshot, with every trim-dropped line preserved in an append-only archive. Deliberately NOT done: fuzzy/similarity matching in the eviction gate (the repo's own [I:5] proxy-gate lesson; an equal-count content swap is a recorded limitation), a committed index artifact for the scan (rejected — the narrowing converges the algorithm to what its one consumer actually needs), and F6's git-shelling numstat cross-check (deferred, new capability class). Suite **641** (was 635; 2 decoy-proof + 4 eviction tests), 0 failures; **0 committed files added.**

### Changed

- **F2 — `collectKnownDecisionIdsByPlan` narrowed from O(all-plan-dirs) to O(anchor-referenced plans).** `checkReverseAnchors` now collects the strict-anchor plan-id set in a first pass over the same per-file reads, and the decisions scan reads only {active plan ∪ referenced plans} decisions.md plus consolidated `plans/DECISIONS.md` — replacing the unconditional walk of every `plans/*/decisions.md` ever created (shipped unmodeled in 9b8d405). Cost note (first compliance instance of the new checklist rule below): O(referenced-plans · bytes), full-validator path only (REFLECT/CLOSE, 2-3× per plan lifecycle); `--pre-step` untouched. Behavior-frozen: full-validator output on the live tree is byte-identical before/after, all pre-existing `[anchor-*]` tests pass unmodified, and a decoy-dirs unit test proves unreferenced plan dirs are never parsed (their Map keys are absent — the old implementation would have included every decoy).

### Added

- **F1 — `[lessons-eviction]` WARN/INFO-only full-validator rule, plus the archivist's post-rewrite re-run.** The new rule compares `plans/LESSONS.md`'s `[I:5]` entry count against the previous close's `lessons_snapshot.md` (previous plan resolved via `plans/INDEX.md`'s last data row): WARN on a count decrease with a diff-style dropped/added-line summary as decision-support, INFO when no baseline exists (no INDEX row, or the previous plan predates the snapshot mechanism), silent otherwise. It NEVER blocks CLOSE — no ERROR severity anywhere in the rule, and it is unreachable from `--pre-step`. Completing the loop, `ip-archivist.md` Step 3 now re-runs the full validator AFTER the LESSONS.md rewrite and reviews any `[lessons-eviction]` WARN — Step 2's validator run precedes the rewrite and cannot see it.
- **F3 — LESSONS overflow archive.** Every line the archivist's over-cap trim drops is first appended to `plans/LESSONS-archive.md` (append-only, runtime-created, each line tagged ` [close: <plan-id>]`, never read by any protocol step by default) — curation is now recoverable instead of silent. Documented alongside the lessons-snapshot docs in `file-formats.md`.
- **F5 — full-corpus-walk cost-note rule.** CLAUDE.md's Validation Checklist now requires any change adding a full-corpus walk over `plans/` (reads every plan directory) to carry a one-line cost note in its CHANGELOG entry — Big-O in plan-dir count, plus which validator/gate path triggers it and how often. The rule exists because F2's scan landed unmodeled; the F2 entry above is its first compliance instance.

### Fixed

- **F8 — CLAUDE.md "Updating Local Skill" modernized to sync-skill-first.** The section still led with the pre-v2.30.0 manual `cp` procedure — the exact copy-only orphan class `make sync-skill` was built to fix (a `cp`-only sync cannot remove repo-deleted files; v2.35.0's `xml.mjs`/`changelog.mjs` would have stayed live in the install forever). Now leads with `make sync-skill` / `.\build.ps1 sync-skill`, states WHY prune-before-copy matters and that the shared `~/.claude/agents/` dir is pruned ONLY of this skill's own `ip-*.md` files (never flatten to delete-and-copy), and demotes the manual `cp` block to a clearly-labeled no-prune fallback.
- **F4 — SKILL.md Recovery step 11 grep-not-read.** The context-loss recovery list told the agent to read `plans/INDEX.md` for topic-to-directory mapping; it now says grep by topic keyword (each row is one line; do not read the whole file) — a whole-file read defeats the index's purpose as the corpus grows.

## [2.52.0] - 2026-07-16

**Agent-prose freshening from the fourth consecutive adversarial pass over the 7 sub-agent definitions (after v2.48.0, v2.50.0, v2.51.0) — three parallel explorers, zero new BUGs: every finding is a missing instruction, an unstated runtime bound, or spec-lagging-practice.** The strongest cross-explorer-confirmed finding was a dead claim: Conflict Prevention asserted worktree isolation that was never built — rewritten to the sequential-executor truth, with the README mirrors swept (`grep -rn worktree src/ README.md` → zero). Every known unbounded orchestrator loop and unhandled branch now has a stated bound or escalation, and two practiced-but-undocumented conventions (the iteration-1 attack-before-release review, the `review-iter-N-passM.md` re-review naming) are codified. Deferred follow-ups, recorded in the plan: a `<skill-path>` wording-parity gate (new gate machinery, its own plan), structured verifier output (no confirmed harness feature), the SYSTEM.md cap floor (no practical occurrence). Suite **635**, 0 failures; **0 files added, 0 new abstractions**.

### Fixed

- **C-2/F-4 — dead worktree-isolation ghost-claim removed from Conflict Prevention.** `SKILL.md` rule 4 (and two README mirror sites) claimed executors parallelize via `isolation: "worktree"` — a mechanism asserted since 2026-04-06 and never built, independently confirmed dead by two explorers. Rewritten TO TRUTH rather than deleted (rules 1-3 form a mechanism list, and the sequential-single-executor fact IS the operative conflict-prevention mechanism): exactly one Executor is spawned at a time, so executor file conflicts cannot arise. Pattern-swept, not named-site-fixed: `worktree` now greps to zero across `src/` + README.
- **C-1 — compression-gate pointer drift.** `SKILL.md` cited "(PLAN step 0)" for the compression gate; the gate lives at PLAN step 0.5. The one-token drift class no mechanical gate sees.

### Added

- **F-1 — the iteration-1 attack-before-release review option, codified at all 9 reviewer-gate sites.** The "or earlier by orchestrator choice (e.g. an iteration-1 attack-before-release pass ahead of a release/version bump)" clause — practiced 4x and recorded in `plans/SYSTEM.md`, but absent from the agent layer — now appears at every reviewer-gate site (`ip-reviewer.md` description, `ip-orchestrator.md` REFLECT dispatch, `state-reflect.md` item 22, SKILL.md + README Agent Definitions rows, README dispatch prose + tree comment, `blast-radius.md` consumer cell), landed in ONE commit with a repo-wide pattern sweep classifying every `iter≥2` pattern hit. The iter≥2 EXTENDED-tier DEFAULT is unchanged everywhere — the clause widens orchestrator choice, never lowers the threshold.
- **R-3/R-4/R-5 — PLAN dispatch loop bounds and the section-verify failure branch** (`ip-orchestrator.md`): 3 consecutive plan rejections without a materially different plan.md → surface a decomposition / EXPLORE-gap prompt instead of a silent re-spawn; 2 consecutive `NEEDS_EXPLORE` signals on the same goal → surface a scope/decomposition question instead of a third round-trip; the orchestrator's OWN section verification failing with no `NEEDS_EXPLORE` self-report → re-spawn ip-plan-writer naming the defective section, never silently proceed.
- **R-1/R-2 — explorer spawn hygiene, both halves.** Orchestrator: assign each topic a distinct kebab-case slug AT SPAWN (checking `findings/` for collisions first) and re-spawn a topic whose findings file is missing/empty ONCE before evaluating the gate. Explorer: a topic that yields nothing still writes its file with `(none found — see Risks & Unknowns)` (mirroring the reviewer's explicit-`(none)` rule), and a pre-existing `findings/{topic-slug}.md` not written this run gets a numeric suffix plus a reported collision.
- **R-6..R-11 — six small-site runtime guards.** Mid-EXECUTE resume now checks `git log` for the current step's commit tag before re-spawning the executor (already-committed step → Post-Step Gate, not re-execution; SKILL.md Recovery item 12). A `# DECISION` anchor whose rationale contradicts the current step's approach is a named Surprise-discovery trigger (`state-execute.md`). A verification command exceeding its stated bound (default 2 minutes) is aborted and reported `Result: FAIL` with a timeout Evidence line rather than hanging the REFLECT gate (`ip-verifier.md`). An empty/placeholder Verification Strategy (0 verified criteria) is FAIL-equivalent for the CLOSE recommendation (`state-reflect.md` item 23). A `bootstrap.mjs close` stderr containing the consolidated-merge WARNING means CLOSE is NOT complete — the archivist reports the failure and the intact per-plan file locations (`ip-archivist.md`). All module edits extend existing items' text — zero renumbering.
- **R-10 + C-3 — reviewer conventions codified.** A re-review of an already-reviewed iteration writes `review-iter-N-passM.md` (M=2,3,…), never overwriting a prior pass — named in `ip-reviewer.md` Output Format and mirrored into BOTH File Ownership tables (byte-identical first cells; `check-doc-parity.mjs` green). The reviewer's "missing decision-refs" bullet now cross-points the v2.51.0 `[changelog-dref-orphan]` WARN: the orphan half is automated, the reviewer's remaining judgment half is "should this `-` have carried a dref at all".

## [2.51.0] - 2026-07-16

**Two low-cost knowledge-graph byproducts from the epistemic-deconstructor analysis (`analyses/analysis_2026-07-16_c3232302`), both strictly additive: the wiring checker now serializes the cross-reference edges it already verifies, and the plan validator now joins changelog decision-refs against decisions.md.** The one notable pre-plan finding: the analysis's "`src/references/` placement syncs for free" premise was FALSE — every copy path in Makefile and build.ps1 is `*.md`-globbed, so a `.jsonl` there ships nowhere, and the only path that would notice it is the whole-dir sync-verify diff, which it would BREAK. Resolved by the generated-only design (D-002): the artifact is gitignored, never committed, excluded from the sync diff, removed by `clean`, and invisible to every `*.md` packaging glob by construction. What did NOT change: no agent contract, no template, no SYSTEM.md generation, no new consolidated file, no mermaid data plane. Suite **635**, 0 failures; **0 tracked files added, 1 new abstraction (`serializeEdges`).**

### Added

- **`--emit-edges [path]` on `check-agent-wiring.mjs` — the checker's verified cross-reference edges as JSONL.** Opt-in flag; no-flag runs stay byte-identical read-only. Edges are collected at the 3 scan functions' verified-OK points, in the SAME match loop that feeds `issues` (anti-proxy: one enumeration, two consumers — no parallel scanner to drift). A pure exported `serializeEdges()` dedupes, sorts by an explicit `(src, line, dst, type)` plain-string comparator, fixes key order `{src, dst, type, line}`, and terminates with a single trailing newline — two runs on an unchanged tree are byte-identical. Default path `src/references/kg-edges.jsonl`, a generated-only artifact (gitignored, excluded from the sync-skill diff, removed by `clean`). Wired into both `make validate` and `build.ps1 validate` (~172 edges on the current tree). Rule (d) file-level skill-path checks and unresolvable citations are deliberately excluded from the edge graph.
- **WARN-level `[changelog-dref-orphan]` join-integrity check in `validate-plan.mjs`.** Every `changelog.md` dref (`D-NNN`) must now resolve to a `## D-NNN` entry in the same plan's `decisions.md`. Reuses `parseDecisionsEntries`; the join fires on any 8-field line's non-`-` dref, shape-valid or not — a shape-invalid dref draws both `[changelog-malformed]` and this WARN (accepted double-report) — and `CHANGELOG_SPEC` stays the sole field-shape authority (the source-grep test is untouched). WARN-only: the exit code is unaffected, and the `--pre-step` path is untouched. The one colliding test fixture (D-1000) was reconciled with a real `## D-1000` entry.

## [2.50.0] - 2026-07-16

**A seventh deep review of the 7 sub-agent definitions — three parallel explorers, every finding re-validated firsthand against live source, then an adversarial pre-release attack that paid for itself twice.** The static pass found one latent BUG and four contract-drift defects (all the "mechanical gates stay green while restatements drift" class); the pre-release ip-reviewer then caught two half-applied fixes before the version bump — an N-place sibling that the first fix missed, and a catch-all the fix itself dropped. Every finding is a restatement that drifted from a correct authoritative source (a script, a Presentation Contract, a reference doc, or SKILL.md); no script behavior changed. Suite **610**, 0 failures; **0 files added, 0 new abstractions, net roughly line-neutral.**

### Fixed

- **O-1 (BUG) — EXECUTE pre-step-gate exit-2 handler now maps each gate slug to a distinct action.** `ip-orchestrator.md`'s exit-2 handler applied ONE undifferentiated procedure (append Fix-Attempts line → revert → emit PC-EXECUTE-LEASH → REFLECT) to all four `validate-plan.mjs --pre-step` slugs, though `runPreStepGate` emits them for semantically distinct conditions. For `no-plan` (state.md unreadable) the "append a line to state.md" step was impossible; for `iteration-cap` (iter≥6) it produced a leash/rollback prompt instead of SKILL.md's decomposition request (and "both attempts" may not exist); for `wrong-state` it emitted a leash instead of Recovery from Context Loss. Split into a per-slug mapping — `leash-cap` unchanged (the one case it got right), `iteration-cap`→decomposition, `wrong-state`/`no-plan`→Recovery with no state.md write — fulfilling the "full slug→action mapping" SKILL.md § Autonomy Leash already pointed here for. A fallthrough arm covers the Exit-1 handler's synthesized `gate-error` slug and any future slug (completion-fix, found by pre-release review after the split first dropped the pre-existing catch-all).
- **W-1 (drift) — verifier unassigned-criterion routing.** `ip-verifier.md` told the verifier to report an unassigned criterion "under `Not Verified` (Result FAIL, Evidence …)", but `## Not Verified` is a `What | Why` table — `Result`/`Evidence` are columns of the separate `## Criteria Verification` table. Retargeted to a `Result: FAIL` row in `## Criteria Verification`.
- **W-2 (drift) — executor relay-fidelity overstatement.** `ip-executor.md`'s blanket "MUST paste each field verbatim" contradicted `file-formats.md`, which specifies PC-EXECUTE-STEP as digest and PC-EXECUTE-LEASH as verbatim(items 1,4)/digest(2-3). Replaced with a pointer to each contract's **Fidelity** line plus "no field may be silently dropped" — no third copy of the fidelity split.
- **E-1 (drift) — Complexity-Budget line target, in all three sibling sites.** `ip-plan-writer.md`, `SKILL.md`, and `README.md` each said "net-zero" (or "net-zero or negative"); canonical is "net negative or neutral" (`complexity-control.md`, `file-formats.md`, `bootstrap.mjs`). "Net-zero" wrongly flags a healthy net-negative diff as off-target. Fixed all three (the second and third caught by pre-release review — the recurring N-place-drift class: the first fix touched one site and created a fresh divergence).
- **E-2 (drift) — README File Ownership table row shape.** `README.md` merged `plans/LESSONS.md` + `plans/SYSTEM.md` into one row labeled "All planning agents"; `SKILL.md` keeps two rows, each naming three readers (Orchestrator, Explorer, Plan-writer). Split to mirror SKILL.md byte-for-byte. Invisible to `check-doc-parity.mjs` (keys-only) — hand-verified.

### Changed

- **O-2 — CLOSE-dispatch Verify list completeness.** `ip-orchestrator.md`'s CLOSE step-2 Verify list checked 4 of ip-archivist's 6 ordered steps; added the consolidated-file >500-line compression check (Step 6).

## [2.49.0] - 2026-07-15

**A new domain-agnostic Root-Cause-Analysis methods reference — five structured techniques for the "why did this fail" work that REFLECT already mandates but never taught how to do.** `src/references/root-cause-analysis.md` gives the analyst a real toolkit: 5 Whys (with the Toyoda/Toyota lineage and IP's own boundary/lever stop rule in place of a fixed question count), a Fishbone/Ishikawa 6-category scan — People/Process/Tooling/Dependency/Environment/Data — that operationalizes the existing "Multiple roots are normal" rule, an opt-in Fault Tree for multi-cause failures, and a Cynefin selector note on when a linear cause-chain misleads. The doc holds *methods only*: it EXTENDS the canonical 4-part RCA schema in `planning-rigor.md` rather than restating it, and is wired via `state-reflect.md` item 16 + SKILL References using the `python-software.md` conditional-citation shape minus the domain gate. Suite **610**, 0 failures; **1 file added, 0 new abstractions, 0 scripts/agents/plan-file artifacts.**

### Added

- **`src/references/root-cause-analysis.md` — RCA methods reference.** Five domain-agnostic techniques (5 Whys, Fishbone/Ishikawa, opt-in Fault Tree, Cynefin selector) drawn only from canonical frameworks. Cross-references the canonical 4-part schema in `planning-rigor.md` (single prose link, no schema duplication) and is cited from `state-reflect.md` item 16, the SKILL References section, and the CLAUDE.md reference tree. No new agent, plan-file, script, or gate.

## [2.48.0] - 2026-07-15

**A sixth deep review of the 7 sub-agent definitions — three parallel explorers, every finding re-validated firsthand by the orchestrator — fixing 11 cross-agent contract defects (one BUG, plus drift, a dead signal, ownership-table gaps, and an unpersisted signal) that all prior passes and every mechanical gate stayed green through.** The citation layer came back clean (the stable-symbol discipline already held); the yield was semantic contract drift no gate can see. `[IRREVERSIBLE]`-tagged steps were previously un-executable (the executor flat-refused, contradicting the tag/dry-run/rollback machinery the rest of the protocol builds); the reviewer's `## Blind Spots` was written every iter≥2 and read by nobody; the File Ownership table under-listed real readers/writers; and verifier Concerns were shown once then discarded. Suite **610**, 0 failures; **0 files added, 0 new abstractions.**

### Fixed

- **A1 (BUG) — executor irreversible-ops now executable-with-safeguards.** `ip-executor.md`'s "Irreversible operations: refuse and report back" flatly contradicted `state-execute.md`, `code-hygiene.md § Irreversible Operations`, and `file-formats.md` (all describe execute-WITH-safeguards). As written, any legitimately `[IRREVERSIBLE]`-tagged step dead-ended at the executor. Rewritten to: follow the safeguard procedure (checkpoint rollback plan + dry-run), report back to the orchestrator for user confirmation, and execute only after confirmation — never a flat permanent refusal.
- **A2 — Post-Step Gate changelog verb.** `ip-orchestrator.md` said the gate "updates" changelog.md; the authoritative `state-execute.md` says "confirm" (changelog is Executor-owned). Aligned to "confirm … do not write it" to prevent a concurrent-write.
- **A3 — reviewer `## Blind Spots` wired into PC-REFLECT item 4** across all 4 sites (ip-reviewer Relay Contract, ip-orchestrator, file-formats, state-reflect), ending a dead signal (same class as the previously-fixed Verdict/NEEDS_EXPLORE).
- **A4/A5/A7 — File Ownership table accuracy** (SKILL.md + README.md, hand-mirrored): Archivist added as a `decisions.md` writer (CLOSE-time Anchor-Refs backfill); Reviewer added as a `plan.md` reader; Orchestrator added to the readers of `changelog.md`/`plans/DECISIONS.md`/`plans/LESSONS.md`; `checkpoints/*` scope broadened to "PIVOT + EXECUTE leash-hit".
- **A6 — explorer now reads `plans/LESSONS.md`** before researching (the ownership table already claimed it did), so EXPLORE surfaces prior failed approaches / gotchas.
- **A8 — executor failure-report field count** corrected ("report all 5 fields" → 4; the 5th, the user prompt, is orchestrator-authored).
- **A9 — verifier Concerns now persist.** Added a `## Concerns` section to the `verification.md` schema (byte-gated `bootstrap.mjs` seed ↔ `file-formats.md` SKELETON, plus the served worked-example) and wired the orchestrator to merge Concerns into it — durable across iterations, not only relayed to chat once.
- **A10 — reviewer read-only-Bash rail** added (mirroring ip-explorer's), closing an asymmetric guardrail.
- **A11 — verifier cross-checks plan.md.** The verifier now independently reads plan.md's Verification Strategy and reports any assigned-but-missing criterion under Not Verified rather than silently skipping it.

Deferred (explicit user decision): A12, a build gate verifying cited symbol names still exist — all currently resolve.

## [2.47.0] - 2026-07-15

**A fifth deep-consistency review of the 7 sub-agent definitions — three parallel explorers, every finding re-verified firsthand — fixing three cross-file inconsistencies that all prior passes and every mechanical gate missed.** The Lifecycle Matrix claimed `verification.md` is writable during EXECUTE when nothing writes it there (only PLAN seeds it and REFLECT merges it); a stale `bootstrap.mjs:1698-1699` line citation for the ENOCLOSE throw had drifted identically in **two** files (the real throw is in `cmdCloseInner`), a silent-drift class no gate re-verifies; and the optional `## Atlas Contradictions` findings section — written by `ip-explorer`, consumed by the orchestrator — was undocumented in the canonical findings template. All localized prose/doc edits behind green parity gates. One sub-explorer over-flag ("six-section vocabulary") was investigated and rejected as a non-bug. Suite **610**, 0 failures; **0 files added, 0 new abstractions.**

### Fixed

- **F1 — Lifecycle Matrix vs reality drift.** `SKILL.md`'s File Lifecycle Matrix marked `verification.md` `W` (writable) in the EXECUTE column, but the entire dispatch chain disagrees: the EXECUTE Post-Step Gate writes only plan/progress/state/changelog, `ip-executor.md` has zero `verification.md` references, and the File Ownership table names only the Plan-writer (PLAN seed) and Orchestrator (REFLECT merge) as writers. Cell corrected `W` → `—`. No mechanical gate asserts on the matrix — this was a contract-audit finding, not a wiring-gate one.
- **F2 — stale ENOCLOSE line citation, durably repointed (2 files).** `ip-orchestrator.md` and `ip-archivist.md` both cited `bootstrap.mjs:1698-1699` as the second-close ENOCLOSE throw site, but those lines are the unrelated `releaseLock()` cleanup — the real throw is inside `cmdCloseInner`'s no-active-plan branch. A repo-wide sweep confirmed these were the only two `*.mjs:NNNN` prose citations, both stale (this pair had drifted ≥3× historically). Replaced the drift-prone line number with a symbol reference so it cannot drift again.
- **F3 — undocumented inter-agent findings section.** The optional `## Atlas Contradictions` section (written by `ip-explorer` when a finding contradicts `plans/SYSTEM.md`, promoted by the orchestrator to a `[CONTRADICTED iter-N]` flag) was absent from the canonical findings-file schema in `references/file-formats.md`. Added a one-line documentation entry with a pointer to `ip-explorer.md` § System-Atlas Awareness.

## [2.46.0] - 2026-07-15

**The orchestrator now surfaces the version + credit banner at its in-thread load-up (engagement) moment, via a new `banner` subcommand.** A dedicated `bootstrap.mjs banner` subcommand prints `creditBanner(resolveSkillVersion())` with no active plan required (it reads only `VERSION`), and all 3 orchestrator announcement sites now emit `iterative-planner v<VERSION> — Developed by Nikolas Markou @ Electi Consulting` before their existing `[iterative-planner] …` mode line — so the attribution is visible the moment the orchestrator engages, not only on `new`/`resume`. `creditBanner()` stays side-effect-free (D-001); the version flows through `resolveSkillVersion()`'s `unknown` degrade path (D-004). Suite **610**, 0 failures; **0 files added, 0 new abstractions.**

### Added

- **`bootstrap.mjs banner` subcommand.** Prints `creditBanner(resolveSkillVersion())`; requires no active plan (reads only `VERSION`). The log happens in the dispatch branch, outside the helper, preserving `creditBanner()`'s side-effect-freedom.
- **Version + credit banner at all 3 orchestrator announcement sites.** `SKILL.md` modes 2 & 3 and `ip-orchestrator.md` now emit a `node <skill-path>/scripts/bootstrap.mjs banner` load-up line before the `[iterative-planner] …` mode line. Covered by a pattern-based test (`v\S+`, bump-proof); TEST_COUNT 609→610.

## [2.45.0] - 2026-07-15

**A user-facing bootstrap CLI attribution banner, bundled with a fourth deep review of the 7 sub-agent definitions that fixed ten contract-drift / dead-wiring / freshening gaps three prior passes missed.** `bootstrap.mjs new` and `resume` now print `iterative-planner v<VERSION> — Developed by Nikolas Markou @ Electi Consulting` directly under their load-up banner, via an earned `creditBanner()` helper (≥2 call sites; `cmdStatus` left pipe-clean by design). The agent review — three parallel explorers, every finding re-verified firsthand — landed two real bugs (PIVOT context-loss, verifier table schema) plus eight smaller contract/clarity fixes, all localized prose edits behind green parity gates. Suite **609**, 0 failures; **0 files added, 1 earned abstraction.**

### Added

- **Bootstrap CLI credit banner.** `cmdNewInner` and `cmdResume` print `  iterative-planner v<VERSION> — Developed by Nikolas Markou @ Electi Consulting` under the `Initialized`/`Resuming` line, via a new module-level `creditBanner(version)` helper — a 3rd consumer of `resolveSkillVersion()` (still degrades to `unknown`, never throws). `cmdStatus` is deliberately untouched to keep its one-line output pipe-clean. Covered by a pattern-based test (`v\S+`, bump-proof); TEST_COUNT 608→609.

### Fixed

- **PIVOT read-set was incomplete (F1).** Neither the `state-pivot.md` module nor the orchestrator's PIVOT dispatch loaded `plan.md`, `verification.md`, or `plans/SYSTEM.md` — all marked `R` at PIVOT by the Lifecycle Matrix and mandated by Mandatory Re-reads. A pivot could be decided without re-reading success criteria, prior verification, or the system atlas. Added all three to both operative copies.
- **ip-verifier Relay Contract table schema mismatch (F2).** The verifier emitted a 5-column table while the canonical `verification.md` Criteria table it feeds is 6-column (`# | Criterion (from plan.md) | Method | Command/Action | Result | Evidence`); "paste verbatim" was incompatible with the merge target. Aligned to the 6-column canonical shape.
- **`NEEDS_EXPLORE` signal had no consumer (F3).** The plan-writer emitted it but the orchestrator's PLAN dispatch never checked for it — a dead signal, the same class as the pre-v2.44.0 Verdict field. Wired an orchestrator-side consumer that routes PLAN→EXPLORE.
- **SKILL.md Conflict-Prevention rule 3 was stale (F4).** It claimed verifiers write `verification.md`; they hold no Write tool. Rewritten to the real mechanism — the orchestrator is the sole writer, merging each verifier's returned results.
- **ip-archivist anchor-grammar enumeration incomplete (F5).** Listed 4 of 5 anchor styles, omitting the HTML/Markdown `<!-- DECISION -->` form — the only recognized form in the `.md` files the archivist audits. Added it.
- **Four smaller contract/clarity gaps (F6–F10).** PLAN dispatch now reads the `findings.md` index (F6); ip-verifier "Not Verified" output gained a verbatim-relay clause (F7); `anchor-refs-missing` now has a prescribed remediation before close (F8); `state-execute.md`'s false "file-based enforcement" claim for the Pre-Step Checklist was reframed to honest advisory (F9, no agent ticks the boxes); and `complexity-control.md`'s self-contradictory earned-abstraction rule ("≥2 call sites" vs "extract on the third occurrence") was standardized to ≥2 (F10).

## [2.44.0] - 2026-07-15

**A third deep review of the 7 sub-agent definitions — past the v2.42.0 and v2.43.0 passes — found one real runtime bug and nine contract/wiring/freshening gaps the earlier passes missed.** The headline (**O-01**): the autonomy leash's pre-step gate counts fix attempts **section-wide, not per-step** (`validate-plan.mjs` `runPreStepGate`), but no operative dispatch ran `reset-attempts` after a successful step — only PIVOT did — so two consecutive steps that each used ≥1 fix attempt would spuriously HARD-trip `leash-cap` on a step that never individually failed twice. SKILL.md already *spec'd* the new-step reset; only the dispatch failed to wire it. This release wires it, then — fittingly — the plan's own adversarial review exercised the `REFLECT→EXECUTE` edge legalized in v2.43.0 **twice** to finish an incomplete remediation: the first fix introduced a revert-first gap and mis-placed the leash-"continue" reset in the wrong state (the exact "an N-place fix's remediation is itself an N-place fix" trap), both caught by successive adversarial passes. Three passes converged **2 → 1 → 0** concerns. Suite **608**, 0 failures; **0 files added, 0 new abstractions.**

### Fixed

- **Autonomy-leash false positive: Fix Attempts never reset between successful steps (O-01).** `runPreStepGate` counts every `Step N, attempt M` line in the `## Fix Attempts` section regardless of step number; the only wired `reset-attempts` call was in the PIVOT module. Two 1-fix-then-succeed steps in a row would trip `leash-cap` on the second. Wired the reset into the orchestrator's EXECUTE SUCCESS branch and the `state-execute.md` Post-Step Gate as a **post-gate action** (not a 5th gate item — that would force a 4→5 N-place count edit across SKILL.md/file-formats), and into the `REFLECT→EXECUTE` re-entry (orchestrator REFLECT dispatch + `state-reflect.md`) so a user "continue" past a leash hit resets before the re-entry's pre-step gate re-trips.
- **Reviewer `## Verdict` was written to disk but read by nobody (R-01).** The three-value verdict (READY_TO_CLOSE/NEEDS_WORK/NEEDS_INVESTIGATION) had zero consumers repo-wide; routing keyed only off the Concerns list. Wired it into REFLECT routing (orchestrator dispatch + PC-REFLECT item 5 + `state-reflect.md` item 22) as a recommendation gate — a non-READY verdict cannot be silently overridden by a CLOSE recommendation — and documented it as consumed in `ip-reviewer.md`. Never bypasses the user CLOSE gate.
- **The operative (emit-state) PC-REFLECT item 4 dropped the verifier-Concerns clause (R-02)** that `ip-orchestrator.md` and `file-formats.md` both carried — N-place drift that silently lost the Concerns fold in monolithic mode. All three copies now byte-agree.
- **The step-1.5 leash-gate path reached REFLECT without revert-first (O-02 remediation).** The PC-EXECUTE-LEASH restatement had reordered + reworded its own canonical block, and the exit-2 handler omitted the revert-first that step 4 and the Autonomy Leash mandate. The restatement now references the canonical block; the exit-2 handler reverts-first; step 4 is descriptive-only (no double-revert).

### Changed

- **Orchestrator-local consistency (O-04, O-05, W-02):** the compression-gate prose no longer implies `changelog.md` is read at PLAN (it is only compressed); the pre-step gate is documented as re-running before every retry-spawn, not just a step's first; the explorer-promised `## Atlas Contradictions → [CONTRADICTED iter-N]` handoff now has an operative promotion step in EXPLORE dispatch.
- **Worker/archivist freshening (W-01, W-03, R-03):** `ip-plan-writer` gained the negative write-scope guard its two sibling workers already carry (it was the only broad-`Write` worker without one); `ip-executor`'s DRY item now cites `code-hygiene.md § Interface Contracts for Shared Assets` (the create-side half); a stale `L-007` citation (a numbering scheme no live artifact uses) was dropped from `ip-archivist`. The `ip-verifier` Relay Contract header was corrected to "items 3-4" (it covers both the table and Concerns).

### Note

- **O-03 (SKILL.md "CLOSE: final commit + tag" is spec'd but no agent implements it) was surfaced and deliberately deferred** by user decision — left as-is this release. The three adversarial passes each found a real defect a green `make validate` never would: a self-introduced revert-first gap, and a remediation that mis-placed the continue-reset in the wrong state — reinforcing (again) that an N-place fix's own remediation must be re-swept exhaustively after each patch.

## [2.43.0] - 2026-07-15

**A second deep review of the 7 sub-agent definitions — going past the v2.42.0 audit — found one real state-machine bug and a cluster of the same N-place-drift class the codebase keeps paying for.** The headline: the state machine had **no legal `REFLECT→EXECUTE` edge**, so `validate-plan.mjs` ERRORed `[transition]` on a completion-fix loop the protocol actually uses — v2.42.0 itself shipped over that live ERROR (D-005 of plan `0fcf9d47`). This release legalizes that edge across every definition site, then — fittingly — **uses it**: the plan's own adversarial review found the T-01 fix was incomplete (8, then 9, stale enumerations of REFLECT's outcome menu), and the remediation looped `REFLECT→EXECUTE` twice to finish. Two adversarial passes converged the stale-site count 8 → 1 → 0; the second pass caught a miss in the *same file* the first remediation had just edited. `bootstrap.mjs` diff = **one gated seed line** (the `state.md` Recommendation template, byte-paired with `file-formats.md` and enforced by `check-template-parity`). Suite **608**, 0 failures; **0 files added, 0 new abstractions.**

### Fixed

- **The state machine had no `REFLECT→EXECUTE` edge, yet the protocol uses one (T-01).** A same-iteration completion-fix loop (finish small REFLECT-surfaced fixes without a full PIVOT) was performed in practice and dispatched by the orchestrator, but absent from all sources of transition truth — the mermaid diagram, the Transitions table, `VALID_TRANSITIONS`, and the PC-REFLECT recommendation menu — so `validate-plan.mjs` ERRORed `[transition]` on it (blocking). Legalized the edge, narrowly scoped to same-iteration completion-fix remediation (`iter` does not increment; not a general re-loop), across **all** of: SKILL.md mermaid + Transitions table, `VALID_TRANSITIONS`, the canonical + orchestrator-inlined PC-REFLECT item 5, the operative `state-reflect.md` routing table + prose, the `state.md` Recommendation seed (byte-gated `bootstrap.mjs`/`file-formats.md` pair), and the README mermaid + prose. Added a regression test. The narrowness is documentation-level (the validator only checks adjacency, as it does for every edge); the real bound on the loop is per-hop user confirmation, not the iteration cap.
- **ip-verifier's `Write` grant was removed in v2.42.0 but both mirror tables still listed it (C-01).** SKILL.md's and README's Agent-Definitions tables still granted `Write` to a subagent whose frontmatter no longer has it — a half-applied fix, invisible because no gate compares the Tools column to frontmatter. Both cells now read `Read, Bash, Grep, Glob`.
- **README still claimed ip-verifier "fills `verification.md`" (C-02)** — the exact ghost `dcd9a34e`/D-004 killed in the File-Ownership table, surviving in the Agent-Definitions table. It returns a table the orchestrator merges; the role text now says so.
- **ip-archivist contradicted its own cited reference on STALE anchors (A-01).** It said they "must be removed before CLOSE — list any remaining as blockers"; `decision-anchoring.md` says a STALE anchor is a **non-blocking WARN** the agent may remove, keep with rationale, or convert. Reworded to match.
- **Stale `bootstrap.mjs:1697` ENOCLOSE citation (A-02)** in ip-orchestrator and ip-archivist — the throw is at `:1698-1699`; `:1697` only constructs the Error. Both corrected.

### Changed

- **The canonical PC-REFLECT item 4 now names the verifier-Concerns relay (C-03)** that ip-orchestrator and ip-verifier both already implement — the canonical doc was the stale one; the two live consumers had converged on richer behavior undocumented in the file they cite as authoritative.
- **Freshening (A-04, A-05, T-02):** ip-plan-writer's `Edit` grant now has an explicit same-iteration-revision purpose (reconciled with the "full rewrite" ownership claim); ip-executor cites the full `§ Revert procedures — manifest-touching reverts` heading; a misleading duplicate `REFLECT→CLOSE` comment was removed from `VALID_TRANSITIONS`.

### Note

- The T-01 fix was itself an N-place edit, and its **own remediation was also an N-place edit** — the second adversarial pass (run after the first remediation per the "attack again after remediation" discipline) found a 9th stale site two lines below the one the first remediation had just fixed, in the same file. Re-sweep every instance after each patch: a green `make validate` never sees a missed sibling copy. The `REFLECT→EXECUTE` edge legalized here was first exercised by this very plan.

## [2.42.0] - 2026-07-15

**A reflexive audit of the 7 sub-agent definitions found 13 contract/ownership defects that no mechanical gate could see — the wiring layer (`check-agent-wiring`, `check-template-parity`) was fully green, but the *semantics* were not.** Two were bugs (an instruction an agent cannot execute; a double-`bootstrap.mjs close` race), five were safety/capability gaps (a missing `<skill-path>` block, an uncreated nuclear checkpoint, an incomplete failure revert, an unrouted verifier signal, a drifted lessons vocabulary), six were dead-prose / DRY / clarity cleanups. All 13 fixed and then **adversarially reviewed before release** — that pass caught 3 half-applied edits, all remediated in the same iteration. `bootstrap.mjs` untouched (the one F7 "high-risk byte-gated" edit turned out to be a misread — the lessons seed is intentionally header-only, like `system`). Suite **607**, 0 failures; **0 files added, 0 new abstractions, net +7 lines**.

### Fixed

- **ip-plan-writer was told to run a script it cannot execute (F1).** Its `emit-template.mjs` fallback requires Bash, but the agent's frontmatter sets `disallowedTools: Bash` and its own rules forbid running code. Removed the dead fallback — it now points only to the Read-able `references/file-formats.md`.
- **`bootstrap.mjs close` could be invoked twice → `ENOCLOSE` crash (F2).** Both ip-archivist and ip-orchestrator claimed to run `close`. Made ip-archivist the single owner (it needs a genuinely post-close consolidated-compression step), reordered its steps so the SYSTEM.md rewrite precedes the one `close` call and compression follows it, and downgraded the orchestrator to confirm-only — **with a fallback that runs `close` itself only if the pointer still exists** (archivist demonstrably skipped it), restoring the pre-plan close guarantee without the double-close race.
- **ip-executor's failure revert was incomplete on manifest-touching steps (F5).** `git checkout -- …; git clean -fd` alone does not restore installed dependencies; added the strict manifest reinstall (`npm ci` / `cargo build` / `poetry install --sync` / …) the checkpoint lockfile-snapshot machinery was built to support, citing `code-hygiene.md § Revert procedures`.

### Added

- **ip-reviewer gained the standard `<skill-path>` resolution block (F3)** every other agent carries — it cites `references/*.md` and previously had no way to resolve them in a consuming project. All 7 agents now carry the block.
- **The mandatory iteration-1 nuclear checkpoint `cp-000-iter1.md` now has a named doer (F4).** The rule lived only in the EXECUTE state-module; neither ip-executor nor the orchestrator dispatch operationalized it, so the "revert to cp-000" safety net could silently never exist. ip-executor now creates it on the first EXECUTE step; the orchestrator's dispatch notes it.
- **ip-verifier's "Concerns" (suspicious-but-PASS observations) now relay into PC-REFLECT Item 4 (F6),** matching the reviewer's concerns path — previously they had no route into the user-visible gate-out and could be silently dropped.

### Changed

- **The LESSONS.md worked example uses the canonical category names (F7)** — Recurring Patterns / Failed Approaches (+ why) / Successful Strategies / Codebase Gotchas — that the archivist synthesis guide and the live file already use, instead of a drifted set. The bootstrap seed is intentionally header-only (sections are added by the archivist at CLOSE, the same unpopulated-seed pattern as `system`), so this is a documentation-example fix, **not** a bootstrap/byte-gated change; `check-template-parity` confirms the seed pair is byte-unchanged. Two pinned-sentinel tests updated in lockstep.
- **ip-verifier dropped its unused `Write` tool (F8)** — it only returns a table as text; the orchestrator owns the `verification.md` merge. Tools are now `Read, Bash, Grep, Glob`, matching its read/report-only role.
- **PC-PLAN now lists "Context" as a distinct required item (F13)** in both the canonical `file-formats.md` contract *and* the orchestrator's inlined copy that drives the render (the two had diverged).
- **Dead / duplicated prose cleared:** removed ip-plan-writer's dead PC-EXPLORE digest role and its mirrored cross-reference (F9); deduped the triplicated commit-tag-derivation paragraph to a single pointer to `SKILL.md § Git Integration` (F10); clarified ip-executor's first-vs-second failure report shape (F11); softened ip-explorer's unconfirmed "the orchestrator passes you SYSTEM.md" claim to match the actual dispatch (F12).

### Note

- The 13 fixes were adversarially reviewed before the version bump (not after). The review confirmed F4/F5/F6/F10/F11 and the F2 step-reorder correct, and flagged 3 half-applied edits — F13's orchestrator-side copy, an F7 vocabulary leftover in ip-archivist, and F2's missing close-fallback — all fixed in the same iteration before release. Green mechanical gates were, once again, not evidence the goal was met; the attack-before-release pass earned its cost.

## [2.41.0] - 2026-07-15

**Five consecutive iterations shipped or drafted a guard against a doc that lies to agents about bootstrap's bytes, and five reviewers each broke it the same way: the guard checked a PROXY for what `emit-template` serves — a region, a phrase set, a boundary — and every proxy was a hand-approximation of the slicer (`resolveTemplate`) that diverged from it on the first attempt.** The skeleton half nobody reads (iter-1), a 4-phrase prose set (iter-2), the first-of-two `<!-- TEMPLATE:END -->` boundary (iter-3), the last-exact-END boundary (iter-4a), an anchored whole-line marker grammar parallel to the slicer (iter-4b/5). v2.41.0 stops approximating: `[header-copy]` now runs over the SERVED ARTIFACTS themselves — `resolveTemplate(slug).body` for all 17 `VALID_TEMPLATES` slugs, the exact bytes `emit-template --name <slug>` hands an agent. The check CALLS the slicer, so **the thing checked IS the thing served** — there is no boundary, region, or grammar left between them to diverge. The entire boundary apparatus accreted across iters 3–4 is deleted (net −21 logic lines). This is the first adversarial review in six rounds that could not drive a poisoned header to an agent with the board green. **0 files added, 0 new abstractions, `bootstrap.mjs` diff empty, 17 slices byte-unchanged.** Suite **607**, 0 failures.

### Fixed

- **The fifth consecutive break — an anchored-vs-unanchored marker-grammar split.** `servedRegionEnd` and the `template-markers` rule found the served-region end with an ANCHORED whole-line regex (`/^<!-- TEMPLATE:<slug> -->$/` on a trimmed line), while `resolveTemplate` — the slicer whose bytes actually reach agents — finds a slug's marker with an UNANCHORED byte substring (`buf.indexOf("<!-- TEMPLATE:<slug> -->")`, first occurrence). Neutralize a slug's real standalone marker (`<!-- TEMPLATE:summary -->` → `<!-- SUMMARYSECTION -->` — nothing checked that a slug HAS a standalone marker) and plant that marker as a MID-LINE substring past `<!-- TEMPLATE:END -->` (`Fetch it via <!-- TEMPLATE:summary --> below.`) followed by `index`'s exact 2-line header and a fabricated line: the anchored boundary never saw the substring, so the checker's scan stopped before it, yet `resolveTemplate("summary")`'s first-occurrence lookup landed ON it and served the poisoned `index` header to every agent — `check-template-parity: PASS`, `make lint && make validate && make test` green at 615/615 (Reviewer 5, reproduced end to end at v2.40.0-dev). The "shared boundary" (D-008) reconciled the checker's two consumers with each other but never with the unanchored slicer whose output reaches agents. `CLAUDE.md` asserted a boundary that could be moved — false a fifth time.

### Changed

- **`[header-copy]` now checks the SERVED ARTIFACTS, and the whole boundary apparatus is DELETED.** For each of the 17 `VALID_TEMPLATES` slugs the checker resolves `resolveTemplate(slug, docBuf)` and scans that served body for any adjacent header line-pair of any `PLAN_TEMPLATES` template. The substrate is the slicer's real output — the union of everything agents can receive — not a doc region. A slug that fails to resolve (marker removed, renamed, or redirected so `resolveTemplate` returns `!ok`) is a **LOUD `[served-resolve]` FAIL naming that slug**; a removed/redirected marker can never silently drop a slug from the check (that silent drop was the enabling half of the fifth break). `servedRegionEnd`, `SLUG_MARKER_RE`, and the `template-markers` marker-grammar rule are gone; the checker imports `resolveTemplate` + `VALID_TEMPLATES` from `emit-template.mjs` instead of a boundary. Net **−21 logic lines** across the checker and `emit-template.mjs`; `resolveTemplate`'s byte-faithful slicing is untouched (all 17 `emit-template --name <slug>` outputs are byte-identical before and after). The one signature change is that `resolveTemplate` now accepts a pre-read `Buffer` as well as a URL — behavior-preserving.
- **The checker reads the doc once as a raw Buffer.** Its served substrate is the raw file bytes it read (not a UTF-8 decode/re-encode round-trip), so it is byte-identical to `emit-template`'s own raw read for all 17 slugs — the "thing checked IS the thing served" equality now holds unconditionally, even for a malformed doc (verified: `resolveTemplate(slug, buf)` in the checker byte-equals the live `emit-template --name <slug>` CLI for all 17 slugs, 0 mismatches).

### Note — what is still allowed to be true

**This iteration closes the ENTIRE boundary-divergence / served-vs-scanned class (iters 3, 4a, 4b, 5) — there is no boundary, region, or grammar left between the checker and what `emit-template` serves.** Five holes remain, orthogonal to the substrate (they live in the header *comparison*, which is unchanged), and all five are named in `CLAUDE.md`:

1. **Skeleton lines *below* a header are still restated in the served bodies, un-gated.** A truthful populated example cannot drop a table's header row; gating them needs a per-slug allowlist — rejected (the rot path that turned `check-doc-parity` into a column-1-only comparison). If bootstrap changes one, the served body goes stale and nothing goes red.
2. **`plan` and `progress` have 1-line headers** (`# Plan v0`, `# Progress`) — below the 2-line threshold, which is not lowered because a 1-line rule would fire on every `# Progress` heading in the doc.
3. **The rule catches HEADER COPIES, not arbitrary false content.** A fabricated NON-header line, a paraphrase, or an invented header in a served body restates no template header, so it passes — a wrong-content defect, outside `[header-copy]`'s charter (which is: no served artifact restates bootstrap's *header* bytes). The same is true of a marker SWAP serving a valid-but-wrong template. `emit-template`'s per-slug sentinel tests are smoke tests, not adversary-proof: a redirect can include the public sentinel string and pass both the sentinel test and `[header-copy]`.
4. **A byte-different but VISUALLY IDENTICAL copy evades it** — a trailing space, an NBSP, a unicode look-alike, or a blank line / HTML comment interleaved *between* two header lines (breaking adjacency). Deliberately not closed (D-007): a normalizing comparison is a *different* rule with its own evasion surface and cannot touch the interleave case.
5. **`CLAUDE.md` is gated by nothing mechanical.** No checker reads it. It is more defensible now — there is no "boundary" claim left to falsify — but its truth still rests on the clause→command→output discipline and on adversarial review, i.e. on people.

### Note — the meta-lesson (D-006 → D-009)

**A gate must inspect the real output, not a proxy for it.** Four iterations refined the proxy — a phrase set, then a first boundary, then a last boundary, then a shared anchored grammar — and each refinement diverged from `resolveTemplate` in a way a reviewer found on the first attempt. Refining the proxy never converged; **eliminating** it did, in one iteration, because the property that matters — *"does any served artifact restate bootstrap's bytes?"* — is only tested by checking the served artifacts. This is D-006 ("test the INVARIANT, not the FIX") taken to its endpoint: the checker stopped approximating where `emit-template`'s output ends and started calling the slicer itself. For the first time in six adversarial rounds, a reviewer could not drive a poisoned header to an agent with the board green.

## [2.40.0] - 2026-07-14

**v2.39.0's guard against a doc that lies about bootstrap's bytes was a 4-phrase prose heuristic, and a reviewer defeated it with one synonym.** Worse: while that rule was busy classifying prose, **four worked examples were restating 100% of bootstrap's header bytes, un-gated, in the half `emit-template` serves to agents** — `index`, `lessons`, `findings-consolidated`, `decisions-consolidated`. LIVE BUG #2 — the defect v2.38.0 was released to fix — was **reproducible at v2.39.0 with the build fully green**: mutate `PLAN_TEMPLATES.lessons`, update the skeleton in lockstep exactly as the gate demands, and `check-template-parity` prints `PASS (12 slugs compared byte-for-byte)` at 598/598 while `emit-template --name lessons` hands agents a block bootstrap does not write. v2.40.0 **deletes the heuristic and compares bytes**: no adjacent line-pair of any template's header may appear anywhere before `<!-- TEMPLATE:END -->`. The keys come from `PLAN_TEMPLATES` itself — there is no intent to guess at and nothing to synonym around. **0 files added, 0 new abstractions, `bootstrap.mjs` diff empty, `file-formats.md` net-negative.** Suite 598 → **608**, 0 failures.

### Fixed

- **The four un-gated header copies are gone.** `index` (2/2 header lines restated), `lessons` (3/3), `findings-consolidated` (2/2), `decisions-consolidated` (2/2) — six fenced blocks in four worked examples, each opening with bootstrap's exact bytes and continuing into invented content. That last part is *why* v2.39.0's audit missed them: its rule was "a fenced block is a byte claim iff its prose asserts it shows what bootstrap writes **and** its body contains no fictional content" — and for these four files bootstrap's template **is** only a header, so an example that restates all of it and then invents rows was classified as a *populated example*. The headers are now elided behind an inline pointer to the `<!-- SKELETON:<slug> -->` region, the one gated statement of those bytes. Everything below each header stays: `index` keeps its table header, divider and both rows; the consolidated pair keep their `## plan-…` sections and `<!-- COMPRESSED-SUMMARY -->` structure; `lessons` keeps its sections.

  The elision was **proven complete, not trusted**: the new rule was run against the *un-elided* doc first and observed FAILing on exactly the six enumerated hits, then run again after the elision.

- **`CLAUDE.md` asserted enforcement that did not exist — for the third time, and it shipped.** v2.39.0's bullet claimed rule (h) had "caught twice" (it had caught zero times) and that "the worked-example half is *not* what bootstrap writes" (it was, verbatim, in four examples). This is the worst defect this project can ship: the artifact every agent and every human reads to learn what is guarded, lying about what is guarded. It is rewritten from the observed tree, **and every clause in it is paired with a command that demonstrates it** — a clause that cannot be demonstrated does not ship. The five residual holes are stated in the same breath as the enforcement (below).

- **A CRITICAL found by attacking the new rule *before* releasing it — the step iterations 1 and 2 did not have.** `[header-copy]`'s scan boundary took the **first** `<!-- TEMPLATE:END -->` (`findIndex`). A **decoy** END marker inserted early therefore *shrank* the scan window, and the rule failed **OPEN**: the reviewer planted bootstrap's exact `findings-consolidated` header plus a fabricated line behind the decoy and got `check-template-parity: PASS`, `make lint && make validate && make test` green at 604/604, while `emit-template` served the poison to agents. The decoy truncates no slice, so the before/after slice-diff discipline sees nothing either. The scan now stops at the **LAST** END — a boundary an attacker can move may only ever **widen** it — and a duplicate END is itself a `[duplicate-region]` FAIL. Fail closed in both directions. Note the symmetry the checker had missed: the `SKELETON` marker family already had a duplicate rule for exactly this attack; the `TEMPLATE` family had none.

### Changed

- **Rule (h) `[byte-claim]` is DELETED, not extended — and replaced by `[header-copy]`, a byte comparison.** The old rule was a 4-phrase set (`written by bootstrap` / `must match exactly` / `update in lockstep` / `written by the executor`); `The freshly created file emitted by bootstrap contains exactly:` sailed straight through it. **Deletion, not a 5th phrase, is the point: a successful synonym is worse than a missing phrase, because it proves the rule's whole CATEGORY is wrong.** Twice this project guessed at byte-claims by heuristic — first "which fenced block *looks* like one" (fails on header-only templates), then "which prose *sounds* like one" (fails on any synonym) — and each was defeated on the first attempt by a reviewer. The ground truth was already in hand: bootstrap's own strings. The new rule computes each template's HEADER (its leading lines up to the first blank line — the run bootstrap writes and agents never populate), indexes every adjacent line-pair of every header, and forbids any of them from appearing before the boundary. No phrase list, no classification, no per-slug allowlist, no skip flag.

### Note — what is still allowed to be true

**A release that names its own holes is the point of this one.** All five are in `CLAUDE.md`, next to the enforcement, not in a footnote:

1. **Skeleton lines *below* a header are still restated verbatim in the worked half, and are still un-gated.** A truthful populated example cannot drop a table's header row. Gating them requires a per-slug allowlist — the design rejected in D-003, and the rot path that turned `check-doc-parity` into a tool comparing only column-1 keys while the owner cells lied. If bootstrap changes one of those lines, the example goes stale and nothing goes red.
2. **`plan` and `progress` have 1-line headers** (`# Plan v0`, `# Progress`) — below the 2-line threshold, which is *not* lowered, because a 1-line rule would fire on every `# Progress` heading in the doc.
3. **The rule prevents *copies*, it does not detect *staleness*.** A paraphrase or an invented header matches nothing and passes.
4. **A byte-different but VISUALLY IDENTICAL copy evades it** — a trailing space, an NBSP, a unicode look-alike, or a blank line / HTML comment interleaved *between* two header lines (breaking adjacency). This is **more** dangerous than (3): a reader cannot *see* it is wrong, and it can arrive **accidentally** via an editor or a paste through a renderer. Deliberately not closed (D-007): a normalizing comparison (trim + NFKC) is a *different* rule with its own evasion surface, it weakens the byte-exactness that is the entire reason this category replaced two failed heuristics, and it cannot touch the interleave case at all.
5. **`CLAUDE.md` is gated by nothing mechanical.** No checker reads it. Its truth rests on the clause→command→output discipline and on adversarial review — i.e. on people.

### Note — the meta-lesson (D-006)

**Success criteria must test the INVARIANT, not the FIX.** Iteration 1's criteria asked "does the gate catch a mutated template?" — it did, and the gate still guarded the copy only the gate reads. Iteration 2's asked "is the changelog block gone? does rule (h) fire?" — both true, and four other examples still restated bootstrap's bytes verbatim. **Both shipped a green board over a false property**, because a criterion that names a specific defect tests *that defect*; only a criterion that quantifies over *all instances* tests the property. The diagnostic that catches this: *"if I satisfy every criterion, what is still allowed to be true?"* — asked of the criteria table before EXECUTE, not of the code after. v2.40.0's two headline tests **loop**: one asserts the invariant over all 12 templates against the live doc and **names no slug**; the other demonstrates the gate FAILing for **each** of the 10 templates with a ≥2-line header. A rule proven to fire once is what v2.39.0 shipped.

### Note — a budget that was never satisfiable (D-007)

The plan required `check-template-parity.mjs` to end **net-zero-or-negative in logic lines**, repaying an earlier overrun by funding the new rule out of rule (h)'s deletion. **That clause contradicted its own arithmetic** — the plan budgeted −9 for the deletion and +15 for the replacement, which is +6 *minimum*. The checker ends at **+19** (145 → 164): +13 for the rule, +6 for the boundary CRITICAL above. Two things were **not** done to make the number green: the working CRLF hint was not deleted (it turns twelve unexplained parity failures into one hint that names the cause — deleting a tested guard to hit an arithmetic target is not engineering), and S9's wording was not retro-fitted to whatever the count happened to be. Recorded as a **plan defect**, not hidden. The structural half of the budget — the half that carries the meaning — **holds**: 0 files added, 0 new abstractions, no allowlist/exception/skip construct, `bootstrap.mjs` diff empty, `file-formats.md` net-negative.

## [2.39.0] - 2026-07-14

**v2.38.0 shipped a real byte-parity gate — and an adversarial review proved it guarded the copy that only the gate reads.** `references/file-formats.md` has two halves. `emit-template.mjs` slices the **worked-example** regions and serves them to agents; the new gate compared `bootstrap.mjs` only to the **skeleton** regions appended below them. So the reviewer re-created v2.38.0's own LIVE BUG #2 — deleting two lines from the changelog header in the worked example, the exact lie that release had just fixed — and `check-template-parity` still printed `PASS (12 slugs compared byte-for-byte)` while `emit-template --name changelog` served the lie straight back to agents. v2.38.0 had fixed one duplication by adding another: the doc stated the changelog header twice, with only one copy gated. This release closes that by **deleting the duplicated byte-claim rather than gating a third copy** — the diff shows a copy *gone*, not a new rule comparing more copies. **0 files added, 0 new abstractions, `file-formats.md` net-negative.** Suite 588 → **598**, 0 failures.

### Fixed

- **The un-gated byte-claim `emit-template` was serving to agents is deleted.** `file-formats.md`'s `changelog` worked example carried a fenced block introduced as *"Header (written by bootstrap on plan creation, or by executor on first append if missing):"* — a verbatim, byte-identical restatement of `PLAN_TEMPLATES.changelog` that **nothing compared to anything**. It is replaced by a one-line pointer to the `<!-- SKELETON:changelog -->` region, the one copy `check-template-parity.mjs` enforces. An audit of all 17 template regions ran first, against the live file, to establish that this was the *only* such block (the rule: a fenced block is a byte claim iff its introducing prose asserts it shows what bootstrap writes **and** its body contains no fictional content — which is why `index`, `lessons`, and the two consolidated files keep their examples, whose *leading lines* coincide with a skeleton before continuing into invented content).

  Two guards now stand where none did. The honest limit, stated because it was true for most of this release: with the block restored, `check-template-parity` **still exits 0** — a suite assertion pinning the deleted block's distinctive literal is what turns `make test` red. Rule (h) (below) closes that last gap, so both `make validate` and `make test` now catch the reviewer's exact move.

- **A regression v2.38.0 itself shipped: a fresh `plans/SYSTEM.md` no longer read as a placeholder.** Fixing LIVE BUG #1 meant adopting the doc's richer schema into bootstrap's skeleton — and in doing so it swapped the house `*To be populated at first CLOSE.*` italic convention for content-shaped bullets with concrete examples. `plans/SYSTEM.md` became the **only** bootstrap-written file whose empty state was textually indistinguishable from a populated one, and it is read at the **start of every EXPLORE and PLAN** — exactly where an agent mistakes schema hints for established facts about the system. It now carries an `*UNPOPULATED SKELETON — every bullet below is a schema hint, not an established fact.*` banner with **every** hint bullet italicized, keeping the richer schema. This shipped to every consuming project; anyone on 2.38.0 should upgrade.

- **The lockstep ghost at `file-formats.md:760-761`.** *"Schema single-source: this section. Bootstrap skeleton in `src/scripts/bootstrap.mjs` must match exactly — update in lockstep."* v2.38.0 deleted this sentence from `bootstrap.mjs` and left its mirror standing in the doc. It was doubly wrong: it named the **un-gated** pair, and that pair is **deliberately unequal** — the doc's `## plans/SYSTEM.md` section is the *populated-form* schema `ip-archivist` fills at CLOSE (its `*Last refreshed:*` line shows a real plan-id; bootstrap writes `(none yet)`), which is why `ip-archivist.md:43` still correctly points there. The prose now says which artifact is which, and names `check-template-parity.mjs` and `<!-- SKELETON:system -->` as the gated pair.

### Added

- **Rule (h) `[byte-claim]` — no line before `<!-- TEMPLATE:END -->` may claim bootstrap's bytes.** The mechanical form of this release's thesis: bootstrap's bytes are claimed **only** in the half the gate compares. A 4-phrase set (`written by bootstrap`, `must match exactly`, `update in lockstep`, `written by the executor`) — a *set*, not a comparison, and explicitly **not** an allowlist of "which fenced block in which region is byte-claiming", which is the design this release rejected. It shipped only because all three hard caps were verified rather than assumed: 4 phrases, **9** net logic lines, and **zero** false positives on the live doc (`single-source` was excluded from the set for exactly this reason — it collides with the legitimate "single-source-of-truth definition" prose in the presentation-contracts section). A test pins the set at four: **if it ever needs a 5th phrase or a per-slug exception, the rule gets deleted, not grown.** Re-inserting the deleted changelog block now fails `make validate` at `file-formats.md:816 [byte-claim]`.

### Changed

- **The gate can no longer pass vacuously.** Four hardening rules, +25 logic lines, all from the adversarial review's own fixtures: **`[coverage]`** — `checkParity({}, "")` used to report `issues=0, compared=0` and **PASS**; the `compared === 12` assertion lived only in the test suite, and **`make validate` does not run the suite**, so the floor was enforced by a human reading stdout. It is now `EXPECTED_SLUGS = 12` inside the gate. **`[duplicate-region]`** — a repeated `<!-- SKELETON:x -->` marker was silently last-wins, so a garbage *first* region (the one a human reading the doc actually reads) could hide behind a clean second one while the gate printed PASS; parsing is now first-wins and a duplicate is a FAIL naming both lines. **`[typing]`** — a non-string template threw a raw `TypeError` instead of reporting. **`[line-endings]`** — a CRLF doc failed all 12 parity rules at once with nothing pointing at the cause; it now gets one hint.

- **CLAUDE.md's `check-template-parity` bullet, rewritten (a third time) to state the two-halves distinction.** v2.37.0 claimed no byte-parity gate existed; v2.38.0 corrected that but recorded the worked-example/skeleton split as a live gap ("NOT byte-compared to anything"). The true statement is now stronger and is the thing to preserve: the worked examples carry **no byte-claims at all**, the skeleton regions are the single gated statement of bootstrap's bytes, and the two halves are **not** byte-compared to each other **and must not be** — for `system` they differ by design.

**The trade-off (D-003), stated plainly:** the doc states bootstrap's bytes in exactly **one gated place**, **at the cost of** the worked examples losing their inline byte-for-byte header blocks — a reader who wants the literal bytes now follows a pointer instead of reading them in situ. The alternative (a second gate rule comparing worked-example blocks to skeletons) was rejected: it keeps **three** copies and needs a per-slug allowlist of which block is byte-claiming, since the seven populated-example slugs have no such block at all. Allowlisted exceptions are precisely how `check-doc-parity` rotted into comparing only column-1 keys for months while the owner cells lied. **Deleting a copy is strictly better than gating a copy.**

## [2.38.0] - 2026-07-14

**The plan-file templates exist twice, and now the two copies are enforced equal.** `bootstrap.mjs` writes every file in a new plan directory from its own inline literals; `references/file-formats.md` publishes what those files are supposed to look like. Nothing compared them — v2.37.0 shipped a CLAUDE.md bullet saying exactly that, and adding a gate "without a plan" was forbidden. This is that plan. The audit that had to come first found the premise was only ~40% true (of 17 template slugs, 12 have a bootstrap counterpart and only 5 were byte-comparable at all), and it found **two drifts already on disk** — one of which had been silently withholding six schema bullets from every plan directory ever created. Both are fixed, in opposite directions, on purpose. Suite 559 → **588**, 0 failures. Zero runtime dependencies; `bootstrap.mjs` still reads no files.

### Added

- **`src/scripts/check-template-parity.mjs` — a byte-parity gate between `bootstrap.mjs`'s templates and `references/file-formats.md`.** Dependency-free, `check-doc-parity.mjs` as its structural template, 111 lines of logic. Three rules: **(a) parity** — every `PLAN_TEMPLATES[slug]` byte-equals its `<!-- SKELETON:<slug> -->` region body, and a failure names `src/references/file-formats.md:<line>`, the actual divergent line; **(b) completeness** — set equality in **both** directions, so a template with no region and a region with no template are each a FAIL; **(c) encodability** — no template may contain a triple-backtick fence or the literal `<!-- TEMPLATE:`, either of which would corrupt a region or silently truncate the `lessons-synthesis` slice. Rule (c) is what keeps rule (a) expressible forever. Wired into `make validate` + `lint` + `test` and into `build.ps1`'s three matching targets **in lockstep** — nothing cross-checks those two files, and wiring one without the other would silently disable the gate on one platform, which is the exact defect class this release exists to kill. 20 new tests.

  The gate was proven to have teeth before it was trusted: a one-character drift in `PLAN_TEMPLATES.progress` turns `make validate` red naming `file-formats.md:1154` (confirmed by hand to be the divergent line), and deleting the `<!-- SKELETON:index -->` region turns it red on completeness naming `index`. A gate observed only passing is evidence of nothing.

- **12 `<!-- SKELETON:<slug> -->` regions in `references/file-formats.md`** — the machine-comparable artifact that did not exist. Appended after the terminating `<!-- TEMPLATE:END -->` marker, which the slicer never reads past, so all 17 `emit-template` slices come out byte-unchanged (captured before, re-captured after, diffed — the slicer's own tests derive `expected` from the file itself and therefore *cannot* catch a slice that moved because the file moved). Generated programmatically from the templates; nothing hand-typed.

- **`PLAN_TEMPLATES` + `renderTemplate()`, exported from `bootstrap.mjs`.** The 12 plan-file bodies were inline `writeFileSync` arguments — not addressable, not diffable. They are now raw strings with `{{TOKEN}}` placeholders behind a pure single-pass renderer that never re-scans a substituted value (a `goal` containing a `{{TOKEN}}`-shaped string must not recurse) and **throws** on an unknown or missing token, inside the try/catch that rolls back a half-written plan dir. A loud failure beats a partial plan. Pinned by a golden-bytes test, which passed on the first run with no golden adjusted — a golden you had to "fix" to make green is not a golden.

### Fixed

Two live drifts. Not hypothetical, not "could happen" — both were on disk, in `main`, at the start of this release.

- **`plans/SYSTEM.md`'s bootstrap skeleton had drifted from the schema `bootstrap.mjs`'s own comment promised it matched "exactly".** The comment said lockstep; the code had not been in lockstep for some time. **Six content bullets that `file-formats.md` specifies had never been written into any plan directory** — Boundaries was short two, Invariants one, and **Codebase Specialization shipped as a heading with zero content under it**. The archivist that fills SYSTEM.md at CLOSE is pointed at the doc's schema and was handed a skeleton that did not implement it. Resolved in favor of the **doc**: the richer skeleton is what bootstrap already claimed to write, and it is a better prompt for the agent that fills it.

- **`references/file-formats.md` documented a runtime behavior that does not happen.** It introduced a fenced block as the `changelog.md` header *"written by bootstrap on plan creation"* and then showed **2 lines**. Bootstrap writes **4** — including an Owner/Reader line and a Format spec line the doc never mentioned. The doc was not incomplete; it was asserting something false about observable behavior. Resolved in favor of the **code**. The opposite direction from the fix above, deliberately: pick the better artifact each time, then let the gate freeze the winner.

- **Two documentation surfaces found broken while fixing the first two.** README's file tree never had a `check-agent-wiring.mjs` row — v2.37.0 shipped a script and left it out of its own documentation. And README's test-command block claimed **531** tests against a live **588**, with a stale file list. Nothing gates that block; it was found by reading.

### Changed

- **CLAUDE.md's "there is NO byte-parity test … do not add one without a plan" bullet is now false, and has been rewritten rather than deleted.** What is true now, and is the thing to preserve: `bootstrap.mjs` still writes from its own `PLAN_TEMPLATES` and performs **zero** runtime reads of `file-formats.md` — a deliberate, load-bearing property, not an oversight — and `check-template-parity.mjs`, run by `make validate`, enforces that those literals byte-match the doc's `<!-- SKELETON:* -->` regions in both directions. So a template edit is still **two** edits; the gate guarantees only that you cannot *forget* the second one, because forgetting it fails the build.

  The trade-off, stated plainly (D-001): **drift becomes mechanically impossible to miss, at the cost of keeping the content in two places.**

  The alternative that removes the duplication outright — have `bootstrap.mjs` read the SKELETON regions from `file-formats.md` at runtime and delete its literals — was **rejected on risk, not on feasibility** (D-002), and must not be recorded as impossible. Exploration killed the objection that would normally dismiss it: path resolution from the installed bundle is *verified working* (`references/` sits at the same relative depth from `scripts/` in both the dev and installed layouts, unlike `VERSION`, which is exactly why `VERSION` needed a two-layout probe), every delivery path that ships `bootstrap.mjs` also ships `references/file-formats.md`, and the cost is one 59KB `readFileSync`. It is buildable today. It is declined because it would give the one script whose failure mode is **"no plan can ever be created again"** a hard runtime dependency on a doc file — converting a maintenance hazard that fails loudly in CI, in the dev tree, with zero runtime blast radius, into an availability hazard that catches nobody until a user cannot create a plan.

## [2.37.0] - 2026-07-14

**The prose layer gets a gate.** Every mechanical surface in this repo is checked — `lint`, `validate`, 531 tests, all green — and every defect this release fixes was sitting in the layer nothing checks: agent prompts, per-state rule modules, reference cross-pointers, the File Ownership table. Ten of them, all the same shape: a document making a claim about the system that the system does not honor. The worst one silently disabled the CLOSE-phase anchor audit in every consuming project. Fixing ten by hand and promising to be careful is the discipline that produced them; so `check-agent-wiring.mjs` was built first, proven RED against the current tree, and only wired into `make validate` once the tree was green. Suite 531 → **559**, 0 failures. Zero runtime dependencies, one new script, one new abstraction.

### Added

- **`src/scripts/check-agent-wiring.mjs` — a prose-layer wiring gate.** Dependency-free, `check-doc-parity.mjs` as its structural template. It scans 21 files (`src/agents/`, `src/scripts/modules/`, `src/SKILL.md`, `src/references/`) and enforces four rules: **script paths** must be invocable from a consuming project's root (`node <skill-path>/scripts/…`, never a bare `node src/scripts/…`); **reference citations** must name a file that exists; **section pointers** must resolve (see *Changed*, below); and any file that invokes a script must resolve `<skill-path>` or point at the rule that does. Wired into `make lint`, `make test`, and — as of the last commit of this release, not the first — `make validate`, plus `build.ps1`'s three matching targets. 28 new tests.

  The gate was proven to have teeth **twice**: once RED against the pre-fix tree (naming `ip-archivist.md:25` and `python-software.md:368` by line), and once again after the fixes landed, by reintroducing F-004's bare path and confirming `make validate` exits 2 and never reaches `Validation passed!`. A gate that has only ever been observed passing is not evidence of anything.

### Fixed

The ten defects the gate exists to catch. Each was found by reading, then pinned by the gate.

- **`ip-archivist.md` told the archivist to run `node src/scripts/validate-plan.mjs`** — a *relative* path. The archivist runs from the consuming project's root, where `src/scripts/` does not exist. So the command resolved to nothing, and the **CLOSE-phase anchor audit silently never ran, in every project that has ever used this skill.** No error: `node` exits non-zero, the agent reads no findings, CLOSE proceeds. The one check that catches orphaned `# DECISION` anchors before a plan is archived was wired to a path that cannot exist. Also fixed: three bare `node scripts/blast-radius.mjs` invocations in `references/blast-radius.md` (a *shipped* reference) and a path-less script mention in `ip-verifier.md`.
- **`references/python-software.md` pointed at the wrong section for its own anti-pattern checklist** — "the 20-item checklist in **C.11**". C.11 is the Toolchain table; the checklist is C.12. The gate then found a second one of exactly the same kind: a `§ B.10` (Dependency Injection) pointer that meant `§ B.13` (Class architecture). Two mis-aimed pointers in one file is not a typo; it is a class.
- **`python-software.md` was consulted at PLAN and REFLECT but not at EXECUTE.** The reviewer graded code against the § C.12 anti-pattern checklist that the executor was never shown — a review gate the writer cannot see is a trap, not a standard. The domain-gated pointer is now in `modules/state-execute.md` (the operative rule, so it reaches monolithic mode too) and in `ip-executor.md`. The conditional gate is preserved verbatim on both: **"Skip for non-software plans."** This file is a caveat for one domain and must never become an unconditional tax on every plan.
- **`python-software.md` advertised an EXPLORE use that was never wired.** Neither `ip-explorer.md` nor `state-explore.md` cites it. Two ways to end a contradiction: wire the claim, or correct it. The claim is corrected (D-003) — § A's models exist to justify a *structure*, which is PLAN's job, and PLAN already has the file. Note the deliberate asymmetry with the fix above: there, the wiring was missing where the concern demonstrably fires; here, the claim was missing a reason to exist.
- **The File Ownership table and File Lifecycle Matrix described writes that no agent performs, and omitted one that an agent is required to perform.** Four lying rows, in both directions. `progress.md` credited the Executor (it only *reads* it; the Post-Step Gate write is the orchestrator's). `verification.md` credited the Verifier (its body never writes a file — it returns a table the orchestrator merges, which is a deliberate, load-bearing Relay Contract). `decisions.md` listed the Executor as reader-only, but the Executor is *mandated* to write it — the Anchor-Refs back-fill, enforced by the validator's own `[anchor-refs-missing]` ERROR. And the Lifecycle Matrix repeated the same omission. Every row was fixed toward **what the agents actually do**, not by making the agents do what the table said: fixing the table is the subtractive fix, and additive fixes to a permissions model are how co-ownership rot starts (D-004). Mirrored by hand into README.md — `check-doc-parity.mjs` compares column-1 path keys only, **not owner cells**, so `make validate` staying green across these edits proves nothing about them.
- **No sub-agent documented how it resolves `<skill-path>`** — the placeholder appears in every script invocation the agents are told to run, and nothing anywhere said what it is. Now: ONE canonical `Resolving <skill-path>` rule in `SKILL.md`, a `SKILL PATH:` dispatch contract in `ip-orchestrator.md` (every spawn prompt MUST carry it), and a one-line **pointer** — not a copy — in each of the five script-invoking agents.

### Changed

- **Section pointers are now `§ <Code> <Title>`, and both tokens must agree with a real heading** (D-002). The obvious gate rule — "every pointer must resolve to a heading that exists" — would have **passed** the C.11 defect above, because C.11 exists. A mis-aimed pointer to a real heading is semantically wrong and syntactically perfect, and no existence check can tell them apart. Requiring the title beside the code creates redundancy on purpose: two independently-typed tokens that must match, which is what makes the slip observable. A future `§ C.11 Anti-pattern checklist` now fails loudly.

  Whole-section pointers (`§ C`) are cited by title in prose instead, and are **not** checkable — a known, accepted blind spot, recorded rather than papered over with an allow-list (D-005). Widening the heading parser to make `§ C` "valid" would have restored the exact unverifiable form that let the C.11 defect hide: a bare letter names no title to disagree with.

### Docs

- **CLAUDE.md now states the template-mechanism truth, and it is not the comfortable one** (D-006). `bootstrap.mjs` **does** duplicate plan-file template content that `references/file-formats.md` also holds — it writes from its own literals and never reads the reference — and **nothing enforces that the two agree**. No test compares them. A maintainer who edits `file-formats.md` gets no signal that `bootstrap.mjs` did not follow. The step that produced this line was briefed to write the opposite ("no duplicate copy exists"); verifying before writing showed that wording was false, and shipping it would have committed the same sin this release exists to fix, in the opposite direction — a fresh false claim, this time about the absence of code. Killing a ghost with a ghost is not a fix. The duplication itself is a real code change with real blast radius and is queued for a dedicated plan, not smuggled into a documentation step.

## [2.36.0] - 2026-07-14

**Three conventions, one release: plan directories are timestamped, EXECUTE commits name their plan, and every new plan records the skill version that created it.** The third one was blocked by a packaging defect — `VERSION` was built by everything and shipped by nothing — so that is fixed here too. Suite 490 → **531**, 0 failures. Zero runtime dependencies, zero new files, one new abstraction (the plan-id read union).

### Changed

- **Plan directories are now `plan-YYYY-MM-DDTHHMMSS-HASH`** (UTC, e.g. `plan-2026-07-14T051317-317362c4`), regex `/^plan-\d{4}-\d{2}-\d{2}T\d{6}-[0-9a-f]{8}$/`. Lexical sort still equals chronological sort, and the timestamp makes two plans created on the same day distinguishable at a glance.

  **The colons the ISO-8601 form implies were deliberately dropped** (D-001). A colon is illegal in a Win32/NTFS filename — it denotes an NTFS Alternate Data Stream — and this project ships `build.ps1` and documents Windows as a first-class install path. `plan-2026-07-14T05:13:17-…` would not merely look odd on Windows; `mkdir` would fail outright. The colon buys a punctuation convention; it costs a supported platform.

- **Read-union, write-new** (D-003). Legacy `plan_YYYY-MM-DD_XXXXXXXX` directories are still **read** on every path — pointer resolution, `status`/`resume`/`close`/`list`/`retire`, the `# DECISION` anchor scan, `## <plan-id>` section headers, the `*Plan: …*` preamble check, the consolidated-file sliding window, the INDEX date column — and are **never generated again**. `shared.mjs` gains `LEGACY_PLAN_ID_PATTERN` and a non-capturing `ANY_PLAN_ID_PATTERN`; generation validates against the strict *new* `PLAN_ID_RE` before it touches the disk.

  This is not softness about the cutover. With a strict single-format regex there is **no commit ordering** in which the plan directory executing this very migration stays valid at every boundary: rename it first and it fails the old regex; flip the regex first and the live directory fails the new one. The only escape would have been one un-bisectable mega-commit renaming the dir, rewriting the pointer, the preamble, and the grammar atomically. The union is what makes the migration bisectable and revertable — and it is what keeps the 18 committed `# DECISION plan_2026-07-14_79ee0f59/D-NNN` anchors in the audit net. Under a new-only grammar those anchors would not have become loud orphans; they would have matched the anchor regexes *not at all*, and silently left the audit net with no error to say so. D-005's "one grammar" discipline is now, explicitly, **one write grammar and one read union** — recorded in the D-005 anchor comment rather than quietly violated.

  As a side effect, the seven hardcoded `"plan_"` literals scattered across `bootstrap.mjs` and `validate-plan.mjs` are gone, onto the shared constants. Every one of them was a **silent** failure site: a missed literal blanks the INDEX date column, or stops the sliding window trimming, or makes `list` blind to a plan — and raises nothing.

- **EXECUTE step commits now carry `[plan-YYYY-MM-DD-HASH/iter-N/step-M] desc`** (D-002), e.g. `[plan-2026-07-14-317362c4/iter-1/step-8] …`. The tag id is derived from the directory name by **dropping the `THHMMSS` segment** — it is not the directory name itself. Prose-only: `SKILL.md`, `modules/state-execute.md`, `agents/ip-executor.md`, `README.md`.

  The changelog ledger's `step` field deliberately stays bare `iter-N/step-M`. Nothing in this codebase parses a commit message — no hook, no CI, no commitlint, no `git log` shelling — and the ledger's `step` value is sourced from `state.md`, not from the commit subject. "Fixing" the apparent inconsistency would drag `schema.mjs` / `STEP_RE` into a release that has no reason to touch them, for zero behavioral gain. That coupling does not exist; we decline to invent it.

### Added

- **New plans stamp `*Skill: iterative-planner vX.Y.Z*` into `state.md` and `decisions.md`** — so a plan directory records which skill version produced it, which is the first thing you want when a plan from three versions ago behaves oddly. `decisions.md` carries it on its own line, never inside the `*Plan: …*` preamble, which is matched positionally.

  The version is resolved by a **never-throwing two-layout probe**: `<script>/../VERSION` (installed layout) first, then `<script>/../../VERSION` (dev tree). The order matters — an installed `bootstrap.mjs` that used the dev-tree depth would resolve to `~/.claude/skills/`, i.e. some *other* skill's directory. A missing, unreadable, or malformed `VERSION` degrades to `unknown` and bootstrap still exits 0. A version stamp is a nicety; a bootstrap that cannot run is a dead skill, and the nicety does not get to take the skill down with it.

### Fixed

- **`VERSION` was never shipped into the built or synced skill package** (D-004). It was *read* at build time by `Makefile`, `build.ps1`, and `check-readme-parity.mjs` — and copied by none of them: absent from `DOC_FILES`, absent from `make sync-skill`'s copy set *and* its `diff -rq` verification list, absent from **both** of `build.ps1`'s doc-copy lists. An installed skill therefore had no version file at all, which is why the version stamp above needed a packaging fix before it could exist. Now copied on every delivery path, and — because an unverified copy is exactly how the pre-v2.35.0 orphan bug happened — *verified* on the one that verifies.
- **`bootstrap.mjs cmdNew` did not recognize error codes other than `EACTIVE`/`ECREATE`.** Any other structured failure fell through to a double lock-release and a raw stack trace. The new plan-id assertion throws `EBADPLANID`, which is now registered, so a rejected id releases the lock once and prints one clean message.
- **`references/decision-anchoring.md` hand-copied the plan-id regex four times, and the copies had drifted** — they said `[0-9a-f]+` where the code enforces `[0-9a-f]{8}`. Documentation that restates a regex is a regex that will eventually be wrong. All four collapse to a single `<plan-id>` placeholder pointing at the one definition in `shared.mjs`.
- **An anchor carrying a commit-tag-shaped plan-id was invisible to the audit net** (D-005) — the blind spot the new commit tag itself opened. `// DECISION plan-2026-07-14-317362c4/D-002` (the dir name minus `THHMMSS`, exactly the derivation agents are now told to perform by hand) matched **no** anchor regex at all: the read union fails, the optional prefix group is skipped, and then `D-` must match `plan-…` and does not. Zero findings — not an orphan ERROR, nothing. A one-character derivation slip silently deleted a decision from the audit net, which is the failure class this release exists to prevent. `validate-plan.mjs` now runs a second, loose-prefix pass over the *same* comment spans and reports `WARN [anchor-badprefix]` for any `DECISION <x>/D-NNN` whose `<x>` is not a plan-id, naming the offender and the likely cause. WARN, not ERROR: the decision is still documented and still legible, and a cosmetic typo must not hard-block a REFLECT→CLOSE gate. The read union is deliberately **not** widened to accept the tag shape — that would make a mis-derived prefix *resolve* against a plan directory that does not exist.
- **`shared.mjs` exported a stateful module-level regex, guarded only by a comment — and the comment's reason was wrong.** `PLAN_SECTION_RE` was `/^## plan[-_]/gm`; the guard claimed `matchAll` is `lastIndex`-safe "because it clones the regex". It does clone — and the clone **copies `lastIndex`**. Two stray `.test()` calls anywhere would have made `matchAll` return `[]`, at which point `trimConsolidatedWindow` computes no section positions, returns early, and the consolidated sliding window **silently stops trimming forever** (`plans/FINDINGS.md` grows without bound, no error). It is now `PLAN_SECTION_PATTERN`, a plain **string**; every call site builds its own `new RegExp(PLAN_SECTION_PATTERN, "gm")`. A string cannot carry `lastIndex`, so the hazard is structurally unreachable instead of prose-guarded.
- **`bootstrap.mjs list` stopped being chronological the moment both grammars coexisted.** It sorted by directory name, and `-` (0x2D) sorts before `_` (0x5F) — so every new-format dir grouped ahead of every legacy dir regardless of date, contradicting D-001's own trade-off line. It now sorts on `planDateFromId()`, tie-breaking on the full name (the date resolves only to the day, and same-day output must still be stable).

### Not done, on purpose

- **`bootstrap.mjs retire` was NOT run on the legacy plan `plan_2026-07-14_79ee0f59`.** Under read-union its 18 anchors are not orphaned, so retire buys nothing — and it would stamp `[STALE]` onto decisions that are still binding, D-005 among them (the very grammar rule this release extends). A `[STALE]` marker on a live constraint is not housekeeping; it is a lie left in the source for the next reader to trust. This is recorded so nobody later "finishes the migration" by retiring it.

## [2.35.0] - 2026-07-14

**Reverted the XML artifact encoding.** The changelog is markdown again, and an append is one line again. Every defect fix from v2.33.0/v2.34.0 stays, and `schema.mjs` stays — it is the part of that work that paid off. Suite 656 → **490** (the 146 tests of the deleted modules go with them), 0 failures. Zero runtime dependencies.

### Removed

- **`src/scripts/xml.mjs`, `src/scripts/changelog.mjs`** (and their test suites), and the `changelog.xml` artifact. **Reason: the migration replaced an atomic single-line append with an O(file) read-modify-write of the whole document, which introduced silent data loss that did not exist before.** Measured at v2.33.0: 16 parallel appends against a 3,000-entry ledger recorded **1**, with every process exiting 0 — total, silent loss from an append-only *evidence* ledger, on the normal path (`ip-executor.md` mandates an append after EACH edit; parallel tool calls are the encouraged pattern). The v2.34.0 file lock that fixed the loss then carried a time-of-check/time-of-use race in its own stale-recovery path. The correct move is not a better lock; it is not needing one. A one-line append to a markdown file needs no lock, no parser, and no serializer.

  Markdown is canonical: `bootstrap.mjs new` creates `changelog.md`, `ip-executor` appends a pipe-delimited line to it, and `ip-reviewer` reads it directly. `maybeCompressChangelog` is the markdown compressor again — same 5-key return shape (`{compressed, beforeLines, afterLines, elidedCount, reason}`), same idempotency, and **byte-identical** to its pre-XML output (pinned by a golden-bytes test).

### Kept

- **`src/scripts/schema.mjs` — the six hand-maintained changelog field regexes stay DELETED.** They were replaced by one declarative spec (`CHANGELOG_SPEC`) which is now the single source of truth for the changelog's field shapes; `validate-plan.mjs` validates each markdown line through it (`splitChangelogFields()` → `entryFromFields()` → `validateElement()`). Its `iso-datetime` check is strictly **stronger** than the regex it replaced: it round-trips the timestamp through `Date`, so calendar-impossible dates such as `2026-02-30` are rejected — the old `TS` regex accepted them (it was shape-only). The XML-document surface of the module (`validateDoc`, `rootElement`, the CLI) is gone; `entryFromFields()` moved in from `changelog.mjs`, where it never belonged.
- **All defect fixes from v2.33.0 and v2.34.0**, untouched and still under test:
  - untracked-file blast-radius scoring (a `CREATE` no longer scores as an error);
  - `git grep` no-match vs. real-error disambiguation, plus the scoped grep fallback;
  - `bootstrap.mjs new --force` no longer swallows the goal argument (positional-only);
  - comment-blind markdown scanners, all five unified onto one code-span-aware, line-count-preserving primitive (`stripHtmlComments`) — so reported line numbers are exact by construction;
  - the iteration hard cap now **fails closed** (`max(raw, stripped)`), with `WARN [state-comment-anomaly]` explaining any over-count;
  - numeric complexity-budget enforcement in the validator;
  - one unified `PLAN_ID_RE`;
  - decision IDs beyond 3 digits (`D-1000` no longer truncates);
  - the `TEST_COUNT` drift gate (`check-test-count.mjs`, run via `make test`).

### Changed

- `[changelog-malformed]` remains a **WARN** and never blocks CLOSE. The `[changelog-unparseable]` and `[changelog-dual-encoding]` checks are gone with the encoding that needed them.
- `TEST_COUNT` 656 → **490** (live). README badge, test-file list, and the `Makefile` / `build.ps1` lint+test targets updated to match.

## [2.34.0] - 2026-07-14

Three **CRITICAL** fixes, all found by an adversarial review of v2.33.0 (`plans/plan_2026-07-14_79ee0f59/`, iteration 2) and all reproduced live before being fixed. Every one of them was a **silent** failure in a mechanism the protocol treats as safety-critical: the evidence ledger, the iteration hard cap, and the decision-schema check. Two of the three were affirmatively claimed correct in shipped in-source decision anchors — those anchors were false, and are corrected in-source here rather than left to mislead. Suite 584 → 640, 0 failures. Zero new runtime dependencies, zero new files, zero new abstractions.

### Fixed

- **CRITICAL — concurrent `changelog.mjs append` lost entries and could corrupt `changelog.xml`.** `append` is a read-modify-write of the whole document (parse → splice → re-serialize → rename), and it was unlocked. Under concurrency, N writers all read the same document and the last rename wins. **Measured pre-fix: 16 parallel appends against a 3000-entry ledger recorded 1 of 16, in 8 of 8 trials — with every process exiting 0.** Silent, total data loss on an append-only evidence ledger. On top of that, `writeDocAtomic` shared a fixed `${file}.tmp` across writers, so two writers interleaved bytes into the same temp file and `renameSync` published whichever half-written document happened to be on disk — which is how a pipeline-written `changelog.xml` ended up unparseable.

  **This was a regression introduced in v2.33.0.** The legacy markdown path appended a single line (effectively atomic under `O_APPEND`); the XML rewrite turned that O(1) line append into an O(file) read-modify-write. And it is on the *normal* path: `ip-executor.md` mandates an append after EACH edit, and parallel tool calls are the encouraged pattern.

  Fixed with an O_EXCL lock (`openSync(lock, "wx")`) wrapping the entire read-modify-write, plus a per-writer temp path (`${file}.${pid}.${n}.tmp`). Both are required; neither alone closes the bug — the unique temp name stops writers corrupting each other's *bytes*, the lock stops them losing each other's *entries*. Degradation is loud and non-fatal: a bounded ~2 s wait with backoff + jitter, then stderr `entry NOT recorded` and a non-zero exit, which `ip-executor.md`'s existing non-fatal rule turns into "log and proceed". EXECUTE never stalls on a changelog write. A lock whose **mtime** is stale (>10 s) is broken and retried, so a crashed writer cannot wedge the ledger. Post-fix: 16/16 recorded, no `.lock` or `.tmp` residue. `bootstrap.mjs`'s XML compression pass — the only *other* writer of `changelog.xml` — takes the same lock; a contended pass returns the existing 5-key shape with the new no-op `reason: "locked"` and simply re-runs at the next PLAN gate.

- **CRITICAL — the iteration hard cap failed OPEN.** `stripHtmlComments`'s documented fail-safe ("an unterminated `<!--` is left untouched, so the cap can only over-count") was **false**. Bootstrap's own `state.md` template ends every file with a guidance HTML comment that supplies a `-->`, so a stray opener is never unterminated — it pairs with the template's trailer and blanks every real transition record in between. **Measured: the cap derived 0 from real `EXECUTE → REFLECT` records.** The safety mechanism did not fire late; it disappeared, silently.

  Fixed by relocating the fail-safe from the stripper to the consumer that needs it: `deriveIterationFromHistory` now counts on the **raw** history block (`max(raw, stripped)`, and raw ≥ stripped always), so it is *structurally incapable* of under-counting for any comment shape. Over-counting remains possible and is the safe direction — it is loud, recoverable, and now explained by a new advisory `WARN [state-comment-anomaly]` (see below). Advisory scanners still read the stripped block, where a false WARN costs nothing.

- **CRITICAL — the decisions validator failed OPEN.** `checkDecisionsSchema` scrubbed HTML comments with `.replace(/<!--[\s\S]*?-->/g, "")` — a regex that is blind to markdown code spans and **removes** lines instead of blanking them. Two consequences. Cosmetic: every reported line number was offset by the size of any stripped comment (the validator said "D-007 (line 59)"; D-007 was at line 69). Serious: a decision entry that merely *discusses* HTML comments supplies a phantom opener inside a backtick span, which pairs with any `-->` downstream and swallows everything between — producing **false ERRORs** and, in the same motion, **silently hiding real ones**. In this repo's own plan directory it was hiding two genuinely-malformed entries (both missing their mandatory `**Complexity Assessment**` block) while reporting two errors that did not exist.

  Fixed by unifying all five `.md` comment scanners onto one code-span-aware, line-count-preserving primitive: a delimiter written inside backticks or a fenced block is prose and can neither open nor close a comment, and stripping never changes the line count, so every reported line number is exact by construction.

- **This was the third occurrence of comment-blindness in this codebase** — v2.32.0's `.md` anchor scanner, v2.33.0's `state.md` transition scanners, and now the decisions parser. Three occurrences is a pattern, not three coincidences, and the trigger is unforgiving: the bug fires whenever someone *documents comment handling*. The fix therefore collapses the scanners onto a **single definition of "where the comments are"** rather than fixing a fourth regex, so there is no fourth occurrence to have.

- Two false in-source DECISION anchors (the `stripHtmlComments` fail-safe claim and the `writeDocAtomic` "atomic" docstring, which was only ever true for a single writer) are **corrected**, not deleted. An invariant asserted in a comment that no test ever tried to break is not an invariant.

### Added

- **`WARN [state-comment-anomaly]`** (advisory; never ERROR, never `--pre-step` exit 2). Fires when `state.md`'s comment markers are unbalanced **or** when the raw and stripped `EXECUTE → REFLECT` counts diverge. The OR is load-bearing: a stray opener that pairs with the template trailer *balances perfectly* and is caught only by the count divergence, while a genuinely unterminated opener is caught only by the balance probe. It is silent on a fresh `bootstrap.mjs new` plan dir and on a well-formed plan.
- Compression gains one no-op return reason: `locked` (XML only). The 5-key return shape the PLAN gate depends on is unchanged.

### Changed

- `TEST_COUNT` 584 → **640** (live). README badge and test-file table updated to match.

## [2.33.0] - 2026-07-14

Two halves, both from `plans/plan_2026-07-14_79ee0f59/`. First: **8 defect fixes** from a script audit (7 found by reading the scripts, 1 found by running the validator against its own plan directory). Second: the **XML artifact foundation** — a zero-dependency parser, a declarative schema, and a write-through CLI — with exactly one artifact migrated end-to-end (`changelog.md` → `changelog.xml`) as the de-risking proof for a later full migration. Suite 302 → 584, 0 failures. Zero new runtime dependencies.

Deferral stated honestly: **13 of the 14 plan-dir artifacts remain markdown.** `decisions.md`, `findings/*`, `plan.md`, `state.md`, `progress.md`, `verification.md`, `summary.md`, and the consolidated `plans/*.md` files are prose-heavy and LLM-authored — precisely the population where hand-written XML tag errors are most likely. Per D-002, an artifact may go XML only once it has a write-through CLI; the changelog was migrated first because it is the most machine-written and the most brittle to parse.

### Fixed

Eight audit defects:

- **`blast-radius.mjs` scored brand-new untracked files as `LOW(0)`** (the HIGH one). `git diff HEAD` does not see untracked paths, so a 500-line new file scored zero and the same file jumped to `MED(3)` on `git add` alone — with no content change. Untracked files now get a synthesized CREATE diff (added = line count), and `locChurn` / `publicApiTouch` / `testDelta` all see the real content.
- **`git grep` exit status 1 (no match) was treated as an error**, so the zero-reverse-deps case — the common one — fell through to an unscoped `grep -r .` over the whole tree. No-match (status 1 + empty stdout) is now distinguished from real failure (spawn error, status ≥ 2), and the fallback, when it does fire, carries the same `--exclude-dir` set as the git-grep path.
- **`bootstrap.mjs new` inferred `--force` from goal text.** The handler scanned the whole arg list, so a word-split `new "add a --force flag"` silently force-closed the active plan and stripped the token from the recorded goal. `--force` is now positional — honored only immediately after `new`.
- **`validate-plan.mjs`'s `state.md` history scanners were comment-blind.** Four scanners read the Transition History block raw, matching the example `EXPLORE → PLAN` inside bootstrap's own HTML-comment guidance — so `[exploration-confidence]` WARNed on every fresh plan, including ones with a correct `confidence:` line. Fixed as a class via a shared line-preserving `stripHtmlComments()`; the iteration hard cap, the transition-legality check, and the PC advisory were all affected and all fixed. The unterminated-comment branch deliberately fails safe (it can over-count iterations, never under-count — under-counting would silently disable the cap).
- **The Complexity Budget was documented but never checked.** `Files added: N/M max` and `New abstractions: N/M max` are now parsed numerically; `N > M` emits WARN `[budget-exceeded]`, suppressed by an explicit `(justified: …)` suffix.
- **`PLAN_ID_RE` existed twice and had drifted** — the producer (`bootstrap.mjs`) enforced 8 hex chars while the checker (`validate-plan.mjs`) accepted `[0-9a-f]+` for "forward compatibility". A checker looser than its producer cannot detect a corrupt pointer. One strict definition now lives in `shared.mjs`.
- **Decision ids were hard-capped at 3 digits** (`D-\d{3}`) across 9 regex sites, so `D-1000` was an unparseable header and an unstampable anchor. Widened to `\d{3,}` — 3-digit padding is now a minimum, not a cap. **Widening it naively introduced a latent source-corruption bug** in `bootstrap.mjs retire`, the one consumer with no terminator after the id: greedy backtracking on an already-stamped `D-1000 [STALE]` matches `D-100`, passes the idempotency lookahead, and rewrites source into `D-100 [STALE]0 [STALE]`. The boundary is now baked into the shared grammar (`\d{3,}(?!\d)`), so all 9 consumers are boundary-safe by construction.
- **Nothing compared `TEST_COUNT` against reality.** `check-readme-parity` compares the README badge against `TEST_COUNT`; when both are stale it passes — and both were (302 vs a live 584). New `check-test-count.mjs` runs the suite, parses the TAP `# pass` / `# fail` summary, and fails on mismatch or on any failing test. Wired into `test`, deliberately not into `validate` (which stays fast and suite-free).

### Added

The XML artifact foundation (zero dependencies — Node 18 ships no XML parser, and adding one would break the property that makes this skill installable as a bare file tree; see D-001):

- **`src/scripts/xml.mjs`** (298 lines) — hand-written parser + serializer over a deliberately restricted subset: elements, attributes, text, CDATA, comments, XML declaration, the 5 predefined entities plus numeric character references. No namespaces, no DTD, no mixed-content semantics. Malformed input throws with line:column. The 300-line budget is pinned by a test — any future *addition* to the parser must re-open D-001 rather than push past it.
- **`src/scripts/schema.mjs`** — a declarative element spec (typed attributes: `enum`, `regex`, `int`, `iso-datetime`, `path`, `free-text`; child cardinality) plus `validateDoc()` / `validateElement()`. It **replaces** the 6 hand-maintained changelog field regexes rather than becoming a seventh representation: the same spec validates the XML form, the legacy markdown form, and the append CLI's inputs. Two field types came out *stricter* than the regexes they replace — `iso-datetime` now rejects calendar-impossible dates like `2026-02-30` (the old regex, and `Date.parse`, both accept it by rolling over), and `path` rejects newlines.
- **`src/scripts/changelog.mjs`** — the write-through CLI: `append` (parse, schema-validate, insert node, re-serialize, atomic `.tmp` + rename), `import` (legacy `.md` → `.xml`, opt-in, `--dry-run`-able), `render` (back to the byte-identical pipe-delimited markdown the Presentation Contracts and `ip-reviewer` consume). **No agent ever hand-writes XML** — appending to a closed root element is not a pure append, and LLM tag-matching errors in an append-only file were the top identified risk. That risk is removed structurally, not by prompt discipline (D-002).
- 282 new tests (302 → 584), including a 50-sequential-append durability test (well-formedness does not degrade under append) and a byte-exact `import → render` round-trip against the repo's real changelog.

### Changed

- **`changelog.xml` is now the encoding for NEW plans.** `bootstrap.mjs new` creates it via the changelog library (it is a *caller*, never a second author of the format). The validator is encoding-aware: `.xml` wins when present, WARN `[changelog-dual-encoding]` when both exist, WARN `[changelog-unparseable]` on a well-formedness failure. Every changelog issue stays WARN-tier, so a bug in our own parser can never block a CLOSE.
- **Legacy `changelog.md` keeps validating and keeps compressing, unchanged.** Migration is opt-in via `changelog.mjs import` and never drops a line: `import` re-renders each element it builds and compares it to the source line, demoting any mismatch to a verbatim `<raw>` element. A line is either understood exactly or preserved byte-for-byte — never reformatted. The legacy markdown compressor is retained beside the new XML one and is proven byte-identical to its pre-change output by a golden-bytes test.
- The 6 changelog field regexes are **deleted** from `validate-plan.mjs` (pinned by a test that greps the source and fails if any returns). Validator output on a real plan dir is byte-identical before and after the port — the schema changed no verdict.
- `ip-executor.md` now requires `changelog.mjs append` (hand-written XML is forbidden; an append failure is non-fatal — log and proceed). `ip-reviewer.md` reads the changelog via `changelog.mjs render`. `file-formats.md`'s changelog template slice is rewritten to the XML form with the schema table, render contract, and precedence rule; all 17 emit-template slugs still slice byte-faithfully.

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
