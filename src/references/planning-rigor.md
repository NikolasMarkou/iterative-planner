# Planning Rigor Reference

Techniques for stronger plans: surface assumptions, anticipate failure, and calibrate confidence. Domain-agnostic — applies to code, research, strategy, operations, and any structured problem-solving.

## Assumption Tracking

Plans depend on assumptions discovered during EXPLORE. Make them explicit so when one breaks, you know which steps are invalidated.

**In `plan.md`** — after Steps, before Failure Modes:

```markdown
## Assumptions
- Market demand stays above 10k units/month (findings/market-analysis.md) → steps 1-4 depend on this
- Existing supplier can scale to 2x capacity (findings/supply-chain.md) → step 2 depends on this. Falsified if lead time exceeds 8 weeks.
- Regulatory approval timeline is 90 days (findings/compliance.md) → step 5 depends on this
```

**Rules**:
- Bullet list, not a table. Each: what you assume, where it's grounded, which steps depend on it.
- Add "Falsified if..." when the falsification condition is non-obvious.
- On surprise discovery during EXECUTE: check Assumptions first. If a listed assumption is falsified, you know which steps to re-evaluate.
- On RE-PLAN: review assumptions — were any wrong? Update findings with corrections.

**Common assumption categories**:

| Category | Example |
|----------|---------|
| Resource availability | "Team has bandwidth," "budget covers X," "tool Y is accessible" |
| Environmental stability | "Requirements won't change," "API stays stable," "regulation unchanged" |
| Capability | "System can handle load," "team has expertise," "data is clean enough" |
| Dependency behavior | "Upstream delivers on time," "third-party service stays reliable" |
| Scope boundaries | "Feature X is out of scope," "we only need to support Y" |

## Pre-Mortem & Falsification Signals

Two prompts, one section. After writing the plan and before presenting for user approval:

1. **Pre-mortem**: Assume this plan failed after full execution. Why? (2-3 scenarios)
2. **Falsification signals**: What observable triggers during EXECUTE mean "wrong approach, stop"?

The pre-mortem generates the signals. They're the same insight — failure scenarios produce the concrete triggers.

**In `plan.md`** — after Failure Modes:

```markdown
## Pre-Mortem & Falsification Signals
*Assume this plan failed. Most likely reasons → observable stop triggers:*
1. **Demand forecast was wrong** — projections assumed stable growth but market is seasonal (step 1) → STOP IF first month actuals deviate >30% from forecast
2. **Integration complexity underestimated** — assumed clean interfaces but legacy system has undocumented constraints (step 3) → STOP IF >2 unexpected interface issues in first integration attempt
3. **Stakeholder alignment was superficial** — verbal buy-in doesn't survive budget review (step 4) → STOP IF key stakeholder raises blocking concerns after plan presentation
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
| **Problem scope** | shallow (key mechanics unclear) / adequate (can state problem, constraints, edge cases) / deep (traced causal chains, know internal dynamics) |
| **Solution space** | narrow (one obvious approach) / open (multiple approaches identified) / constrained (few options, hard limits) |
| **Risk visibility** | blind (unknown unknowns) / partial (some risks identified) / clear (risks mapped, unknowns located) |

**Gate**: All three must be at least "adequate" to transition. Any "shallow" or "blind" → keep exploring. This is a mental check recorded in the transition log, not a separate file section.

**Calibration cues by dimension**:

| Dimension | "Adequate" feels like... | "Shallow/Blind" feels like... |
|-----------|-------------------------|-------------------------------|
| Scope | You can explain the problem to someone unfamiliar and answer their follow-ups | You'd struggle to explain why the problem exists or what constraints matter |
| Solutions | You can name at least two viable approaches and articulate trade-offs | You have one idea and haven't considered alternatives |
| Risks | You can list what could go wrong and where uncertainty clusters | You feel confident but can't name specific risks — that's the danger signal |

## Prediction Accuracy

Track how well the plan predicted reality. Builds institutional memory about systematic biases.

**In `verification.md`** — during REFLECT, after Criteria Verification:

```markdown
## Prediction Accuracy
| Predicted (from plan.md) | Actual | Delta |
|--------------------------|--------|-------|
| 5 steps | 7 steps (+2 during EXECUTE) | +40% |
| 3 components affected | 5 components affected | +67% |
| Net-neutral complexity | Moderate added complexity | over budget |
| 1 iteration | 3 iterations | 3x underestimate |
```

**Rules**:
- Fill in during REFLECT by comparing plan.md (original) against actual results.
- Default metrics: step count, scope of changes, complexity delta, iteration count. Add task-specific metrics as relevant (e.g., time elapsed, resources consumed, stakeholders consulted).
- Feed significant patterns into `plans/LESSONS.md` at CLOSE (e.g., "consistently underestimate scope by 50%").
- Not a judgment — it's calibration data. Underestimates are normal early on. The goal is to get better over time.

**Common bias patterns to watch for**:

| Bias | Pattern | Antidote |
|------|---------|----------|
| Planning fallacy | Steps and effort consistently underestimated | Multiply initial estimate by historical correction factor |
| Scope creep blindness | "Small additions" accumulate unnoticed | Track scope changes explicitly in progress.md |
| Optimism on dependencies | External dependencies assumed to be reliable | Add buffer for every external dependency |
| Complexity discount | "It's straightforward" → it wasn't | If you catch yourself saying "simple," add a risk entry |

## Ghost Constraint Hunting (RE-PLAN)

Ghost constraints = past constraints baked into the current approach that no longer apply. They're the most common source of unnecessarily constrained solution spaces.

**Active scan during RE-PLAN** — before designing a new approach, ask:

1. **Is the constraint that led to the failed approach still valid?** Example: "We assumed we couldn't change the vendor because of a contract — but the contract was renegotiated last quarter."
2. **Are we inheriting environmental constraints that are actually preferences?** Example: "Everyone uses tool X, so we assumed we must use tool X — but the actual requirement is 'reliable data processing,' not a specific tool."
3. **Did an early finding become a ghost?** Re-check findings from early EXPLORE against current understanding. Early findings are most likely to become stale.

**Ghost constraint indicators**:
- "We've always done it this way" without a traceable reason
- A constraint that nobody can attribute to a specific requirement or decision
- An assumption carried from a previous iteration that was never re-validated
- Constraints inherited from analogous past projects that may not transfer

Log ghost constraints found in `decisions.md` with: what the ghost was, why it no longer applies, and how removing it changes the solution space.

## Phase Balance Heuristic

Rough guideline for effort distribution. Not hard rules — adjust per task complexity.

| Phase | Typical Budget | Warning Sign |
|-------|---------------|--------------|
| EXPLORE | 20-30% | >40% → over-exploring or task needs decomposition |
| PLAN | 10-15% | >25% → can't converge → go back to EXPLORE |
| EXECUTE | 40-50% | >60% → likely under-explored |
| REFLECT | 5-10% | <5% → skimming verification. If routing CLOSE after <5% REFLECT, explain in `decisions.md` why verification was trivial. |
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
