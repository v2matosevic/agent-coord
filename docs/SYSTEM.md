# agent-coord — System Documentation (as built)

Complete record of the cross-agent coordination layer: what it is, how it's
wired, every component, and how agents are expected to use it. For the original
architecture rationale see [`../DESIGN.md`](../DESIGN.md); for the day-to-day
agent behaviour see [`AGENT-PROTOCOL.md`](./AGENT-PROTOCOL.md).

Status: **Tier 0–2 complete.** Built on Node's built-in `node:sqlite` (WAL);
hooks/CLI are zero-dependency, only the MCP server uses `@modelcontextprotocol/sdk`.

---

## 1. The problem it solves

Marko runs many AI coding agents at once — several Claude Code terminals in one
VS Code window on one repo, plus more across other windows/repos, plus Codex.
Each agent process is an island with zero shared state, so they: edit the same
file simultaneously, duplicate work, make contradictory decisions, and collide on
shared singletons (one dev port, one dev DB, one production deploy). This is
the classic distributed-systems failure with no coordination primitive.

agent-coord gives every agent a **shared store**, **presence**, **file/resource
locking**, a **universal commit net**, and **observability** — globally, across
every repo on the machine.

---

## 2. Architecture (as built)

```
        ┌──────────────────────────────────────────────────────────────┐
        │ SHARED STORE — SQLite WAL @ %USERPROFILE%\.agent-coord\state.db │
        │ agents · workspaces · file_leases · resource_leases ·          │
        │ lease_queue · activity_log · schema_version                    │
        └───────────────▲───────────────────────────▲──────────────────┘
                        │                            │
        AWARENESS (model-invoked, universal)   ENFORCEMENT (automatic)
        ┌─────────────────────────────┐   ┌──────────────────────────────────┐
        │ MCP server (mcp/server.mjs)  │   │ Claude PreToolUse → claim or exit-2│
        │ in Codex + Claude globally   │   │ Claude Bash guard → resource leases │
        │ claim_files / list / announce│   │ git pre-commit (GLOBAL) → block any │
        │ / get_global_state / ...     │   │   committer staging a held file     │
        └─────────────────────────────┘   └──────────────────────────────────┘
                        │
        OBSERVABILITY: statusline · cli/status · cli/watch · cli/dashboard (browser)
        ISOLATION (opt-in): cli/worktree — per-agent worktree+branch+port
```

**Three scopes** (the mental model):
- **Room** = `workspace_id`, keyed on the **repo root alone** (branch-independent,
  so `git switch` never orphans leases). The unit of *file* conflict.
- **Global** = the whole fleet across every repo/window. The unit of *awareness*.
- **Resource** = machine-wide singletons (`port:3000`, `db:dev`, `deploy:primary`),
  orthogonal to rooms — two agents in different repos still contend.

**Atomicity:** every store mutation runs in a `BEGIN IMMEDIATE` transaction with
retry-on-busy, so a claim's check-and-insert is atomic across processes (proven:
30 processes racing → exactly one winner).

**Fail-open-but-loud:** any store error makes a hook proceed (never freezes real
work) but writes a `coord-degraded.flag` + stderr, surfaced by statusline/doctor.

---

## 3. What runs where (the global wiring)

### Claude Code — `~/.claude/settings.json` (user scope = every session, every dir)

| Event | Matcher | Script | Action |
|---|---|---|---|
| SessionStart | — | `hooks/session.mjs --register` | register agent + reap + publish claude.exe→id link |
| UserPromptSubmit | — | `hooks/session.mjs --prompt` | capture the task + deliver unread peer messages |
| PreToolUse | `Write\|Edit\|MultiEdit\|NotebookEdit` | `hooks/guard.mjs` | claim file or **exit 2**; overlap escalation block |
| PreToolUse | `Bash` | `hooks/bash-guard.mjs` | claim port/DB/deploy or **exit 2**; stamp committer marker |
| PostToolUse | `Write\|Edit\|MultiEdit\|NotebookEdit` | `hooks/guard.mjs --post` | heartbeat + log edit + **mid-turn deliver** messages/overlap advisory |
| SessionEnd | — | `hooks/session.mjs --release` | release all |
| SubagentStart | — | `hooks/session.mjs --subagent-start` | register the subagent (distinct id) |
| SubagentStop | — | `hooks/session.mjs --subagent-stop` | release the subagent |
| statusLine | — | `cli/statusline.mjs` | live fleet line |

All commands run as `node --disable-warning=ExperimentalWarning "$AGENT_COORD/<script>"`.

