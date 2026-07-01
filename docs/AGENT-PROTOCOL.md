# Agent Protocol — coordinating with other agents

You are very likely **not the only agent working on this machine.** Other Claude
Code and Codex sessions may be editing this repo (or sharing the dev port / DB /
deploy) right now. A coordination layer (`agent-coord`) tracks all of them in a
shared store. This is how you stay in sync instead of stepping on each other.

## What's automatic (you don't have to remember)

- At session start you get a **room brief** in context: live peers + their tasks,
  the task board, standing decisions, waiting mail. You arrive informed — no
  tool calls needed.
- Before any `Write`/`Edit`/`MultiEdit`, a hook **claims the file**. If another
  live agent holds it you get a **blocked tool call (exit 2)** naming the holder.
- **If you were blocked, you'll be told when it frees** — a `✅ "<path>" is free
  now` line arrives mid-turn the moment the holder releases / goes cold / dies.
  No blind retry loop needed: do other work and act when it arrives.
- Before risky shell commands (`Bash` **or `PowerShell`**: dev server,
  `drizzle-kit push`/migrations, deploy) a hook **claims the shared resource** — a
  dev port is machine-wide (two repos on one port collide), a deploy is keyed to
  this repo (an unrelated repo's deploy won't block yours); a colliding second one
  is blocked.
- `git commit` is gated globally: it's **rejected** if you stage a file another
  live agent holds. (This is the net that also catches Codex / manual commits.)

## What you should do proactively

1. **Check in with ONE call: `announce_intent`.** Announce a one-line task before
   starting — the response is the whole check-in: `brief` (who you are, live
   peers + their tasks, the board, standing decisions, unread mail) plus
   `overlaps`/`warning` if a peer is already on similar work. No separate
   `whoami`/`list_active_agents`/`list_tasks` round needed — spend those calls
   only when you need detail the brief didn't carry (`get_global_state` for
   leases, `cli/status.mjs` from a shell). If a peer is already on the area you
   were about to touch, **pick different work or coordinate** — don't duplicate
   or contradict them. (Claude also captures your task from the prompt, and gets
   the same brief free at session start.)
2. **Respect a block — but it self-heals.** An `exit 2` means a peer is
   *actively* editing that file right now (a lock goes **cold** and stops
   blocking a few minutes after the holder moves on — so abandoned files free
   themselves; you never need to force-release a stale lock or ask the human to
   unlock). When blocked: edit a different file and retry shortly, or
   `post_message` the holder to coordinate. The block message tells you roughly
   when it auto-frees. Force-release (`cli/release.mjs`) is a true last resort
   only if a holder is wedged/dead and you can't wait.
3. **Check in periodically** during long tasks — a peer may have started since you
   began. A quick `list_active_agents` keeps the codebase coherent.
4. **Want hard isolation?** `node $AGENT_COORD/cli/worktree.mjs new`
   gives you your own worktree + branch + port so you physically can't collide;
   merge back when done.

## Talk to each other (workspace-scoped messaging)

You can leave notes for the other agents in your repo — and you'll automatically
hear theirs. This is how you go from "avoid collisions" to actually coordinating.

- **Post** with the MCP `post_message` tool. Default scope is THIS workspace (same
  repo), so projects never bleed. `to:<agent_id>` directs it; `scope:'global'`
  broadcasts to the whole fleet. Examples: "refactoring auth, leave lib/auth
  alone for ~20 min", "API routes are done — safe to wire the UI now."
- **Receive** automatically: unread messages from peers are injected into your
  context at the start of each turn (you'll see a `📬` block). `read_messages`
  also pulls them on demand (this is the path Codex/other agents use). The backlog
  can span hours, so each message is tagged with whether its sender is **still
  live** (`from_live`; exited senders are flagged) — don't plan a hand-off to an
  agent that has already left. `list_active_agents` is the source of truth for who
  can actually act right now.
- `announce_intent` also broadcasts your task to the room, so peers see what you
  picked up. The statusline shows a `✉ N` unread indicator.

Use it like a teammate in the same room: say what you're about to do, hand off
when you're done, and warn before a big change.

**You hear peers mid-turn now.** Unread messages are surfaced not only at your
next prompt but BETWEEN your tool calls (after each edit), so a peer can reach
you even while you're heads-down building. If a `📬` block tells you a peer is
already on your work — stop and coordinate; don't finish a duplicate in silence.

## Don't duplicate — de-conflicting overlapping work

The worst failure isn't two agents touching one file (the lock catches that) —
it's two agents launched on the same vague prompt quietly building the SAME
thing in parallel. Guard against it:

- **Claim the work, not just the files.** Check the shared task board
  (`list_tasks`) before picking up work, then `claim_task` the unit you'll do
  (pass a `title` to create+claim, or a `task_id` from the board). A peer then
  *sees* it's taken — the structural fix for duplication. `node cli/tasks.mjs`
  shows the board.
- **Hand off, don't just finish.** Mark a task `done` with `update_task` AND a
  `summary` — 1-3 sentences on what you built, where, and any gotchas. Whoever
  depends on your task gets it as a directed message the moment they unblock,
  and whoever claims downstream work receives it as `handoff`. A bare `done`
  makes them start blind.
- **Idle? Pull work.** `claim_next_task` atomically claims the highest-priority
  READY task on this repo's board (deps done, not owned by a live peer) and
  returns it with the upstream handoff. Seeded board + idle agents = the fleet
  schedules itself. Set `priority` on tasks you create to order the pull.
- **Announce first.** `announce_intent` also returns a `warning` if a live peer
  in this repo is already on similar work. If you're the **later starter**, you
  yield: narrow your lane (re-announce a distinct sub-task — that clears the
  flag) or `post_message` to split scope. Don't rebuild what they're building.
- **The tiebreaker is deterministic:** the agent that **started first**
  (earlier `registered_at`, visible in `list_active_agents`) keeps the work; the
  later starter stands down. No need to argue or call the human.
- **Automatic backstop:** if you ARE the later starter and keep editing the
  overlapping area, your guard first advises you (mid-turn), then — if you ignore
  it — **blocks your edits** until you differentiate your task. This is by
  design; re-announce a real, distinct lane to proceed.
- **Ask a peer to stand down** with `request_yield(to, reason)` instead of
  force-releasing their locks or asking the human to kill them. They hear it
  mid-turn; if they agree they release and stop. Reserve it for when you're
  provably duplicating and you have priority (started first / verified version).

## Record decisions — stay architecturally coherent

Locks catch same-file edits and the overlap check catches same-task text — but
neither catches two agents making **contradictory choices in different files**
("JWT in this route, server sessions in that one"). The decision log does:

- **Before** an architectural or convention choice (auth model, library, naming,
  API shape), check `list_decisions` — a peer may have already decided it.
- **After** making one that constrains others, `record_decision(topic, decision)`
  — e.g. topic `auth`, decision `httpOnly JWT cookies, no localStorage`. Live
  peers hear it mid-turn (📬) and every newly arriving agent sees the current
  set in its session brief.
- Disagree with a recorded decision? Don't silently contradict it — `post_message`
  the author (re-recording the same topic supersedes it, so converge first).

## Search the room's memory before starting

`list_decisions` and `list_tasks` only show the latest state; the `search` tool
(FTS5 full-text over peer messages, decisions, and tasks) answers "has this
been discussed / decided / built already?" in one call — plain-language query,
best matches first with «highlighted» snippets:

- Picking up vague or resumed work → `search("checkout webhook")` before
  building from scratch; a peer's done-summary or warning may already cover it.
- Optional `kinds: ["message"|"decision"|"task"|"issue"]` narrows; default searches all.

## Report problems you hit — the cross-project issue log

When you run into a real problem that isn't worth derailing the current task to
fix — a bug, a recurring friction, a broken build, a confusing/broken API, a
coordination footgun — **log it** instead of letting it evaporate. The operator
reviews the backlog later and fixes things with full context, so the next session
doesn't start blind.

- **`report_issue(title, …)`** files it to a durable, **cross-project** log (it
  outlives this session and isn't tied to one repo). Add `body` (what happened +
  how to reproduce + the error text + what you tried), `severity`
  (low|medium|high|critical), `kind` (bug|friction|build|coordination|perf|docs),
  and `area` (the file/dir). It's auto-tagged with this project, you, the branch,
  and the time — so a one-line title is the only hard requirement.
- This is **not** live coordination (use `post_message` for "leave lib/auth
  alone") and **not** task handoff (use `update_task`). It's a backlog to fix
  later — don't drop what you're doing to fix the issue unless asked.
- **Check before you debug:** your session brief shows this repo's open-issue
  count, and `list_issues` (scoped to THIS repo, like every other in-session tool)
  plus `search` surface problems already on file — the thing you're chasing may
  already be logged, maybe even with a `resolution` from last time. (The
  cross-project survey is the operator's `cli/issues.mjs`, not an in-session tool —
  one repo's agent has no business reading another client's backlog.)
- Fixed one? `resolve_issue(issue_id, resolution)` records HOW — that note is what
  pays off when the same thing recurs. The operator's terminal view is
  `node $AGENT_COORD/cli/issues.mjs` (global survey, detail, resolve, export).

## Before pushing commits you didn't make

If you're told to push and the history has commits from OTHER agents, don't
reflexively ask the human "should I push these?" — work it out:

1. Run `pending_push_review` (MCP) or `node $AGENT_COORD\cli\pending-push.mjs`.
   Per unpushed commit it tells you the author, whether that agent is still live,
   and a verdict.
2. Act on the verdicts:
   - **push-mine / push-peer-done** — yours, or a finished agent's committed
     (non-WIP) work → safe to include.
   - **hold-wip** — subject marked WIP → do NOT push to prod.
   - **ask-peer** — the author is still LIVE → `ask_agent(to:<author>, "commit
     <hash> — prod-ready?")` then `check_replies`. Confirm → include; no → hold;
     no reply + they drop offline → fall back.
   - **ask-human / unknown** — provenance unknown → genuinely the human's call.
3. Mark your own not-yet-ready commits `wip:` so peers hold them automatically.

**Auto-push when clear (the operator's standing choice):** if `pending_push_review` returns
`allClear: true` — every unpushed commit is push-safe (yours or finished peers, no
WIP, nothing ambiguous) — **push without asking the human.** Only stop to ask when
there are blockers (WIP / live-peer / unknown author).

Honest limit: a finished agent can't answer — provenance + the WIP convention
carry the decision; live ask/reply is only the bonus path when peers are concurrent.

## If it's degraded

If `cli/status.mjs` / the statusline shows **⚠ COORD DEGRADED**, the store hit an
error and locks aren't being enforced — be extra conservative about shared files
until it clears (`node $AGENT_COORD/cli/doctor.mjs` to diagnose).

## The point

The codebase must stay coherent even with a dozen agents on it. Enforcement
prevents the worst collisions; **proactive awareness** (check → announce →
respect → re-check) prevents the subtler ones — duplicated work and contradictory
designs. Treat other agents as teammates you can see, not invisible strangers.
