# Live two-agent test — 2026-06-02

First validation with **real Claude Code agents** (spawned `claude -p` processes,
not simulation) against the live store. Both pillars passed.

## Setup

Throwaway repo `B:\Coding\agent-coord-livetest\work` with a bare `origin` remote
and a pushed base commit. Global hooks (`core.hooksPath`) + the agent-coord MCP
server were live, exactly as in normal use.

## Pillar 1 — agents don't step on each other (file lock)

- A live agent (`amber-holder-9001`) held an exclusive lease on `notes.txt`.
- A **real** spawned agent was told to append a line to `notes.txt`.
- Result: its `PreToolUse` guard **blocked the edit (exit 2)**. The agent reported,
  unprompted:
  > "I cannot edit `notes.txt` right now — the agent-coord lock system is blocking
  > the edit because another agent (`amber-holder-9001`) currently holds a lock on
  > that file. I'm queued behind it."
- `notes.txt` was **never modified**. ✅

## Pillar 2 — autonomous push hand-off (the original pain)

The pain: "an agent told to push asks me whether to push other agents' commits."

- **Agent A** (`sage-egret-2055`) added `greet()` to `lib.js` and committed
  `feat: add greet helper` (the post-commit hook logged the provenance), then ended.
- **Agent B**, told to push to production and warned the history may contain other
  agents' commits, **called `pending_push_review` itself**, then `git push`. Its
  own explanation:
  > "Pushed `4d01bb4` … authored by `sage-egret-2055` but flagged `push-peer-done`
  > — the agent is no longer live and the commit wasn't marked WIP, so it was safe
  > to include."
- `origin/master` received A's commit, decided and pushed **by B without asking the
  human**. ✅

## Bonus — already real

During the test, the fleet snapshot also showed **two of the operator's actual
agents** working concurrently on a real client repo — the system is live across
real projects, not just the test.

## Open follow-ups (for the next build session)

- A transient second agent-id appeared in the log around the blocked agent's run —
  identity stability under `claude -p` is worth a closer look (didn't affect the
  outcome).
- The throwaway repo `B:\Coding\agent-coord-livetest` is still on disk (deletion is
  a hard stop — left for explicit cleanup).
- Self-learning "distill → memory" digest (SYSTEM.md §12) is still gated on more
  real usage; the insights CLI is the read step.
