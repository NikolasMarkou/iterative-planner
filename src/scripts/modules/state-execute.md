- **Pre-Step Checklist** in `state.md`: reset all boxes `[ ]`, then check each `[x]` as completed before starting the step. This is the file-based enforcement of Mandatory Re-reads.
- Iteration 1, first EXECUTE → create `checkpoints/cp-000-iter1.md` (nuclear fallback). "Git State" = commit hash BEFORE changes (the restore point).
- One step at a time. Post-Step Gate after each (see below).
- Checkpoint before risky changes (3+ files, shared modules, destructive ops). Name: `cp-NNN-iterN.md` (e.g. `cp-001-iter2.md`). Increment NNN globally across iterations.
- Commit after each successful step: `[iter-N/step-M] description`.
- If something breaks → STOP. 2 fix attempts max (Autonomy Leash). Each must follow Revert-First.
- **Irreversible operations** (DB migrations, external API calls, service config, non-tracked file deletion): mark step `[IRREVERSIBLE]` in `plan.md` during PLAN. Full procedure: `references/code-hygiene.md`.
- **Surprise discovery** (behavior contradicts findings, unknown dependency, wrong assumption) → check plan.md Assumptions to identify which steps are invalidated. Note in `state.md`, finish or revert current step, transition to REFLECT. Do NOT silently update findings during EXECUTE.
- **Falsification signal fires** (from Pre-Mortem & Falsification Signals in plan.md) → same as surprise discovery. Log which signal fired in `decisions.md`.
- Add `# DECISION <plan-id>/D-NNN` comments (e.g. `# DECISION plan_2026-05-07_7556fb98/D-003`) where any of the 5 trigger conditions in `references/decision-anchoring.md` apply. Plan-id prefix matches the active plan directory name.
- **Per-Edit Changelog (v2.15.0+)**: after each `Edit` or `Write`, append one pipe-delimited line per file to `{plan-dir}/changelog.md` recording timestamp, iter/step, commit (or `uncommitted`), path, op + LOC, blast-radius (`node <skill-path>/scripts/blast-radius.mjs <file>` — first stdout line), decision-ref (`D-NNN` or `-`), and a one-clause reason. Append-only. Decision-ref is optional — `-` is fine for most edits. The 5 `# DECISION` trigger conditions are unchanged. Radius script always exits 0 — never blocks the step. See `references/file-formats.md` for full format (or run `node <skill-path>/scripts/emit-template.mjs --name changelog` to get just this template — file-formats.md is the canonical fallback) and `references/blast-radius.md` for radius scoring.

#### Post-Step Gate (successful steps only — all 4 before moving on)
1. `plan.md` — mark step `[x]`, advance marker, update complexity budget
2. `progress.md` — move item Remaining → Completed, set next In Progress
3. `state.md` — update step number, append to change manifest
4. `changelog.md` — confirm one line per file edited in this step (validator WARNs on drift)

On **failed step**: skip gate. Follow Autonomy Leash (revert-first, 2 attempts max).