### git — global `core.hooksPath` (every repo on the machine)

`git config --global core.hooksPath %USERPROFILE%/.agent-coord/githooks`. Three
hooks, all **fail open** (only rc=1 blocks) and all **chain** to any repo-local
hook (skipping our own): `pre-commit` (`cli/precommit-check.mjs` — the
cross-agent commit net), `post-commit` (provenance logging, never blocks), and
`pre-push` (`cli/prepush-check.mjs` — blocks `wip/*` snapshot branches of
uncommitted work from reaching a PUBLIC GitHub remote; deletions exempt;
`AGENT_COORD_ALLOW_PUBLIC_WIP=1` overrides). Prior value saved to
`~/.agent-coord/git-hookspath.prior`.

### MCP server — Codex + Claude (global)

- Codex: `codex mcp add agent-coord -- node ... mcp/server.mjs --tool codex`
  (in `~/.codex/config.toml`, covers all Codex projects).
- Claude: `claude mcp add agent-coord --scope user -- node ... --tool claude-code`
  (in `~/.claude.json`).

One stdio server process == one agent (clients spawn it per session).

---

## 4. Components

```
lib/
  store.mjs        node:sqlite open/init, WAL+busy_timeout, writeTxn(IMMEDIATE)+retry, degraded flag
  identity.mjs     agentIdFromSession() + resolveAgentId() (subagent-aware) + COORD_HOME (env-overridable)
  proc-ancestry.mjs findClaudePid() — walk the process tree to the shared claude.exe (cross-platform)
  session-link.mjs claude.exe→agentId handshake so the MCP server adopts the hook identity (no ghost twin)
  path-canon.mjs   canonicalRepoRoot/workspaceId (room key) + canonicalFilePath (alias-collapsing)
  git-context.mjs  repo root + branch for a cwd
  agents.mjs       ensureAgent (upsert+heartbeat), heartbeat, markDead, agentAlive
  leases.mjs       claimFile/releaseFile/peekConflicts, claimResource/releaseResource, enqueue, releaseAllForAgent
  overlap.mjs      duplicate-work detection (task Jaccard) + tiebreaker + advisory throttle/escalation
  tasks.mjs        shared task board — createTask (dedup, priority) / claimTask (atomic, dead-owner reclaim, returns handoff) / claimNextTask (pull best READY task) / updateTask (summary on done -> notify dependents) / listTasks (deps readiness)
  decisions.mjs    decision log — recordDecision (broadcast to room) / listDecisions (latest per topic)
  room-brief.mjs   buildRoomBrief() — session-start context: peers, board, decisions, unread
  coord-context.mjs midTurnContext() — peer messages + freed files I was blocked on + overlap advisory (PostToolUse additionalContext / UserPromptSubmit stdout)
  activity.mjs     logActivity, getFleet, queueDepth, recentActivity, getGlobalState
  insights.mjs     shared read-only analysis — collisionHotspots (same file, 2+ agents) + pathHistory (powers query_history)
  notify.mjs       native desktop notifications (macOS) — block / message / yield; throttled, detached, fail-safe
  bash-targets.mjs detectWriteTargets — files a shell command writes (sed -i / > / >> / tee / cp / mv / touch / Set-Content / Add-Content / Out-File); quote-aware tokenizer, repo-only, cwd-relative
  snapshot.mjs     atomic JSON mirror of the fleet → ~/.agent-coord/snapshot.json (written by the statusline tick + state-json); stamps generatedAt + clone root
  public-remote.mjs parseGitHubRepo + cached unauthenticated-API visibility oracle + wip-ref parsing (powers the pre-push guard)
  reaper.mjs       reap() + reapThrottled() — GC dead agents / expired leases / stale links; wal_checkpoint
  config.mjs       FILE_TTL_SEC, RESOURCE_TTL_SEC, DEAD_MS (3 min), FILE_ACTIVE_MS (5 min warm window), OVERLAP_*, NOTIFY_*, SCHEMA_VERSION
hooks/
  session.mjs      register (+ room brief) / prompt (mid-turn-context delivery) / subagent-start / subagent-stop / release
  guard.mjs        PreToolUse file claim-or-block (exit 2) + notify on block; --post = heartbeat + log + mid-turn delivery (shell calls too)
  bash-guard.mjs   PreToolUse Bash|PowerShell: resource + shell-write-target claim-or-block + committer marker
mcp/
  server.mjs       stdio MCP server (24 tools); one process = one agent
  tool-defs.mjs    JSON-Schema tool catalog
cli/
  statusline.mjs   Claude status line — leads with THIS terminal's own id + its subagents, then the fleet (⚠ CONTENDED / DEGRADED); also rewrites snapshot.json each tick
  status.mjs       one-shot fleet table        watch.mjs   terminal live view
  dashboard.mjs    browser dashboard (+ dashboard-ui.mjs)
  worktree.mjs     new / list / rm — physical isolation
  insights.mjs     terminal retro          digest.mjs   durable per-project hotspot digest → ~/.agent-coord/digests/
  macos-menubar.mjs + install-macos-menubar.mjs   SwiftBar/xbar menu-bar fleet (macOS)
  doctor.mjs       9-point health check        release.mjs  unstick leases
  install-global.mjs / install-git-hook.mjs / install-claude-hooks.mjs
  state-json.mjs   live store → JSON for the menu-bar plugin + the extension's refresh fallback; also refreshes snapshot.json
vscode-extension/  Activity Bar "Fleet" webview — icon → live panel + open-in-tab.
                   Reads ~/.agent-coord/snapshot.json directly (no subprocess / no node:sqlite / no PATH dep),
                   falls back to system node + state-json.mjs only when the snapshot is stale
git/pre-commit     reference copy of the hook
setup.{mjs,ps1}    idempotent cross-platform installer (setup.mjs adds the macOS menu-bar plugin on darwin)
test/              26 files — locks/board/messaging/overlap/identity/cooperation/shell-writes/insights/prepush-guard (+ helpers)
tier0/             original presence-only layer (superseded, kept for reference)
```

