# CLAUDE.md

Guidance for working with the Iterative Planner codebase.

## Project Purpose

Claude Code skill: state-machine driven iterative planning and execution. Cycle: Explore, Plan, Execute, Reflect, Pivot. The filesystem is the persistent memory (`plans/plan-YYYY-MM-DDTHHMMSS-XXXXXXXX/`; legacy `plans/plan_YYYY-MM-DD_XXXXXXXX/` dirs are still read, never written).

Use cases: multi-file tasks, migrations, refactoring, failed tasks, debugging, anything touching 3+ files or 2+ systems.

## Repository Structure

```
iterative-planner/
├── README.md, LICENSE (Apache 2.0), CHANGELOG.md, CLAUDE.md
├── VERSION                  # single source of truth for the version
├── TEST_COUNT               # live `node --test` pass count, checked by make test
├── Makefile, build.ps1      # Unix / Windows build scripts (both read VERSION)
├── .github/workflows/ci.yml # `make validate` then `make test`, Node 20/22/24 (never run locally)
└── src/
    ├── SKILL.md             # core protocol (state machine, rules): the main instruction set
    ├── commands/ip-dashboard.md   # /ip-dashboard slash command (installed to ~/.claude/commands/)
    ├── agents/              # sub-agents (installed to ~/.claude/agents/)
    │   ip-orchestrator (owns the state machine, spawns the rest), ip-explorer (EXPLORE research),
    │   ip-plan-writer (PLAN), ip-executor (EXECUTE, one step), ip-verifier (REFLECT checks),
    │   ip-reviewer (adversarial review, iteration >= 2 by default), ip-boyscout (read-only
    │   hygiene sweep once work looks close-ready), ip-archivist (CLOSE housekeeping)
    ├── scripts/             # Node.js 18+, every script has a *.test.mjs beside it (node:test)
    │   ├── bootstrap.mjs        # plan directory management (see Key Commands)
    │   ├── validate-plan.mjs    # protocol compliance validator and pre-step gate
    │   ├── blast-radius.mjs     # per-edit blast-radius scorer (used by ip-executor)
    │   ├── schema.mjs           # CHANGELOG_SPEC: the one definition of changelog field shapes
    │   ├── shared.mjs           # shared helpers, incl. the symlink-aware `isMain` entry check
    │   ├── emit-state.mjs       # emits modules/state-<s>.md (per-state rules) on demand
    │   ├── emit-template.mjs    # emits one plan-file template from references/file-formats.md
    │   ├── scar-scan.mjs        # hygiene report for ip-boyscout (a report, not a gate)
    │   ├── dashboard.mjs        # read-only HTML view of plans/ (not a gate)
    │   ├── session-title.mjs    # optional session-title hook helper (not a gate)
    │   ├── check-test-count.mjs # TEST_COUNT vs live pass count (make test only)
    │   ├── check-doc-parity.mjs, check-readme-parity.mjs, check-changelog-parity.mjs,
    │   │   check-agent-wiring.mjs, check-template-parity.mjs, check-register.mjs
    │   │                        # structural gates run by make validate
    │   ├── register-baseline.json  # per-file ceilings read by check-register.mjs
    │   └── modules/state-{explore,plan,execute,reflect,pivot}.md  # verbatim per-state rule bodies
    └── references/          # knowledge base, read on demand
        blast-radius, code-hygiene, complexity-control, convergence-metrics, decision-anchoring,
        file-formats (templates for every plan file), planning-rigor, root-cause-analysis,
        python-software (software-engineering caveats, any language)
```

## Key Commands

### Bootstrap

Run from a project root:

```bash
node <skill-path>/scripts/bootstrap.mjs "goal"              # new plan (same as `new`)
node <skill-path>/scripts/bootstrap.mjs new [--force] "goal" # --force closes the active plan first
node <skill-path>/scripts/bootstrap.mjs resume | status | close | list | banner
node <skill-path>/scripts/bootstrap.mjs retire <plan-id>     # mark a removed plan's DECISION anchors [STALE], drop its dir
node <skill-path>/scripts/bootstrap.mjs reset-attempts       # clear the active plan's Fix Attempts
```

`new` creates the plan directory (UTC, colon-free id), all plan files, and the `plans/.current_plan` pointer. It also creates `plans/FINDINGS.md`, `DECISIONS.md`, `LESSONS.md`, `SYSTEM.md` (system atlas, max 300 lines, rewritten by ip-archivist at CLOSE) and `INDEX.md` if missing. It refuses if a plan is already active.

