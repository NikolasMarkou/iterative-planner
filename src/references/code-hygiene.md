# Code Hygiene Reference

Failed code must not survive. Dirty state from failed EXECUTE = compounding bugs.

## Change Manifest

Maintain in `state.md` during EXECUTE:

```markdown
## Change Manifest (current iteration)
- [x] `lib/session/token_service.rb` — CREATED (step 1, committed abc123)
- [ ] `app/middleware/auth.rb` — MODIFIED lines 23-45 (step 2, uncommitted)
- [ ] `config/initializers/session.rb` — MODIFIED (step 2, uncommitted)
```

Update after every file create/modify/delete. `[x]` = committed, `[ ]` = uncommitted.
Reset on iteration increment (PLAN → EXECUTE). Prior iteration's commits need no tracking.

## On Failed Step (→ REFLECT)

Successful steps already committed. Applies only to failed step.

1. Revert uncommitted immediately:
   ```
   git checkout -- <uncommitted files from manifest>
   git clean -fd  # remove untracked files from failed step
   ```
2. Update change manifest.
3. Log reverted files in `decisions.md`.

Codebase after failed step = last successful commit. No half-applied changes, no debug code, no commented-out attempts.

## On RE-PLAN

Read `checkpoints/*` first — know your rollback options. Decide explicitly:

1. **Keep successful commits?** When: steps already committed are valid under new approach AND tests pass with them. Log: "Keeping steps 1-2, reverting step 3."
2. **Revert to checkpoint?** When: new approach is fundamentally different, or kept commits would conflict/mislead. Choose the latest checkpoint that gives a clean base:
   ```
   git checkout <checkpoint-commit> -- .
   ```
   Log: "Reverted all changes from iteration N. Starting from checkpoint cp-NNN."
3. **Default when unsure**: revert to latest checkpoint. Safer than debugging stale state from a different approach.
4. **No partial work.** Known-good before PLAN = tests pass, no uncommitted changes, no dead code.

## Nuclear Option (Full Revert)

```
git stash  # safety net
git checkout <cp-000-commit> -- .  # revert to initial checkpoint
```

Log: "NUCLEAR REVERT to initial state. All N iterations reverted. Stashed for recovery."

## Irreversible Operations

Steps tagged `[IRREVERSIBLE]` in `plan.md` — side effects that git cannot undo.

**Examples**: DB migrations, external API calls with side effects, service config changes, deletion of non-git-tracked files, sending notifications/emails.

**Before executing**:
1. Get **explicit user confirmation** — present what will happen and that it cannot be auto-reverted.
2. Document **rollback plan** in checkpoint — manual steps to undo (e.g. "run down migration", "delete API key via dashboard").
3. **Dry-run first** if available (e.g. `--dry-run`, `--check`, `--plan` flags). Show output to user before real run.

**If it fails**: manual rollback per checkpoint plan. Do NOT retry without user direction.

## Forbidden Leftovers

After any revert, grep for these — if found, revert is incomplete:

- `// TODO` / `# FIXME` added during failed attempt
- `console.log`, `print()`, `debugger` statements you added
- Commented-out code from failed approach
- Import statements for removed modules
- Test files for reverted code
