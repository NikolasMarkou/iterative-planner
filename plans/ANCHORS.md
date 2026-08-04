# Decision Anchor Manifest
*Committed, append-only. One line per anchored decision, so a `# DECISION <plan-id>/D-NNN` anchor still resolves after its plan directory is gone.*
*Format: `<plan-id>/D-NNN | YYYY-MM-DD | one-line rationale`. Never edited, never reordered, never trimmed.*
*Written by ip-archivist at CLOSE. Read by validate-plan.mjs as the durable anchor-resolution tier.*

<!--
One-time backfill, reconstructed by hand at the close of plan-2026-08-04T092155-0063b038
from the anchor comments still present in source. Every line below asserts only two
things: that the id existed, and what its own anchor comment says at its point of
impact. None of them reconstructs an original decisions.md entry — those files are gone.
The date on each line is the date carried by the plan-id itself, the only date actually
recoverable. Two ids use the legacy underscore plan-id grammar and are written verbatim.

This manifest is append-only, and it is the last time lines are written this way. Future
lines are appended by ip-archivist at CLOSE, from the closing plan's own decisions.md —
the authoritative record — and never from a scan of source anchors. Deriving lines from
the anchors they validate would make an anchor its own proof of validity, which is why
plan criterion C-13 forbids shipping any script, make target, or agent instruction that
does it.
-->

plan_2026-07-14_79ee0f59/D-001 | 2026-07-14 | The changelog's six field shapes (ts, step, commit, op, radius, dref) have exactly one definition, CHANGELOG_SPEC in schema.mjs; the hand-maintained copies inside validate-plan.mjs were deleted rather than kept in lockstep.
plan_2026-07-14_79ee0f59/D-002 | 2026-07-14 | The changelog stays a markdown file whose append is one line; the v2.33.0 re-encoding turned every write into a whole-file read-modify-write that silently dropped concurrent entries, and was reverted.
plan_2026-07-14_79ee0f59/D-003 | 2026-07-14 | state.md's Transition History is read comment-blind through a single helper, because bootstrap's own state.md template embeds an example transition inside an HTML comment that a raw scan ingests as a real record.
plan_2026-07-14_79ee0f59/D-004 | 2026-07-14 | The `--force` token is positional, honored only immediately after `new`; the tolerant includes-scan made ordinary goal text destructive for any caller that word-splits its goal.
plan_2026-07-14_79ee0f59/D-005 | 2026-07-14 | shared.mjs holds the only definitions of the plan-id and decision-id grammars, and the decision-id pattern's trailing negative-digit lookahead is load-bearing: without it a greedy digit run backtracked and corrupted source during a retire stamp.
plan_2026-07-14_79ee0f59/D-009 | 2026-07-14 | Corrects a false fail-safe claim made under D-003: the iteration hard cap counts on the raw Transition History block, because a stray comment opener pairs with the template's own trailer and once made the cap derive zero from four real records; the over-count it buys is explained by a WARN-only diagnostic.
plan_2026-07-14_79ee0f59/D-010 | 2026-07-14 | Every markdown scanner locates comments through shared.mjs's code-span-aware htmlCommentSpans and matches headings line-anchored; the local comment regex was blind to backticked prose and the substring heading lookup matched the heading's own name quoted mid-line.
plan_2026-07-14_317362c4/D-001 | 2026-07-14 | Plan directory stamps are UTC and deliberately colon-free, because a colon is illegal in a Windows filename and fixed-width HHMMSS keeps lexical order equal to chronological order.
plan_2026-07-14_317362c4/D-004 | 2026-07-14 | The skill version is resolved by probing the installed layout before the dev layout and never throws: a missing or garbage VERSION degrades to the string "unknown" rather than crashing plan creation on every fresh install.
plan_2026-07-14_317362c4/D-005 | 2026-07-14 | Anchors whose plan-id prefix is not a legal plan-id are found by a second loose-prefix pass and reported as WARN, rather than widening the read grammar, which would make a mis-derived prefix silently resolve to a plan that does not exist.
plan-2026-07-14T141152-113d5b92/D-001 | 2026-07-14 | The plan-file template literals stay inside bootstrap.mjs with no runtime read of file-formats.md, because bootstrap's failure mode is that no plan can ever be created again; the resulting duplication is byte-guarded by check-template-parity.mjs instead.
plan-2026-07-14T141152-113d5b92/D-008 | 2026-07-14 | emit-template.mjs is the single owner of the template marker literal, imported by every consumer including the checker, so the grammar cannot exist as two hand-maintained copies.
plan-2026-07-14T141152-113d5b92/D-009 | 2026-07-14 | check-template-parity imports the slicer itself and scans resolveTemplate's output for all 17 served slugs, because every earlier proxy for the served region diverged from that slicer; a slug that fails to resolve is a loud failure naming it, never a silent skip.
plan-2026-07-16T085306-8bd12f33/D-001 | 2026-07-16 | Changelog dref join integrity is a separate flat string-set membership check called only from the full validation; it never re-validates the dref shape and is never wired into the fast pre-step gate.
plan-2026-07-16T085306-8bd12f33/D-004 | 2026-07-16 | The emitted edge graph carries only verified-OK rule matches pushed from the same loops that feed the issue list, with no parallel collector pass and locale-independent sorting so the output stays byte-identical across platforms.
plan-2026-07-16T085306-8bd12f33/D-005 | 2026-07-16 | A test fixture keeps a real four-digit decisions entry so the dref join check runs legitimately clean; the entry must not be removed and the slug must not be renamed off its prefix to dodge the test's own filter.
plan-2026-07-16T164852-47577439/D-001 | 2026-07-16 | Two anchor sites carry differing rationale under this one id: at the lessons-eviction check it means severity stays WARN or INFO on a count-only trigger with no fuzzy content matching, and at the anchor resolver it means per-plan decisions reads stay scoped to the plan-ids source anchors actually name rather than a walk of every plan directory.
plan-2026-07-21T092933-3295714d/D-002 | 2026-07-21 | blast-radius derives the repo root once and frames its search pathspecs from it, keeping the inclusive top pathspec that a subdirectory invocation needs to see importers outside its own subtree, while diff pathspecs stay cwd-relative because git resolves those itself.
plan-2026-07-21T092933-3295714d/D-003 | 2026-07-21 | Each gate script reads its repo-root override from an opt-in environment variable inside the entry-point branch only, so tests can spawn the real CLI failure paths against fixture roots while importers and the default CLI stay byte-identical.
plan-2026-07-21T111733-38d0cd87/D-001 | 2026-07-21 | The edge-graph writer fails loud on any write error and never creates the parent directory: a mistyped output path exits non-zero with the error code reported verbatim instead of silently making directories.
plan-2026-07-23T191907-b8d237ed/D-001 | 2026-07-23 | The register scan strips bracket-tag spans before the compound regex, replacing them with a space to keep token boundaries, so a bracket tag's inner slug is not counted twice; the one overlapping pair did not earn a shared range-dedupe abstraction.