### Dashboard

`node <skill-path>/scripts/dashboard.mjs [--watch] [--open] [--out <file.html>] [--no-usage]`. Users start it through `/ip-dashboard`, which runs it as a background task.

- It is a viewer for people, not part of the protocol: no agent runs it and nothing in `SKILL.md` mentions it. A test in `check-agent-wiring.test.mjs` pins that.
- `bootstrap.mjs` only does two `existsSync` checks (script path, `~/.claude/commands/ip-dashboard.md`) to print a hint. A second test forbids a dynamic `import(` in `bootstrap.mjs`, so a viewer bug cannot reach plan creation.
- It writes only to its output folder (private per-user folder in the OS temp dir by default) and loads nothing from the network.
- Token usage comes from Claude Code's session logs, an unpublished format; when the logs are missing or change shape the page shows no usage.
- `ip-dashboard.md` declares `allowed-tools: Bash(node:*)`, which is broad; it stays broad because the narrower syntax for a quoted `$HOME` path is unverified.

### Session title hook

`session-title.mjs` is an optional helper the user wires into `~/.claude/settings.json` by hand (`--print-settings` prints the snippet; nothing here edits that file). It prints a session title for the active plan, never writes files, and on any failure prints nothing and exits 0. `bootstrap.mjs` and all protocol prose never name it (pinned by tests). Tested only with piped sample input, so whether the title reaches a terminal tab is unverified. Known limits: a renamed project folder stops the hint updating; the printed script path is double-quoted but not shell-escaped; if `UserPromptSubmit` input lacks `session_title` (unverified), a `/rename` name is overwritten each prompt. The orchestrator's SPAWN lines in `state.md` are ignored by the validator, `bootstrap.mjs status` and the dashboard, and stay arrow-free so other readers are not misled.

## Protocol Reference

The full spec is in **src/SKILL.md**; do not duplicate it here. Where to look:

- State machine, transitions, re-reads, leash, file ownership, sub-agent architecture: SKILL.md sections of the same names
- Complexity control: SKILL.md + `references/complexity-control.md`
- Code hygiene: SKILL.md + `references/code-hygiene.md`
- Decision anchoring: SKILL.md + `references/decision-anchoring.md`
- Planning rigor (assumptions, pre-mortem, falsification, confidence, ghost constraints): `references/planning-rigor.md`
- Git integration: SKILL.md "Git Integration"

## Working with This Codebase

