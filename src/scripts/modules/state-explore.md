- Read `state.md`, `plans/FINDINGS.md` and `plans/DECISIONS.md` (limit: 600 lines), `plans/LESSONS.md`, and `plans/SYSTEM.md` at start of EXPLORE for cross-plan context. SYSTEM.md is the structural prior — what the target system looks like, distinct from goal-driven findings. **Do NOT eagerly load `plans/INDEX.md`** — it is read on demand only.
- **On-demand INDEX.md read** — consult `plans/INDEX.md` (and then the specific per-plan `plans/<plan-id>/findings.md` it points to) when ANY of the following triggers fires:
  1. The goal mentions a topic or domain that is absent from the recent FINDINGS.md window.
  2. A `[CORRECTED iter-N]` or other cross-reference in FINDINGS.md / LESSONS.md / SYSTEM.md points to a per-plan finding that is no longer in the sliding window.
  3. The user explicitly references prior work ("we tried this before", "the X migration plan", etc.).
  4. The current plan touches files that appear in older plan directories' change manifests.
  See `references/file-formats.md` `plans/INDEX.md` section for the schema. Default is **do not read** — INDEX.md is a locator, not a cross-plan memory.
- **System-atlas contradiction flag**: if an EXPLORE finding contradicts an existing `plans/SYSTEM.md` entry, mark the contradiction in `findings.md` with `[CONTRADICTED iter-N]` (mirrors the `[CORRECTED iter-N]` rule for findings) — the archivist will reconcile at CLOSE in Step 4.
- Read code, grep, glob, search. One focused question at a time.
- Flush to `findings.md` + `findings/` after every 2 reads. **Read the file first** before each write.
- Include file paths + code path traces (e.g. `auth.rb:23` → `SessionStore#find` → `redis_store.rb:get`).
- DO NOT skip EXPLORE even if you think you know the answer.
- **Minimum depth**: ≥3 indexed findings in `findings.md` before transitioning to PLAN. Findings must cover: (1) problem scope, (2) affected files, (3) existing patterns or constraints. Fewer than 3 → keep exploring.
- **Exploration Confidence** — before transitioning to PLAN, self-assess: problem scope [shallow/adequate/deep], solution space [narrow/open/constrained], risk visibility [blind/partial/clear]. All must be at least "adequate." Any "shallow" or "blind" → keep exploring. Record in the transition log entry in `state.md`. See `references/planning-rigor.md`.
- **Constraint classification** — when documenting constraints in `findings.md`, classify each as:
  - **Hard constraint**: non-negotiable (physics, budget, existing systems, regulations, deadlines).
  - **Soft constraint**: preferences, conventions, team familiarity — negotiable if trade-off is explicit.
  - **Ghost constraint**: past constraints baked into current approach that **no longer apply**. Finding and removing ghost constraints unlocks options nobody thought were available.
  Separate constraints from preferences — be honest about which is which. Can't distinguish them → keep exploring.
- Use **Task subagents** (or `ip-explorer` agents if installed) to parallelize research. Spawn 1-3 explorer agents simultaneously, each assigned a distinct research topic. All subagent output → `{plan-dir}/findings/` files. Never rely on context-only results. **Main agent** updates `findings.md` index after subagents write — subagents don't touch the index. **Naming**: `findings/{topic-slug}.md` (kebab-case, descriptive — e.g. `auth-system.md`, `test-coverage.md`). See "Sub-Agent Architecture" section for dispatch details.
- Use "think hard" / "ultrathink" for complex analysis.
- REFLECT → EXPLORE loops: append to existing findings, don't overwrite. Mark corrections with `[CORRECTED iter-N]`.

