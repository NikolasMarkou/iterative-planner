# Complexity Control Reference

Default response to failure = simplify, not add.

## The Complexity Ratchet — Recognize It

| Signal | Pattern |
|---|---|
| Wrapper cascade | fn wrapping broken fn to "handle" issue |
| Symptom suppression | try/catch hiding error |
| Adapter insertion | bridge/shim between things you just wrote |
| Toggle proliferation | config flag switching old/new |
| Circular fix | code working around code from 3 steps ago |
| Cross-step breakage | fix for step N breaks step N-2 |
| Compiler appeasement | types/interfaces added to satisfy compiler |
| Step count growing | plan steps increase instead of shrink |

## Complexity Budget

Track in `plan.md`:

```markdown
## Complexity Budget
- Files added: 0/3 max
- New abstractions (classes/modules/interfaces): 0/2 max
- Lines added vs removed: +0/-0 (target: net negative or neutral)
```

Any limit hit → STOP → REFLECT. Ask: "Root cause or symptom?"

**Earned-abstraction rule (use before reuse).** An abstraction (class/module/interface/shared param/flag) is *earned* only when ≥2 concrete call sites need it. Simplicity before generality: build the concrete thing first, extract once a second concrete call site appears — not in anticipation. A single-use abstraction is speculative generality — it spends the abstraction budget with no payoff → inline it. (YAGNI.)

## Revert-First Policy (EXECUTE failure)

1. STOP. No new code.
2. Can revert? → revert + verify clean (no debug code/imports/TODOs).
3. Can delete? → delete.
4. Fix ≤10 lines? → apply.
5. None ⇒ STOP → REFLECT.

`|new_lines| > 10 ⇒ not a fix ⇒ REFLECT` (10-Line Rule).
Autonomy: 2 fix attempts/step (revert/delete/one-liner only). Both fail ⇒ STOP. See Autonomy Leash in SKILL.md.

## Simplification Checks (REFLECT)

Re-read `decisions.md`. Answer in `decisions.md` using this format:

```markdown
**Simplification Checks**:
1. Could I delete code instead? [yes/no — what]
2. Symptom or root cause? [symptom/root — why]
3. Essential or accidental complexity? [essential/accidental — why]
4. Would a junior dev understand? [yes/no — what's complex]
5. Fighting the framework? [yes/no — what]
6. What if I revert everything? [worth it/not — why]
**Blocker found**: [yes/no — if yes, must address before CLOSE]
```

1. **Could I delete code instead?** Best fix = removing what broke.
2. **Symptom or root cause?** Band-aids compound.
3. **Essential or accidental complexity?** Essential complexity is inherent in the problem — it can be partitioned but not eliminated. Accidental complexity is self-inflicted through poor choices, wrong tools, or accumulated shortcuts. If accidental → simplify or remove. If essential → partition it, don't fight it.
4. **Would a junior dev understand?** Needs a paragraph to explain → too complex.
5. **Fighting the framework?** Writing adapters/shims → using it wrong. Read docs.
6. **What if I revert everything?** Sunk cost ≠ reason to continue. Three clean attempts > one Frankenstein.

If any check reveals a blocker → document in `decisions.md` → must address before CLOSE (PIVOT or fix).

## 3-Strike Rule

Same area fixed 3× across iterations ⇒
1. STOP → REFLECT. Log `3-STRIKE TRIGGERED on [file/module]` in `decisions.md`.
2. Do NOT attempt fix #4.
3. Revert to checkpoint covering struck area (or revert uncommitted if none → decide in PIVOT).
4. → PIVOT: "fundamentally different approach for [file/module]."
5. Consider: is this code even necessary?

## Forbidden Fix Patterns

Catch yourself doing one → revert.

| Pattern | Looks Like | Do Instead |
|---------|-----------|------------|
| Wrapper cascade | Function calling broken function with extra handling | Fix or replace broken function |
| Config toggle | Flag switching old/new behavior | Pick one. Delete other. |
| Defensive copy-paste | Duplicating + modifying "to be safe" | Modify original or extract shared part |
| Exception swallowing | `catch(e) { /* ignore */ }` | Fix why error happens |
| Type escape hatch | `as any`, `# type: ignore`, `@SuppressWarnings` | Fix the types. Compiler is right. |
| Adapter layer | New class to translate between things you control | Change one to match the other |
| "Temporary" workaround | "I'll clean this up later" | Do it right now or don't |

## Complexity Assessment (mandatory in PIVOT entries)

```markdown
**Complexity Assessment**:
- Lines added in failed attempt: N
- New abstractions added: N
- Could the fix have been simpler? [yes/no + why]
- Am I adding or removing complexity with the new plan? [adding/removing/neutral]
```

## Nuclear Option

Iteration 5 AND total lines added > 2× original scope:

1. Present full decision log to user.
2. Recommend: revert ALL, start clean with `decisions.md` knowledge.
3. If agreed → revert to `cp-000` (initial checkpoint). User may choose a later checkpoint if partial progress is worth keeping — confirm explicitly.
4. PIVOT from scratch using only decision log.

Protocol working as designed — not failure.