Data model: see `lib/store.mjs` `SCHEMA`. Key tables — `agents` (id, tool, pid,
repo, branch, task, status, last_heartbeat), `file_leases` (workspace_id, path,
agent_id, mode, expires_at), `resource_leases`, `lease_queue` (block-time waiter
rows, drained by `freedFileWaits` for the freed-file notify), `activity_log`,
`messages` (workspace-scoped agent-to-agent mailbox) + `message_reads` (per-agent
read pointer), `tasks` (workspace-scoped shared task board — owner, status,
`depends_on`, `summary` handoff, `priority`), `decisions` (workspace-scoped
decision log, latest per topic).

---

## 5. Commands

```bash
# all CLIs run with: node --disable-warning=ExperimentalWarning <path>
cli/doctor.mjs                  # 9-point health check
cli/status.mjs                  # one-shot fleet table + recent activity
cli/watch.mjs                   # terminal live view (2s)
cli/dashboard.mjs [port]        # browser dashboard (default :7777)
cli/worktree.mjs new [--base b] # isolate an agent: own worktree+branch+port
cli/worktree.mjs list | rm <name>
cli/insights.mjs [--since 7d]   # retro: same-file-by-2+-agents + conflicts
cli/digest.mjs [--since 7d]     # durable per-project hotspot digest → ~/.agent-coord/digests/
cli/install-macos-menubar.mjs   # SwiftBar/xbar menu-bar fleet (macOS)
cli/pending-push.mjs            # who made the unpushed commits + push verdicts
cli/release.mjs --file <p> | --resource <id> | --agent <id> | --all
setup.mjs                       # (re)install everything, idempotent, any OS (setup.ps1 = Windows + VS Code panel)
```

MCP tools (24, in Claude + Codex): whoami, announce_intent, list_active_agents,
get_global_state, check_conflicts, claim_files (returns a `hotspot` warning on
known multi-agent files), release_files, claim_resource, release_resource,
log_activity, post_message, read_messages, pending_push_review, ask_agent,
check_replies, reply, request_yield, query_history, list_tasks, claim_task,
claim_next_task, update_task, record_decision, list_decisions.

---

## 6. How agents use it — the coordination protocol

See [`AGENT-PROTOCOL.md`](./AGENT-PROTOCOL.md). In short: **Claude is enforced
automatically** (you don't have to remember). But every agent should *also*
proactively (a) check the fleet before starting (`list_active_agents` /
`cli/status.mjs`), (b) `announce_intent` so peers see the task, (c) treat an
`exit 2` block or a rejected commit as "a peer owns this — coordinate, don't
fight it", and (d) **talk**: `post_message` to coordinate with peers in the same
repo; unread messages are injected into a Claude agent's context each turn (and
`read_messages` pulls them for Codex/others). Codex and other MCP agents rely on
this protocol + the commit net, since they can't be hard-blocked pre-write.

---

## 7. Robustness & failure modes

