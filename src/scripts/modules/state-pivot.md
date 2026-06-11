- Read `decisions.md`, `findings.md`, relevant `findings/*`, `plans/LESSONS.md`.
- Read `checkpoints/*` — decide keep vs revert. Default: if unsure, revert to latest checkpoint. See `references/code-hygiene.md` for full decision framework.
- **Ghost constraint scan** *(EXTENDED — skip for iteration 1)* — before designing a new approach, ask: (1) Is the constraint that led to the failed approach still valid? (2) Are we inheriting environmental constraints that are actually preferences? (3) Did an early finding become stale? Log ghost constraints found in `decisions.md`. See `references/planning-rigor.md`.
- If earlier findings proved wrong or incomplete → update `findings.md` + `findings/*` with corrections. Mark corrections: `[CORRECTED iter-N]` + what changed and why. Append, don't delete original text.
- **Momentum check** *(EXTENDED — 2nd PIVOT onward)* — log pivot direction, check for oscillation. Momentum < 0.3 → recommend decomposition. See `references/convergence-metrics.md`.
- Write `decisions.md`: log pivot + mandatory Complexity Assessment (+ pivot direction log if EXTENDED).
- Write `state.md` + `progress.md` (mark failed items, note pivot).
- Run `bootstrap.mjs reset-attempts` — the leash counter must NOT carry into the post-pivot EXECUTE, or the pre-step gate HARD-fails (`leash-cap`) on the first new step. (Same command applies when advancing to a genuinely new step.)
- Present options to user → get approval → transition to PLAN. Emit **PC-PIVOT** (Pivot Options contract — see `references/file-formats.md` "Presentation Contracts"): pivot reason, available checkpoints (verbatim from `checkpoints/*`), ghost constraints surfaced, 1-3 candidate directions framed "X at the cost of Y", and an explicit prompt for direction + keep-vs-revert decision.

