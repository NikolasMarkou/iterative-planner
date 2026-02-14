# Complexity Control Reference

The #1 failure mode of AI coding agents is adding complexity in response to failure.
Something breaks, so you add a wrapper. The wrapper has edge cases, so you add a handler.
The handler conflicts with existing code, so you add an adapter. Now you have 4 new
abstractions and the original problem is buried under layers of band-aids.

**The default response to failure MUST be to simplify, not to add.**

---

## The Complexity Ratchet — Recognize It

You are hitting the complexity ratchet when:
- You're wrapping a function in another function to "handle" an issue
- You're adding a try/catch or error handler to suppress a symptom
- You're creating an adapter/bridge/shim between two things you just wrote
- You're adding a configuration option to toggle between old and new behavior
- You're writing code to work around code you wrote 3 steps ago
- The fix for step N breaks step N-2
- You're adding types/interfaces to satisfy the compiler after your change
- Your plan steps are growing instead of shrinking

---

## The Complexity Budget

Track in `plan.md` under every plan version:

```markdown
## Complexity Budget
- Files added: 0/3 max
- New abstractions (classes/modules/interfaces): 0/2 max
- Lines added vs removed: +0/-0 (target: net negative or neutral)
```

If any limit is hit, STOP and enter REFLECT. Do not continue EXECUTE.
Ask: "Am I solving the root cause or patching symptoms?"

---

## Revert-First Policy

When something breaks during EXECUTE:

```
Step 1: STOP. Do not write any new code.
Step 2: Read the error. Understand it fully. Write it in decisions.md.
Step 3: Ask: "Can I fix this by REVERTING my last change?"
        If yes → revert and re-approach. Verify revert is clean (no leftover
        debug code, imports, or TODOs from the failed attempt).
        If no  → Ask: "Can I fix this by DELETING something?"
        If no  → Ask: "Can I fix this with a ONE-LINE change?"
        If no  → STOP. Enter REFLECT. You're about to add complexity.
```

**Never write more than 10 lines of new code as a "fix" without entering REFLECT first.**
If a fix needs more than 10 lines, it's not a fix — it's a new feature, and it needs
to go through the PLAN phase.

**Autonomy limit**: You get a maximum of 2 fix attempts per plan step. Both must
follow this policy (revert, delete, or one-liner). If neither works, STOP and
present the situation to the user. Do not attempt a 3rd fix. Do not try a different
angle. Do not keep going. Wait for user direction. See the Autonomy Leash section
in SKILL.md for the full rule and tracking format.

---

## Mandatory Simplification Checks

During every REFLECT phase, first **re-read `{plan-dir}/decisions.md`** to check what
has already been tried and failed. Then answer these explicitly in `decisions.md`:

1. **Could I delete code instead?** The best fix is often removing the thing that
   broke, not adding a workaround. Deleting code is always preferable to adding code.

2. **Am I treating a symptom?** If the fix doesn't address WHY something broke,
   it's a band-aid. Band-aids compound. Stop and find the root cause.

3. **Would a junior dev understand this?** If your solution requires a paragraph
   to explain, it's too complex. A good solution is obvious in hindsight.

4. **Am I fighting the framework/language/library?** If you're writing adapters
   or shims to make a tool work the way you want, you're probably using it wrong.
   Read the docs again. Use it the way it was designed.

5. **What happens if I revert everything and try a fundamentally different approach?**
   Sunk cost is not a reason to keep going. Three clean attempts beat one
   Frankenstein monster.

---

## The 3-Strike Rule

If the same area of code requires fixes 3 times across iterations:

1. **STOP executing immediately.**
2. Enter REFLECT.
3. Log in `decisions.md`: "3-STRIKE TRIGGERED on [file/module]"
4. The current approach to this area is wrong. Do not attempt a 4th fix.
5. Enter RE-PLAN with the constraint: "must use a fundamentally different
   approach for [file/module]."
6. Consider: is this code even necessary? Can the requirement be met without it?

---

## Forbidden Patterns During Fix Attempts

Do NOT do any of these when fixing a failure. If you catch yourself doing one, revert.

| Pattern | What It Looks Like | What To Do Instead |
|---------|-------------------|-------------------|
| **Wrapper cascade** | Adding a function that calls the broken function with extra handling | Fix the broken function or replace it |
| **Config toggle** | Adding a flag to switch between old and new behavior | Pick one. Delete the other. |
| **Defensive copy-paste** | Duplicating a function and modifying the copy "to be safe" | Modify the original or extract the shared part |
| **Exception swallowing** | `try { ... } catch(e) { /* ignore */ }` to make an error go away | Fix why the error happens |
| **Type escape hatches** | `as any`, `# type: ignore`, `@SuppressWarnings` to silence the compiler | Fix the types. The compiler is right. |
| **Adapter layer** | Creating a new class/module just to translate between two things you control | Change one of the two things to match the other |
| **"Temporary" workaround** | "I'll clean this up later" — you won't | Do it right now or don't do it |

---

## Complexity Assessment in decisions.md

Every RE-PLAN entry in `decisions.md` must include this block:

```markdown
**Complexity Assessment**:
- Lines added in failed attempt: N
- New abstractions added: N
- Could the fix have been simpler? [yes/no + why]
- Am I adding or removing complexity with the new plan? [adding/removing/neutral]
```

---

## The Nuclear Option

If iteration count hits 5 AND total lines added across all iterations exceeds
the original task's estimated scope by 2x:

1. Present the user with the full decision log.
2. Recommend: "Revert ALL changes. Start from a clean state. The accumulated
   complexity is higher than the cost of a fresh start with everything we now know."
3. If user agrees, revert to the initial checkpoint and RE-PLAN from scratch
   using only the `decisions.md` knowledge (not the code from failed attempts).

This is not failure. This is the protocol working as designed. The `decisions.md`
file means the fresh start has full knowledge of what doesn't work.
