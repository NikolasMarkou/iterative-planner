# Planning Rigor Reference

Techniques for stronger plans: surface assumptions, anticipate failure, and calibrate confidence.

## Assumption Tracking

Plans depend on assumptions discovered during EXPLORE. Make them explicit so when one breaks, you know which steps are invalidated.

**In `plan.md`** — after Steps, before Failure Modes:

```markdown
## Assumptions
- Redis handles 80% of sessions (findings/auth-system.md) → steps 1-3 depend on this
- SessionSerializer can be extended (findings/auth-system.md L34) → step 2 depends on this. Falsified if gem locks serializer interface.
- No other consumers of cookie format (findings/dependencies.md) → step 3 depends on this
```

**Rules**:
- Bullet list, not a table. Each: what you assume, where it's grounded, which steps depend on it.
- Add "Falsified if..." when the falsification condition is non-obvious.
- On surprise discovery during EXECUTE: check Assumptions first. If a listed assumption is falsified, you know which steps to re-evaluate.
- On RE-PLAN: review assumptions — were any wrong? Update findings with corrections.

## Pre-Mortem & Falsification Signals

Two prompts, one section. After writing the plan and before presenting for user approval:

1. **Pre-mortem**: Assume this plan failed after full execution. Why? (2-3 scenarios)
2. **Falsification signals**: What observable triggers during EXECUTE mean "wrong approach, stop"?

The pre-mortem generates the signals. They're the same insight — failure scenarios produce the concrete triggers.

**In `plan.md`** — after Failure Modes:

```markdown
## Pre-Mortem & Falsification Signals
*Assume this plan failed. Most likely reasons → observable stop triggers:*
1. **Cookie fallback is more complex than expected** — SSO flow depends on cookie format details we haven't fully traced (step 3) → STOP IF >2 files need changes in SSO module
2. **Token validation has edge cases with clock skew** — distributed services may reject valid tokens near expiry (step 2) → STOP IF intermittent test failures on token expiry
3. **Interface is wrong** — new auth path requires too many mocks → STOP IF test suite needs >3 mocks for token flow
```

**Rules**:
- 2-3 entries. Each names: what could go wrong, which step, and a concrete STOP IF trigger.
- Failure Modes table covers *dependencies* (external). This section covers *approach validity* (internal).
- Can't imagine failure → plan is underspecified or you're overconfident. Go back to EXPLORE.
- STOP IF triggers are checked during EXECUTE. When one fires: note in `state.md`, finish or revert current step, transition to REFLECT. Log which signal fired in `decisions.md`.
- Distinct from success criteria (which define "done") and Autonomy Leash (which triggers on step *failure*) — these trigger on approach *invalidity*.

## Exploration Confidence

Quality gate for EXPLORE → PLAN transition. The 3-finding minimum is a *quantity* floor. This is the *quality* check.

Before transitioning to PLAN, self-assess in the EXPLORE → PLAN transition log in `state.md`:

```markdown
- EXPLORE → PLAN (confidence: scope=adequate, solutions=adequate, risks=partial)
```

| Dimension | Levels |
|-----------|--------|
| **Problem scope** | shallow (key mechanics unclear) / adequate (can state problem, invariants, edge cases) / deep (traced code paths, know internals) |
| **Solution space** | narrow (one obvious approach) / open (multiple approaches identified) / constrained (few options, hard limits) |
| **Risk visibility** | blind (unknown unknowns) / partial (some risks identified) / clear (risks mapped, unknowns located) |

**Gate**: All three must be at least "adequate" to transition. Any "shallow" or "blind" → keep exploring. This is a mental check recorded in the transition log, not a separate file section.

## Prediction Accuracy

Track how well the plan predicted reality. Builds institutional memory about systematic biases.

**In `verification.md`** — during REFLECT, after Criteria Verification:

```markdown
## Prediction Accuracy
| Predicted (from plan.md) | Actual | Delta |
|--------------------------|--------|-------|
| 5 steps | 7 steps (+2 during EXECUTE) | +40% |
| 3 files modified | 5 files modified | +67% |
| Net-zero lines | +45 lines | over budget |
| 1 iteration | 3 iterations | 3x underestimate |
```

**Rules**:
- Fill in during REFLECT by comparing plan.md (original) against actual results.
- Focus on: step count, file count, line delta, iteration count. Add task-specific metrics if relevant.
- Feed significant patterns into `plans/LESSONS.md` at CLOSE (e.g., "consistently underestimate file count by 50%").
- Not a judgment — it's calibration data. Underestimates are normal early on. The goal is to get better over time.

## Ghost Constraint Hunting (RE-PLAN)

Ghost constraints = past constraints baked into the current approach that no longer apply. They're the most common source of unnecessarily constrained solution spaces.

**Active scan during RE-PLAN** — before designing a new approach, ask:

1. **Is the constraint that led to the failed approach still valid?** Example: "We assumed we couldn't change the serializer because of gem X — but gem X was upgraded last month."
2. **Are we inheriting constraints from the codebase that are actually preferences?** Example: "Everything uses Redis, so we assumed we must use Redis — but the actual requirement is 'fast key-value lookup.'"
3. **Did an early finding become a ghost?** Re-check findings from early EXPLORE against current understanding. Early findings are most likely to become stale.

Log ghost constraints found in `decisions.md` with: what the ghost was, why it no longer applies, and how removing it changes the solution space.

## Phase Balance Heuristic

Rough guideline for effort distribution. Not hard rules — adjust per task complexity.

| Phase | Typical Budget | Warning Sign |
|-------|---------------|--------------|
| EXPLORE | 20-30% | >40% → over-exploring or task needs decomposition |
| PLAN | 10-15% | >25% → can't converge → go back to EXPLORE |
| EXECUTE | 40-50% | >60% → likely under-explored |
| REFLECT | 5-10% | <5% → skimming verification |
| RE-PLAN | 5-10% | >15% → churning, consider decomposition |

If EXECUTE consistently dominates (>60%), the pattern is: not enough exploration upfront → discoveries during execution → surprise pivots. Invest more in EXPLORE.

## Decomposition at Iteration Limit

At iteration 5 (nuclear option check), if continuing:

**Mandatory decomposition analysis** in `decisions.md`:

```markdown
## Decomposition Analysis (iteration 5)
**Why iterations are accumulating**: [root cause — scope creep? wrong abstraction? insufficient exploration?]

**Independent sub-goals** (each could be a separate plan):
1. [Sub-goal A] — [what it covers, estimated complexity]
2. [Sub-goal B] — [what it covers, estimated complexity]
3. [Sub-goal C] — [what it covers, estimated complexity]

**Dependencies between sub-goals**: [which must come first, which are independent]
**Recommendation**: [decompose now / one more iteration with tighter scope / nuclear revert]
```

This gives the user something actionable when the iteration 6 hard stop hits, rather than just "this is too hard."
