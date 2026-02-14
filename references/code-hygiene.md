# Code Hygiene Reference

Failed code must not survive into the next iteration. Dirty state from a failed
EXECUTE is the #1 source of compounding bugs — you end up debugging your debug code.

---

## Change Manifest

During EXECUTE, maintain a **change manifest** in `state.md`:

```markdown
## Change Manifest (current iteration)
- [x] `lib/session/token_service.rb` — CREATED (step 1, committed abc123)
- [ ] `app/middleware/auth.rb` — MODIFIED lines 23-45 (step 2, uncommitted)
- [ ] `config/initializers/session.rb` — MODIFIED (step 2, uncommitted)
```

Update this after every file create/modify/delete. This is how you know exactly
what to revert.

**Reset the Change Manifest when the iteration counter increments** (PLAN → EXECUTE
transition). The new iteration starts with a clean manifest. Changes kept from
the prior iteration are already committed and don't need tracking.

---

## On Failed Step (Entering REFLECT)

If a step fails and you're transitioning to REFLECT (including after a leash hit):

**Note:** Successful steps should already be committed before entering REFLECT.
This revert procedure applies only when a step has failed.

1. **Revert all uncommitted changes** from the failed step immediately.
   ```
   git checkout -- <files from change manifest that are uncommitted>
   git clean -fd  # remove untracked files created in failed step
   ```
2. Update the change manifest to reflect the revert.
3. Log what was reverted in `decisions.md`.

The codebase after a failed step must be in the **exact same state as after the
last successful commit**. No half-applied changes. No leftover debug code.
No commented-out attempts.

---

## On RE-PLAN

When transitioning to RE-PLAN, decide explicitly:

1. **Keep committed work from successful steps?** If the successful steps are still
   valid under the new plan, keep them. Note in `decisions.md`: "Keeping steps 1-2,
   reverting step 3."
2. **Revert everything from this iteration?** If the new plan takes a fundamentally
   different approach, revert to the last checkpoint:
   ```
   git checkout <checkpoint-commit> -- .
   ```
   Note in `decisions.md`: "Reverted all changes from iteration N. Starting clean
   from checkpoint cp-NNN."
3. **Never leave partial work.** The codebase must be in a known-good state before
   PLAN begins. "Known-good" means: tests pass, no uncommitted changes, no dead code
   from failed attempts.

---

## On Nuclear Option (Full Revert)

When reverting all iterations:
```
git stash  # safety net in case user wants to recover something
git checkout <cp-000-commit> -- .  # revert to initial checkpoint from before iteration 1
```
Log in `decisions.md`: "NUCLEAR REVERT to initial state. All N iterations reverted.
Stashed in git stash for recovery if needed."

---

## Forbidden Leftovers

After any revert, grep for these — if found, the revert is incomplete:

- `// TODO: fix this` or `# FIXME` added during the failed attempt
- `console.log`, `print()`, `debugger` statements you added
- Commented-out code blocks from the failed approach
- Import statements for modules that no longer exist
- Test files for code that was reverted
