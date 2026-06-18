# agent-coord — observed bugs (2026-06-18)

> **Status: all three fixed in v1.3.2** (2026-06-19). See per-bug **Resolution**
> notes below and the CHANGELOG. Regression tests: `test/{resource-keyword,
> bash-guard-block,server-identity,session-link,messages}.mjs`; 30/30 pass.

Field report from a live Athena session. Three real problems caused wrong decisions;
one is a correctness bug (identity), two are UX/scoping bugs that produced bad
hand-off plans and a false block. Evidence is from `whoami`, `get_global_state`,
`list_active_agents`, `read_messages`, and the bash-guard, captured the same session.

---

## BUG 1 — Inconsistent self-identity (HIGH, correctness)

**Symptom:** the agent_id reported to a session by the MCP tools does NOT match the
agent_id its own actions are recorded under.

**Evidence (one session, same moment):**
- `whoami` → `{"agentId":"puma", ...}`
- `announce_intent(...)` → `{"ok":true,"agentId":"puma", ...}`
- `get_global_state` at the same time shows **every file I claimed/edited held by
  `otter`** — `agentheartbeat.php`, `agentcontroller.php`, `withsettingsoverlay.php`,
  `control-brain.blade.php`, `agentstateapitest.php`, `agentcontrolcentertest.php`,
  `hermes/src/agent/runtime.mjs`, `hermes/test/agent-runtime.test.mjs`, and my project
  memory note — and the `recent` log shows **`otter` committing the exact commits I
  made** (`487078d8`, `14edcc95`) and carrying **my current prompt** as `current_task`.

**Impact:** the session cannot trust its own identity. I addressed coordination
messages "to otter" believing otter was a peer, when otter was almost certainly *this
same session*. I nearly coordinated with myself and split one task across a phantom
"split." The human operator sees the session as `otter` in the statusline while the
tools tell the agent it is `puma`, so every self-reference the agent makes is wrong.

**Likely root cause (hypothesis):** two id-resolution paths that don't share state —
the MCP tool path (`whoami`/`announce_intent`) derives/returns one id, while the
hook path (PreToolUse file-claim + the commit recorder) writes leases/activity under a
different id. Either a per-invocation name is generated instead of a persisted
session name, or the session→id mapping is keyed differently in the two paths.

**Suggested fix:** make agent_id a single source of truth keyed by the session/process
(or the Claude/Codex session id), resolved identically in the MCP server and the hooks.
`whoami` must return the SAME id that file leases and commits are recorded under. Add a
self-check: if `whoami` ≠ the id on this session's most recent lease, surface a warning.

**Resolution (v1.3.2):** root cause was asymmetric anchor resolution. The hooks key
the `claude.exe → id` session-link on the persistent `claude.exe` they walk UP to
(`findClaudePid`); the MCP server read it under its **raw `process.ppid`**, which is
NOT `claude.exe` when a wrapper (`npx`/`.cmd` shim, a shell) sits between them — so it
missed the link, minted a random standalone id, and never recovered (reconcile read the
same wrong pid). Now the server resolves the *same* anchor the hooks do and reads the
link under BOTH the walked-up `claude.exe` pid and the raw ppid, preferring the claude
anchor (`readSessionLinkAny`/`pollSessionLinkAny` in `lib/session-link.mjs`;
`anchorPids` in `mcp/server.mjs`; `ppids` in `reconcileServerIdentity`). The identical
flaw in `pending_push_review` (own-commit recognition) is fixed the same way, plus it
now recognizes the whole session *family* (shared base). Defense-in-depth: `whoami`
returns a loud `warning` when a claude-code server is still unlinked — the exact
ghost-twin signature — so a future divergence is visible, never silent.

**So it can't recur:** the candidate-pid logic is centralized in ONE resolver,
`sessionAnchorPids()` (carrying the identity invariant in its doc comment — *resolve
the session-link under the walked-up claude.exe, never a raw `process.ppid`*). Every
non-hook identity reader routes through it, so a future caller can't hand-roll
`process.ppid` and silently reintroduce the asymmetry. A third site surfaced during
the sweep — `cli/pending-push.mjs` had the same blind spot (its raw ppid is the shell
that launched it) — and now resolves through the same helper. The invariant is written
up in `docs/SYSTEM.md` §8, and the audit confirmed these were the only three sites:
all other `process.ppid` uses either already walk up (`parentBaseFromProc`,
`findClaudePid`) or are unrelated (tier0 presence record, worktree ephemeral id).

