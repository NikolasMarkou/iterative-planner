# PR Proposal

## Title
Refactor bootstrap merge utilities, tighten PowerShell CLI failure behavior, and document merge edge cases

## Summary
This PR includes three focused improvements:

1. **Modularization of bootstrap merge logic**
   - Extracted merge/text-normalization helpers from `src/scripts/bootstrap.mjs` into:
     - `src/scripts/bootstrap-merge-utils.mjs`
     - `src/scripts/bootstrap-consolidated-utils.mjs`
   - `bootstrap.mjs` now imports these utilities, reducing file complexity and improving maintainability.

2. **Safer CLI behavior in PowerShell build script**
   - Updated `build.ps1` to return a non-zero exit code (`exit 1`) for unknown commands.
   - This prevents false-positive success in CI or scripted usage when command names are mistyped.

3. **Documentation of merge behavior edge cases**
   - Added a README section: **"Merge Edge Cases (Consolidated Files)"**.
   - Documents normalization and merge rules that were previously implicit in code/tests.

---

## Rationale

### 1) bootstrap modularization
- **Problem:** `bootstrap.mjs` accumulated multiple concerns (CLI dispatch, file creation, merge transforms, consolidation policy).
- **Why now:** Code review flagged high cognitive load and change risk in a monolithic script.
- **Benefit:** Better separation of concerns, easier targeted tests, lower regression risk for future changes.

### 2) `build.ps1` unknown command behavior
- **Problem:** Unknown commands showed help but exited successfully.
- **Risk:** CI and automation might silently continue after invalid invocation.
- **Benefit:** Fail-fast semantics align with common CLI expectations and make scripting safer.

### 3) README edge-case documentation
- **Problem:** Important merge behavior lived mostly in implementation and test expectations.
- **Benefit:** Contributors can reason about expected behavior without reverse-engineering helper functions.

---

## Files changed

### Modified
- `src/scripts/bootstrap.mjs`
  - Imports extracted utility modules
  - Removes inlined merge helper implementations
- `build.ps1`
  - Unknown command branch now exits with status code `1`
- `README.md`
  - Adds "Merge Edge Cases (Consolidated Files)" section

### Added
- `src/scripts/bootstrap-merge-utils.mjs`
  - `stripHeader`
  - `stripCrossPlanNote`
- `src/scripts/bootstrap-consolidated-utils.mjs`
  - `prependToConsolidated`
  - `checkConsolidatedSize`
  - `trimConsolidatedWindow`
  - associated constants

---

## Behavior impact

### Expected behavior changes
- **Intentional:** `build.ps1` now fails (`exit 1`) on unknown command.

### Non-behavioral refactors
- Merge behavior in bootstrap is intended to remain functionally equivalent (code moved, not redesigned).

---

## Validation performed

- Syntax checks:
  - `node --check src/scripts/bootstrap.mjs`
  - `node --check src/scripts/bootstrap-merge-utils.mjs`
  - `node --check src/scripts/bootstrap-consolidated-utils.mjs`
- Full test suite:
  - `node --test src/scripts/bootstrap.test.mjs`
  - Result: **99/99 passing**

---

## Risk assessment

- **Low risk** for refactor sections (covered by existing test suite).
- **Low/intentional behavioral change** in `build.ps1` default command handling.

---

## Suggested PR body (copy/paste)

### What changed
- Extracted bootstrap merge helpers into dedicated utility modules:
  - `bootstrap-merge-utils.mjs`
  - `bootstrap-consolidated-utils.mjs`
- Updated `bootstrap.mjs` to consume those modules.
- Updated `build.ps1` to fail on unknown commands (`exit 1`).
- Added README docs for consolidated merge edge-case behavior.

### Why
- Reduce `bootstrap.mjs` complexity and improve maintainability.
- Prevent silent CI/script success on invalid PowerShell command usage.
- Make merge behavior explicit for contributors.

### Validation
- `node --check` on updated/new scripts
- `node --test src/scripts/bootstrap.test.mjs` → **99 passing**
