
Three phases: Gate-In (gather context), Evaluate (verify + analyze), Gate-Out (decide + present).

#### Phase 1: Gate-In (mandatory reads before any evaluation)
1. Read `plan.md` — success criteria, verification strategy, assumptions, pre-mortem signals.
2. Read `progress.md` — what was completed, what remains, what failed.
3. Read `verification.md` — previous verification results (if iteration 2+). On re-entry after an interruption: a Criteria table with fewer rows than plan.md's Success Criteria, or a `findings/review-iter-N[-passM].md` missing its `## Verdict` line, is PARTIAL evidence from an interrupted verifier/reviewer — treat it as such and re-spawn rather than trusting file existence (for a reviewer, per the `-passM` naming rule; a re-spawned verifier just returns results — verification.md has no passM scheme).
4. Read `findings.md` + relevant `findings/*` — check if EXECUTE discoveries contradict earlier findings. Note contradictions in `decisions.md`.
5. Read `checkpoints/*` — know rollback options before deciding next transition. Note available restore points in `decisions.md` if transitioning to PIVOT.
6. Read `decisions.md` — check 3-strike patterns, review previous REFLECT cycles (iteration 2+).
7. Read `changelog.md` — per-edit ledger for this iteration. Surfaces HIGH-radius edits, "tiny edit big radius" outliers, and REVERT lines.

All seven reads are CORE. Do not evaluate until all are complete.

