# Universal Cross-Agent Coordination Layer — Architecture & Build Plan

**Target:** Windows 11 + PowerShell 7 + VS Code. Many AI coding agents (Claude Code, Codex CLI, Cursor, Gemini CLI, Windsurf, Cline/Roo, Aider, VS Code Copilot) running simultaneously across one shared repo and across multiple windows/repos on one developer machine.

Produced 2026-06 via an 8-agent research+design workflow (verified extension points, not assumed). Tier 0 + Tier 1 (the MVP) are buildable today.

---

## 1. Root Cause

Agents conflict because **each agent process is an island with zero shared state.** A Claude session, a Codex session, and a Cursor agent each see only their own context window and their own working tree on disk. There is (1) **no presence** — no agent knows another exists, let alone its repo/branch/file/task; (2) **no shared store** — nothing on the machine records "agent X is editing `src/foo.ts` for task T"; (3) **no locking** — nothing checks, before an edit lands, whether someone else owns that file; and (4) **no resolution** — even where a conflict is detected, there is no protocol to wait, queue, or merge. The native mechanisms that could help (Claude's `SubagentStart/Stop`) are all **intra-session** — they coordinate one parent's own children, never two peer sessions in two terminals or two windows. The result is the classic distributed-systems failure with no coordination primitive: lost updates, duplicated work, contradictory parallel decisions, and collisions on **shared singletons** (one dev port, one dev DB, one VPS) that are not files at all.

---

## 2. Architecture Overview

A **single local coordination store** is the source of truth. It is fronted by an **awareness tier** (MCP, model-invoked, universal) and an **enforcement tier** (hooks + git pre-commit, automatic, graded by capability). Two orthogonal lease namespaces ride on the same store: **file leases** (scoped to a repo "room") and **global-resource leases** (machine-wide: ports, DB, deploy).

```
                ┌──────────────────────────────────────────────────────────┐
                │  SHARED STORE (source of truth)                            │
                │  SQLite WAL @ %USERPROFILE%\.agent-coord\state.db          │
                │  agents · workspaces · file_leases · resource_leases       │
                │  lease_queue · activity_log · schema_version               │
                │  (owner-only ACL; asserted NOT inside any git repo)        │
                └───────────────▲───────────────────────▲──────────────────┘
                                │                       │
        AWARENESS (model-invoked, universal)     ENFORCEMENT (automatic, graded)
      ┌───────────────────────────────────┐  ┌──────────────────────────────────────────┐
      │ Coordination MCP server (stdio)    │  │ A. Claude PreToolUse  → exit 2 (PRE-WRITE) │
      │ in every agent's global MCP config │  │ B. git pre-commit hook → reject commit     │
      │ register / heartbeat / claim_files │  │    (UNIVERSAL chokepoint: every committer) │
      │ claim_resource / release / queue   │  │ C. Other agents' hooks → graded:           │
      │ check_conflicts / list / log /     │  │    BLOCKS-PRE-WRITE | DETECTS-POST-WRITE   │
      │ get_global_state                   │  │    | NONE  (probed, not assumed)           │
      └───────────────────────────────────┘  └──────────────────────────────────────────┘
                                │
                      DISCOVERABILITY                       OPTIONAL PHYSICAL TIER
          coord status / coord watch (zero-daemon CLI)      git worktree per agent
          + per-agent statusline (reads snapshot file)      → same-file disk collision impossible
                                                            (opt-in; own room per tree+branch)
```

**Why this shape:**

- **MCP is the only universal substrate for awareness.** Every mainstream agent except Aider ships a first-party MCP client configured from a stable global file. One coordination MCP server, registered once per agent, is visible to every agent in every window. But MCP tools are **model-invoked** — an agent can forget to call them — so MCP buys awareness, never enforcement.
- **The git `pre-commit` hook is the only universal enforcement primitive.** It fires for *anything that commits* — Claude, Codex, Cursor, Aider, Cline, manual edits — at the one moment the full changed-file set is knowable and atomically blockable. It is the cross-agent guarantee. Everything per-agent above it reduces collision *probability* and improves *latency* of detection.
- **Per-agent live hooks are graded, not assumed.** Claude `PreToolUse` exit 2 is a true pre-write block (verified primitive). The rest are probed at install time. Cursor's file hook (`afterFileEdit`) fires **after** the write — detect/revert, not prevent. Codex/Gemini/Copilot deny shapes are version-pinned at install, not hardcoded from memory.
- **Worktrees are the optional hard guarantee.** Two agents on separate worktrees/branches cannot collide on disk; conflicts defer to one explicit merge. Opt-in, because it contradicts the "many agents in one shared tree" topology and adds merge + runtime-isolation cost.

---

## 3. Components

### 3.1 The store — SQLite (WAL) at a global, non-repo path

**Location:** `%USERPROFILE%\.agent-coord\state.db` → `%USERPROFILE%\.agent-coord\state.db`

**Why here / why SQLite:** global and outside any repo (shared across every window and every repo); local fixed disk (WAL needs shared memory, forbidden on network/UNC/OneDrive FS); WAL gives many readers + one writer with no daemon; transactional, indexed queries ("who owns file X", "list live agents in repo Y").

**Hard rules (correctness-critical):**

- Open every connection with `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON;`.
- Every write path (`claim`, `release`, `heartbeat`, `log`, `reap`, `enqueue`) goes through `db.transaction(fn).immediate(...)` — never a bare `db.transaction(fn)`. **`better-sqlite3`'s default is DEFERRED**, which takes a read lock then tries to upgrade on INSERT; two upgraders deadlock as `SQLITE_BUSY_SNAPSHOT`, which `busy_timeout` does **not** resolve. `.immediate()` takes the write lock up front so contenders queue. `store.js` exposes only `writeTxn()` (immediate) and `readTxn()`.
- **Retry wrapper** around every write: catch `SQLITE_BUSY` / `SQLITE_BUSY_SNAPSHOT`, retry up to N times with jitter, then fail-open-loud (§8.8).
- **Schema init is single-writer:** an `IMMEDIATE` transaction creates tables + sets `schema_version`; concurrent cold-starts that lose the race just open the existing DB.
- **ACL on creation:** `icacls` owner-only (the store aggregates every repo path, branch, and task across all client work — sensitive).
- Runtime check at `SessionStart`: refuse to run if `.agent-coord` resolves onto a network/UNC/OneDrive-synced path.

A JSON/JSONL file is the **Tier 0** representation only (§6).

### 3.2 The coordination MCP server (stdio)

A single stdio MCP server (`agent-coord-mcp`), registered in each agent's global MCP config, is a thin RPC over the store. To avoid the native-module ABI problem (§3.6) it is the *one* process that owns `better-sqlite3`; hooks talk to the store either through this server or through a pinned runtime.

| Tool | Signature | Purpose |
|---|---|---|
| `register_agent` | `(tool, repo_path, branch, worktree_path?, task?) → {agent_id}` | Announce presence; stable id. |
| `heartbeat` | `(agent_id) → {ok, peers_changed}` | Refresh liveness. |
| `announce_intent` | `(agent_id, task, files_glob?, architectural_scope?) → {ok, warnings[], conflicts[]}` | Broadcast task; warns/denies on overlapping architectural scope. |
| `claim_files` | `(agent_id, paths[], mode='shared'\|'exclusive', ttl_s, reason) → {granted[], queued[], conflicts[]}` | Reserve files. Default **shared**; exclusive only for serial files. |
| `release_claim` | `(agent_id, paths[]?) → {released[]}` | Free files (session→agent binding verified). |
| `check_conflicts` | `(agent_id, paths[]) → {conflicts[]}` | Read-only; used by hooks. |
| `claim_resource` | `(agent_id, resource_id, ttl_s, reason) → {granted\|queued, conflicts[]}` | Machine-wide singleton (port/DB/deploy/DNS). |
| `release_resource` | `(agent_id, resource_id) → {released}` | Free a global resource. |
| `dequeue_notify` | `(agent_id) → {granted[]}` | Poll for queued claims now granted. |
| `list_active_agents` | `(repo_path?, branch?) → {agents[]}` | Global or room-scoped view. |
| `log_activity` | `(agent_id, event, detail) → {ok}` | Append to awareness feed. |
| `get_global_state` | `() → {agents[], file_leases[], resource_leases[], queue[], recent_log[], degraded}` | One-shot snapshot. |

### 3.3 Data model

```
schema_version ( version INTEGER )

agents
  agent_id TEXT PK         -- human-memorable, e.g. "fox"
  tool TEXT                -- claude-code | codex | cursor | gemini | windsurf | cline | aider | copilot
  pid INTEGER  proc_start_time TEXT   -- captured ONCE at register
  repo_path TEXT  branch TEXT  worktree_path TEXT NULL  current_task TEXT NULL
  status TEXT              -- active | idle | dead
  registered_at TEXT  last_heartbeat TEXT
  session_token TEXT       -- random; binds session→agent_id so release can't be forged accidentally

workspaces                 -- "rooms"
  workspace_id TEXT PK     -- shared-tree: hash(canonical repo root). worktree tier: hash(root@branch)
  repo_path TEXT  branch TEXT

file_leases
  lease_id TEXT PK  workspace_id TEXT  path TEXT   -- canonical repo-relative POSIX, lowercased on Win
  agent_id TEXT  mode TEXT               -- shared | exclusive
  content_hash TEXT NULL                  -- captured at claim; detect silent edits
  reason TEXT  acquired_at TEXT  expires_at TEXT
  INDEX (workspace_id, path)

resource_leases            -- machine-wide singletons, orthogonal to rooms
  resource_id TEXT PK      -- "port:3000" | "db:dev-mysql" | "deploy:prod-vps" | "dns:example.com"
  agent_id TEXT  reason TEXT  acquired_at TEXT  expires_at TEXT

lease_queue                -- resolution: waiters for a busy file/resource
  seq INTEGER PK AUTOINCREMENT  kind TEXT   -- file | resource
  key TEXT  agent_id TEXT  requested_at TEXT  ttl_s INTEGER

activity_log
  seq INTEGER PK AUTOINCREMENT  ts TEXT  agent_id TEXT  workspace_id TEXT
  event TEXT  detail TEXT     -- register|claim|edit|release|commit|done|conflict|queued|granted|degraded
```

**Room vs global vs resource — three scopes:**
- **Room** (`workspace_id`) = unit of *file* conflict. Keyed on canonical repo **root alone** in the shared-tree case (the bytes on disk are shared regardless of branch label; a mutable HEAD in the key would orphan every live lease the instant anyone runs `git switch`). Branch enters the key **only** in the worktree tier. Detached HEAD / mid-rebase → repo-root-only. Re-resolved on every guard call, never cached at SessionStart.
- **Global view** = unit of *awareness*. `list_active_agents()` unscoped and `get_global_state()` ignore the room and show the whole fleet across all windows/repos.
- **Resource** = unit of *singleton* contention. Machine-wide, orthogonal to rooms — two agents in two different repos still contend for `port:3000`, `db:dev-mysql`, `deploy:prod-vps`.

### 3.4 Canonical path & room keying (do-or-die)

One normalizer in `path.js`, unit-tested against adversarial inputs:
1. Resolve repo root via `git rev-parse --show-toplevel`.
2. Resolve junctions/`subst`/symlinks via `fs.realpathSync.native` (B: is frequently a `subst`).
3. Store paths repo-relative, forward-slash, lowercased on Windows (carry an `os` flag so Linux stays case-sensitive).
4. `workspace_id = hash(canonical_realpath_root [+ '@' + branch only in worktree tier])`.
5. Drive-letter case normalized (`b:\` ≡ `B:\`).

Per-agent path extraction differs: Claude → `tool_input.file_path`; Codex → `apply_patch` hunk targets; Cursor → `afterFileEdit` path. The guard maps each to the canonical key before lookup.

### 3.5 Enforcement: Claude hooks + the universal git pre-commit hook

**Claude Code hooks** (`~/.claude/settings.json`, deep-**merged** by the installer, never overwritten):

| Event | Matcher | Action |
|---|---|---|
| `SessionStart` | — | `register_agent` (captures own pid+start_time+session_token); writes agent_id+token to a temp file keyed by `session_id`. **No separate heartbeat process.** |
| `PreToolUse` | `Write\|Edit\|MultiEdit\|NotebookEdit` | For each path: canonicalize → `check_conflicts`. If a live *other* agent holds an **exclusive** lease → **exit 2** with clear stderr. Else acquire/refresh lease, capture `content_hash`, refresh heartbeat, exit 0. |
| `PreToolUse` | `Bash` | Best-effort scan for (a) file-mutating commands (`Set-Content`, `> file`, `sed -i`, codegen) → check file lease; (b) **shared-resource** commands (`deploy`, `drizzle-kit push`, migration, dev-server port bind) → require the matching `resource_lease` or **exit 2**. |
| `PostToolUse` | `Write\|Edit\|MultiEdit` | `log_activity(edit)`; refresh lease + heartbeat; if a file changed whose `content_hash` differs but no lease held by me → log `conflict(silent-edit)`. |
| `Stop` / `SessionEnd` | — | `release_claim(all)` + `release_resource(all)` + mark `status=dead`. |
| `statusLine` | — | Read the **snapshot file** the MCP server maintains (no DB open, no native module). Render compact: `◆ 3 here · fox edit src/auth/** · ⚠ COORD DEGRADED`. `refreshInterval: 5000`. |

**Git pre-commit hook (the universal chokepoint, per repo via `core.hooksPath`):** reads the store, computes the canonical key for every staged path, and rejects the commit if any staged file is held by another live agent's exclusive lease, or if the commit touches a guarded resource (migration/lockfile) without the resource lease. Single mechanism covering Codex, Cursor, Aider, Cline, Copilot, and manual commits uniformly. Detection at commit, not edit — but real, hard enforcement for every committer.

### 3.6 Native-module / runtime pinning

`better-sqlite3` is a compiled addon bound to one Node ABI. Hooks invoked as bare `node guard.js` crash with `ERR_DLOPEN_FAILED` if the `node` on PATH has a different ABI — and because the guard fails-open, that silently disables coordination. Mitigations: (a) pin the runtime — ship the guard as a self-contained executable (bundled Node via `pkg`/Bun/Deno-compile, or absolute `node.exe` + vendored prebuilt `better-sqlite3`); or (b) single owner of the native module — the hook does the conflict check over the running MCP server via tiny stdio/named-pipe IPC. Either way, **no per-agent detached heartbeat process** — liveness rides on `PreToolUse`/`PostToolUse` plus the statusline tick.

---

## 4. How Each Problem Is Solved

### (a) Same-repo conflicts (multiple agents, one tree)
Same repo root → same `workspace_id` (branch not in key, so mid-session `git switch` doesn't orphan leases).
1. Agent A edits `src/checkout.ts`: `PreToolUse` → `claim_files` → granted, lease + `content_hash`.
2. Agent B edits the same file: `PreToolUse` → `check_conflicts` → sees A's live exclusive lease → **exit 2**; B's model receives "locked by fox for 'vCard checkout'". B is offered the resolution tier (§4c), not a dead end.
3. Automatic for Claude (doesn't depend on B's model calling `claim_files`). Non-Claude degrades per the matrix (§5), backstopped by git pre-commit.

**Most same-file edits are non-overlapping line ranges that git merges cleanly.** So default is a **shared** lease + optimistic reconcile; exclusive locks reserved for genuinely serial files (`package.json`, lockfiles, migrations, schema). Avoids false-positive serialization that would tank throughput at dozens of agents.

### (b) Multi-window / multi-repo awareness
Every agent opens the same global store. `list_active_agents()` unscoped, `coord status`, and the statusline show the whole fleet ("12 agents: 4 in Version2.0, 2 in qr-app, …"). The activity log is one global replayable feed. Enforcement stays room-scoped; awareness is global.

### (c) Conflict resolution (not just detection)
1. **Shared leases by default** — non-overlapping changes both proceed; reconcile at commit via git 3-way merge.
2. **Queue, not dead-end** — on a genuine exclusive conflict, `claim_files` returns `{queued, position, est_wait}`; agent polls `dequeue_notify`.
3. **Stale-lease steal handshake** — a waiter may take a lease whose owner is provably dead (heartbeat-dead), not merely TTL-expired-while-alive.
4. **Architectural-decision case** — `announce_intent(architectural_scope)` denies/warns a second agent declaring an overlapping architectural task (e.g. "rewrite auth model") *before* parallel divergence.
5. **Human escalation** — `coord status` shows the queue/conflicts; `coord release --force <key>` breaks a stuck lease.

### (d) Cross-repo shared resources (ports, dev DB, deploy/DNS/migrations)
The room model can't see these — they're machine-wide singletons. The `resource_leases` namespace handles them:
- **Ports** allocated from the store (`resource:port:3000`), not a positional formula.
- **Dev DB** — `resource:db:dev-mysql`; `drizzle-kit push` and migrations require the lease; a second concurrent migration is hard-blocked machine-wide.
- **Deploy / DNS** — `resource:deploy:prod-vps`, `resource:dns:<zone>`. A second simultaneous deploy is blocked across repos. (These also remain user-confirm hard-stops; the lease prevents agent-vs-agent collision, the confirm prevents unwanted mutation.)

---

## 5. Cross-Agent Integration

### Capability matrix (probed at install, version-pinned — NOT assumed)

| Agent | Awareness (MCP) | Enforcement state | Mechanism |
|---|---|---|---|
| **Claude Code** | yes | **BLOCKS-PRE-WRITE** | `PreToolUse` exit 2 + pre-commit |
| **Codex CLI** | yes | pin at install: likely PRE-WRITE on `apply_patch`/`Bash` | deny shape pinned + pre-commit |
| **Cursor 1.7+** | yes | **DETECTS-POST-WRITE** for file edits (`afterFileEdit` fires after write); PRE for shell/MCP | revert-or-flag + escalate; pre-commit is the real block |
| **Gemini CLI** | yes | pin at install (`BeforeTool`) | deny shape pinned + pre-commit |
| **VS Code Copilot** | yes | preview — pin or treat as NONE | pre-commit |
| **Windsurf / Cline / Roo** | yes | **NONE** (no enforcing hooks) | advisory awareness + pre-commit |
| **Aider** | no MCP | **NONE** | git pre-commit only (Aider auto-commits — caught here) |

**Honest reading:** hard enforcement = Claude (`PreToolUse`) + **anything that commits** (git pre-commit). Everything else is advisory awareness + commit-time catch.

### Plugging in a non-Claude agent
Register the server once. E.g. Codex `~/.codex/config.toml`:
```toml
[mcp_servers.agent_coord]
command = "node"
args = ["%USERPROFILE%\\.agent-coord\\mcp\\server.js"]
```
Cursor (`~/.cursor/mcp.json`), Gemini (`~/.gemini/settings.json`), Windsurf, Cline, Roo use `mcpServers`; VS Code Copilot uses `servers`. Add a system-prompt rule: *"Before editing, call `claim_files`; before deploy/migrate/port-bind, call `claim_resource`; on conflict, wait or coordinate."* One `agent-coord-guard --agent <tool>` selects the correct deny dialect; store logic identical, only the output serializer branches.

---

## 6. Tiered Roadmap

### Tier 0 — Shared presence, honestly scoped (~1–2h)
Per-agent files, not shared JSONL: each agent writes `presence/<agent_id>.json` (last-write-wins per file → no interleave, no Windows append-corruption risk). The statusline globs the directory; mtime gives free liveness; deleting the file on exit gives free cleanup. No DB, no MCP, no locking — pure awareness. ~80% of awareness at near-zero risk.

### Tier 1 — The MVP (build this; spec in §7)
- SQLite WAL store (§3.1) with `.immediate()` + retry + single-writer init + ACL.
- `agent-coord-mcp` (§3.2) including `claim_resource`/queue.
- `agent-coord-guard` + Claude hooks (§3.5): register, file-block, Bash/resource guard, log/refresh/silent-edit-detect, release.
- **Git pre-commit hook** via `core.hooksPath` — universal enforcement, in the MVP, not deferred.
- **Installer** `setup.ps1` (deep-merge configs, back up originals, detect agents, gitignore template, assert store not inside a repo) + **`coord doctor`** (verifies MCP reachable AND hook firing per agent).
- **`coord status` / `coord watch`** zero-daemon CLI — the cross-window fleet view, in the MVP.
- Canonical path/room keying (§3.4) with unit tests.
- Resource leases for port / dev DB / deploy wired into the Bash guard + pre-commit.

### Tier 2 — Isolation, liveness polish, live view
- Liveness reconciliation done right (§8.1): heartbeat-driven, lease validity tied to agent liveness, lazy single-lease PID+start-time check, periodic full reap owned by the MCP server idle timer.
- Per-agent deny dialects completed for all hook-capable agents (version-pinned).
- Optional worktree isolation: worktree-tier rooms (root@branch); ports from the resource table; `.env` symlinked/read from one source (never fanned-out); per-tree distinct PORT and distinct product DB path; `npm ci` per tree (npm here means multi-GB `node_modules` per tree — a prerequisite, not an afterthought).
- Browser dashboard: a localhost WS daemon on top of SQLite (not source of truth) for a live fleet view. Polish — `coord status`/`watch` already cover the MVP.

---

## 7. Concrete Build Plan (Tier 0 → Tier 1 MVP)

### Files
```
%USERPROFILE%\.agent-coord\
├─ state.db                       # SQLite WAL (created once, owner-only ACL)
├─ snapshot.json                  # MCP rewrites on change; statusline reads this (no DB/native load)
├─ coord-degraded.flag            # presence => enforcement degraded; statusline renders red
├─ presence\<agent_id>.json       # Tier 0 per-agent presence (also a fallback)
├─ lib\
│   ├─ store.js                   # better-sqlite3; exports writeTxn()(IMMEDIATE)+readTxn() only; retry-on-busy
│   ├─ path.js                    # canonical repo-relative POSIX, lc-on-Win, realpath/junction-resolve
│   ├─ room.js                    # workspace_id (repo-root-only shared-tree; root@branch worktree)
│   ├─ ids.js                     # human-memorable agent_id + session_token
│   ├─ liveness.js                # heartbeat TTL; lazy per-lease PID+start-time check (Get-CimInstance)
│   └─ resources.js               # claim/release/queue for port|db|deploy|dns singletons
├─ mcp\server.js                  # stdio MCP server; single owner of better-sqlite3; rewrites snapshot.json
├─ hooks\
│   ├─ guard.js                   # universal guard: --agent <tool> [--post]; reads stdin JSON
│   └─ session.js                 # register / release-all
├─ cli\
│   ├─ status.js                  # one-shot fleet table + leases + queue + conflicts + degraded banner
│   ├─ watch.js                   # status in a console-clear refresh loop (no daemon)
│   └─ doctor.js                  # per-agent: MCP reachable? hook firing? capability state?
├─ git\pre-commit                 # UNIVERSAL chokepoint
├─ setup.ps1                      # installer
└─ schema.sql                     # CREATE TABLE IF NOT EXISTS ... ; schema_version
```

### Schema (single-writer init, IMMEDIATE)
```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 10000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY, tool TEXT, pid INTEGER, proc_start_time TEXT,
  repo_path TEXT, branch TEXT, worktree_path TEXT, current_task TEXT,
  status TEXT DEFAULT 'active', registered_at TEXT, last_heartbeat TEXT,
  session_token TEXT);

CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT PRIMARY KEY, repo_path TEXT, branch TEXT);

CREATE TABLE IF NOT EXISTS file_leases (
  lease_id TEXT PRIMARY KEY, workspace_id TEXT, path TEXT, agent_id TEXT,
  mode TEXT DEFAULT 'shared', content_hash TEXT, reason TEXT,
  acquired_at TEXT, expires_at TEXT);
CREATE INDEX IF NOT EXISTS idx_leases_ws_path ON file_leases(workspace_id, path);

CREATE TABLE IF NOT EXISTS resource_leases (
  resource_id TEXT PRIMARY KEY, agent_id TEXT, reason TEXT,
  acquired_at TEXT, expires_at TEXT);

CREATE TABLE IF NOT EXISTS lease_queue (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, key TEXT,
  agent_id TEXT, requested_at TEXT, ttl_s INTEGER);

CREATE TABLE IF NOT EXISTS activity_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, agent_id TEXT,
  workspace_id TEXT, event TEXT, detail TEXT);
```

### `PreToolUse` guard — load-bearing pseudocode
```js
// node guard.js --agent claude        (stdin = hook JSON)
const input = JSON.parse(readStdin());                 // {session_id, cwd, tool_name, tool_input}
const { me, token } = sessionAgent(input.session_id);  // temp file written at SessionStart

try {
  const paths = extractPaths(input);                   // per-agent shape
  const { repo, branch, detached } = gitContext(input.cwd);
  const ws = workspaceId(repo, branch, detached);      // repo-root-only unless worktree tier
  for (const raw of paths) {
    const path = canonical(raw, repo);                 // realpath, repo-relative, posix, lc-on-win
    const holder = readTxn(db => db.prepare(`
      SELECT l.agent_id, a.current_task FROM file_leases l JOIN agents a USING(agent_id)
      WHERE l.workspace_id=? AND l.path=? AND l.mode='exclusive'
        AND a.status='active' AND a.agent_id<>? AND l.expires_at > ?`
    ).get(ws, path, me, nowIso()));

    if (holder && agentAlive(holder.agent_id)) {       // lazy per-lease liveness ONLY here
      log(ws, me, 'conflict', { path, holder: holder.agent_id });
      enqueue('file', ws + '||' + path, me);
      stderr(`BLOCKED: ${path} is locked by ${holder.agent_id} for "${holder.current_task}". `
           + `You are queued. Wait (dequeue_notify) or edit another file.`);
      process.exit(2);                                  // Claude blocks; feeds stderr to model
    }
    writeTxn(db => upsertLease(db, { ws, path, agent_id: me, mode: leaseMode(path), ttl: defaultTtl() }));
    writeTxn(db => touchHeartbeat(db, me));
    log(ws, me, 'claim', { path });
  }
  process.exit(0);
} catch (e) {
  setDegradedFlag(e);                                   // LOUD fail-open
  stderr(`COORD DEGRADED: store error (${e.code}); proceeding WITHOUT lock enforcement.`);
  process.exit(0);
}
```
For Codex/Cursor/Gemini only the `exit 2` tail changes to the pinned deny dialect, selected by `--agent`. For Cursor's *file* path (post-write), the action is revert-or-flag + `log(conflict)` + escalate.

### `~/.claude/settings.json` (installer deep-merges; never clobbers existing hooks)
```jsonc
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command",
      "command": "node %USERPROFILE%\\.agent-coord\\hooks\\session.js --register" }] }],
    "PreToolUse": [
      { "matcher": "Write|Edit|MultiEdit|NotebookEdit", "hooks": [{ "type": "command",
        "command": "node %USERPROFILE%\\.agent-coord\\hooks\\guard.js --agent claude" }] },
      { "matcher": "Bash", "hooks": [{ "type": "command",
        "command": "node %USERPROFILE%\\.agent-coord\\hooks\\guard.js --agent claude --bash" }] }
    ],
    "PostToolUse": [{ "matcher": "Write|Edit|MultiEdit", "hooks": [{ "type": "command",
      "command": "node %USERPROFILE%\\.agent-coord\\hooks\\guard.js --agent claude --post" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command",
      "command": "node %USERPROFILE%\\.agent-coord\\hooks\\session.js --release" }] }]
  },
  "statusLine": { "type": "command",
    "command": "node %USERPROFILE%\\.agent-coord\\cli\\statusline.js",
    "refreshInterval": 5000 }
}
```

### Required test harness (deliverable, not optional)
1. **Concurrent-claim race:** N processes hammering `claim_files` on one path; assert exactly one exclusive winner, others queued, zero unhandled `SQLITE_BUSY`.
2. **Path-aliasing:** 6 spellings (case, slash, drive-letter, junction, absolute, relative) → one lease row.
3. **Liveness/reaper:** hard-kill mid-lease; lease freed only after heartbeat-dead, with PID-reuse guarded by `proc_start_time`.
4. **ABI-mismatch detection:** run guard under a wrong-ABI node; assert it sets the degraded flag (doesn't silently no-op).
5. **Writer-contention ceiling:** 40 concurrent `claim`/`heartbeat`/`log`; record p99 and the measured ceiling.
6. **Mid-session `git switch`:** assert leases survive (room keyed on repo root, not branch).
7. **Resource lease:** two repos contend for `deploy:prod-vps`; one granted, one blocked.

---

## 8. Failure Modes

1. **Dead agents / stale locks.** Liveness = short heartbeat refreshed inside the hooks that already fire (dead after ~3–5 min), not a per-agent process. Lease validity tied to agent liveness, not a fixed wall clock. The expensive PID + `proc_start_time` check is lazy, only for the contended lease. Periodic full reap owned by one process (MCP server idle timer).
2. **Store write race.** All writes via `.immediate()` + `busy_timeout` + retry-with-jitter. Claim is one atomic check-and-insert transaction.
3. **Model ignores advisories.** Claude `PreToolUse` auto-claims regardless. For MCP-only/no-hook agents, the git pre-commit hook is the backstop; silent edits caught by `content_hash` mismatch.
4. **Agents that lie / over-claim / forget.** TTL caps blast radius; `claim_files` rejects suspiciously broad globs; `release` fires on `Stop`; the store is truth (guard re-reads). `release_*` verify the `session_token`→`agent_id` binding.
5. **Unmatched write paths (Bash `apply_patch`, `sed -i`, `>`, codegen, subagents).** Best-effort Bash detection + git pre-commit as true serialization point. Documented honestly: advisory-with-teeth + guaranteed detection-at-commit, not a hard pre-write mutex for every path.
6. **Subagent identity.** Derive a sub-identity (`agent_id#sub<n>`) so siblings don't deadlock as one identity; same-session siblings get shared leases among themselves.
7. **Guard latency.** Hot path = indexed point-lookups (sub-ms) + at most one lazy liveness check on contention. Budget < 100 ms. No network, no full sweep, no PowerShell on the happy path.
8. **Store SPOF / fail-open made LOUD.** On store error/lock/ABI failure the guard fails open for the write but loudly: writes `coord-degraded.flag`, prints `COORD DEGRADED` to stderr, statusline + `coord status` render a red banner.
9. **WAL growth / network-FS misuse.** Periodic `wal_checkpoint(RESTART)`. Setup refuses a store path on UNC/OneDrive/mapped-network drives.
10. **Config drift / schema migration.** `schema_version` row + version negotiation: a guard/server whose version != stored version refuses to write (degraded-loud). `setup.ps1` is the single install/update path; backs up and deep-merges.

---

## 9. Honest Limitations

This system **reduces collision probability and guarantees detection-at-commit. It is not a machine-wide mutex around every file write.**

- **Coordination is advisory-by-default; only two enforcement points are hard:** Claude `PreToolUse` exit 2 (before the write), and the git pre-commit hook (at commit, every committer). Everything else is advisory awareness. Non-Claude agents mostly cannot be hard-blocked pre-write — Cursor's file hook fires after the write; Codex/Gemini/Copilot hook contracts are preview/fast-moving and pinned-at-install. For a guarantee on a non-Claude agent, the answer is the commit hook or a worktree.
- **No auth/trust boundary inside the store.** Any local process can open the SQLite file and forge a lease. Acceptable only because this is a single-user machine. `session_token` prevents *accidental* cross-agent release, not malicious.
- **Bash/shell and subagent edits can bypass the live guard.** Best-effort Bash detection + commit-time catch + `content_hash` logging narrow the gap; they don't close it.
- **Whole-file granularity.** Locks are per file, not per line. Shared-by-default + optimistic git merge mitigate false-positive serialization; genuinely overlapping lines still reconcile at merge.
- **Resource leases prevent agent-vs-agent collision, not unwanted mutation.** A deploy/DNS lease stops two agents deploying at once; it does not replace the human-confirm hard-stop.
- **The "40–50 agents" figure is borrowed prior art until the §7 contention test measures *this* implementation's ceiling.**
- **Cross-room architectural divergence is surfaced and warned, not prevented.** Two agents rewriting the auth model on two branches get a warning + a visible feed entry — a human or the agents must act on it.

---

**Bottom line.** One global SQLite store (`.immediate()` writes, canonical repo-root rooms, owner-only ACL), fronted by an MCP server for universal awareness and by two real enforcement points — Claude `PreToolUse` and the **git pre-commit hook (the cross-agent chokepoint)** — with a resolution tier (shared leases + queue + optimistic merge), a machine-wide resource-lease namespace (ports/DB/deploy/DNS), an installer + `coord` CLI, and worktrees as an optional physical guarantee. Ship Tier 0 (per-agent presence files) today; Tier 1 is the MVP, buildable now on Windows/Node, contingent on the §7 test harness. Build the Node/stdio/SQLite version as specced; cite MCP Agent Mail only as validation of the tool shapes — adopting an HTTP/Python daemon would contradict the no-daemon/no-SPOF posture.
