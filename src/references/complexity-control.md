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

This fenced block is the canonical shape (same 3 fields, same wording). The two byte-gated copies in `file-formats.md` (the SKELETON:plan region's block and the plan.md worked-example block) and SKILL.md's one-liner summary must match it.

Track in `plan.md`:

```markdown
## Complexity Budget
- Files added: 0/3 max
- New abstractions (classes/modules/interfaces): 0/2 max
- Lines added vs removed: +0/-0 (target: net negative or neutral)
```

Any limit hit → STOP → REFLECT. Ask: "Root cause or symptom?"

**Earned-abstraction rule (use before reuse).** An abstraction (class/module/interface/shared param/flag) is *earned* only when ≥2 concrete call sites need it. Simplicity before generality: build the concrete thing first, extract once a second concrete call site appears — not in anticipation. A single-use abstraction is speculative generality — it spends the abstraction budget with no payoff → inline it. (YAGNI.)

## Before Writing New Code

Before planning or writing any new file, function, abstraction or dependency, ask these five questions in this order. Stop at the first yes: skip it (question 1) or use the existing thing (questions 2 to 5).

1. Can this be skipped with the goal still met? If yes, skip it.
2. Is it already in the codebase? Use it.
3. Does the language's standard library do it? Use it.
4. Does a dependency that is already installed do it? Use it.
5. Does a native platform feature do it (OS, shell, git, browser, database, framework built-in)? Use it.

Only after five no answers, write new code.

- Questions 3 to 5 apply to software work only; questions 1 and 2 apply to every plan.
- Adding a new dependency is not question 4. It is a Build vs Buy decision: `references/python-software.md` § Decision frameworks.
- When: in PLAN, for every new entry in Files To Modify and every new abstraction in Steps; in EXECUTE, before adding a function, constant, parser, rule or dependency; in REFLECT, through Simplification Check 1.
- A "new" line in Files To Modify says which question failed, for example `(new: no existing helper, standard library call or installed package does this)`.
- Advisory: reviewers spot-check it; no script gates it.

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

1. **Could I delete code instead?** Best fix = removing what broke. This also covers new code that redoes something that already existed (in the codebase, the standard library, an installed dependency or the platform): delete it and use the existing thing, per § Before Writing New Code.
2. **Symptom or root cause?** Band-aids compound.
3. **Essential or accidental complexity?** Essential complexity is inherent in the problem — it can be partitioned but not eliminated. Accidental complexity is self-inflicted through poor choices, wrong tools, or accumulated shortcuts. If accidental → simplify or remove. If essential → partition it, don't fight it.
4. **Would a junior dev understand?** Needs a paragraph to explain → too complex.
5. **Fighting the framework?** Writing adapters/shims → using it wrong. Read docs.
6. **What if I revert everything?** Sunk cost ≠ reason to continue. Three clean attempts > one Frankenstein.

If any check reveals a blocker → document in `decisions.md` → must address before CLOSE (PIVOT or fix).

## Consolidation Pass (REFLECT)

A review of everything the plan wrote, read as one whole, after the work looks close to done and verification has passed. No single step can see duplication that spans two steps; this pass can.

- **When and who.** Software plans only, meaning "software-engineering tasks (any language, incl. Python)". A non-software plan does not get this pass; the rest of the hygiene sweep still runs on it.
  - The pass is part of that sweep: ip-boyscout does it, or the orchestrator itself when the run has no sub-agents.
  - The sweep reports and never edits.
- **Scope.** The files `changelog.md` names, read together as one diff. The report says which files it compared, so a partial read is visible.
- **What to look for, by pointer.**
  - New code the goal does not need, or that redoes something that already exists: § Before Writing New Code, questions 1 to 5, asked over the whole diff.
  - Copy-paste and swallowed errors: § Forbidden Fix Patterns.
  - A single-use abstraction: the earned-abstraction rule above.
  - Leftovers and dead helpers: `references/code-hygiene.md` § Forbidden Leftovers.
  - Shared code with no contract: `references/code-hygiene.md` § Interface Contracts for Shared Assets.
  - For software plans also the checklist in `references/python-software.md` § C.12 Anti-pattern checklist.
  - The one addition here is duplication between two steps' new code. Quote both `file:line` locations as the evidence.
- **Leave alone.** Code under a decision anchor, code whose changelog line carries a decision reference, and duplication that `decisions.md` records (an entry that mentions duplication or lockstep). Leave alone means do not report it as a finding, not even as a note.
- **Over-consolidation guard.** Merge only when both copies change for the same reason. Two look-alikes that change for different reasons stay apart. A finding names the smaller version and shows that the net line count goes down. "Could be cleaner" is not a finding.
- **Attribution.** Each finding names one anchor file: the file its fix edits first, and a file that some `changelog.md` line names.
  - For duplication across steps, the anchor file is the file from the later changelog line (the line that added the second copy). The remediation says which copy survives.
  - The entry's attributed-to value is the step on that changelog line. If no changelog line names a file, write `attributed to: none`.
- **Fixing.** Findings are `[judgment]` entries under `## Introduced`. The user approves them at the REFLECT gate; each approved one becomes a completion fix step in EXECUTE, and REFLECT then verifies again.
  - A consolidation fix is a planned step, not a repair of a failed step, so the 10-Line Rule and the fix attempt limits (Revert-First Policy) do not bind it.
  - Its own bounds: net lines are zero or negative, behavior does not change, and the criteria already in `verification.md` are the test. If a fix breaks one of them, revert the fix and report it; do not patch it forward.
  - A fix that adds a helper spends one of the two new-abstraction slots in the Complexity Budget, so check the headroom first.
  - These fixes share the two hygiene remediation rounds per iteration; there is no separate count.

## 3-Strike Rule

Same area fixed 3× across iterations ⇒
1. STOP → REFLECT. Log `3-STRIKE TRIGGERED on [file/module]` in `decisions.md`.
2. Do NOT attempt fix #4.
3. Revert to checkpoint covering struck area (or revert uncommitted if none → decide in PIVOT).
4. → PIVOT: "fundamentally different approach for [file/module]."
5. Consider: is this code even necessary?

**Scope note**: this rule is advisory-only — no script counts strikes anywhere in
`<skill-path>/scripts/*.mjs`; it is checked by whichever agent reads `decisions.md` before
writing a fix. Its literal condition is scoped "across iterations," but a
completion-fix or leash-override retry loop (`SKILL.md` § Transitions, REFLECT →
EXECUTE) can repeat several times within a single declared iteration without ever
satisfying that literal wording — the same gap SKILL.md's Iteration Limits section
documents for the mechanically-enforced cap. Apply the rule's intent (three failed
attempts on the same area is a stop signal, whatever the declared iteration count
says) even when the literal "across iterations" wording doesn't obviously fire.

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
