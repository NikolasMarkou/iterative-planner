# Code Hygiene Reference

Failed code must not survive. Dirty state from failed EXECUTE = compounding bugs.

## Change Manifest

Maintain in `state.md` during EXECUTE:

```markdown
## Change Manifest (current iteration)
- Step 1 (abc123): `lib/session/token_service.rb`
- Step 2 (uncommitted): `app/middleware/auth.rb`, `config/initializers/session.rb`
```

One line per step, formatted as `- Step N (commit-hash-or-"uncommitted"):` followed by each filename wrapped in backticks and comma-separated — e.g. `file1`, `file2`, `file3`. Update after every file create/modify/delete for the current step. A step line carrying `uncommitted` (or no hash) signals that step's changes are not yet committed; once the step's commit lands, replace `uncommitted` with the real commit hash — the line is edited in place, not duplicated. Backticking each filename is the one non-negotiable requirement: `blast-radius.mjs`'s `iterationHistory()` signal matches a path only when it is bounded by a backtick, whitespace, or line-end, so an un-backticked filename immediately followed by a comma (e.g. `file1, file2`) silently fails to match. The lowercase-hyphenated `step-N` form (rather than capitalized `Step N`) is an equally-acceptable minor stylistic variant seen in some real plans — capitalization/hyphenation is not load-bearing, only the backticks are.
Reset on iteration increment (PLAN → EXECUTE). Prior iteration's commits need no tracking.

Some real plans nest the manifest by iteration instead of resetting it in place — `## Change Manifest (iteration N — vX.Y.Z)` with the iteration number/version in the heading — as an optional, sanctioned extension of this same per-step format, not a different one.

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

PIVOT never appends to `changelog.md`; it only reads it. The ledger is written by the step that made the edits, and a `REVERT(file)` line belongs to the failed step path above, so the absence of a changelog step here is deliberate rather than a gap.

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

This list is now also run mechanically. `node <skill-path>/scripts/scar-scan.mjs` sweeps for five of the kinds above — leftover markers, debug statements, commented-out code, imports of removed modules, and test files whose subject is gone — and reports what it finds without failing a build. Part of it, and only part: its line rules match at the start of a line, so a marker or a debug call written at the end of a line of code is not seen, which is the commonest form in real code. That anchor is deliberate — dropping it was measured on this repository and every extra hit was a marker word quoted inside a test fixture — but it means a clean sweep is a weaker statement than a clean read. It also deliberately does not flag `console.log` or `print()`, even though the list names them, because every gate in this repository is a command line tool whose entire output channel is `console.log`, so that rule would fire on hundreds of correct lines. The list here stays the canonical definition: the scanner covers part of it, and the rest is still read by eye.

## Interface Contracts for Shared Assets

A function or module imported by ≥2 callers (a shared/reused asset) carries a short interface contract at its definition: parameters, return shape, and failure mode. Undocumented shared code is a hygiene leftover — reuse fails when the contract is unclear, so developers re-duplicate instead of reusing. (Document everything you mean to reuse.)

Robustness scales with reuse. Shared assets — or any HIGH blast-radius edit (`references/blast-radius.md`) — require their failure modes verified, not just the happy path. A reusable asset that is bug-prone gets abandoned and re-cloned, the opposite of reuse: prioritize robustness for anything meant to be shared.