- **Dead agents / stale locks** — liveness = heartbeat (dead after 3 min); the
  reaper GCs agents/leases older than 30 min and on every session start.
- **Sticky locks / friction** — a file lease only *blocks* while **warm**: the
  holder edited that exact file within `FILE_ACTIVE_MS` (5 min). Past that it goes
  **cold** and a waiting agent takes the file automatically (the takeover sweeps
  the stale lease). So a one-time edit never wedges a still-alive session, and
  resolving a block needs no force-release and no human — it just self-heals when
  the holder moves on. Active concurrent edits still block (the real guarantee).
- **Store write races** — `BEGIN IMMEDIATE` + `busy_timeout` + retry-with-jitter.
- **Schema drift** — a store written by a newer `schema_version` flips the
  degraded flag instead of writing incompatible data.
- **Model ignores advisories** — Claude `PreToolUse` auto-claims regardless; the
  git pre-commit net backstops every committer; silent edits caught by
  `content_hash`/commit-time.
- **Store SPOF** — fail-open-but-loud (degraded flag + stderr + statusline banner).
- **WAL growth / network FS** — periodic `wal_checkpoint`; store must be on a
  local, non-synced disk.

---

## 8. Tests & health

26 tests (run isolated via `AGENT_COORD_HOME`): `prepush-guard` (public-remote
WIP guard: URL parse / push matrix / visibility oracle / cache),
`path-aliasing` (platform-aware),
`concurrency`
(30→1), `cold-lease` (warm blocks, cold self-heals on takeover), `tasks` (board:
create/dedup/claim-race/dead-owner-reclaim/deps), `waiter-notify` (block →
enqueue → free → notify exactly once), `handoff` (done→notify with
summary+readiness, claim returns handoff, claim_next_task pull order),
`decisions` (record/supersede/broadcast + room brief), `bash-targets`
(shell-write detection: redirects/sed/tee/cp/mv/PowerShell cmdlets + the
quote/heredoc/fd/null-sink false-positive guards), `bash-guard-block` (the live
shell hook blocks a write to a peer-held file), `notify` (plan/throttle/disabled,
dry-run — no real banners), `insights` (collision hotspots + path history),
`server-identity` (standalone server late-adopts the hook id), `resource`,
`resource-keyword`, `precommit` (cross-agent vs self),
`pending-push`, `mcp-smoke` (real MCP client), `liveness` (dead-holder + reap),
`git-switch` (room invariant), `schema-guard`, `subagent` (distinct ids + sibling
lock), `messages` (workspace-scoped, directed, read-once, no self-delivery),
`overlap` + `overlap-flow` (duplicate-work detection, tiebreaker, advisory→escalate
→clear), `session-link` (claude.exe handshake: a `--tool claude-code` MCP server
adopts the published id end-to-end; Codex stays standalone). `cli/doctor.mjs` = 9/9.

---

## 9. Decisions & deviations from DESIGN.md

- **`node:sqlite` instead of `better-sqlite3`** — Node 22.22 ships it; zero deps,
  no native build, kills the §3.6 ABI failure mode (a node upgrade silently
  disabling hooks). Same `IMMEDIATE`-transaction guarantee.
- **Exclusive-by-default file leases** (not shared+serial-list) — fits Marko's
  solo/handful-per-repo reality; blocking concurrent same-file edits is the
  headline value. Shared mode exists for future tuning.
- **Global `core.hooksPath`** for the commit net (DESIGN suggested per-repo) —
  the explicit "make it global" requirement; chains to repo-local hooks, fails open.
- **MCP for awareness only** — Claude is enforced by hooks; Codex/others get
  awareness + the commit net (no reliable pre-write block).
- **PID-reuse liveness guard deferred** — it would hinge on the hook's `ppid`
  being the stable agent process; if wrong it could free a *live* lease (break the
  core guarantee). Heartbeat liveness kept. Revisit only if crash-recovery latency
  proves a problem.
- **Lease keyed by session cwd's repo** — assumes an agent works within its
  session's repo (true for the design's usage model).
- **One identity per Claude session (unified hook + MCP).** The MCP server used
  to mint a `randomUUID()` identity, so every Claude session showed up as TWO
  agents — a hook-self that held the locks and a random MCP-self that sent the
  messages. That split inflated the fleet, broke own-commit recognition in
  `pending_push_review` (provenance under the hook id, comparison under the MCP
  id), and echoed an agent's own broadcasts back to it. Claude exposes no session
  id to MCP servers, so the bridge is the **claude.exe both processes share**:
  the SessionStart hook walks the process tree to that pid (`proc-ancestry.mjs`)
  and writes `pid→agentId` (`session-link.mjs`); the MCP server reads it by its
  own ppid and adopts the same id. Fail-safe: no link ⇒ standalone id, so Codex
  is unaffected. An *adopted* server also skips teardown (the SessionEnd hook owns
  lifecycle) so an MCP restart can't release a live session's locks.
