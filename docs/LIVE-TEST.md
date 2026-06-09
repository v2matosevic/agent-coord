# Live two-agent test — 2026-06-09 (cooperation tier)

Second live validation with real `claude -p` agents (sonnet), this time of the
cooperation tier: room brief, blocked→freed notification, and the task-handoff
pipeline. Throwaway repo `B:\Coding\agent-coord-livetest\coop`; board pre-seeded
with `t1` (auth module, prio 5) and `t2` (CLI wiring, depends on t1). Agent A
(`cedar-marten-2628`) was told to claim t1 and work `src/auth.ts` warm; Agent B
(`flint-egret-7259`) launched once A's lease existed, told to claim t2 and try
the same file. **All four pillars passed:**

- **Room brief** — B quoted it verbatim, unprompted: itself, A + A's task, and
  the board (`1 claimed (t-4dee9d → cedar-marten)`). Arrived informed, zero
  tool calls.
- **Block → pivot** — B's first `src/auth.ts` edit was blocked (exit 2 naming
  cedar-marten). B did NOT force-release or stall: it moved to `src/main.ts`
  per protocol.
- **Freed notification** — when A released, B's next mid-turn 📬 carried
  `✅ "src/auth.ts" is free now…`; B quoted it and retried — its review line
  landed in the file **44 s after the block**, with no blind retry loop and no
  human.
- **Handoff pipeline** — A marked t1 done with a real summary (named both
  exported functions); B received it as a directed dependency-done message
  (quoted it verbatim), then wired `src/main.ts` importing **exactly the two
  functions the summary named**, and closed t2 with its own summary.

Note: `claim_task` returned no `handoff` for B — correct, not a bug: B claimed
t2 *before* t1 was done, so the context arrived via the dependency-done message
instead (the designed flow for that ordering).

---

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
