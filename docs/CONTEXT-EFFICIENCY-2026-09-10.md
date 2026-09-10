# Quality-preserving context efficiency, September 10

Marko authorized reducing Astra's prompt-to-project completion time without
lowering output quality. Tracking: Athena `Athena-dgdd`; coordination issue
`i-5126d678`. Astra/high, long-context settings, permissions, hook trust, locks,
standing decisions and release requirements are unchanged.

## Implemented

The active inbox now excludes only broadcasts that both predate the recipient's
original registration and come from a currently inactive sender. Direct messages
still cross workspace boundaries and never use this history filter. Broadcasts
sent during the recipient's session still arrive after the sender exits. Earlier
messages from live peers or children of live parent sessions remain eligible.
Missing registration preserves the previous behavior, and resume does not reset
registration. The same predicate drives read, peek, count and remaining-count
queries. Message retention, search, decision records and leases are unchanged.

This replaces automatic replay with on-demand retrieval, not deletion. A brief
explains where history lives when there is current coordination to show; an empty
room still emits only its identity. The MCP tool description explains that trusted
hooks already deliver mail and manual polling is the fallback.

## Evidence

- Initial real session on September 10 started with 774 queued messages. Native
  hook output repeatedly delivered September 3-6 work from exited peers in batches
  of 15. A current direct memory-pressure warning repeated behind that backlog.
- New `test/message-history.mjs` failed before the implementation: 778 inbox
  messages instead of 4. Afterward its 774 historical broadcasts stay searchable;
  all four actionable messages arrive, the next event is silent, stored row count
  is unchanged, and resumed/unregistered recipients retain their inbox semantics.
- At 14:25:09 UTC, a read-only snapshot of the real SQLite metadata was copied to
  an in-memory database, without message bodies. For this exact recipient's
  registration and a fresh unread cursor, the old rule yielded **778** messages
  and the new rule **9**: **769** historical broadcasts excluded. No live store
  data was altered by this comparison. This measures context selection, not task
  completion time or model inference speed.
- The real trusted Codex hook immediately switched to current peer work and
  direct warnings after the source edit. Subsequent tool events no longer replayed
  historical batches. No app/session restart or hook trust change was needed.
- Focused messaging, history and hook-budget suites passed. The first full suite
  passed 48/49 and caught an added line in an empty-room brief. That regression
  was fixed; decisions, hook-budget and message-history reruns passed 3/3.
- `node cli/doctor.mjs`: 10/10 configuration checks passed. Doctor alone does not
  establish native runtime delivery; the actual hook observation above does.

Final full-suite result is recorded in the completion section below.

## Verification guidance installed on Olympus

The existing skill-scope sections in `~/.codex/AGENTS.md` and
`~/.claude/CLAUDE.md` now say to retain already-read unchanged guidance, read
current shared source before editing, identify affected behavior, run focused
checks then all required gates, and reuse results only while relevant source,
dependencies, configuration and environment are unchanged. Reused evidence must
name scope/provenance; claims about current external state still require current
checks. Changes, failures or unresolved concerns invalidate affected results.
This does not authorize skipping security, visual, correctness or release checks.

The existing Obsidian outcome/stopping note and its index pointer record Marko's
September 10 clarification. Original global instruction files and the note are
backed up at `C:/Users/matos/.claude/backups/workflow-efficiency-20260910/`.
No Laconia-managed voice text was changed. Both inspected repository roots lack
`CLAUDE.md`; their `AGENTS.md` and relevant memory were used.

## Delivery and limits

The hook loads this checkout on each event, so the inbox behavior is active on
Olympus. Already-running MCP servers retain imported modules until their normal
restart; newly started servers load the new query and description. Global
instructions are installed for new sessions, not presumed hot-reloaded in existing
ones. No existing conversation was stopped, no global installer was run and no
remote machine was changed.

Confidence is high for the tested inbox behavior and the observed reduction in
historical context. End-to-end project time and output-quality comparisons across
real coding tasks remain unmeasured. Machine commit pressure was independently
reported during this work; this change does not repair that separate issue.

## Completion

The final `npm test` run passed **49/49 suites**, exit code 0. One previous
final-source run lost its result during the conversation interruption, so it was
rerun with durable output rather than inferred successful. The saved log is
`C:/Users/matos/.claude/backups/workflow-efficiency-20260910/final-regression.log`,
SHA-256 `f46c6aa40e91cc7454e7a15c8cf38c4c5b4858e37f09b1577f689d673df4cf09`.
The final global-file comparison proved each instruction file differs from its
backup by exactly the intended paragraph replacement. The model remains
`gpt-6-astra`, effort `high`, context `1000000`, compaction threshold `800000`.

Source and evidence are committed locally; no remote publication or machine
rollout was performed. The exact source commit is recorded in the Athena handoff
at `docs/ade/evidence/2026-09-10-workflow-efficiency.md`. The native hook remains
active and the global instruction files are saved. No work from other agents was
included in this change.
