# Changelog

Notable changes to `agent-coord`. Dates are when the work landed; this is a
single-user tool with trunk-based history, so entries map to themes, not semver.

## Recent — single trunk; machine-local wiring untracked

This repo's `main` is now the one trunk both dev machines work on (the old
private-history branch is archived locally, never pushed). `.claude/` is no
longer tracked: it held one machine's Hermes auto-sync session hooks, which are
per-machine wiring — and in a public repo, every cloner was inheriting them.
**If you had those hooks via this repo: after pulling, re-run
`hermes hook install` once — the file it writes is now gitignored, so your
sync keeps working but stays local.**

## Recent — cooperation tier (from collision-avoidance to actual teamwork)

Built on Windows in parallel with the macOS expansion below, then reconciled
(see the cross-machine note at the end of this entry). Every coordination loop
used to be half-closed: a blocked agent re-polled blindly, a finished dependency
notified nobody, a new agent arrived blind. This tier closes them — all
additive, no schema-version bump, live fleet undisrupted.

**Blocked-file notifications.** An exit-2 block already enqueued a waiter;
nothing drained it. Now, when the file frees (holder released / went cold /
died — evaluated lazily, no event source needed) the waiter hears
`✅ "<path>" is free now` once, through the same mid-turn channel as peer
messages. Granting a claim consumes your own waiter row. Shell-write blocks
enqueue too, so they get the same notification. `+ test/waiter-notify.mjs`.

**Task handoff — the board becomes a pipeline.** `update_task(done)` takes a
`summary` (what was built, where, gotchas); owners of dependent tasks receive it
as a directed message the moment they unblock, and `claim_task` /
`claim_next_task` return completed-dependency summaries as `handoff`, so
downstream work starts informed instead of blind. `+ test/handoff.mjs`.

**`claim_next_task` + priority — a self-scheduling work pool.** Atomically pulls
the highest-priority READY task (deps done, not held by a live peer, dead-owner
reclaim included). Seed a board, point idle agents at it, they drain it.

**Decision log.** The one root-cause failure nothing caught: two agents making
*contradictory architectural choices in different files* (locks see same-file
edits, overlap sees same-task text; neither sees "JWT here, sessions there").
`record_decision(topic, decision)` is workspace-scoped, latest-per-topic,
broadcast to the room (heard mid-turn) and shown to every arriving agent.
`list_decisions` to consult. `+ test/decisions.mjs`.

**Session-start room brief.** SessionStart stdout lands in context, so an
arriving agent is briefed for free — live peers + their tasks, board state,
standing decisions, waiting mail — without remembering to call any tool. Silent
when there's nothing to say. Prompt-time delivery now uses the same channel as
mid-turn (freed files + overlap advisories arrive at prompts too).

**Fix: PowerShell tool bypassed the guards (Windows).** Found by dogfooding: the
bash-guard matcher was `Bash` only, so commands run through Claude Code's
PowerShell tool never claimed resources or stamped the committer marker — an
agent's own PowerShell `git commit` was blocked as a "cross-agent" conflict.
Matchers are now `Bash|PowerShell` (the installer migrates existing groups in
place), and `guard.mjs --post` rides shell calls too, so an agent deep in a
test/build loop still hears peers mid-turn.

**Live-validated** with two real `claude -p` agents (see `docs/LIVE-TEST.md`):
room brief quoted verbatim, block → pivot → freed-notification → retry in 44 s,
and the dependency summary used to wire the downstream file correctly.

**Cross-machine reconciliation note.** This tier and the macOS expansion were
built concurrently on two machines, and both independently closed the
shell-write gap — a textbook duplicate-work case the tool itself would have
caught *within* one machine. The detectors were unified into
`lib/bash-targets.mjs` (the tokenizer architecture, extended with PowerShell
cmdlets `Set-Content`/`Add-Content`/`Out-File`, `$null`/`nul` sink rejection,
unexpandable-variable rejection, and cwd-relative target resolution).
MCP tools now 24; suite 25 files, green on Windows 11 + macOS.

## 1.0.1 — resume identity reconciliation (no more ghost twins)

Root-cause fix for the split this session surfaced: the MCP server resolved its
identity once at startup and, if it lost the SessionStart race or the session
**resumed**, ran forever under a standalone id while the hooks kept the original —
a "ghost twin" that split locks/messages and made `pending_push_review` read a
self-commit as a live peer's. Two parts: (1) the SessionStart hook now writes the
claude.exe→id link for the freshly-resolved *current* pid as well as the cached one
(the cache pointed at the pre-resume pid, orphaning the resumed session's new MCP
server); (2) `lib/server-identity.mjs` lets the server **late-adopt** that link on
its next tool call — before any claim, so the throwaway id never accrues state —
tearing down the dead twin. Gated to `claude-code` like the startup adoption (Codex
never adopts). `+ test/server-identity.mjs`; suite 22/22, `doctor` 9/9. A precursor
patch in `lib/pending-push.mjs` also bridges the same split (treats the
session-linked hook id for our parent pid as ours) so a self-commit isn't read as a
live peer's even before the server reconciles.

