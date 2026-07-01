# Changelog

Notable changes to `agent-coord`. Dates are when the work landed; this is a
single-user tool with trunk-based history, so entries map to themes, not semver.

## v1.5.1 — review fixes for the v1.5.0 caps

A by-the-book self-review of v1.5.0 (8 finder angles, adversarial verify) found
one real regression and three design warts. All fixed:

- **The `get_global_state` cap broke human-facing surfaces.** `getGlobalState()`
  also feeds the macOS menubar, the browser dashboard, `snapshot.json` → the
  VS Code fleet view, and `state-json` — all of which derive counts and the
  lease-contention badge from list lengths and none of which render the `note`.
  With >50 live leases a real two-agent collision could vanish from the menu
  bar. The cap is now **opt-in** (`getGlobalState(db, { cap })`) and applied
  only in the MCP handler; default callers get complete lists again. The capped
  variant now also caps `resourceLeases` (was inconsistently unbounded).
- **A directed message could wait behind broadcasts, silently.** Delivery is
  FIFO (the read pointer is a seq watermark), so a `request_yield` or ask
  behind ≥15 older broadcasts wasn't injected OR desktop-bannered that event.
  `readMessages` now reports `remainingDirected`; mid-turn delivery flags
  "addressed directly to YOU — read_messages now" and fires the banner the
  moment such a message exists.
- **`readMessages` owns its truncation math.** It returns
  `{ messages, remaining, remainingDirected }` computed in the same transaction
  on one shared `UNREAD_WHERE` predicate (also reused by `unreadCount`), with
  the fetch pushed to SQL (`LIMIT ?+1`). The two call sites' fragile
  `length === cap` + twin-query reconstruction is gone.
- **Room-brief mail line no longer steers Claude into a redundant call** — the
  wording now leads with "they reach you automatically if you're hook-wired"
  and offers `read_messages` as the pull fallback.
- New `test/global-state-cap.mjs` (default complete + conflict pair visible;
  capped clips every list and names each in `note`); capped-read test now
  asserts exact `remaining` and the directed-remainder flag. 32 tests.

## v1.5.0 — context-budget diet + one-call check-in

The coordination layer writes INTO model context (hook stdout, MCP results), so
its own chattiness is a token cost paid by every agent on the machine. This
release makes arrival cheaper and delivery bounded — awareness for fewer tokens.

- **A solo agent now learns its own name for free.** The room brief used to stay
  silent when you were alone with an empty board — so a solo agent never saw
  "you are badger" and spent tool calls (`whoami` + schema load) to find out.
  The brief now always opens with the identity line; the solo case is exactly
  one line.
- **`announce_intent` is the whole check-in.** Its response now carries `brief`
  — identity, live peers + tasks, the board, standing decisions, unread count —
  alongside the existing `overlaps`/`warning`. One call replaces the
  `whoami` → `list_active_agents` → `list_tasks` round. Biggest win for
  **hookless agents (Codex)**: they get no SessionStart brief, so announce is
  their only arrival-awareness channel — Claude and Codex now arrive equally
  informed.
- **Bounded, lossless message delivery.** `read_messages` returns at most 30
  per call and mid-turn/prompt-time injection at most 15 per event — but the
  read pointer only advances past what was actually returned, so a day's
  backlog drains across calls in order, nothing skipped, nothing redelivered.
  Truncation is always announced (`remaining` + a note), never silent.
- **`get_global_state` capped.** Leases/queue/tasks lists return the 50 newest
  rows each, with an explicit `note` when clipped pointing at the scoped tools
  (`check_conflicts`, `list_tasks`).
- New coverage: capped batch reads drain losslessly in order (`test/messages.mjs`),
  announce carries the brief end-to-end over a real MCP client (`test/mcp-smoke.mjs`),
  solo brief is identity-only (`test/decisions.mjs`). Caps live in `lib/config.mjs`
  (`MSG_READ_MAX`, `MSG_DELIVER_MAX`, `STATE_LIST_MAX`).

## v1.4.0 — cross-project issue log ("come back later and fix it")

