# Iterative Planner

[![License](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Skill](https://img.shields.io/badge/Skill-v2.35.0-green.svg)](CHANGELOG.md)
[![Tests](https://img.shields.io/badge/tests-518%20passing-brightgreen.svg)](src/scripts/bootstrap.test.mjs)
[![Sponsored by Electi](https://img.shields.io/badge/Sponsored%20by-Electi-red.svg)](https://www.electiconsulting.com)

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) skill that turns ad-hoc agent runs into structured, recoverable, evidence-driven work.

Left unstructured, Claude plans once, hits a wall, and layers fix on fix until it loses track of what it already tried. Iterative Planner replaces that with a state machine — **Explore → Plan → Execute → Reflect → Pivot → Close** — and writes every finding, decision, and pivot to disk as it goes. The filesystem is the working memory: the context window can rot mid-task, but the plan directory cannot.

Use it for refactors, migrations, debugging, system design, or deep research — anything where "just do it" turns into a mess.

---

## Table of Contents

**Start here**
- [When to Use This](#when-to-use-this)
- [How It Works](#how-it-works)
- [Get Started in 60 Seconds](#get-started-in-60-seconds)
- [A Worked Example](#a-worked-example)
- [Why This Works](#why-this-works)

**Reference**
- [The Plan Directory](#the-plan-directory)
- [Bootstrapping](#bootstrapping)
- [Sub-Agent Architecture](#sub-agent-architecture)
- [Presentation Contracts](#presentation-contracts)
- [Validator](#validator)
- [Git Integration](#git-integration)
- [FAQ](#faq)

**Project**
- [Contributing](#contributing)
- [Project Structure](#project-structure)
- [Sponsored by](#sponsored-by)
- [License](#license)

---

## When to Use This

| Use it | Skip it |
|--------|---------|
| Multi-step tasks touching 3+ files or 2+ systems | Single-file, single-step changes |
| Migrations, refactors, architectural changes | Well-known, straightforward solutions |
| Tasks that have already failed once | Quick fixes where you already know the answer |
| Complex research or analysis with many moving parts | One-shot questions |
| System design and technical decision-making | |
| Debugging where the root cause is unclear | |
| Anything where you'd benefit from "what did I already try?" | |

**Trigger phrases**: *"plan this"*, *"figure out"*, *"help me think through"*, *"I've been struggling with"*, *"debug this complex issue"*.

---

## How It Works

Six states. Every transition is logged, every decision recorded, and the filesystem is the source of truth.

```mermaid
stateDiagram-v2
    [*] --> EXPLORE
    EXPLORE --> PLAN : enough context
    PLAN --> EXPLORE : need more context
    PLAN --> PLAN : user rejects, revise
    PLAN --> EXECUTE : user approves
    EXECUTE --> REFLECT : phase ends, fails, or autonomy leash hits
    REFLECT --> CLOSE : criteria PASS, user confirms
    REFLECT --> PIVOT : failed or better approach
    REFLECT --> EXPLORE : need more context
    PIVOT --> PLAN : new approach ready
    CLOSE --> [*]
```

> If your viewer does not render mermaid, the table below covers the same states.

| State | What happens | Guardrails |
|-------|-------------|------------|
| **EXPLORE** | Read, search, ask. Pull cross-plan findings, decisions, lessons, and the system atlas. | Read-only on the project. All notes go to the plan directory. Minimum 3 indexed findings before PLAN. |
| **PLAN** | Design the approach. Identify every artifact to create or modify. Write success criteria, verification strategy, assumptions, failure modes, and a pre-mortem. | No code changes. User must approve before execution. |
| **EXECUTE** | Implement one step at a time. Commit after each success. Append a per-edit changelog line for every file edited. | 2 fix attempts max. Revert-first on failure. Surprises trigger REFLECT. |
| **REFLECT** | Three phases: Gate-In (read everything), Evaluate (verify, diff review, regression check, scope drift, root cause, run validator), Gate-Out (write results, present to user). | Evidence-based only. Regressions and simplification blockers prevent CLOSE. Contradicted findings trigger EXPLORE. |
| **PIVOT** | Diagnose the failure, hunt for ghost constraints, propose a new direction. | Must explain what failed and why. User approves new direction. |
| **CLOSE** | Write summary. Audit decision anchors. Merge knowledge into consolidated files. Rewrite LESSONS.md and SYSTEM.md. | Verify clean output. No leftover artifacts. |

**Iteration limits.** Iterations increment on each PLAN → EXECUTE transition. At **iteration 5** the protocol forces a decomposition analysis — identify 2-3 independent sub-goals that could each be a separate plan. At **iteration 6+** it hard-stops and the task must be broken up. This prevents the runaway "one more iteration" pattern that destroys plans.

---

## Get Started in 60 Seconds

**Requires**: Node.js 18+ (for the bootstrap and validator scripts).

### Option 1 — Zip package (recommended)

Download the latest zip from [Releases](https://github.com/NikolasMarkou/iterative-planner/releases) and unzip into your local skills directory:

```bash
unzip iterative-planner-v*.zip -d ~/.claude/skills/
```

### Option 2 — Single-file skill

Download `iterative-planner-combined.md` from [Releases](https://github.com/NikolasMarkou/iterative-planner/releases) and add it to Claude Code's Custom Instructions (Settings → Custom Instructions).

> The single-file version does not include `bootstrap.mjs` or the sub-agent definitions (`src/agents/*.md`) — the combined file runs in SKILL.md's single-thread monolithic-fallback mode. Plan directories must be created manually. For full bootstrap and sub-agent support, use the zip package.

### Option 3 — Clone and install

```bash
git clone https://github.com/NikolasMarkou/iterative-planner.git
cd iterative-planner
make build
cp -r build/iterative-planner ~/.claude/skills/
```

### Sub-agents (optional but recommended)

To enable parallel agent dispatch (explorers in parallel, a dedicated verifier, an adversarial reviewer):

```bash
mkdir -p ~/.claude/agents
cp src/agents/*.md ~/.claude/agents/
```

The skill works without sub-agents — they are an optimization layer, not a requirement.

### First run

In any project directory, give Claude a complex task or just say **"plan this"**. Claude runs `bootstrap.mjs new "<your goal>"`, drops into EXPLORE, and walks through the cycle.

---

## A Worked Example

A complete cycle, condensed.

> **You**: "I want to migrate our auth from session cookies to stateless JWTs. Plan this."

**Claude (EXPLORE)** runs `bootstrap.mjs new "Migrate auth from session cookies to JWT"`, creates `plans/plan_2026-05-07_a3f1b2c9/`, then:

- Reads `plans/FINDINGS.md`, `plans/DECISIONS.md`, `plans/LESSONS.md`, `plans/SYSTEM.md` for cross-plan context.
- Spawns 2-3 `ip-explorer` sub-agents in parallel: one maps the auth surface, one inventories existing JWT usage, one examines the test suite.
- Writes results to `findings/auth-system.md`, `findings/jwt-current.md`, `findings/test-coverage.md`.
- Classifies constraints: **HARD** (existing OAuth providers must keep working), **SOFT** (team prefers `jose` over `jsonwebtoken`), **GHOST** (a 5-year-old comment about Redis cluster topology that no longer applies).

**Claude (PLAN)** writes `plan.md` with:

- **Problem Statement** — expected behavior, invariants, edge cases.
- **Steps** — each annotated `[RISK: low/medium/high]` and `[deps: N,M]`. Riskiest first.
- **Success Criteria** + **Verification Strategy** — every criterion has a test command and a pass condition.
- **Assumptions** — each traced to a finding.
- **Failure Modes** — what if the JWT library is slow, returns garbage, or is down.
- **Pre-Mortem & Falsification Signals** — "STOP IF p99 latency increases more than 20ms."

Claude presents the plan as a **PC-PLAN** block (verbatim — not a paraphrase). You approve or push back. If you push back, Claude revises and re-presents the same contract.

**Claude (EXECUTE)** implements step 1. After each file edit, an entry is appended to `changelog.md` recording timestamp, step, commit, file, op, **blast-radius score**, decision-ref, and reason. After each successful step:

- `plan.md` step marked `[x]`.
- `progress.md` updated.
- `state.md` change manifest extended.
- Commit: `[iter-1/step-1] add JWT verifier`.

If a step fails: **revert uncommitted**, two fix attempts max, each constrained by the Revert-First and 10-Line rules. Both fail → STOP, present, ask you.

**Claude (REFLECT)** runs the verifier. The PASS/FAIL table from `verification.md` is rendered **verbatim** in the **PC-REFLECT** block. If it is iteration 2+, an `ip-reviewer` sub-agent runs an adversarial review and its concerns are folded in verbatim. Claude recommends close, pivot, or explore. **You** decide.

**Claude (CLOSE)** spawns `ip-archivist` to write `summary.md`, audit `# DECISION plan_2026-05-07_a3f1b2c9/D-NNN` anchors in source, rewrite `plans/LESSONS.md` (≤200 lines), and rewrite the `plans/SYSTEM.md` atlas (≤300 lines). Then `bootstrap.mjs close` merges per-plan findings and decisions into the consolidated cross-plan files (sliding window of the 4 most recent plans).

The next plan starts with all of this on disk, available to read.

---

## Why This Works

Five properties separate this from "ask Claude to make a plan."

### 1. Persistent memory

Everything important lives on disk, not the context window. State, decisions, findings, progress, and verification results survive conversation restarts. **Mandatory re-reads** keep the agent grounded: `state.md` is re-read every 10 tool calls; after 50 messages, `state.md` and `plan.md` are re-read before every response. The context window can rot mid-task; the plan directory cannot.

### 2. Cross-plan intelligence

When a plan closes, its findings and decisions merge into consolidated files at the `plans/` root, and the next plan reads them during EXPLORE. Migrations build on earlier debugging sessions; design plans inherit constraints discovered during prior research; failed approaches stay visible so future plans don't repeat dead ends. A **sliding window** keeps the consolidated files to the 4 most recent plans (older sections stay intact in their own directories, indexed by `plans/INDEX.md`).

Alongside the goal-driven findings sits the **system atlas** (`plans/SYSTEM.md`): a curated, domain-neutral map of *what the system being planned against actually is* — Identity, Components, Boundaries, Invariants, Flows, Known Patterns. Capped at 300 lines, rewritten at CLOSE, read at the start of every EXPLORE and PLAN. It is the structural prior the agent carries into every new plan.

### 3. Self-correcting research

Every discovery is written to `findings.md` with file paths, code-path traces, and evidence. The agent cannot transition to PLAN until it has at least 3 indexed findings covering problem scope, affected areas, and existing patterns. When execution proves a finding wrong, it gets a `[CORRECTED iter-N]` marker — the original stays for traceability.

### 4. The autonomy leash

When a step fails during EXECUTE, the agent gets **2 fix attempts**, each constrained to reverting, deleting, or a minimal change. If neither works, it stops, reverts uncommitted changes, presents what happened, and asks you. No silent third attempts. No "one more try." This is the single most important rule for keeping unattended agent work safe.

### 5. Revert-first complexity control

The default response to failure is to **simplify, never to add**: can I fix by reverting? deleting? a one-line change? If none of those — **stop** and enter REFLECT. Hard limits back this up.

<details>
<summary><strong>Complexity hard limits</strong></summary>

| Rule | What it does |
|------|-------------|
| **10-Line Rule** | If a "fix" needs more than 10 new lines, it's not a fix. It needs a plan. |
| **3-Strike Rule** | Same area breaks 3 times? The approach is wrong. Mandatory PIVOT, with revert to a covering checkpoint. |
| **Complexity Budget** | Max 3 new files, max 2 new abstractions, target net-zero or negative line count. Tracked in `plan.md`. |
| **Nuclear Option** | At iteration 5, scope doubled? Recommend full revert to the iteration-1 checkpoint. The decision log preserves all learnings. |
| **6 Simplification Checks** | Structured REFLECT diagnostic: delete instead? symptom or root cause? essential or accidental complexity? fighting the framework? worth reverting everything? |

</details>

### Reasoning frameworks built into each state

Each state embeds domain-agnostic thinking tools so the rigor is structural, not improvised.

<details>
<summary><strong>Framework per state</strong></summary>

| Framework | State | What it does |
|-----------|-------|-------------|
| **Constraint classification** | EXPLORE | Tag every constraint *hard*, *soft*, or *ghost* (no longer applies). Ghost constraints reveal previously blocked options. |
| **Exploration confidence** | EXPLORE | Self-assess scope, solution space, risk visibility. "Shallow" on any dimension means keep exploring. |
| **Problem decomposition** | PLAN | Understand the whole, find natural boundaries, minimize dependencies, start with the riskiest part. |
| **Assumption tracking** | PLAN | Every assumption traced to a finding and linked to dependent steps. When one breaks, you know what's invalidated. |
| **Pre-mortem & falsification** | PLAN | Assume the plan failed. Why? Extract concrete STOP IF triggers. Counters confirmation bias. |
| **Prediction accuracy** | REFLECT | Compare predicted vs actual step/file/line counts. Calibrates future estimates via LESSONS.md. |
| **Root cause analysis** | REFLECT | On failure: immediate cause, contributing factor, failed defense, prevention. Stop rule against premature closure. |
| **Essential vs accidental complexity** | REFLECT | "Inherent in the problem, or did we create it?" Essential = partition. Accidental = remove. |
| **Ghost-constraint hunting** | PIVOT | Before pivoting, check whether the constraint behind the failed approach is still valid. |

</details>

### Audit trail and clean output

Three mechanisms keep the workspace honest, all visible on disk.

<details>
<summary><strong>The three mechanisms</strong></summary>

- **Decision anchoring** — when code survives a failed alternative, the agent leaves a plan-qualified `# DECISION plan_YYYY-MM-DD_XXXXXXXX/D-NNN` comment at the point of impact, stating what *not* to do and why. The plan-id prefix stays resolvable even after the consolidated `plans/DECISIONS.md` sliding-window trim. The validator audits every anchor at CLOSE. (Details: [`src/references/decision-anchoring.md`](src/references/decision-anchoring.md).)
- **Per-edit changelog + blast-radius scoring** — every file edit appends one line to `{plan-dir}/changelog.md` (timestamp, iter/step, commit, path, op, blast-radius tier, decision-ref, reason). A deterministic scorer tiers each edit LOW/MED/HIGH and surfaces "tiny edit, big radius" outliers that plan-level failure modes miss. Always advisory, never blocks CLOSE. (Details: [`src/references/blast-radius.md`](src/references/blast-radius.md).)
- **Clean output hygiene** — every change is tracked in a manifest, failed steps revert immediately, and forbidden leftovers (TODOs, debug prints, commented-out code, orphan helpers) are flagged at REFLECT. The workspace is always known-good before new work begins.

</details>

---

## The Plan Directory

```
plans/
├── .current_plan                  # active plan directory name
├── FINDINGS.md                    # consolidated findings, newest first, sliding window of 4 plans
├── DECISIONS.md                   # consolidated decisions, newest first, sliding window of 4 plans
├── LESSONS.md                     # cross-plan institutional memory (max 200 lines, rewritten on close)
├── SYSTEM.md                      # system atlas, domain-neutral map (max 300 lines, rewritten on close)
├── INDEX.md                       # topic-to-directory mapping (survives sliding-window trim)
└── plan_2026-05-07_a3f1b2c9/
    ├── state.md                   # current state, iteration, step, change manifest, transition log
    ├── plan.md                    # the living plan (rewritten each iteration)
    ├── decisions.md               # append-only log of every decision and pivot
    ├── findings.md                # index of discoveries (corrected when wrong)
    ├── findings/                  # detailed research files (one per topic)
    ├── progress.md                # done vs in-progress vs remaining
    ├── verification.md            # verification results per REFLECT cycle
    ├── changelog.md               # per-edit ledger (one line per file edit)
    ├── checkpoints/               # snapshots before risky changes
    ├── lessons_snapshot.md        # LESSONS.md snapshot at close (auto-created)
    └── summary.md                 # written at close
```

Templates for every file are in [`src/references/file-formats.md`](src/references/file-formats.md).

**File lifecycle** — each file has a lifecycle: which states write it, which read it, which never touch it. The full matrix is in [`src/SKILL.md`](src/SKILL.md). The protocol enforces a **read-before-write** rule on every plan file — the writing agent must read first, even on the first update after bootstrap.

### File ownership

Each file has a single owner. Only the owner writes; others read. This prevents concurrent-write conflicts when sub-agents run in parallel. Co-ownership is permitted where writes are disjoint and never concurrent (the orchestrator sequences them); the orchestrator's co-owned writes are confined to Post-Step Gate cursor/ledger updates.

| File | Owner | Readers |
|------|-------|---------|
| `state.md` | Orchestrator | All agents |
| `plan.md` | Plan-writer (full rewrite) + Orchestrator (Post-Step Gate) | Executor, Verifier |
| `decisions.md` | Orchestrator + Plan-writer | All agents |
| `findings.md` (index) | Orchestrator | Plan-writer, Reviewer |
| `findings/{topic}.md` | Explorer (one file per explorer) | Orchestrator, Plan-writer |
| `findings/review-iter-N.md` | Reviewer | Orchestrator |
| `progress.md` | Orchestrator + Executor | All agents |
| `verification.md` | Plan-writer (template), Verifier (results) | Orchestrator, Reviewer |
| `changelog.md` | Executor (append per edit) + Orchestrator (Post-Step Gate) | Reviewer |
| `checkpoints/*` | Executor | Orchestrator (for PIVOT) |
| `summary.md` | Archivist | — |
| `plans/FINDINGS.md` | Archivist (via bootstrap) | Orchestrator, Plan-writer |
| `plans/DECISIONS.md` | Archivist (via bootstrap) | Plan-writer |
| `plans/LESSONS.md`, `plans/SYSTEM.md` | Archivist | All planning agents |
| `plans/INDEX.md` | Archivist (via bootstrap) | Orchestrator |

---

## Bootstrapping

Manage plan directories from your project root:

```bash
node <skill-path>/scripts/bootstrap.mjs new "goal"           # create new plan
node <skill-path>/scripts/bootstrap.mjs new --force "goal"   # close active plan, create new one
node <skill-path>/scripts/bootstrap.mjs resume               # output current plan state for re-entry
node <skill-path>/scripts/bootstrap.mjs status               # one-line state summary
node <skill-path>/scripts/bootstrap.mjs close                # close active plan (merges + preserves)
node <skill-path>/scripts/bootstrap.mjs list                 # show all plan directories
node <skill-path>/scripts/bootstrap.mjs retire <plan-id>     # mark a removed plan's DECISION anchors [STALE], drop its dir
node <skill-path>/scripts/bootstrap.mjs reset-attempts       # clear active plan's Fix Attempts (unjam stale leash counter)
node <skill-path>/scripts/validate-plan.mjs                  # validate active plan compliance
```

- **`new`** creates the plan directory, writes the `.current_plan` pointer, ensures cross-plan files exist (`FINDINGS.md`, `DECISIONS.md`, `LESSONS.md`, `SYSTEM.md`, `INDEX.md`), adds `plans/` to `.gitignore`, and drops the agent into EXPLORE. Refuses if an active plan already exists — use `resume` to continue, `close` to end it, or `new --force` to close-and-replace.
- **`close`** merges per-plan findings and decisions into the consolidated files (newest first), appends to `INDEX.md`, snapshots `LESSONS.md` to the plan directory, removes the pointer, and preserves the plan directory for reference.
- **`resume`** is the key command for surviving context-window resets — at the start of a new conversation, after compression, or any time the agent seems to have lost track. It reads `state.md`, `plan.md`, `progress.md`, and `decisions.md` and prints a structured re-entry summary. **`status`** prints a one-line summary; **`list`** shows all plan directories with state and goal.

<details>
<summary><strong>Merge edge cases</strong></summary>

When `close` merges per-plan files into `plans/FINDINGS.md` and `plans/DECISIONS.md`: only content at and below the first `##` heading is merged; per-plan files with no `##` headings are skipped as boilerplate; cross-plan boilerplate notes are stripped to avoid duplication; relative links like `(findings/foo.md)` are rewritten to include the plan directory path.

</details>

---

## Sub-Agent Architecture

The orchestrator coordinates seven specialized agents. Sub-agents cannot spawn other sub-agents — the orchestrator is the sole coordinator. Sub-agents are **optional**: if their definitions are not installed under `~/.claude/agents/`, the monolithic skill works as before.

When the skill activates with the agent definitions installed, the conversation assumes the orchestrator role **in-thread** (it reads `agents/ip-orchestrator.md` and adopts it — it does not spawn a separate orchestrator); when they are not installed, the same conversation runs the full protocol single-threaded. See [`src/SKILL.md`](src/SKILL.md) "Orchestrator Role Assumption."

| Agent | Role | Tools | Model |
|-------|------|-------|-------|
| **Orchestrator** | State machine owner, dispatcher, user-facing relay | Agent, Read, Write, Edit, Bash, Grep, Glob | inherit |
| **ip-explorer** | Read-only codebase research (EXPLORE) | Read, Write, Grep, Glob, Bash | sonnet |
| **ip-plan-writer** | Generates `plan.md` and `verification.md` template (PLAN) | Read, Write, Edit, Grep, Glob | inherit |
| **ip-executor** | Implements one plan step at a time (EXECUTE) | Read, Edit, Write, Bash, Grep, Glob | inherit |
| **ip-verifier** | Runs verification checks, fills `verification.md` (REFLECT) | Read, Write, Bash, Grep, Glob | sonnet |
| **ip-reviewer** | Adversarial review, iteration ≥ 2 (REFLECT) | Read, Write, Grep, Glob, Bash | opus |
| **ip-archivist** | CLOSE housekeeping: `summary.md`, anchor audit, LESSONS, SYSTEM | Read, Write, Edit, Grep, Glob, Bash | sonnet |

**Dispatch by state**: EXPLORE — 1-3 explorers in parallel, one per topic. PLAN — one plan-writer. EXECUTE — one executor per step, sequential by default (independent steps can parallelize via `isolation: "worktree"`). REFLECT — verifier(s) for checks, reviewer (iteration 2+) for adversarial review. CLOSE — archivist for the housekeeping.

---

## Presentation Contracts

Sub-agents are invisible to the user — only the orchestrator's chat text reaches them, and disk artifacts are memory, not a user-facing channel. To stop the orchestrator from collapsing critical artifacts (the verifier's PASS/FAIL table, the reviewer's concerns, a leash-failure block) into a terse summary, every user-facing state transition is governed by a named **Presentation Contract** that fixes when it fires, the ordered content list, the fidelity (verbatim vs digest), and the minimum sections (the floor).

<details>
<summary><strong>The six contracts</strong></summary>

| Contract | When | Floor |
|----------|------|-------|
| **PC-EXPLORE** | EXPLORE handoff to PLAN | Findings index, key constraints (HARD/SOFT/GHOST), exploration confidence, synthesis paragraph |
| **PC-PLAN** | Before user approval to EXECUTE | `plan.md` rendered verbatim — Steps, Success Criteria, Verification Strategy, Failure Modes, Assumptions |
| **PC-EXECUTE-STEP** | After each successful step | 5 fields: step, files, commit, surprises, next-preview |
| **PC-EXECUTE-LEASH** | On autonomy leash hit | 5 fields: step intent, 2 attempts, root cause guess, checkpoint registry, prompt |
| **PC-REFLECT** | Phase-3 Gate-Out | Exactly 5 items: completed, remaining, verifier table verbatim, issues + reviewer concerns, recommendation + prompt |
| **PC-PIVOT** | Pivot Options | Pivot reason, checkpoint registry, ghost constraints, 1-3 candidate directions framed "X at the cost of Y", explicit prompt |

</details>

Canonical definitions live in [`src/references/file-formats.md`](src/references/file-formats.md) under "Presentation Contracts." This closes the gap where the protocol once used single verbs ("Present", "Report", "Surface") and the orchestrator defaulted to terse summaries.

---

## Validator

`src/scripts/validate-plan.mjs` is a read-only protocol-compliance check. It runs automatically during REFLECT and can be run manually any time. Exit 0 = pass, exit 1 = errors; warnings are non-blocking. A separate `--pre-step` mode runs before each EXECUTE step and HARD-blocks (exit 2) on a leash-cap, wrong-state, iteration-cap, or no-plan condition.

<details>
<summary><strong>What it checks</strong></summary>

State-transition validity; the mandatory `plan.md` sections (Problem Statement, Verification Strategy, Failure Modes, Assumptions, Pre-Mortem); the ≥3-findings gate before PLAN; cross-file consistency (state ↔ plan ↔ progress ↔ verification); the decisions schema (D-NNN sequential, "X at the cost of Y" trade-off, PIVOT complexity assessment); plan-qualified DECISION anchors in source (forward + reverse audit); the `verification.md` verdict structure; convergence metrics (iteration 2+); iteration limits; the SYSTEM.md cap; and the 8-field changelog format.

</details>

The validator cannot inspect chat content — it surfaces metadata signals only. Content fidelity is enforced by the agent prompts themselves.

---

## Git Integration

| Phase | Git behavior |
|-------|-------------|
| EXPLORE / PLAN / REFLECT / PIVOT | No commits. |
| EXECUTE (success) | Commit after each step: `[iter-N/step-M] description` |
| EXECUTE (failure) | Revert all uncommitted changes to last clean commit. |
| PIVOT | Decide: keep successful commits, or `git checkout <checkpoint-commit> -- .` to revert. Choice logged in `decisions.md`. |
| CLOSE | Final commit with summary. |

Bootstrap automatically adds `plans/` to `.gitignore`. Remove that entry if your team wants decision logs versioned for post-mortems.

---

## FAQ

**What if bootstrap refuses to create a new plan?**
An active plan already exists. Use `resume` to continue it, `close` to end it, or `new --force` to close it and start fresh.

**Can I have multiple active plans at once?**
No. One active plan at a time, tracked by `plans/.current_plan`. Close the current plan before starting a new one.

**Where do plan files go?**
Always under `plans/` in the project root. Bootstrap creates this directory automatically.

**Are plan files committed to git?**
No. Bootstrap adds `plans/` to `.gitignore` by default. Remove it if you want decision logs versioned.

**What if I want to start completely over?**
Run `bootstrap.mjs new --force "new goal"`. This closes the active plan (merging its findings) and creates a fresh one. All previous plan directories are preserved.

**What happens at iteration 5?**
The protocol forces a decomposition analysis: identify 2-3 independent sub-goals that could each be a separate plan. At iteration 6+, execution stops entirely.

**Can I run the agents in parallel?**
Explorers always parallelize. Verifiers can parallelize across independent checks. Executors can parallelize via `isolation: "worktree"` for truly independent steps. The orchestrator sequences anything that touches the same plan file.

**Do I need the sub-agent definitions?**
No. They are an optimization layer. Without them, the monolithic skill drives the same state machine in a single thread.

**What if I lose context mid-plan?**
Run `bootstrap.mjs resume`. It reconstructs the current state from disk and prints a summary. The agent never starts over — it picks up from `state.md`.

**Why plan-qualified DECISION anchors?**
The consolidated `plans/DECISIONS.md` uses a 4-plan sliding window. Bare `D-NNN` anchors become orphans once their plan is trimmed. Plan-qualified anchors (`# DECISION plan_YYYY-MM-DD_XXXXXXXX/D-NNN`) survive trim and resolve unambiguously.

---

## Contributing

### Running tests

The test suite covers bootstrap operations, state transitions, consolidated file management, sliding-window behavior, anchor validation, and edge cases.

<details>
<summary><strong>Test command</strong></summary>

```bash
node --test src/scripts/bootstrap.test.mjs \
            src/scripts/validate-plan.test.mjs \
            src/scripts/blast-radius.test.mjs \
            src/scripts/check-doc-parity.test.mjs \
            src/scripts/emit-state.test.mjs \
            src/scripts/emit-template.test.mjs \
            src/scripts/check-readme-parity.test.mjs \
            src/scripts/check-test-count.test.mjs \
            src/scripts/shared.test.mjs \
            src/scripts/schema.test.mjs
# 518 tests total: bootstrap 214, validate-plan 103, shared 69, schema 48,
#                  blast-radius 37, check-test-count 17, emit-state 12,
#                  emit-template 10, check-doc-parity 4, check-readme-parity 4
```

`node src/scripts/check-test-count.mjs` re-runs the suite and fails if the live pass count disagrees with the `TEST_COUNT` file. It runs as part of `make test` (not `make validate`, which stays suite-free and fast).

</details>

### Build and package

`VERSION` is the single source of truth for the version number. Both `Makefile` and `build.ps1` read from it. Bump `VERSION` and `CHANGELOG.md`; nothing else.

<details>
<summary><strong>Build commands (Make / PowerShell)</strong></summary>

```bash
# Windows (PowerShell)
.\build.ps1 build            # build skill package structure
.\build.ps1 build-combined   # build single-file skill with inlined references
.\build.ps1 package          # create zip package
.\build.ps1 package-combined # single-file skill in dist/
.\build.ps1 package-tar      # tarball package
.\build.ps1 validate         # validate skill structure
.\build.ps1 lint             # check script syntax
.\build.ps1 test             # run tests (lint + round-trip)
.\build.ps1 clean            # remove build artifacts
.\build.ps1 list             # show package contents
.\build.ps1 help             # show available commands

# Unix / Linux / macOS
make build
make build-combined
make package                 # default
make package-combined
make package-tar
make validate
make lint
make test
make clean
make list
make help
```

</details>

### Validation checklist

<details>
<summary><strong>Before submitting changes</strong></summary>

- [ ] `make validate` (or `.\build.ps1 validate`) passes
- [ ] `node --test src/scripts/*.test.mjs` passes (518 tests, 0 failing) and `node src/scripts/check-test-count.mjs` exits 0
- [ ] `src/SKILL.md` has `name:` and `description:` in YAML frontmatter
- [ ] All cross-references in `src/SKILL.md` point to existing files in `src/references/`
- [ ] State machine diagram matches transition rules table
- [ ] Plan directory structure in `src/SKILL.md` matches `bootstrap.mjs` output
- [ ] Agent definitions in `src/agents/` have `name:`, `description:`, `tools:` in YAML frontmatter
- [ ] File Ownership Model table matches agent tool permissions

</details>

---

## Project Structure

<details>
<summary><strong>Full file tree</strong></summary>

```
iterative-planner/
├── README.md                       # this file
├── CLAUDE.md                       # AI assistant guidance for contributors
├── CHANGELOG.md                    # version history
├── LICENSE                         # GNU GPLv3
├── VERSION                         # single source of truth for version number
├── Makefile                        # Unix/Linux/macOS build
├── build.ps1                       # Windows PowerShell build
└── src/
    ├── SKILL.md                    # core protocol — the complete skill specification
    ├── agents/                     # sub-agent definitions (optional, install to ~/.claude/agents/)
    │   ├── ip-orchestrator.md      # state machine owner, spawns all other agents
    │   ├── ip-explorer.md          # read-only codebase research (EXPLORE)
    │   ├── ip-plan-writer.md       # plan generation (PLAN)
    │   ├── ip-executor.md          # code execution (EXECUTE)
    │   ├── ip-verifier.md          # verification checks (REFLECT)
    │   ├── ip-reviewer.md          # adversarial review (REFLECT, iteration ≥ 2)
    │   └── ip-archivist.md         # CLOSE housekeeping
    ├── scripts/
    │   ├── bootstrap.mjs           # plan directory lifecycle (Node.js 18+)
    │   ├── bootstrap.test.mjs      # bootstrap test suite (node:test)
    │   ├── validate-plan.mjs       # protocol compliance validator (+ `--pre-step` gate, exit 2)
    │   ├── validate-plan.test.mjs  # validator test suite
    │   ├── blast-radius.mjs        # deterministic per-file blast-radius scorer (spawnSync argv — no shell)
    │   ├── blast-radius.test.mjs   # blast-radius test suite (node:test)
    │   ├── check-doc-parity.mjs    # README<->SKILL.md File Ownership parity gate (run via make validate)
    │   ├── check-doc-parity.test.mjs # doc-parity test suite (node:test)
    │   ├── check-readme-parity.mjs         # README version badge and test count parity gate (used by make/build.ps1 validate; Node.js 18+)
    │   ├── check-readme-parity.test.mjs    # Test suite (node:test)
    │   ├── check-test-count.mjs    # TEST_COUNT vs live `node --test` pass-count gate (run via make test)
    │   ├── check-test-count.test.mjs # check-test-count test suite (node:test)
    │   ├── schema.mjs              # CHANGELOG_SPEC — the one declarative definition of the changelog's field shapes (used by validate-plan.mjs)
    │   ├── schema.test.mjs         # schema test suite (node:test)
    │   ├── emit-state.mjs          # per-state rule router; emits scripts/modules/state-<s>.md on demand
    │   ├── emit-state.test.mjs     # emit-state test suite (node:test)
    │   ├── emit-template.mjs       # per-template slicer; emits one plan-file template from references/file-formats.md via --name <slug>
    │   ├── emit-template.test.mjs  # emit-template test suite (node:test)
    │   ├── shared.mjs              # shared helpers (field extraction, changelog field split, compression markers, id grammars)
    │   └── modules/                # verbatim per-state rule bodies (EXPLORE/PLAN/EXECUTE/REFLECT/PIVOT), emitted on demand
    └── references/
        ├── file-formats.md         # templates for every plan directory file + Presentation Contracts
        ├── code-hygiene.md         # change manifests, revert procedures, cleanup rules
        ├── complexity-control.md   # anti-complexity protocol and forbidden patterns
        ├── convergence-metrics.md  # convergence score, momentum tracker, iteration health
        ├── decision-anchoring.md   # when and how to anchor decisions in code (plan-qualified)
        ├── planning-rigor.md       # assumptions, pre-mortem, falsification, root cause, decomposition
        ├── blast-radius.md         # tiers, signals, scoring formula for the per-edit ledger
        └── python-software.md      # Python/software-engineering caveat (conditional)
```

</details>

For the complete protocol specification, see [`src/SKILL.md`](src/SKILL.md).

---

## Sponsored by

This project is sponsored by **[Electi Consulting](https://www.electiconsulting.com)**, a technology consultancy specializing in AI, blockchain, cryptography, and data science. Founded in 2017, headquartered in Limassol, Cyprus, with a London presence. Clients include the European Central Bank, US Navy, and Cyprus Securities and Exchange Commission.

---

## License

[GNU General Public License v3.0](LICENSE)