- **src/SKILL.md**: core protocol; changes affect all planning behavior.
- **src/agents/**: YAML frontmatter (name, description, tools, model) plus a Markdown system prompt.
- **src/references/**: supplementary knowledge, read on demand. Add new files for expanded guidance.
- **src/scripts/emit-state.mjs + modules/**: SKILL.md keeps only summaries and `emit-state` pointers. Edit a rule body in its module, not in SKILL.md.
- **VERSION**: bump only `VERSION` + `CHANGELOG.md` (plus the README version badge and `TEST_COUNT` when they move).
- Keep the state machine diagram, transition rules, file lifecycle matrix and file-format references in sync across SKILL.md and `references/`.
- Reference docs use clear headers, tables, code snippets, and cross-references to other references.
- Stack: Node.js ESM, Markdown, PowerShell/Make.

### Build Commands

```bash
make build | build-combined | package | package-combined | package-tar
make validate    # structural gates, fast, no suite run
make lint        # script syntax
make test        # lint + one full suite run + TEST_COUNT check
make clean | list | help | sync-skill
```

`.\build.ps1 <same target>` on Windows (requires PowerShell 7).

### Validation Checklist

Run `make validate` and `make test` (or the `build.ps1` equivalents) before finishing. What they enforce, and the traps to avoid:

**Docs and wiring**
- [ ] SKILL.md has `name:` and `description:` frontmatter; every cross-reference in it points to an existing file in `src/references/`.
- [ ] State machine diagram, transition table, File Lifecycle Matrix and plan-directory file list agree. `bootstrap.mjs` creates every file `file-formats.md` lists (including `verification.md`, `FINDINGS.md`, `DECISIONS.md`, `LESSONS.md`, `SYSTEM.md`, `INDEX.md`), and `lessons_snapshot.md` appears in the plan dir on close.
- [ ] Every agent in `src/agents/` has `name:`, `description:`, `tools:` frontmatter and matches SKILL.md "Sub-Agent Architecture" and its File Ownership table. SKILL.md "Orchestrator Role Assumption" names `iterative-planner-orchestrator`, matching `ip-orchestrator.md`. SKILL.md points at the orchestrator for dispatch sequencing and does not restate it.
- [ ] README and SKILL.md File Ownership tables agree (`check-doc-parity.mjs`): path keys in both directions and owner-cell text (exact match after whitespace normalization; the readers column is not gated). Either side parsing fewer than `EXPECTED_MIN_KEYS` keys fails `[doc-parity-floor]`.
- [ ] README version badge and test badge match `VERSION` and `TEST_COUNT` (`check-readme-parity.mjs`). Both are matched as whole shields.io badges (markdown or `<img src>` form), never as a bare substring; do not loosen that, since a substring let a deleted badge pass.
- [ ] CHANGELOG's first `## [X.Y.Z]` entry equals `VERSION` (`check-changelog-parity.mjs`); a missing CHANGELOG is a FAIL. **Editing pitfall:** when adding a section, anchor the edit on the previous section's first body line and re-create its `## [PREV]` header in the new text, then check `grep -n '^## \[' CHANGELOG.md | head -4`. Anchoring on the header line has consumed it three releases running.
- [ ] Prose wiring (`check-agent-wiring.mjs`; scope `src/agents`, `scripts/modules`, `SKILL.md`, `references`; README and CLAUDE.md are out of scope): every `node <skill-path>/scripts/<x>.mjs` invocation uses `<skill-path>`, never a bare `node src/scripts/...` (correct here, broken in a consuming project); every `references/x.md` or `src/references/x.md` citation resolves (one `canonicalDocPath()` handles both spellings; do not add a `startsWith("references/")` guard); every `§ <Code> <Title>` pointer resolves; named scripts, agents and modules exist. Floor `EXPECTED_MIN_PROSE_FILES` fails `[scan-floor]` if the scan shrinks. Known miss: a node option with a separate value token (`node --loader x src/...`) evades the path check.
- [ ] Register ratchet (`check-register.mjs`): jargon density of CLAUDE.md, README, SKILL.md, agents, references, modules and the command stays at or below the per-file ceiling in `register-baseline.json`. It fails `[register-drift]` only when both density and raw marker count rise past the committed pair, so deleting plain prose can never fail. Each ceiling is the file's exact live measurement, and a pin test requires that. After any edit that moves a doc's measurement, run `node src/scripts/check-register.mjs --regenerate` and commit the diff. Regenerate lowers or holds ceilings freely; raising one is refused unless named with `--raise <file>`. `EXPECTED_MIN_FILES` is pinned to the live doc count, so a new doc without a baseline entry (or a stale entry) fails.
- [ ] `emit-state --state <explore|plan|execute|reflect|pivot>` emits each module (unknown or missing state exits non-zero). `emit-template --name <slug>` emits the byte-faithful slice of `file-formats.md` for each of the 17 slugs (missing name exits 2, unknown exits 1).

**Plan-file templates live in two places, on purpose**
- [ ] `bootstrap.mjs` renders new plan files from its own exported `PLAN_TEMPLATES` (12 entries) and never reads `file-formats.md` at runtime, because a failure there would stop all plan creation. `check-template-parity.mjs` byte-compares those 12 entries against the 12 `<!-- SKELETON:<slug> -->` regions in `file-formats.md`, both directions. **A template edit is two edits** (the `PLAN_TEMPLATES` entry and its skeleton region); forgetting one turns the build red naming the slug.
- [ ] Skeleton regions and the served bodies (`resolveTemplate(slug).body`, the exact bytes `emit-template` hands agents) are deliberately not compared to each other (`system` differs on purpose: served is the populated schema, bootstrap writes an unpopulated skeleton). Instead rule `[header-copy]` forbids any adjacent header line-pair of any template from reappearing in any of the 17 served bodies. It calls the real slicer, so checker and served bytes cannot diverge; a slug that fails to resolve is a loud `[served-resolve]` FAIL. Holes it does not cover: (1) skeleton lines below a header can go stale unnoticed; (2) `plan` and `progress` have 1-line headers, under the 2-line threshold; (3) a fabricated non-header line or a swapped marker serving a wrong template restates no header; (4) a visually identical byte-different copy (trailing space, NBSP, interleaved blank line) evades it, deliberately, since normalizing would weaken byte-exactness; (5) nothing mechanical checks CLAUDE.md itself.
- [ ] `plans/ANCHORS.md` stays committed. Bootstrap writes the plans glob plus a negation line for it into `.gitignore`, so `git ls-files plans/` prints exactly that one path. It is the durable tier of anchor resolution in `validate-plan.mjs`; every other source lives in the ignored plans dir and is gone in a fresh clone. Older anchors with nothing to resolve against are the "anchor backlog"; the scar scanner reports them as inherited. It is deliberately not a `PLAN_TEMPLATES` entry (a 13th key would ripple through the slug floors and every "12 templates / 17 served" count). Format: `file-formats.md` § plans/ANCHORS.md.
- [ ] `.md` HTML-comment anchors (`<!-- DECISION ... -->` form only) are scanned by `validate-plan.mjs` and stamped by `bootstrap.mjs retire`; both list `.md` in `ANCHOR_SOURCE_EXTS`, and block-comment scanning is off for `HTML_STYLE_EXTS`. Doc examples in `src/references/*.md` must use placeholder ids (`decision-anchoring.md` § Writing About Anchors).
- [ ] **A shipped `.md` file cannot carry a live decision anchor**, because a test requires zero anchor findings in shipped Markdown and such an anchor would point at a plan dir nobody else has. This contradicts the anchoring rule given to the executor and nothing resolves it. Working practice: put the reasoning in a plain comment that names the decision without the anchor form; use real anchors only in source files (decision D-015 in `plan-2026-09-01T100120-4f591469`, uncommitted).

**Changelog, iterations, validator**
- [ ] The changelog is markdown and an append is ONE line (`{plan-dir}/changelog.md`, pipe-delimited, 8 fields). Do not re-encode it or route writes through a document library: the v2.33.0 XML encoding made each append a whole-file rewrite and lost entries under concurrency (reverted in v2.35.0). `maybeCompressChangelog` keeps its 5-key return shape, frozen by a golden-bytes test in `bootstrap.test.mjs`.
- [ ] Field shapes (ts, step, commit, op, radius, dref) are defined once, in `CHANGELOG_SPEC` in `schema.mjs`. Do not re-declare those regexes in `validate-plan.mjs` or `bootstrap.mjs` (a source-grep test pins this). The validator checks each line via `splitChangelogFields()`, `entryFromFields()`, `validateElement()`.
- [ ] **A completion fix is numbered as a sub-step of the step it repairs:** a fix to step 9 is `iter-1/step-9.1`, a second is `iter-1/step-9.2`; the iteration does not go up. Never `iter-1/completion-fix`: it fails the `step` grammar and warns on every line (it has happened in two plans). Only the changelog field is checked; the commit subject may read however is clearest. The changelog `step` field carries no plan-id prefix, unlike the commit tag.
- [ ] **Iteration means re-plans.** The enforced iteration is the larger of the declared `## Iteration:` and the count of PLAN to EXECUTE arrivals; completion-fix round trips never raise it. A separate hard cap fires at 18 EXECUTE to REFLECT arrivals (warning `[round-cap]` from 15; hygiene remediation and completion-fix rounds count too). When the iteration, round or leash cap fires there is no override: do a partial CLOSE (finish the CLOSE steps, `bootstrap.mjs close`, mark `summary.md` partial), then `bootstrap.mjs new` per sub-goal.
- [ ] The validator fires only on non-conforming input and has no Presentation Contract check (the old `presentation-contract-unlogged` warning demanded a log nothing told agents to write, and was deleted). `findings/` holds three artifact schemas: explorer topic files, `review-iter-N[-passM].md` (Concerns / Blind Spots / Verdict) and `hygiene-iter-N[-passM].md` (Inherited / Introduced / Verdict, via `HYGIENE_FILE_RE`). The reviewer and hygiene branches switch the required section list and never exempt: a file missing its `## Verdict` must still warn. The verification-evidence check skips a row only when its Criterion cell is placeholder text; never widen that to the Evidence cell.
- [ ] The pre-step leash gate (`validate-plan.mjs --pre-step`) is stated in `modules/state-execute.md`, the one rule body both the agent path and the single-thread path read; stating it only in the orchestrator prompt left single-thread runs without it. The executor makes at most one fix try per spawn, so the two recorded attempts are the two spawns.
- [ ] `verification.md` is not written during EXECUTE: the orchestrator is the sole writer, merging the verifier's returned results at REFLECT. Bootstrap's template header and its skeleton region agree (the mandatory pair of edits).
- [ ] The scar scanner reports and never gates. Its only non-zero exits are `[scan-unavailable]` (upstream validator absent, crashed, timed out, or printed no proof of a run) and `[scan-floor]` (fewer categories reported than `EXPECTED_MIN_CATEGORIES`, pinned equal to `CATEGORIES.length`, 5). On those paths stdout stays empty even under `--json`, so a consumer cannot mistake it for a clean repo. There is deliberately no floor on finding counts (the right end state is zero). Disclosed holes: a category whose own pattern rotted silently matches nothing (only per-category fixtures cover it), and `console.log` / `print()` are listed as Forbidden Leftovers but not flagged, since every gate here is a CLI that prints with `console.log`.
- [ ] The scar scanner attributes an anchor by identity, never by which files a plan touched: for orphaned anchors an item is this plan's only when its plan-id resolves AND equals the active plan-id (membership alone once blamed a plan for three pre-existing anchors). Two narrowings are written in the scanner header: an anchor with no resolvable plan-id always reads inherited, and the unreferenced-checkpoint rule skips the active plan's in-flight checkpoints.
- [ ] Enumeration floors are each pinned equal to their live count by a `pin:` test, so a new agent, reference doc or ownership row that lands without moving its floor turns the suite red: `EXPECTED_MIN_PROSE_FILES` (check-agent-wiring), `EXPECTED_MIN_FILES` (check-register), `EXPECTED_MIN_KEYS` (check-doc-parity), `EXPECTED_SLUGS = 12` (check-template-parity).
- [ ] `TEST_COUNT` matches the live pass count (`check-test-count.mjs`, run via `make test`, deliberately not in `make validate`, which stays fast). The checker accepts both TAP (`# pass N`) and Node 24 spec (`ℹ pass N`) summaries and passes no `--test-reporter` flag, to keep the Node 18+ floor.
- [ ] Any change adding a full-corpus walk over `plans/` (reading every plan dir) carries a one-line cost note in its CHANGELOG entry: Big-O in plan-dir count, which validator or gate path triggers it, how often.
- [ ] Every CLI script except two uses `isMain` from `shared.mjs`; none but `session-title.mjs` compares `process.argv[1]` itself (source-grep test). `session-title.mjs` keeps its own guard to stay a standalone hook helper; `blast-radius.mjs` has no guard and runs on import (the executor only invokes it as a CLI).

**Build channels**
- [ ] `make build` and `build.ps1` remove the old build dir first; `package` and `package-tar` remove the old archive first. Lockstep tests pin both channels.
- [ ] **The two channels must fail on the same conditions.** `build.ps1` must not wrap a mandatory script in a `Test-Path` skip (the Makefile dies when the file is gone, so a skip made a deleted gate pass on Windows only). It declares `#Requires -Version 7` on line 1 and names `-Encoding utf8` on every `Get-Content` / `Set-Content`, because Windows PowerShell 5.1 defaults to the ANSI codepage and would corrupt SKILL.md's em dashes, arrows and section signs. The `#Requires` floor is a compatibility break, disclosed in README and the 2.61.0 CHANGELOG. Seventeen lockstep tests bind the channels (same validate gate set, no skip wrapper, same lint and test lists, same `build-combined` rewrite pairs, same trailing Note, version guard, encoded round-trips); they live in `check-doc-parity.test.mjs` as a home of convenience. **No PowerShell runs in the usual dev environment, so every claim about that channel is verified by reading, not running; say so when reporting on it.**
- [ ] Both channels' `build-combined` rewrite the `emit-state` / `emit-template` pointers (neither router runs in a paste context; the five module bodies are inlined as `## State Module: <state>`). The two rewrite maps are one fact in two places and a lockstep test compares them pair by pair. Acceptance is exactly: no `node <skill-path>/scripts/emit-` line in the combined output. About 22 `bootstrap.mjs` / `blast-radius.mjs` / `validate-plan.mjs` pointers survive on purpose, and the combined file's trailing Note (at the end, because SKILL.md's frontmatter must be the first bytes) says no script pointer in it is runnable as written.
- [ ] In-place `sed` goes through `SED_I`, chosen by trying bare `sed -i` on a scratch file (GNU and BusyBox pass; BSD falls back to `sed -i ''`). CI runs `make validate` and `make test` on Node 20, 22 and 24; scripts promise Node 18+, but test files use `import.meta.dirname`, so running the suite needs 20.11+.
- [ ] **A Makefile `for` loop must fail the build from ANY iteration, not just the last.** The old shape `for x in ...; do <test> || ( echo ERROR && exit 1 ); done` only exits the subshell, and a loop returns its last iteration's status, so only the last entry was enforced (six loops in `validate` were affected). Use a brace group `{ echo ...; exit 1; }`. Single-line `|| ( ... && exit 1)` outside loops is fine. **Probe any repair with a non-last entry.** `build.ps1` accumulates into `$errors` and never had this bug.
- [ ] The state-machine check asserts real indented `FROM --> TO` diagram edges for all ten transitions (including `REFLECT --> EXECUTE`), not `FROM.*TO` anywhere in the file. Removing an edge must turn the build red; it was decorative in the Makefile until v2.63.0 because of the loop bug above.

## Updating Local Skill

When asked to "update local skill", run the sync target. It is THE procedure:

```bash
make sync-skill          # Unix/Linux/macOS
.\build.ps1 sync-skill   # Windows
```

It prunes before copying, copies SKILL.md, scripts + modules, references, agents, README/LICENSE/CHANGELOG/VERSION (VERSION is needed at runtime: bootstrap stamps it into new plans), then verifies every synced tree with `diff -rq` and exits 1 on any mismatch. Pruning matters because `cp` cannot remove files deleted from the repo (v2.35.0 removed `xml.mjs` / `changelog.mjs`, and a copy-only sync would have left both live).

- The skill's own install dirs (`~/.claude/skills/iterative-planner/{scripts,scripts/modules,references,agents}`) are wholly owned and glob-pruned.
- The shared `~/.claude/agents/` is pruned only of this skill's own `ip-*.md` files; never glob-delete there, since other skills' agents live in it. The shared `~/.claude/commands/` gets `src/commands/ip-dashboard.md` copied in and only that file pruned.
- It first removes four stale paths from the old layout (`src/`, `CLAUDE.md`, `Makefile`, `build.ps1`) and refuses to run with an empty `$HOME`. Then it checks the install root's top-level entries against a 10-entry allowlist (includes `commands`, no `.git`) and fails on anything else without deleting. If a new top-level entry is ever written, add it to the allowlist in both channels.
- If the install folder is a git checkout (`<install>/.git` exists), prune and allowlist are skipped with one warning; never touch that git data. The way to a plain install is to delete the folder and sync again.

### Fallback (no make or PowerShell)

This does not remove repo-deleted files; verify afterwards and delete orphans by hand.

```bash
S=~/.claude/skills/iterative-planner
cp src/SKILL.md $S/SKILL.md
# exclude test files (a raw `cp src/scripts/*.mjs` ships *.test.mjs into the install)
find src/scripts -maxdepth 1 -name '*.mjs' ! -name '*.test.mjs' -exec cp {} $S/scripts/ \;
cp src/scripts/*.json $S/scripts/
mkdir -p $S/scripts/modules && cp src/scripts/modules/*.md $S/scripts/modules/   # the *.mjs glob skips modules/
cp src/references/*.md $S/references/
mkdir -p ~/.claude/commands && cp src/commands/ip-dashboard.md ~/.claude/commands/
cp README.md LICENSE CHANGELOG.md VERSION $S/
mkdir -p ~/.claude/agents && cp src/agents/*.md ~/.claude/agents/     # shared dir: copy only
mkdir -p $S/agents && cp src/agents/*.md $S/agents/
```

Then verify every tree; all must print nothing:

```bash
diff -q src/commands/ip-dashboard.md ~/.claude/commands/ip-dashboard.md
diff -rq --exclude='.claude' src/agents $S/agents
diff -rq --exclude='.claude' src/scripts/modules $S/scripts/modules
diff -rq --exclude='.claude' --exclude='*.test.mjs' src/scripts $S/scripts
diff -rq --exclude='.claude' --exclude='kg-edges.jsonl' src/references $S/references
ls $S/scripts/*.test.mjs   # must not exist: a leaked test file is a regression
```

`kg-edges.jsonl` is generated-only and never synced. Any file present only in the install is an orphan to delete by hand.
