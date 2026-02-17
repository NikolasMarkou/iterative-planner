# Decision Anchoring Reference

Code from multiple iterations carries invisible context. Without anchors, someone will "fix" a deliberate choice that took 3 failed attempts to reach.

## When to Anchor

Add `# DECISION D-NNN` when ANY apply:

- Code implements approach chosen **after a prior approach failed**
- Implementation is **non-obvious** ("why not do X instead?")
- Simpler-looking alternative was **deliberately rejected**
- Code works around a **framework/library/dependency constraint**
- **3-strike** forced a different approach

## Format

Short. Reference decision ID from `decisions.md`. Enough to stop blind changes + pointer to full story.

```python
# DECISION D-003: Using stateless tokens instead of dual-write.
# Dual-write doubled Redis memory due to 30-day TTLs (see decisions.md D-002, D-003).
# Do NOT switch back to session-store-based approach without addressing memory growth.
def create_token(user):
    ...
```

```ruby
# DECISION D-005: Calling Redis directly, not through SessionStore.
# SessionStore#find deserializes into cookie format, which breaks token flow.
# Three attempts to adapt SessionStore failed (see decisions.md D-003..D-005).
def authenticate!(request)
  token = Redis.current.get("token:#{extract_token(request)}")
  ...
end
```

## Rules

- **One comment block per decision, at point of impact.** Not scattered across files.
- **Reference decision ID** (`D-NNN`). Full story lives in `decisions.md`.
- **State what NOT to do** and why. Prevent regression, not explain implementation.
- **Strip anchors for reverted code.** Anchors only live on surviving code.
- **Don't anchor trivial choices.** Only when real decision history exists.

## Audit at CLOSE

Before `summary.md`: scan `decisions.md` for failed alternatives / 3-strike pivots. Verify corresponding code has anchor comments. Plan directory is ephemeral — code outlives it.

In `summary.md`: list files with anchors and which `D-NNN` they reference.