- **Talk reaches heads-down agents (mid-turn delivery).** Messages were injected
  only at `UserPromptSubmit`, so an agent building a whole feature in one long
  turn never saw a peer's messages until it finished (the coral-mole standoff).
  Delivery now also rides `PostToolUse` (after each edit) as
  `additionalContext` — non-blocking, and deliberately NOT a PreToolUse
  forced-`allow` (which would bypass Bash/edit permission prompts).
- **Warm/cold leases (self-healing locks).** Leases used to block for their full
  1h TTL as long as the holder's *session* was alive — so a file edited once
  stayed locked for the session, and the only escape (force-release) bubbled up to
  the human. Now a lease only blocks while **warm** (holder touched that file
  within `FILE_ACTIVE_MS`); cold leases don't block and are swept on takeover. The
  block message states when it auto-frees and steers to "edit elsewhere / message
  the peer," never "ask the human / force-release." Real concurrent edits still
  block. Same warmth gate in `peekConflicts` and the pre-commit net.
- **Statusline self-identity.** It showed only peers, so a terminal couldn't say
  which agent it *was*. It now leads with this terminal's own id and its live
  subagents (`◆ <id> ⤷ sub-a, sub-b`), so a glance maps terminal → agent.
- **Duplicate-work de-confliction (advisory → escalate).** Two agents on one
  vague prompt would build the same thing; the file lock only caught concurrent
  same-file edits and just blocked the loser. Now a cheap task-similarity check
  (`overlap.mjs`, Jaccard over significant tokens — NOT ML) flags overlap;
  `announce_intent` warns up front; the deterministic tiebreaker is the earlier
  `registered_at`; and the later-starter is advised mid-turn, then hard-blocked
  by its own guard if it keeps duplicating (escape hatch: announce a distinct
  lane). `request_yield` lets the priority agent ask a peer to stand down instead
  of force-releasing locks or a human kill.
- **Cooperation tier (2026-06): close every half-open loop.** The prevention
  layer (locks, overlap, commit net) was done; what remained was that every
  coordination event died in a table nobody read back. Four loops closed, all
  additive (no `SCHEMA_VERSION` bump): (1) **freed-file notify** — guard blocks
  already enqueued waiters into `lease_queue`; `freedFileWaits` drains them
  *lazily* at delivery time (release, cold-expiry, death, and reap all look
  identical to a lazy check — no event source needed, which is why this is
  ~40 lines instead of a pub/sub layer). (2) **Task handoff** — `summary` on
  done → directed message to dependents' owners + `handoff` returned on claim;
  the board went from "don't duplicate" to an actual pipeline. (3)
  **`claim_next_task`** — atomic pull of the best READY task; idle agents drain
  a seeded board (work-stealing without a scheduler). (4) **Decision log** —
  covers the failure no other mechanism saw: contradictory architecture
  choices in *different* files; broadcast rides the existing message channel,
  durable rows feed the brief. Plus the **session-start room brief**
  (SessionStart stdout → context: arrive informed, zero tool calls) and
  prompt-time delivery unified onto `midTurnContext`.
- **PowerShell guard coverage (found by dogfooding).** The bash-guard matcher
  was `Bash` only; Claude Code on Windows routes shell work through the
  `PowerShell` tool (same `tool_input.command` shape), so resource guards and
  the committer marker silently didn't fire — an agent's own PowerShell
  `git commit` was rejected by the pre-commit net as "cross-agent". Matchers
  are now `Bash|PowerShell`; the installer migrates existing matcher groups in
  place. `guard.mjs --post` also rides shell calls (no `file_path` → heartbeat
  + delivery only), so long test/build loops aren't deaf to peers.
- **Shared task board (`tasks.mjs` + `cli/tasks.mjs`).** The *structural* version
  of the above: agents `claim_task` discrete units of work (atomic claim — one
  winner under a race, like file leases), so a peer simply sees a task is taken
  rather than relying on text-similarity inference. Workspace-scoped, with title
  dedup, dead-owner auto-reclaim, and a `depends_on` list that marks a task
  blocked/ready. Added **without a SCHEMA_VERSION bump** (the table is additive and
  never read by older code), so the live fleet's long-running v2 MCP servers don't
  trip the "schema ahead" degraded flag.

