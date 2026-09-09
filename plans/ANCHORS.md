# Decision Anchor Manifest
*Committed, append-only. One line per anchored decision, so a `# DECISION <plan-id>/D-NNN` anchor still resolves after its plan directory is gone.*
*Format: `<plan-id>/D-NNN | YYYY-MM-DD | one-line rationale`. Never edited, never reordered, never trimmed.*
*Written by ip-archivist at CLOSE. Read by validate-plan.mjs as the durable anchor-resolution tier.*
plan-2026-09-04T124202-72910089/D-001 | 2026-09-04 | Leave check-agent-wiring.mjs rule (d)'s agents-only scan scope unchanged (no module resolution lines exist to check yet) and document the reasoning in-code instead of widening it.