## 1.0.0 — stable cut: live snapshot + VS Code fleet view

First version tagged stable (`v1.0.0`), after a full pass over presence,
self-healing leases, the git commit net, messaging, overlap/duplicate-work
detection, and self-learning insights — `doctor` 9/9, suite green.

**Live snapshot (`lib/snapshot.mjs`).** A plain-JSON mirror of the whole fleet at
`~/.agent-coord/snapshot.json`, written atomically (temp+rename) by the Claude
statusline every tick — so it's fresh whenever any agent is live — and refreshed
by `cli/state-json.mjs`. It stamps `generatedAt` and the clone `root`. The point:
external consumers no longer need to open SQLite or find a `node>=22` on PATH
(fnm's node lives at an ephemeral per-shell path a GUI editor can't see).

**VS Code Fleet view, robust + zero-config.** The Activity-Bar panel now reads the
snapshot file directly (no subprocess, no `node:sqlite`, no configured path),
falling back to a live `state-json.mjs` read — rooted from the snapshot — only
when the file is stale. The view gained per-agent heartbeat age, every file +
resource claim (click a file chip to open it), the shared task board, and a live
"updated Ns ago". macOS install documented (the old README was Windows-only).

**Test suite no longer spams real macOS notifications.** `test/bash-guard-block.mjs`
ran the real Bash guard whose block path calls `notify()`; isolating the store via
`AGENT_COORD_HOME` doesn't isolate the OS notification layer, so running the suite
popped a live "blocked (shell)" banner. The spawned guard now opts out with
`AGENT_COORD_NOTIFY=0` (assertions unchanged). `overlap-flow.mjs` only notifies on
messages, of which it posts none, so it was already clean.

## Recent — self-learning (digest, hotspot warnings, query_history)

The gated SYSTEM.md §12 step, now that insights proved real signal. The retro
analysis moved into a shared `lib/insights.mjs` (collision hotspots + path
history), reused four ways: (1) `cli/insights.mjs` (unchanged terminal output);
(2) `cli/digest.mjs` writes a DURABLE per-project hotspot record — one regenerated
markdown file per project in `~/.agent-coord/digests/`, deliberately NOT the
hand-curated vault or your client repos, high-threshold (`--min-agents`,
update-not-duplicate); (3) a just-in-time `hotspot` warning on `claim_files` when
you grab a file 2+ agents have edited recently; (4) a new `query_history` MCP tool
— who touched a file (exact) or directory (prefix) lately, the distinct agents and
events the lock wouldn't show. `+ test/insights.mjs`; suite 21/21; 21 MCP tools.

## Recent — macOS expansion (menu bar, notifications, shell-write guard)

**Menu-bar fleet (SwiftBar/xbar).** The Mac-native counterpart to the VS Code
Fleet panel: a read-only renderer (`cli/macos-menubar.mjs`) prints the live fleet
in menu-bar format — agent count (🟢/🔴/⚠️), agents grouped by repo with the file
each holds, contended files, resource leases, task-board count, dashboard link.
`cli/install-macos-menubar.mjs` generates a bash stub that resolves node from the
fnm default alias / Homebrew (GUI apps get a minimal PATH) and installs it into the
SwiftBar/xbar plugin folder if present. `setup.mjs` runs it on macOS.

**Native desktop notifications.** Reach the heads-down *human* with what the layer
already tells heads-down *agents*: `lib/notify.mjs` fires macOS banners (terminal-
notifier if present, else osascript) when you're blocked on a file, a peer messages
you, or asks you to yield. Non-blocking (detached) and fail-safe so it can never
delay a hook; same-key alerts deduped within a 30s file-backed throttle. On by
default on macOS (`AGENT_COORD_NOTIFY=0` mutes). `+ test/notify.mjs`.

**Shell-write guard.** Closes the documented gap where `sed -i`, `>`/`>>`, `tee`,
`cp`/`mv`, `touch` mutate a repo file without going through Write/Edit. A quote-aware
tokenizer (`lib/bash-targets.mjs`) extracts the files a Bash command would write —
biased to false negatives, ignoring quoted `>`, file descriptors, `/dev/*`, and
out-of-repo paths — and the Bash guard claims each, blocking only on a warm live
peer (same self-healing guarantee as a normal edit). `+ test/bash-targets.mjs,
test/bash-guard-block.mjs`.

## Recent — verified + tuned for macOS

Installed and proven on **macOS (Apple Silicon, Node 24)** via the cross-platform
`node setup.mjs` path: `doctor` 9/9, full suite 17/17, and a live fleet of
concurrent Claude sessions with real-commit provenance logging. Two runtime spots
were Windows-only and now branch on `process.platform` — **Windows behaviour is
unchanged**:
- `cli/worktree.mjs` linked a worktree's `node_modules` with `cmd /c mklink /J`
  (a Windows junction) — on macOS/Linux it now makes a directory **symlink** (same
  "no multi-GB reinstall" effect), and prints `export PORT=` (zsh/bash) instead of
  the PowerShell `$env:PORT=` hint.
