# Version2 — Agent Coordination (`agent-coord`)

**A machine-wide coordination layer so multiple AI coding agents running at once
don't step on each other.** Shared presence, file locks, a universal git commit
guard, agent-to-agent messaging, and duplicate-work detection — across every
terminal, window, and repo on your machine.

Built on Node's built-in `node:sqlite` (WAL). The hooks and CLI are **zero-dependency**;
only the MCP server pulls one package (`@modelcontextprotocol/sdk`). No native
build, no daemon, no SPOF — it fails *open but loud*, so a glitch never freezes
your work.

---

## Why

Every AI coding agent is an island: a Claude Code session, a Codex session, and a
Cursor agent each see only their own context and their own working tree. Run a few
at once on one repo — or sharing one dev port / DB / deploy — and they edit the
same file simultaneously, duplicate each other's work, make contradictory
decisions, and collide on shared singletons. That's a distributed-systems failure
with **no coordination primitive**. This adds one.

---

## Install

### Option A — let your coding agent do it (recommended)

Clone the repo, open it in your agent (Claude Code, Codex, Cursor, …), and paste:

> **Read `AGENTS.md` in this repo and set up agent-coord for me: install it, run
> the health check, and tell me what's live and what I need to do next.**

The agent follows the [`AGENTS.md`](./AGENTS.md) runbook — installs, verifies
(`doctor` 9/9), and reports back. That's it.

```bash
git clone https://github.com/v2matosevic/Version2-Agent-Coordination.git
cd Version2-Agent-Coordination
# then open this folder in your agent and paste the message above
```

### Option B — one command yourself

```bash
node setup.mjs        # any OS — Windows / macOS / Linux
```
or, on Windows (also builds the VS Code Fleet panel):
```powershell
./setup.ps1
```