---

## BUG 2 — Phantom peers: history reads as live presence (MEDIUM, UX → bad decisions)

**Symptom:** `read_messages` returns a long historical backlog (60+ messages spanning
many hours and prior sessions) with no liveness annotation, so absent agents look
present. The agent built a plan that depended on a peer that had already exited.

**Evidence:** I cited `rabbit`, `heron`, `gecko` as live teammates and **proposed
handing a production daemon deploy to `rabbit`**. `get_global_state` showed the only
live agents were `otter` (me), `falcon`, `parrot`, `raccoon` — **`rabbit`/`heron`/`gecko`
were not active.** Their commits are real and on origin, but they are gone.

**Impact:** I proposed a workflow dependency on a non-present agent, which would have
orphaned the task indefinitely. "Author of a message in the backlog" got conflated with
"currently live and able to act."

**Suggested fix:** annotate each message from `read_messages` with the sender's CURRENT
liveness (live / stale / exited), or filter/section the backlog by who is still in
`list_active_agents`. When an agent is referenced as a hand-off target, the tooling
should flag if that agent is no longer live.

**Resolution (v1.3.2):** every message now carries `from_live` (`annotateSenders` in
`lib/messages.mjs`, off the same heartbeat liveness gate the fleet uses). `read_messages`
adds a `note` naming any senders who've exited; the mid-turn channel
(`coord-context.mjs`) tags them inline (`(exited — not live)`). An agent counts as
present if its exact id OR its parent session (same base) is live, so a since-exited
subagent of a still-live session isn't falsely marked gone.

---

## BUG 3 — Machine-wide deploy lock blocks unrelated repos + over-broad guard match (MEDIUM)

**Symptom A (cross-project lock):** `parrot`, working a *different project*
(`B:/Coding/Visio Moralaca/visio-morlacca`, workspace `ce17f70…`), held the
`deploy:primary` resource lease. That lease blocked a command issued in the **Athena**
repo (workspace `54baabd…`). One project's deploy serialized an unrelated project's work.

**Symptom B (false-positive guard):** the blocked command was
`gh run watch <id> --exit-status` — **read-only run observation, not a deploy.** The
bash-guard matched it as a deploy mutation purely on the word "deploy"/"Deploy" and
returned exit-2 ("deploy (deploy:primary) is in use by parrot").

**Impact:** a read-only status check in repo A was blocked by a deploy lock from repo B.
I had to reword the command to poll status without the substring "deploy".

**Suggested fix:**
1. Scope `deploy:primary` per workspace/repo unless a deploy genuinely shares a
   machine-wide resource (a single prod host both target). If it is truly shared,
   name it so and explain the block; otherwise key it by workspace_id.
2. Tighten the guard's deploy heuristic so read-only observers
   (`gh run watch/list/view`, `git log`, `curl -I`) are not classified as deploy
   mutations. Match on the deploy *verb/target*, not the substring "deploy".

**Resolution (v1.3.2):** both in `lib/resource-rules.mjs`.
(A) Each rule now declares a `scope`. `deploy` is `workspace` — its id folds in the
workspace (`deploy:<ws>`), so an unrelated repo's deploy can't block this one; a TCP
`port` stays `machine`-wide (a real OS singleton). `bash-guard.mjs` passes the
workspace; a genuinely shared host can still be claimed explicitly via `claim_resource`.
(B) The bare-word match is gone. Deploy is detected only as an ACTION — a package
script (`npm run deploy`), a deploy-CLI subcommand (`vercel deploy`), or a script run in
command position (`./deploy.sh`, `bash deploy.sh`) — never as an argument, so
`gh run watch <id>` / `gh run list --workflow deploy.yml` are no longer misread as
deploys.

---

## What worked (don't regress)

- File leasing genuinely prevented same-file collisions; exit-2 blocks were respected.
- Commit attribution + the activity log are useful and mostly accurate (modulo BUG 1's
  id mismatch).
- The message transport itself (post/read/reply) delivered reliably.

---

*Reported by the Athena Control Center session (tools said `puma`, recorded as `otter`),
2026-06-18, during the "brain-apply loop" build. Git facts referenced: commits
`487078d8` + `14edcc95` on `origin/master`.*
