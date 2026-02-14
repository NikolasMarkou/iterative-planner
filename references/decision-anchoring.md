# Decision Anchoring Reference

Code that survived multiple iterations carries invisible context. Without comments,
the next person (or next session) will see "weird" code and "fix" it — undoing a
deliberate choice that took 3 failed attempts to reach.

---

## When to Anchor

Add a decision anchor comment when ANY of these are true:

- The code implements an approach chosen **after a prior approach failed**
- The implementation is **non-obvious** and someone would reasonably ask "why not do X instead?"
- A simpler-looking alternative was **deliberately rejected** (and you know why)
- The code works around a **framework/library/dependency constraint**
- A **3-strike** forced a fundamentally different approach to this area

---

## Format

Keep it short. Reference the decision ID from `decisions.md`. Don't duplicate
the full reasoning — just enough to stop someone from blindly changing it, and
a pointer to the full story.

```python
# DECISION D-003: Using stateless tokens instead of dual-write.
# Dual-write doubled Redis memory due to 30-day TTLs (see .plan/decisions.md D-002, D-003).
# Do NOT switch back to session-store-based approach without addressing memory growth.
def create_token(user):
    ...
```

```ruby
# DECISION D-005: Calling Redis directly, not through SessionStore.
# SessionStore#find deserializes into cookie format, which breaks token flow.
# Three attempts to adapt SessionStore failed (see .plan/decisions.md D-003..D-005).
def authenticate!(request)
  token = Redis.current.get("token:#{extract_token(request)}")
  ...
end
```

---

## Rules

- **One comment block per decision, at the point of impact.** Not scattered across
  multiple files saying the same thing.
- **Reference the decision ID** (`D-NNN`). The full story lives in `decisions.md`.
- **State what NOT to do** and why. The anchor's job is to prevent regression,
  not explain the implementation.
- **Strip anchors for rejected code.** If you revert code that had anchors, the
  anchors go too. Anchors only live on surviving code.
- **Don't anchor trivial choices.** Only anchor when there's real decision history
  behind it. A straightforward implementation needs no anchor even if it went
  through the planning process.

---

## Audit at CLOSE

Before writing `summary.md`, scan `decisions.md` for entries with failed
alternatives or 3-strike pivots. For each, verify the corresponding code has
a decision anchor comment. `.plan/` is ephemeral — the code outlives it.

In `summary.md`, list files that carry decision anchors and which decision IDs
they reference (see the summary.md template in `references/file-formats.md`).