- `test/path-aliasing.mjs` fed Windows drive-letter/backslash spellings that are
  meaningless on POSIX — the §7.2 collapse-to-one-key test is now platform-aware
  (Windows spellings on win32, POSIX spellings elsewhere).

Identity unification confirmed on macOS: the `claude` process reports `comm=claude`,
so the `ps`-based `proc-ancestry` (no `/proc`) resolves it — no ghost twins.

## Recent — shared task board

A structural answer to duplicate work, complementing the text-similarity overlap
detection: agents `claim_task` discrete units of work (atomic claim — exactly one
winner under a race, like file leases), so a peer *sees* a task is taken rather
than inferring it. Workspace-scoped board with title dedup, dead-owner
auto-reclaim, and a `depends_on` list that marks tasks blocked/ready. New MCP
tools `list_tasks` / `claim_task` / `update_task`, a `cli/tasks.mjs` viewer, and
tasks surfaced in `get_global_state`. Shipped **without a schema-version bump**
(additive table, never read by older code) so the live fleet isn't disrupted.
`+ test/tasks.mjs`.

## Recent — coordination quality + portability

**Self-healing file locks (warm/cold).** A lease used to block for its full TTL as
long as the holder's *session* was alive — so a file edited once stayed locked for
the session and the only escape (force-release) bubbled up to the human. Now a
lease blocks only while **warm** (the holder edited that exact file within
`FILE_ACTIVE_MS`, default 5 min); past that it goes **cold** and a waiting agent
takes the file automatically, sweeping the stale lease. Same gate in conflict
checks and the pre-commit net. The block message states when it auto-frees and
steers to "edit elsewhere / message the peer," never "force-release / ask the
human." `+ test/cold-lease.mjs`.

**One identity per session (hook + MCP unified).** The stdio MCP server minted a
random identity, so every Claude session showed up as *two* agents — a hook-self
that held the locks and a random MCP-self that sent the messages. That doubled the
fleet, broke own-commit recognition in `pending_push_review`, and echoed an agent's
own broadcasts back to it. Bridged on the `claude.exe` both processes share
(`proc-ancestry.mjs` walks the tree, `session-link.mjs` publishes `pid → agentId`,
the MCP server adopts it). Fails safe to standalone, so Codex is unaffected.
`+ test/session-link.mjs`.

**Mid-turn message delivery.** Peer messages were injected only at
`UserPromptSubmit`, so an agent building a feature in one long turn never heard
them. Now also delivered between tool calls via `PostToolUse` `additionalContext`
(non-blocking; not a forced `allow`, so it can never bypass a permission prompt).

**Duplicate-work de-confliction.** Two agents on one vague prompt would build the
same thing. A cheap task-similarity heuristic (`overlap.mjs`, Jaccard over tokens
— not ML) flags overlap; `announce_intent` warns the later starter; the
deterministic tiebreaker is the earlier `registered_at`; the later starter is
advised mid-turn, then hard-blocked by its own guard if it keeps duplicating
(escape hatch: announce a distinct lane). New `request_yield` MCP tool asks a peer
to stand down instead of fighting locks. `+ test/overlap.mjs, test/overlap-flow.mjs`.

**Statusline self-identity.** The statusline showed only peers; it now leads with
*this* terminal's own id and its live subagents (`◆ <id> ⤷ sub-a, sub-b`), so a
glance maps each terminal to its agent.

**Portability.** Every script derives the repo root from its own location — install
from any clone path. Added cross-platform `node setup.mjs` (Windows/macOS/Linux)
alongside `setup.ps1`. `AGENTS.md` runbook lets a coding agent install it
autonomously.

## Earlier milestones

- **Auto-push when clear** — `pending_push_review` returns `allClear` when every
  unpushed commit is push-safe; agents push without asking. Deploy-keyword
  false-positive in the Bash guard fixed.
- **Commit provenance + autonomous pre-push decision** — a post-commit hook logs
  who authored each commit; agents map unpushed commits to author + live status +
  a verdict. Live ask/reply between concurrent agents.
- **Workspace-scoped agent-to-agent messaging** — a mailbox on top of presence
  (broadcast + directed, read-once, project-isolated).
- **`cli/insights.mjs`** — retro: files edited by 2+ distinct agents + conflicts.
- **VS Code "Agent Fleet" extension** — Activity Bar panel reading the live store.
- **Tier 2** — live browser dashboard; git-worktree isolation; subagent identity.
- **Tier 0–1 (global)** — SQLite WAL store, file/resource leases, Claude
  `PreToolUse` hard-block, **global** git pre-commit net across all repos, MCP
  server in Claude + Codex, reaper, `doctor`/`status`/`watch`, `setup.ps1`.

See `docs/SYSTEM.md` §9 for the design decisions behind these, and `DESIGN.md`
for the original architecture.
