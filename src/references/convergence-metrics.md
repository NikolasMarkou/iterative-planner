# Convergence Metrics Reference

Quantitative signals for detecting stalling and oscillation across iterations. Both metrics are **EXTENDED** — skip for iteration 1 single-pass plans.

## Convergence Score

Computed during REFLECT Phase 2 (iteration 2+). Answers: "Is the plan converging toward done, or are we spinning?"

### Formula

```
convergence_score = pass_rate_delta + scope_stability + issue_trend
                    (each scored -1 to +1, total range: -3 to +3)

pass_rate_delta = current_pass_rate - previous_pass_rate
  Pass rate = criteria PASS / total criteria (from verification.md)
  Range: -1.0 to +1.0. Positive = improving.

scope_stability = 1 - clamp(|files_changed - files_planned| / files_planned, 0, 1)
  Range: 0.0 to 1.0. 1.0 = no scope drift.
  Use Files To Modify (plan.md) vs change manifest (state.md).

issue_trend = sign(previous_new_issues - current_new_issues)
  +1 if fewer new issues this iteration, -1 if more, 0 if same.
  Count: FAIL results + regressions + scope drift items in verification.md.
```

### Decision Rules

| Score | Signal | Action |
|-------|--------|--------|
| > +1.0 for 2 iterations | **Converging** | Strong case for CLOSE (pending criteria) |
| 0.0 to +1.0 | **Progressing** | Continue current approach |
| -1.0 to 0.0 for 2 iterations | **Stalling** | Consider PIVOT or decomposition early |
| < -1.0 for 2 iterations | **Diverging** | Trigger decomposition analysis (don't wait for iteration 5) |

### Where to Record

In `verification.md`, after Prediction Accuracy:

```markdown
## Convergence Metrics
| Metric | Previous | Current | Delta |
|--------|----------|---------|-------|
| Pass rate | 2/5 (40%) | 4/5 (80%) | +0.40 |
| Scope (files planned vs changed) | 3 vs 4 | 3 vs 3 | stable (1.0) |
| New issues found | 3 | 1 | improving (+1) |
| **Convergence score** | — | **+2.4** | **Converging** |
```

### First Iteration
Write "N/A — first iteration, no previous data to compare" in the table. The score becomes meaningful at iteration 2.

---

## Momentum Tracker (Pivot Direction Log)

Logged during PIVOT in `decisions.md`. Answers: "Are our PIVOTs making progress or oscillating?"

### Format

Add to each PIVOT entry in `decisions.md`:

```markdown
**Pivot Direction**: [1-3 word summary of change direction]
**Direction History**: [list of all pivot directions this plan]
**Momentum**: [N same-direction / M total pivots = ratio]
```

### Example

```markdown
## D-004 | REFLECT → PIVOT | 2025-01-16
**Context**: Token validation still failing on edge cases
**Pivot Direction**: simplify validation
**Direction History**: add caching → simplify auth → add caching → simplify validation
**Momentum**: 1/3 = 0.33 (oscillating — 2 direction reversals)
...
```

### Decision Rules

| Momentum | Signal | Action |
|----------|--------|--------|
| >= 0.7 | **Consistent** | PIVOTs are refining, not reversing. Continue. |
| 0.3 - 0.7 | **Mixed** | Review whether the plan's framing is wrong, not just the approach. |
| < 0.3 | **Oscillating** | Strong signal for decomposition. Log in decisions.md: "Momentum < 0.3 — oscillation detected. Consider splitting goal into independent sub-plans." |

### How to Classify Direction

Use a short phrase describing the *nature* of the change, not the specific implementation:
- "simplify X" vs "add X" — these are opposite directions
- "simplify auth" then "simplify validation" — same direction (simplifying)
- "add caching" then "remove caching" — opposite directions (oscillation)

Two consecutive PIVOTs in opposite directions = 1 reversal. Count reversals, not just differences.

### First PIVOT
No momentum calculation on the first PIVOT (no history). Just log the direction. Momentum tracking starts from the second PIVOT onward.