A durable, machine-wide backlog of problems worth fixing later — the gap every
other table left open. Messages, decisions, and tasks are workspace-scoped and
short-lived (built for agents coordinating *now*, then GC'd); none of them catch
"an agent hit a real bug / friction / broken build it shouldn't derail the current
task to fix, and it evaporated." The next "fix this" then starts from zero context.

- **`report_issue` (MCP, any repo).** An agent files a problem with one call —
  `title` required; optional `body` (repro + error + what was tried), `severity`
  (low|medium|high|critical), `kind` (bug|friction|build|coordination|perf|docs),
  `area`. Auto-tagged with the project, agent, branch, and time. It's a backlog,
  not a broadcast — it doesn't ride the 📬 channel and doesn't ask you to fix it now.
- **`list_issues` / `resolve_issue` (MCP)** and **`cli/issues.mjs`** (the operator's
  survey-and-close face). The MCP `list_issues` is **workspace-scoped** like every
  other agent-facing tool — one repo's agent shouldn't read another client's backlog.
  The **cross-project survey is the operator's CLI**: `cli/issues.mjs` lists the whole
  machine's backlog **global by default** (grouped by repo) — the bird's-eye view that
  makes "check the logs" work from one place — with `--here` to scope, `<id>` for full
  context, `--add`/`--resolve`/`--reopen`, and `--export`. Resolving records a
  `resolution` (the how-fixed note the next session reads when the same thing recurs).
  Grouping/export key on `workspace_id`, so two repos sharing a folder name stay
  distinct instead of merging or clobbering each other's export file.
- **Wired into the existing substrate:** indexed into the FTS5 `search` table
  (room-scoped, so an agent's search can't surface another project's issue) — with
  a warm-store catch-up backfill, since `issues` is the first kind added to an index
  that already exists on the live store (the one-shot cold backfill would skip it).
  This repo's open-issue count is surfaced in the session brief.
- **Durable + safe:** never auto-expires (unlike the coordination tables); markdown
  export lands in `~/.agent-coord/issues/` (mirrors `digests/`) — *outside* any
  repo, so the public GitHub remote can't leak client context. Additive table, **no
  `SCHEMA_VERSION` bump**, so live v2 MCP servers don't trip the degraded flag.
- Machine-local for v1 (like the whole system); cross-device sync (carry
  `~/.agent-coord/issues/` over hermes) is the documented next step.
- `test/issues.mjs` (22 checks: report/scope/severity-order/resolve-reopen/wontfix/
  stats/proto-key-severity/basename-collision grouping+export/warm-path room-scoped
  FTS — the test runs the warm index path so a missed-index regression can't hide).
  Suite 30→31, all green; `doctor` 9/9; 25→28 MCP tools.

## v1.3.2 — field-report fixes: identity anchor, sender liveness, deploy scope

Three problems from a live Athena session (`docs/OBSERVED-BUGS-2026-06-18.md`):

- **Identity split (HIGH, correctness).** `whoami` reported one name while the
  hooks recorded this session's file leases and commits under another — the
  session couldn't trust its own identity and nearly coordinated with itself.
  Root cause: the stdio MCP server read the `claude.exe → id` session-link under
  its **raw `process.ppid`**, but the hooks key that link on the `claude.exe`
  they walk *up* to (`findClaudePid`). With any wrapper between `claude.exe` and
  the server (an `npx`/`.cmd` shim, a shell), the keys disagreed, so the server
  missed the link and minted a random "ghost twin" — permanently, since the
  reconcile path read the same wrong pid. **Fix:** the server now resolves the
  same anchor the hooks do and reads the link under **both** the walked-up
  `claude.exe` pid and the raw ppid (`readSessionLinkAny`/`pollSessionLinkAny`,
  preferring the claude anchor). `pending_push_review` shared the bug and the
  fix (own-commit recognition now also matches the whole session *family* by
  base). Defense-in-depth: `whoami` now returns a loud `warning` when a
  claude-code server never linked to its hooks (the ghost-twin signature),
  instead of silently reporting a name nothing else agrees with.
  **So it can't recur:** the anchor logic is centralized in one resolver,
  `sessionAnchorPids()` (the documented identity invariant — claude.exe first,
  raw ppid only as fallback, never the raw ppid alone), and every non-hook
  identity reader routes through it — the MCP server, `pending_push_review`, AND
  the `cli/pending-push.mjs` CLI (which had the same blind spot: its raw ppid is
  the shell that launched it, so it couldn't recognize its own session's commits).

- **Phantom peers (MEDIUM).** `read_messages` returned a multi-hour backlog with
  no liveness, so a since-exited author read as a live teammate (one plan handed
  a prod deploy to an agent that was already gone). **Fix:** every message now
  carries `from_live`; the mid-turn channel tags exited senders inline; an agent
  counts as present if its exact id *or* its parent session (same base) is live.
  `read_messages` adds a `note` naming any senders who've exited.

- **Deploy lock too broad (MEDIUM).** (A) `deploy:primary` was a single global
  key, so one repo's deploy serialized an unrelated repo's work — it's now keyed
  to the **workspace** (`deploy:<ws>`); a real OS singleton (a TCP port) stays
  machine-wide. A genuinely shared host can still be claimed explicitly via
  `claim_resource`. (B) the deploy heuristic matched the bare word "deploy"
  anywhere, so a read-only `gh run watch <id>` / `gh run list --workflow
  deploy.yml` referencing a deploy workflow was blocked as a deploy mutation —
  it now matches deploy as an **action** (a package script, a deploy-CLI
  subcommand, or a script executed in command position), never as an argument.

`+` expanded `test/{resource-keyword,bash-guard-block,server-identity,
session-link,messages}.mjs` (anchor resolution, multi-candidate adoption, the
unlinked-warns self-check, sender liveness, deploy observer/scope); 30/30 pass.
Test harness hardened so a Windows temp-cleanup race (`rmSync` vs a just-exited
SQLite handle) can't mask a green suite. The identity invariant is documented in
`docs/SYSTEM.md` §8 and at `sessionAnchorPids`. No schema change; no re-install
needed (the MCP server picks up the fix on its next spawn).

## v1.3.1 — fan-out identity unification (no more ghost-twin subagents)

**The bug:** an orchestrator that fans out many subagents at once could split
into TWO coordination identities. A subagent's hook payload does not reliably
carry the parent's `session_id`, so `agentIdFromSession` claimed a *separate*
codename for the whole fan-out — parent `horse`, subagents `goat/…` — and the
one session looked like two competing ones. The duplicate-work guard then stood
subagents down against their own siblings (`overlapHardBlock` -> `exit 2`),
leaving fan-out work half-done.

**The fix, two parts:**
- **Pin the subagent base to the parent.** New `parentBaseFromProc()`
  (`session-link.mjs`) resolves the parent's claimed name the same way the MCP
  server avoids its ghost twin: walk up to the `claude.exe` that parents the
  hook and read the link `SessionStart` published. `resolveAgentId(input,
  {parentBase})` uses it, so a subagent is always `<parent>/type-tag` even when
  its `session_id` differs. Falls back to the `session_id` hash when no link is
  resolvable (no regression for Codex / no-hooks). Wired into all three hooks
  (`session`, `guard`, `bash-guard`).
- **Never flag your own family.** `findOverlappingPeers` now skips agents that
  share my base (`baseAgentId`): a parent and its subagents are one fleet
  running the umbrella task, which is collaboration, not duplicate work.
  Cross-session peers (different base) still flag normally.

Sibling-vs-sibling *file* leasing is unchanged (two subagents editing the same
file still serialize, by design). `+ test/subagent-fanout.mjs`; 30/30 pass.
Known remaining nuance: the stdio MCP server still attributes every subagent's
*tool* call to the one server identity (it can't see which subagent called) —
separate from this hook-path fix.

## v1.3.0 — searchable coordination memory; failure-path delivery

**`search` (25th MCP tool + `cli/search.mjs`):** full-text search over the
room's accumulated memory — peer messages, recorded decisions, and board tasks
— so "has this been discussed / decided / built already?" is one plain-language
query with «highlighted» snippets, best match first, instead of paging
chronological dumps. One FTS5 virtual table (`search_index`) indexes all three
kinds; SQLite **triggers** keep it in sync with zero changes to the write paths
(so even older long-running processes' writes are indexed), a one-time backfill
covers everything the store already holds, and global broadcasts stay
searchable from every room. Queries are quoted term-by-term (AND semantics) so
natural punctuation can't hit MATCH syntax errors. No FTS5 in the SQLite build?
Everything degrades to a LIKE scan — same shape, no ranking, never blocks.
activity_log is deliberately not indexed (high-volume/low-text;
`query_history` serves it). `+ lib/search.mjs`, `cli/search.mjs`,
`test/search.mjs`.

**Failures deliver too (`PostToolUseFailure`):** mid-turn delivery + heartbeat
now also ride tool *failures* — the agent stuck retrying a broken build is
exactly the one that must stay visible to the fleet and hear a peer's "stop, I
broke that". Same `guard.mjs --post`, event-aware (a failed edit isn't logged
as an edit). Re-run `node setup.mjs` (or the installer) to register the hook.

**Positioning:** README gains a "How it compares" section — the honest map of
the field (isolation tools, advisory-lease tools) and where enforced
shared-tree coordination sits. Research-backed: nobody else combines hook-level
blocking + machine-wide resource locks + git chokepoints.

## v1.3.0 also — duplicate-work guard fixed for resumed sessions; MCP instructions

Field report from a live agent (gilt-hawk): a RESUMED session inherits the
synthetic prompt "Continue where you left off" as its task text, Jaccard-matches
any peer with an equally generic task, escalates to a stand-down — and the
stand-down blocked Edit calls even OUTSIDE the repo; re-announcing a distinct
sub-task never cleared it. Three root causes, three fixes: (1) **intents beat
prompts** — `announce_intent` now writes an `intent` column (additive ALTER, no
schema bump) that overlap detection prefers over `current_task`, so the next
UserPromptSubmit can't clobber a deliberately differentiated lane; resume
boilerplate is also no longer captured as a task at all. (2) **announce really
clears** — `announce_intent` resets the escalation counter directly (if the new
lane still overlaps, advisories resume and re-escalate on their own). (3)
**stand-downs are repo-scoped** — the hard-block now applies only to files
inside the workspace repo (`isRepoRelative`), never to a memory dir or another
tree. + regression checks in `test/overlap-flow.mjs` / `test/path-aliasing.mjs`.

Token hygiene: the MCP server now ships an `instructions` field — under
client-side tool-schema deferral (Claude Code's tool search, on by default)
it's the only server text that stays in every session's context, so it carries
the whole protocol in miniature. Server version string synced to the package.

## v1.2.0 — simple, speakable agent names

Agent IDs are now a single common word: `cedar-bison-5003` → `fox`. The
operator often addresses agents through voice transcription, and
`umber-shrike-7421` survives neither a microphone nor a memory. Names come
from a pool of 64 easy-to-say animals; since a small pool makes pure-hash
collisions likely (and a collision silently merges two sessions' locks), a
name is now **claimed, not hashed**: the session's first hook claims a free
name under `~/.agent-coord/names/` (deterministic starting point + linear
probe, create-exclusive so two sessions can't win the same name), every later
hook resolves the same claim, and a name recycles after ~24 h of silence. If
the names dir is unreachable the old behavior remains as the fail-open
fallback: a deterministic hash pick, collision-possible but never blocking.
The numeric suffix is gone for good — every display surface was already
stripping it with a local `short()` helper, so the ID now IS the display name
and all nine `short()` shims are deleted. One-time effect on upgrade: **every
agent is renamed**, so a live session's pre-upgrade locks read as another
agent's until they go cold and self-release (~minutes). Self-healing.

## v1.1.0 — open-source release readiness

The repo is now a proper public open-source project, not just a public repo:
MIT `LICENSE`; CI running the full suite on Windows/macOS/Linux × Node 22/24
on every push and PR; `npm test` via a new `test/run-all.mjs` runner (every
non-underscore test, each in its own throwaway store); `CONTRIBUTING.md`
(zero-dependency rule, fail-open invariant, test expectations); `SECURITY.md`
(single-user threat model + private vulnerability reporting); issue and PR
templates; README badges + a dashboard screenshot (seeded demo fleet) and a
social-preview card under `docs/assets/`. Operator-specific names in the
public docs genericized.

## Recent — messaging is machine-local by design; quieter banners

Boundary made explicit after an agent assumed otherwise: the store is one
SQLite file per machine, so `post_message` — even `scope:'global'` — reaches
only agents on **this** device. Cross-DEVICE messaging is a different tool's
job (Athena Workspaces' `hermes msg`, hub-routed notes + dispatchable tasks);
docs now say so. Desktop banners fire only for messages **directed to a
specific agent** — a broadcast is delivered once per receiving agent, so
bannering all of them turned one post into N alerts. And `test/messages.mjs`
now self-isolates its store like every other test: global broadcasts in the
live store deliver to every workspace, so an un-isolated run inherited
whatever real agents posted that day.

## Recent — public-remote WIP guard (pre-push)

New universal-chokepoint net, same philosophy as the pre-commit guard: a global
**pre-push hook** blocks `wip/*` snapshot branches — the carrier some
machine-sync tooling force-pushes with your UNCOMMITTED work — from landing on
a **public** GitHub remote, no matter which tool pushes. Observed live before
the fix: two dirty-tree snapshots auto-pushed to this very repo. Visibility
oracle = an unauthenticated GitHub API probe (200 ⇒ public by definition),
disk-cached 7d; non-wip pushes never touch the network. Deleting a `wip/*` ref
stays allowed (cleanup must always work), unknown visibility fails open-but-loud,
`AGENT_COORD_ALLOW_PUBLIC_WIP=1` is the deliberate escape hatch, and a
repo-local pre-push still chains. `+ lib/public-remote.mjs`,
`cli/prepush-check.mjs`, `test/prepush-guard.mjs`; re-run the installer
(`node setup.mjs`) to get the hook.

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
