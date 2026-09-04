# Faster work on shared files

## What exists today

File claims cover the whole file. A peer's claim blocks while the peer is live
and the claim was refreshed within five minutes. A missing heartbeat stops
blocking after three minutes. Explicit release can free the file immediately.
These are fallback timeouts, not suggested working intervals.

Blocked native edits enter a waiting list. At a subsequent context-delivery
event, the waiter is told if the file was available when checked. This is a
notification, not a reservation or FIFO handoff. Other agents can claim it first.
Reclaim and re-read before applying an edit. Long-running tools do not receive
these notifications continuously.

## Recommended workflow now

1. Announce a narrow task. Read and reason without claiming a large set of files
   far in advance. Claims should cover the next coherent edit.
2. Claim, re-read the current file, and apply a small edit. Release finished
   paths with `release_files({paths:[...]})` before unrelated work.
3. Run tests against a stable checkout. If releasing files lets peers modify the
   code under test, the result describes only the revision actually tested;
   rerun relevant checks after integration. Use an isolated worktree for long
   changes or tests that need stable files.
4. When blocked, work elsewhere. A peer handoff must name what changed and what
   remains. Reclaim and re-read on notification; do not retry a stale full-file
   replacement or force-release another live agent.
5. For substantial same-file work, create separate Git worktrees and assign one
   integration owner. Merge each finished change and test the combined result.
   Physical isolation avoids overwrite races; it does not prevent logical
   conflicts. Shared dev ports, databases and deployments still need claims.

The existing `cli/worktree.mjs new` helper creates a branch/worktree and suggests
a port. It can link dependencies and environment files back to the main tree;
those linked resources remain shared. A suggested port is not yet reserved.

## Next implementation priorities

These are proposals, not implemented guarantees in v1.9.0.

- Add per-file wait duration and contention counts. Separate active editing
  time from idle reservation time so tuning follows measured bottlenecks.
- Notify the current holder of queued work, with deduplication and a concrete
  request to finish a small edit and hand off. Give the holder a safe checkpoint;
  do not automatically unlock a file halfway through a command.
- Add explicit atomic handoff to a named, live waiter with bounded acceptance.
  Test stale waiters, crashed holders, competing claims and multi-file edits.
- For coordinated patch submission, record a base content hash, validate it
  under the write claim, then apply or reject/rebase the patch. After merging,
  validate the combined changes. A stored hash alone does not prevent stale
  writes; all mutation paths need to enforce it.

Do not start by globally shortening timeouts or enabling line-level locks.
Shorter timeouts can expire during valid long-running work. Disjoint line edits
can still break imports, interfaces, formatting or behavior together. Worktree
isolation and short explicit handoffs preserve the current safety model while
allowing useful parallel work. Confidence: high for those workflow choices;
unknown for their speedup until contention is measured.
