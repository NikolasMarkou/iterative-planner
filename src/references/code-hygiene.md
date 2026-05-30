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

## Revert procedures — manifest-touching reverts

v2.18.0+: when a revert traverses a commit that touched a package manifest, the bare `git checkout` is NOT a complete revert — a strict-fidelity reinstall is required to reconcile install state with the restored lockfile. The detailed steps are appended to each revert procedure below.

## On Failed Step (→ REFLECT)

Successful steps already committed. Applies only to failed step.

1. Revert uncommitted immediately:
   ```
   git checkout -- <uncommitted files from manifest>
   git clean -fd  # remove untracked files from failed step
   ```
2. Update change manifest.
3. Log reverted files in `decisions.md`.
4. Append a `REVERT(file)` line to `{plan-dir}/changelog.md` for each reverted file (one line per file). Reason: `revert: <what failed>`. Append-only — never delete the original lines that recorded the failed edits.
5. **Post-git restore** (when reverting through a step that touched a manifest):
   - If `{plan-dir}/checkpoints/cp-NNN-iterN.lockfiles/` exists OR the reverted commit modified a tracked lockfile (`package-lock.json`, `Cargo.lock`, `poetry.lock`, `Gemfile.lock`, `go.sum`, `composer.lock`, `pnpm-lock.yaml`, `yarn.lock`, `uv.lock`):
     1. If snapshot directory exists, `cp checkpoints/cp-NNN-iterN.lockfiles/* .` to overwrite (only needed for `.gitignore`d lockfiles — git checkout already restores tracked ones).
     2. Run the ecosystem's strict-fidelity install: `npm ci` / `cargo build` / `poetry install --sync` / `bundle install` / `go mod download` / `composer install`.
     3. Verify `node_modules/` / `target/` / `.venv/` / `vendor/` matches the lockfile state. The revert is NOT complete until this finishes successfully.
   - If the reverted commits did NOT touch a manifest, skip — `git checkout` is sufficient.

Codebase after failed step = last successful commit. No half-applied changes, no debug code, no commented-out attempts.

## On PIVOT

Read `checkpoints/*` first — know your rollback options. Decide explicitly:

1. **Keep successful commits?** When: steps already committed are valid under new approach AND tests pass with them. Log: "Keeping steps 1-2, reverting step 3."
2. **Revert to checkpoint?** When: new approach is fundamentally different, or kept commits would conflict/mislead. Choose the latest checkpoint that gives a clean base:
   ```
   git checkout <checkpoint-commit> -- .
   ```
   Log: "Reverted all changes from iteration N. Starting from checkpoint cp-NNN."
3. **Default when unsure**: revert to latest checkpoint. Safer than debugging stale state from a different approach.
4. **No partial work.** Known-good before PLAN = tests pass, no uncommitted changes, no dead code.
5. **Post-git restore** (when reverting through a step that touched a manifest — applies only when keep-vs-revert decides REVERT):
   - If `{plan-dir}/checkpoints/cp-NNN-iterN.lockfiles/` exists OR the reverted commit modified a tracked lockfile (`package-lock.json`, `Cargo.lock`, `poetry.lock`, `Gemfile.lock`, `go.sum`, `composer.lock`, `pnpm-lock.yaml`, `yarn.lock`, `uv.lock`):
     1. If snapshot directory exists, `cp checkpoints/cp-NNN-iterN.lockfiles/* .` to overwrite (only needed for `.gitignore`d lockfiles — git checkout already restores tracked ones).
     2. Run the ecosystem's strict-fidelity install: `npm ci` / `cargo build` / `poetry install --sync` / `bundle install` / `go mod download` / `composer install`.
     3. Verify `node_modules/` / `target/` / `.venv/` / `vendor/` matches the lockfile state. The revert is NOT complete until this finishes successfully.
   - If the reverted commits did NOT touch a manifest, skip — `git checkout` is sufficient.

## Nuclear Option (Full Revert)

```
git stash  # safety net
git checkout <cp-000-commit> -- .  # revert to initial checkpoint
```

Log: "NUCLEAR REVERT to initial state. All N iterations reverted. Stashed for recovery."

**Post-git restore** (when reverting through a step that touched a manifest):
- If `{plan-dir}/checkpoints/cp-NNN-iterN.lockfiles/` exists OR the reverted commit modified a tracked lockfile (`package-lock.json`, `Cargo.lock`, `poetry.lock`, `Gemfile.lock`, `go.sum`, `composer.lock`, `pnpm-lock.yaml`, `yarn.lock`, `uv.lock`):
  1. If snapshot directory exists, `cp checkpoints/cp-NNN-iterN.lockfiles/* .` to overwrite (only needed for `.gitignore`d lockfiles — git checkout already restores tracked ones).
  2. Run the ecosystem's strict-fidelity install: `npm ci` / `cargo build` / `poetry install --sync` / `bundle install` / `go mod download` / `composer install`.
  3. Verify `node_modules/` / `target/` / `.venv/` / `vendor/` matches the lockfile state. The revert is NOT complete until this finishes successfully.
- If the reverted commits did NOT touch a manifest, skip — `git checkout` is sufficient.

## Irreversible Operations

Steps tagged `[IRREVERSIBLE]` in `plan.md` — side effects that git cannot undo.

**Examples**: DB migrations, external API calls with side effects, service config changes, deletion of non-git-tracked files, sending notifications/emails.

**Before executing**:
1. User confirmation — state what happens + cannot auto-revert.
2. Rollback plan in checkpoint — manual undo steps (e.g. "run down migration", "delete API key via dashboard").
3. Dry-run if available (`--dry-run`, `--check`, `--plan`). Show output before real run.

On failure: manual rollback per checkpoint. Do NOT retry without user direction.

## Forbidden Leftovers

After any revert, grep for these — if found, revert is incomplete:

- `// TODO` / `# FIXME` added during failed attempt
- `console.log`, `print()`, `debugger` statements you added
- Commented-out code from failed approach
- Import statements for removed modules
- Test files for reverted code
- Stale `# DECISION <plan-id>/D-NNN` anchors on reverted code. Grep example (matches both qualified `plan-id/D-NNN` and legacy bare `D-NNN`):
  ```
  grep -rEn "DECISION ([A-Za-z0-9_-]+/)?D-[0-9]{3}" --include="*.py" --include="*.js" --include="*.ts" \
      --include="*.mjs" --include="*.rb" --include="*.go" --include="*.rs" --include="*.java" .
  ```
  A `# DECISION <plan-id>/D-NNN` (or `// …`, `/* … */`) comment whose `D-NNN` points at a decision tied to reverted code is a leftover and must be removed. Anchors only live on surviving code (see `decision-anchoring.md`). Alternative: mark with `[STALE]` per the staleness rule in `decision-anchoring.md` if it lands.

## Interface Contracts for Shared Assets

A function or module imported by ≥2 callers (a shared/reused asset) carries a short interface contract at its definition: parameters, return shape, and failure mode. Undocumented shared code is a hygiene leftover — reuse fails when the contract is unclear, so developers re-duplicate instead of reusing. (Document everything you mean to reuse.)

Robustness scales with reuse. Shared assets — or any HIGH blast-radius edit (`references/blast-radius.md`) — require their failure modes verified, not just the happy path. A reusable asset that is bug-prone gets abandoned and re-cloned, the opposite of reuse: prioritize robustness for anything meant to be shared.
