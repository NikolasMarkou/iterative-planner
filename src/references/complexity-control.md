# Complexity Control Reference

Default response to failure = simplify, not add.

## The Complexity Ratchet — Recognize It

Signs:
- Wrapping a function in another function to "handle" an issue
- Adding try/catch to suppress a symptom
- Creating adapter/bridge/shim between things you just wrote
- Adding config toggle between old and new behavior
- Writing code to work around code from 3 steps ago
- Fix for step N breaks step N-2
- Adding types/interfaces to satisfy compiler after your change
- Plan steps are growing instead of shrinking

## Complexity Budget

Track in `plan.md`:

```markdown
## Complexity Budget
- Files added: 0/3 max
- New abstractions (classes/modules/interfaces): 0/2 max
- Lines added vs removed: +0/-0 (target: net negative or neutral)
```

Any limit hit → STOP → REFLECT. Ask: "Root cause or symptom?"

## Revert-First Policy

Something breaks during EXECUTE:

1. STOP. No new code.
2. Read the error. Log in `decisions.md`.
3. REVERT? → revert. Verify clean: no debug code/imports/TODOs.
4. DELETE? → delete.
5. ONE-LINE fix? → do it.
6. None → STOP → REFLECT.

**10-Line Rule**: fix needs >10 new lines → not a fix → REFLECT.

**Autonomy limit**: 2 fix attempts per step (revert/delete/one-liner only). Both fail → STOP. Wait for user. See Autonomy Leash in SKILL.md.

## Simplification Checks (REFLECT)

Re-read `decisions.md`. Answer in `decisions.md` using this format:

```markdown
**Simplification Checks**:
1. Could I delete code instead? [yes/no — what]
2. Symptom or root cause? [symptom/root — why]
3. Would a junior dev understand? [yes/no — what's complex]
4. Fighting the framework? [yes/no — what]
5. What if I revert everything? [worth it/not — why]
**Blocker found**: [yes/no — if yes, must address before CLOSE]
```

1. **Could I delete code instead?** Best fix = removing what broke.
2. **Symptom or root cause?** Band-aids compound.
3. **Would a junior dev understand?** Needs a paragraph to explain → too complex.
4. **Fighting the framework?** Writing adapters/shims → using it wrong. Read docs.
5. **What if I revert everything?** Sunk cost ≠ reason to continue. Three clean attempts > one Frankenstein.

If any check reveals a blocker → document in `decisions.md` → must address before CLOSE (RE-PLAN or fix).

## 3-Strike Rule

Same area needs fixes 3× across iterations:

1. STOP executing.
2. → REFLECT.
3. Log: "3-STRIKE TRIGGERED on [file/module]" in `decisions.md`.
4. Do NOT attempt fix #4.
5. Revert to checkpoint covering the struck area. If no matching checkpoint → revert uncommitted, then decide in RE-PLAN.
6. → RE-PLAN: "fundamentally different approach for [file/module]."
7. Consider: is this code even necessary?

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

## Complexity Assessment (mandatory in RE-PLAN entries)

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
4. RE-PLAN from scratch using only decision log.

Protocol working as designed — not failure.