---

## 10. Reverts / uninstall

- Claude hooks/statusline: restore a `~/.claude/settings.json.bak.*`.
- Global git hook: `git config --global --unset core.hooksPath` (prior value in
  `~/.agent-coord/git-hookspath.prior`).
- Codex: `codex mcp remove agent-coord` (config backup in `~/.codex/`).
- Claude MCP: `claude mcp remove agent-coord --scope user`.
- State: delete `~/.agent-coord/` (regenerates from live sessions).

---

## 11. Open / next

- **Live validation** with two real agents under actual load (the one thing code
  can't replace) — tune `DEAD_MS` / TTLs from what's observed. *(Done twice — see
  `LIVE-TEST.md`: 2026-06-02 locks + push handoff; 2026-06-09 cooperation tier.)*
- PID-reuse liveness guard (deferred, see §9).
- Possible: per-line granularity, shared-lease serial-list, auth boundary (only
  if this stops being a single-user machine).
- See [`FUTURE.md`](./FUTURE.md) for the post-macOS-expansion roadmap.

**macOS expansion (built):** verified + tuned for macOS (worktree symlink vs the
Windows junction; platform-aware path test); a SwiftBar/xbar **menu-bar fleet**
(`cli/macos-menubar.mjs`), **native desktop notifications** on block/message/yield
(`lib/notify.mjs`), a **shell-write guard** so `sed -i`/`>`/`tee`/`cp`/`mv` don't
bypass the file lock (`lib/bash-targets.mjs`, later unified with the Windows-side
PowerShell detection), and the **self-learning** digest + hotspot warnings +
`query_history` (§12).

Build log: `6c3742e` (Tier 0–1 global), `d54f076` (dashboard), `503ecd2` (worktree +
subagent + hardening); macOS port + expansion `36b587d`…`f390922` (public main);
cooperation tier + reconciliation 2026-06-09 (this repo).

---

## 12. Memory integration & self-learning (honest)

The compounding loop: **act → record → distill → inform → act.**
- **act** — agents edit / claim / deploy.
- **record** — every action already lands in `activity_log`, a durable,
  never-pruned timeline of who touched what, where, and where conflicts happened.
- **distill** — `cli/insights.mjs` turns that log into signal on demand (read-only,
  stdout). Flagship: files edited by **2+ distinct agents** — the
  duplicated/contradictory-work failure the lock structurally can't catch (leases
  block only *concurrent* holders; serial same-file work leaves no conflict).
- **inform** — distilled patterns become durable memory (Obsidian notes) the next
  session reads, and the global `CLAUDE.md` behaviour that shapes how agents act.

**"Self-learning" here is deterministic distillation — NOT ML / embeddings / RAG.**
Accumulate structured observations → periodically summarize the durable ones into
memory the next agent reads. That is the whole mechanism; anything fancier is hype.

**Build order (gated on the still-pending two-agent live test):**
- NOW: `cli/insights.mjs`. If its output is boring, the lane stops here — cheaply.
- LATER (only once insights proves there's signal): a `digest` that writes scoped
  per-project memory notes (high threshold, update-not-duplicate); hotspot warnings
  surfaced in `claim_files`; a `query_history` MCP tool; SessionStart-throttled run.
- CUT: a model-curated "summarize my work" auto-note writer — it pollutes the
  hand-curated vault that models Marko; and scheduling a writer before it's proven.

**Privacy (hard rules — the store is single-user but mixes clients):**
- Distill reads **only** `activity_log` — **never** `agents.current_task` (verbatim
  client prompt text lives there).
- One global store aggregates multiple client repos → any vault write MUST scope
  strictly by `workspace_id`; never emit one project's paths into another's note.
- `activity_log.detail` can hold cross-repo / out-of-root absolute paths →
  quarantine them as their own bucket, never force-merge across projects.

---

## 13. Validation

**Live two-agent test passed (2026-06-02)** with real `claude -p` agents — see
[`LIVE-TEST.md`](./LIVE-TEST.md). Pillar 1 (a real agent was blocked from editing a
held file) and Pillar 2 (a real agent autonomously decided + pushed another agent's
finished commit via `pending_push_review`, without asking the human) both held.
Plus ~12 deterministic tests (`test/`, run isolated via `AGENT_COORD_HOME`) and the
9-point `cli/doctor.mjs`.