Both are **idempotent** (safe to re-run) and **fail-soft** (skip a step if a CLI
isn't installed). They wire Claude Code hooks + statusline, the global git
pre-commit net, and the MCP server into Claude and Codex, then run the health
check. **Requires Node ≥ 22.** Open new agent sessions afterward to pick it up.

Verify any time:
```bash
node cli/doctor.mjs        # expect: 9/9 checks passed
```

---

## What you get

| Agent | What it gets |
|---|---|
| **Claude Code** | Full enforcement — a `PreToolUse` hook claims the file you're about to edit or **blocks it (`exit 2`)** if a peer holds it. Bash guard reserves dev port / DB / deploy. Statusline shows the fleet **and your own identity**. MCP tools for active coordination. |
| **Codex** | MCP awareness + model-invoked claims; enforced at commit by the global pre-commit net. |
| **Any committer** (Codex / Cursor / Aider / manual) | The **global git pre-commit** rejects a commit that stages a file another live agent is actively editing. |

### The coordination model

- **Rooms & resources.** A *room* = a repo (branch-independent), the unit of file
  conflict. *Resources* = machine-wide singletons (`port:3000`, `db:dev`,
  `deploy:primary`) — two agents in different repos still contend for them.
- **Self-healing locks (warm/cold).** A file lock only blocks while it's *warm* —
  the holder edited that file in the last few minutes. Once they move on it goes
  *cold* and a waiting agent takes it **automatically** — no force-release, no
  asking the human to unlock. Active concurrent edits still block.
- **Talk that reaches heads-down agents.** Agents leave each other messages
  (`post_message`, workspace-scoped). Unread messages surface not just at the next
  prompt but **between tool calls**, so a peer can reach an agent mid-build.
- **Shared task board.** Agents `claim_task` discrete units of work (atomic — one
  winner under a race), so a peer simply *sees* a task is taken instead of two
  agents building the same thing. Title dedup, dead-owner auto-reclaim, and a
  `depends_on` list that marks tasks blocked/ready. `node cli/tasks.mjs` shows it.
- **Duplicate-work de-confliction.** Beyond the board, `announce_intent` warns the
  later starter that a peer is already on similar work (text-similarity). The
  deterministic tiebreaker (who started first) decides who yields; the later
  starter is advised, then auto-blocked if it keeps duplicating. Ask a peer to
  stand down with `request_yield` instead of fighting locks.
- **One identity per session.** Each agent is a single, stable identity across its
  hooks and its MCP tools — so locks, messages, and commit provenance all line up
  (no ghost twins, and the statusline tells you which terminal is which agent).
- **Autonomous push hand-off.** Told to push a history with other agents' commits,
  an agent runs `pending_push_review` (author + live status + verdict per commit)
  instead of asking you.

---

## Commands

```bash
node cli/doctor.mjs                 # 9-point health check
node cli/status.mjs                 # one-shot fleet table
node cli/watch.mjs                  # live fleet in the terminal (2s)
node cli/dashboard.mjs [port]       # live browser dashboard (default :7777)
node cli/tasks.mjs                  # shared task board (--add "title" | --done <id>)
node cli/worktree.mjs new           # isolate an agent: own worktree + branch + port
node cli/insights.mjs [--since 7d]  # retro: files edited by 2+ agents + conflicts
node cli/pending-push.mjs           # who authored the unpushed commits + push verdicts
node cli/release.mjs --file <p> | --resource <id> | --agent <id> | --all
```
All CLIs run under `node --disable-warning=ExperimentalWarning <script>`.

## MCP tools (Claude + Codex)

`whoami`, `announce_intent`, `list_active_agents`, `get_global_state`,
`check_conflicts`, `claim_files`, `release_files`, `claim_resource`,
`release_resource`, `log_activity`, `post_message`, `read_messages`,
`pending_push_review`, `ask_agent`, `check_replies`, `reply`, `request_yield`,
`list_tasks`, `claim_task`, `update_task`.

## VS Code extension (optional)

An Activity Bar **Fleet** panel — every agent across every repo (who, file held,
leases, queue, activity) + an "Open in Tab" view. `setup.ps1` builds and installs
it; see [`vscode-extension/README.md`](./vscode-extension/README.md). It reads the
store via your system `node` (no extension dependencies).

## macOS menu bar (optional)

The Mac-native counterpart to the VS Code panel: a **SwiftBar/xbar plugin** that
lives in the menu bar showing the live fleet — agent count (🟢 / 🔴 when files are
contended / ⚠️ when degraded), a dropdown of agents grouped by repo with the file
each holds, contended files, resource leases, the task board, and a link to the
dashboard. `node setup.mjs` generates it on macOS; or run it directly:

```bash
node cli/install-macos-menubar.mjs   # generates the plugin + installs it if SwiftBar/xbar is found
```

Needs [SwiftBar](https://swiftbar.app) (`brew install --cask swiftbar`) or xbar.
The plugin is read-only and resolves `node` itself (GUI apps don't inherit your
fnm/Homebrew PATH), so it works regardless of how Node is installed.

## Tests

```bash
# isolated store via AGENT_COORD_HOME; all green
node test/concurrency.mjs   node test/cold-lease.mjs   node test/overlap.mjs
node test/session-link.mjs  node test/messages.mjs     node test/precommit.mjs
node test/liveness.mjs      node test/mcp-smoke.mjs     node test/git-switch.mjs
```

## Uninstall

```bash
git config --global --unset core.hooksPath   # prior value in ~/.agent-coord/git-hookspath.prior
claude mcp remove agent-coord --scope user
codex mcp remove agent-coord
# restore a ~/.claude/settings.json.bak.*  and delete ~/.agent-coord/
```

## Honest limits

Coordination is advisory-by-default; the only **hard** blocks are Claude Code
`PreToolUse` (pre-write) and the git pre-commit hook (at commit, every committer).
Non-Claude agents get awareness via MCP + the commit net, not pre-write blocking.
Locks are whole-file. A single-user machine is assumed — there's no auth boundary
in the store. See [`DESIGN.md` §9](./DESIGN.md) for the full list.

## Docs

- [`AGENTS.md`](./AGENTS.md) — install/operation runbook for AI agents.
- [`docs/SYSTEM.md`](./docs/SYSTEM.md) — complete as-built reference.
- [`docs/AGENT-PROTOCOL.md`](./docs/AGENT-PROTOCOL.md) — how agents should coordinate.
- [`DESIGN.md`](./DESIGN.md) — original architecture & rationale.
- [`CHANGELOG.md`](./CHANGELOG.md) — what's been built.
- [`docs/LIVE-TEST.md`](./docs/LIVE-TEST.md) — first live two-agent validation.

---

Platform: developed on **Windows 11 + PowerShell 7** and also installed & proven on
**macOS (Apple Silicon)** — both with Claude Code and Codex. The core (Node +
`node:sqlite` + the hooks/MCP/CLI) is portable; `node setup.mjs` runs on
Windows/macOS/Linux (doctor 9/9, suite 17/17 on macOS). The few Windows-specific
runtime paths branch on `process.platform`, so each OS keeps its native behaviour.
Single-user machine by design.
