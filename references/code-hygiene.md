# Code Hygiene Reference

Failed code must not survive into the next iteration. Dirty state from failed EXECUTE = compounding bugs.

## Change Manifest

Maintain in `state.md` during EXECUTE:

```markdown
## Change Manifest (current iteration)
- [x] `lib/session/token_service.rb` — CREATED (step 1, committed abc123)
- [ ] `app/middleware/auth.rb` — MODIFIED lines 23-45 (step 2, uncommitted)
- [ ] `config/initializers/session.rb` — MODIFIED (step 2, uncommitted)
```

Update after every file create/modify/delete. `[x]` = committed, `[ ]` = uncommitted.
Reset manifest on iteration increment (PLAN → EXECUTE). Prior iteration's committed changes don't need tracking.

## On Failed Step (→ REFLECT)

Successful steps should already be committed. This applies only to the failed step.

1. Revert all uncommitted changes immediately:
   ```
   git checkout -- <uncommitted files from manifest>
   git clean -fd  # remove untracked files from failed step
   ```
2. Update change manifest.
3. Log reverted files in `decisions.md`.

Codebase after failed step = exact state of last successful commit. No half-applied changes, debug code, or commented-out attempts.

## On RE-PLAN

Decide explicitly:

1. **Keep successful commits?** If valid under new plan → keep. Log: "Keeping steps 1-2, reverting step 3."
2. **Revert everything?** If fundamentally different approach:
   ```
   git checkout <checkpoint-commit> -- .
   ```
   Log: "Reverted all changes from iteration N. Starting from checkpoint cp-NNN."
3. **Never leave partial work.** Known-good before PLAN = tests pass, no uncommitted changes, no dead code.

## Nuclear Option (Full Revert)

```
git stash  # safety net
git checkout <cp-000-commit> -- .  # revert to initial checkpoint
```

Log: "NUCLEAR REVERT to initial state. All N iterations reverted. Stashed for recovery."

## Forbidden Leftovers

After any revert, grep for these — if found, revert is incomplete:

- `// TODO` / `# FIXME` added during failed attempt
- `console.log`, `print()`, `debugger` statements you added
- Commented-out code from failed approach
- Import statements for removed modules
- Test files for reverted code
