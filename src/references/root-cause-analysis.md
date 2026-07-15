# Root Cause Analysis Methods Reference

Structured methods for executing the failure-time RCA step more rigorously. Domain-agnostic — applies to code, protocol, research, operations, and any structured problem-solving.

## When to use / relationship to the canonical schema

`references/planning-rigor.md` § Root Cause Analysis is the **single source** of the canonical RCA block that gets written into `decisions.md` at REFLECT — its 4-part shape (immediate cause → contributing factor → failed defense → prevention) is defined there and mirrored in `references/file-formats.md`. This doc does **not** restate that block; it **extends** it with named methods for *arriving at* good answers to those four questions.

Consult this doc when the RCA step follows a failure (step failed, leash hit, surprise discovery) and the default 4-line block feels too shallow — when the immediate cause is obvious but the real contributing factor is not, or when several causes seem to combine. The methods here augment RCA for **all plans**, not only software work.

**Rules**:
- The 4-part block stays the deliverable. These methods feed it; they do not replace it.
- Reach for structure only when a flat answer is unsatisfying. A clean single-cause failure needs no framework.
- Pick one method, not all four. They overlap on purpose — 5 Whys for depth, fishbone for breadth, fault tree for combination.

## 5 Whys

Named for **Sakichi Toyoda** and formalized in the **Toyota Production System**: ask "why?" of a failure, then ask "why?" of that answer, walking a chain from symptom toward a lever you can actually pull.

IP does **not** use the textbook fixed count of five. Adopt IP's existing **stop rule** as the canonical stopping criterion: keep asking *"but why was that possible?"* until the whys either **leave the system boundary** (out of your control) or **stop yielding actionable levers**. Five is a rule of thumb; the boundary/lever test is the real one — sometimes three whys suffice, sometimes seven are needed.

Formalize as a numbered why-chain:

1. **Symptom** — a gate passed on a proxy but the real invariant drifted.
2. Why? — the gate string-matched a named site instead of sweeping all sites.
3. Why? — the check was written against one example, not the class.
4. Why? — the author assumed the class had one member. (← lever: assumptions must be sweep-verified, not example-verified.)
5. Why was *that* possible? — no test asserted the sweep. (← lever: add the sweep assertion.)

Stop at 5: whys 4 and 5 each yield an actionable lever, and a sixth ("why did the author assume?") leaves the system boundary into individual judgement. **Do not stop at the first plausible cause** — that is premature closure, the most common RCA failure mode.

## Fishbone / Ishikawa category scan

The classic Ishikawa **6M** (Man / Machine / Method / Material / Measurement / Mother-Nature) adapted to IP-neutral categories. This is the **structured way to execute** the existing "Multiple roots are normal" rule: a category checklist that fights causal tunnel-vision by forcing you to look down each branch before committing to one chain.

| Category | Prompting question | IP example |
|---|---|---|
| **People** | Did a human judgement or handoff contribute? | An executor skipped a re-read; a reviewer rubber-stamped. |
| **Process** | Did the protocol/steps allow or invite the error? | A step's ordering let a stale value be read before it was refreshed. |
| **Tooling** | Did a gate, script, or check fail to catch it? | A validator matched a proxy instead of the real invariant. |
| **Dependency** | Did an upstream file, module, or contract change? | A canonical schema moved and a consumer kept the old copy. |
| **Environment** | Did the runtime, path, or config differ from assumed? | A skill-path resolved differently in a consuming project. |
| **Data** | Was an input, fixture, or template malformed or stale? | A template's bytes drifted from the served artifact. |

**Rules**:
- Walk **every** category, even the ones that seem irrelevant — the point is to surface the second root, not confirm the first.
- A finding in two categories (e.g. Process *and* Tooling) is normal and more honest than either alone.
- Empty categories are a result too: "no Dependency cause" is worth recording, not skipping.

## Fault Tree Analysis

**Opt-in — for multi-cause failures only.** The default RCA stays the 4-line block; reach for a fault tree only when several causes must **combine** to produce the failure and a flat list obscures how. It is a top-down deductive tree: start from the top failure event and decompose downward through **AND** gates (all children required) and **OR** gates (any child suffices) until you reach base causes you can act on.

```
        [Release shipped broken]
                 |
               (AND)
        ┌────────┴────────┐
  [bad edit merged]   [gate did not catch it]
                           |
                         (OR)
                   ┌───────┴───────┐
            [check skipped]   [check tested a proxy]
```

Read it as: the release broke **because** a bad edit merged **and** the gate failed to catch it; the gate failed **because** the check was skipped **or** it tested a proxy. AND gates point to defense-in-depth (add a second independent barrier); OR gates point to the weakest single branch (fix the cheapest one first).

**Rules**:
- Use only when ≥2 causes combine. A single-cause failure is a 5-Whys chain, not a tree.
- Keep it small — a tree that needs more than ~8 nodes is a signal to decompose the failure, not to keep drawing.
- Base causes (leaves) are where prevention attaches; internal gates just show the logic.

## Choosing a framework (Cynefin note)

Linear RCA and 5 Whys fit the **Complicated** domain, where cause and effect are knowable with analysis — a clean chain from symptom to lever is trustworthy there. In the **Complex** domain, cause and effect are visible only in **hindsight**, so a clean linear chain *misleads*: it invents a tidy story for a failure that emerged from many interacting parts. When a failure resists a single chain — the same fix works once and not again, or the cause seems to shift as you probe — treat it as Complex: prefer probe-sense-respond over a linear root, hold **multiple parallel hypotheses**, and use the fishbone category scan (breadth) rather than 5 Whys (depth). The tell that you are in the wrong domain: a chain that looks clean but keeps needing exceptions.