#### Phase 2: Evaluate
*(Continues the numbering from Phase 1's 7 reads — Evaluate runs 8–22.)*
8. **Cross-validate plan vs progress** — every `[x]` in plan.md must be "Completed" in progress.md. Fix drift before proceeding.
9. **Diff review** — review actual code changes (git diff or change manifest in state.md). Check for: debug artifacts, commented-out code, TODO/FIXME/HACK leftovers, unintended modifications to files not in the plan. This checks code quality; verification (below) checks correctness.
10. **Changelog scan (v2.15.0+)** — read `changelog.md`. List HIGH-radius edits and "tiny edit big radius" outliers (small `EDIT(+N,-M)` paired with MED/HIGH radius). Flag thin reasons. Surface concerns in the review output (or `findings/review-iter-N[-passM].md` when an `ip-reviewer` runs). Informational only — never blocks CLOSE.
11. **Run verification** — execute each check from the Verification Strategy. Read `verification.md`, then record results: criterion, method, command/action, result (PASS/FAIL), evidence (output summary or log reference). See `references/file-formats.md` for template — or run `node <skill-path>/scripts/emit-template.mjs --name verification` to get just this template (file-formats.md is the canonical fallback).
12. **Regression check** — re-run any tests that passed before this iteration. If a previously-passing test now fails, record as FAIL in Additional Checks with "regression" noted in Details. Regressions block CLOSE.
13. **Scope drift check** — compare files actually changed (change manifest in state.md) against Files To Modify in plan.md. Unplanned file changes must be justified in `decisions.md` or reverted. Criteria can pass even when implementation has drifted.
14. **Criteria adequacy** — before accepting PASS results, ask: do these criteria test what matters, or what was easy to test? Are there behaviors the criteria don't cover? Record gaps in `verification.md` Not Verified section.
15. **Not-verified list** — in `verification.md`, write what you didn't test and why (no coverage, out of scope, untestable). Absence of evidence is not evidence of absence.
16. **Root cause analysis** (when REFLECT follows failure) — in `decisions.md`, answer: (1) immediate cause, (2) contributing factor (trace back one level), (3) failed defense (which barrier should have caught this and why didn't it), (4) prevention. If the failure is a regression, prepend a Change Analysis question: "what changed since the last passing state?". Multiple roots are normal — don't stop at the first plausible cause. Skip entirely if all criteria PASS on first attempt. See `references/planning-rigor.md` for the canonical 4-part schema, and `references/root-cause-analysis.md` for structured methods (5 Whys, fishbone category scan, optional fault tree, Cynefin selector).
17. **Run 6 Simplification Checks** (`references/complexity-control.md`). Compare against **written criteria**, not memory.
    - **Python/software tasks**: run `references/python-software.md` § C.12 Anti-pattern checklist (20 items) as an extra review gate. Skip for non-software plans.
18. **Run `validate-plan.mjs`** — protocol compliance check. Address ERRORs before CLOSE. WARNs are advisory. Note: this run precedes Phase 3's decisions.md writes; the authoritative pre-close validator gate is ip-archivist Step 1 plus its Step 3/4 post-rewrite re-runs — do not turn this item into a hard REFLECT→CLOSE gate without accounting for the later writes.
19. **Prediction accuracy** *(EXTENDED — skip for iteration 1)* — compare plan.md predictions against actual results. Record in `verification.md` Prediction Accuracy table. See `references/planning-rigor.md`.
20. **Convergence score** *(EXTENDED — iteration 2+)* — compute pass rate trend, scope stability, issue decay. Record in `verification.md` Convergence Metrics table. Stalling/diverging scores strengthen case for PIVOT or decomposition — don't wait for iteration 5. See `references/convergence-metrics.md`.
21. **Devil's advocate** *(EXTENDED — skip for iteration 1)* — before routing to CLOSE: name one reason this might still be wrong despite passing verification. If you can't think of one, be more suspicious, not less. Record in `decisions.md`.
22. **Adversarial review** *(EXTENDED — iteration 2+ by default; the orchestrator may spawn it earlier by choice, e.g. an iteration-1 attack-before-release pass ahead of a release/version bump — the iteration-2+ default is unchanged)* — spawn an `ip-reviewer` agent (or Task subagent) with `verification.md`, `plan.md` (criteria), and `decisions.md`. Its job: are criteria adequate? what wasn't tested? does evidence support CLOSE? Output → `findings/review-iter-N[-passM].md` (bare for a first pass, `-passM` for re-reviews per ip-reviewer's naming rule). Main agent must address each concern in `decisions.md` before routing to CLOSE, AND honor the review's `## Verdict` (READY_TO_CLOSE / NEEDS_WORK / NEEDS_INVESTIGATION): a non-`READY_TO_CLOSE` verdict must be reflected in the routing recommendation — don't recommend CLOSE over it without a justified override in `decisions.md`. See "Sub-Agent Architecture" section for dispatch details.

#### Phase 3: Gate-Out (write + present)
23. Write `verification.md` — complete Verdict section. 0 verified criteria (an empty or placeholder Verification Strategy) is FAIL-equivalent for the item-5 recommendation below: never recommend CLOSE on an empty Verification Strategy without calling it out explicitly.
24. Write `decisions.md` — what happened, what was learned, root cause (if failure). Include Simplification Checks output.
25. Write `progress.md` — update status of all items.
26. Write `state.md` — log evaluation summary, update transition.

**Present to user before routing — PC-REFLECT contract** (see `references/file-formats.md` "Presentation Contracts"). Emit a 5-item block (exactly 5 — collapsing violates the contract):
1. What was completed (verbatim from `progress.md`)
2. What remains (verbatim from `progress.md`, or "none")
3. Verification results summary — PASS/FAIL counts plus the per-criterion table from `verification.md` rendered **verbatim** (the verifier's table is the literal payload, do not paraphrase)
4. Issues found: regressions, scope drift, unverified areas, simplification blockers; **plus** any CRITICAL/WARNING items from `findings/review-iter-N[-passM].md` (when a review ran) folded in verbatim; **plus** any verifier **Concerns** (suspicious-but-PASS observations, per the Relay Contract in `ip-verifier.md`) folded in verbatim; **plus** the reviewer's `## Blind Spots` bullets (what wasn't tested and why it matters) folded in
5. Recommend: close, pivot, explore, or execute — **wait for user confirmation**. If an adversarial review ran, the recommendation must be consistent with its `## Verdict`: do NOT recommend CLOSE over a `NEEDS_WORK`/`NEEDS_INVESTIGATION` verdict without a justified override in `decisions.md`.

| Condition | → Transition |
|-----------|--------------|
| All criteria verified PASS in `verification.md`, no regressions, no simplification blockers + **user confirms** | → CLOSE |
| Completion-fix remediation surfaced during REFLECT: small fixes to finish the SAME iteration's work (not a new approach → not PIVOT; not more context → not EXPLORE) + **user confirms** | → EXECUTE (same iteration; `iter` does not increment) |
| Failure understood, new approach clear | → PIVOT |
| Unknowns need investigation, or findings contradicted | → EXPLORE (update findings first) |

> **Before re-entering EXECUTE** (the → EXECUTE row above, OR a user "continue" past a leash hit): run `node <skill-path>/scripts/bootstrap.mjs reset-attempts`. The leash counter must not carry into the re-entry, or EXECUTE's pre-step gate re-trips `leash-cap` on the stale count before any spawn (mirrors the PIVOT reset; this is the "user direction" reset the Autonomy Leash names).

