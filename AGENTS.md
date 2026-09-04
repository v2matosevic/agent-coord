# AGENTS.md — install & operation playbook for AI coding agents

You are an AI coding agent (Claude Code, Codex, Cursor, …). A human cloned this
repo and asked you to **set it up**. This file is your runbook. Follow it top to
bottom; it is idempotent (safe to re-run) and cross-platform.

> **What this is:** `agent-coord` is a machine-wide coordination layer so that
> *multiple AI coding agents running at once* (many terminals / windows, Claude +
> Codex) don't step on each other — shared presence, file locks, a universal git
> commit guard, agent-to-agent messaging, and duplicate-work detection. It is the
> tool **you and your sibling agents** will run under.

## 0. Preflight (verify, don't assume)

Run these and confirm before continuing:

- **Node 22.16+ (22.x) or 24+** (required for `node:sqlite` with FTS5):
  `node --version`. Setup probes SQLite and full-text search before modifying configuration.
- **git present:** `git --version`.
- You are at the repo root (this file is here): the folder contains `setup.mjs`, `cli/`, `hooks/`, `mcp/`.

## 1. Install (one command)

From the repo root:

```bash
node setup.mjs
```

This is idempotent and fail-soft. It will:
1. `npm install` (only the MCP server needs deps).
2. Install Claude Code hooks + statusline into `~/.claude/settings.json` (merged, backed up — never clobbers existing hooks).
3. Install a **global** git pre-commit/post-commit net via `git config --global core.hooksPath` (fails open; chains to existing repo hooks).
4. Install Codex lifecycle/file/message hooks into `~/.codex/hooks.json` (or `$CODEX_HOME`), preserving existing handlers, and register MCP with available CLIs.
5. Run the health check.

**Windows alternative** (also builds the VS Code Fleet panel + sets `AGENT_COORD_ROOT`):
```powershell
./setup.ps1
```

If `node setup.mjs` can't run a step (e.g. a CLI isn't installed), that's fine —
it skips and reports. Don't fight it.

## 2. Verify (must pass before you report success)

```bash
node cli/doctor.mjs
```
Expect **`10/10 checks passed`**. Hook configuration is checked, not Codex trust or runtime delivery. If a check fails, read its line — common causes:
- *Claude MCP server* / *Codex MCP server* failing → that CLI isn't installed (OK to leave; note it to the human).
- *store writable* failing → the store dir (`~/.agent-coord`) isn't writable, or is on a network/OneDrive-synced path (it must be a local disk).

Then confirm the test suite is green (isolated store, touches nothing live):
```bash
npm test
```
The runner creates a temporary store for each test and scrubs inherited agent
identity. It works unchanged in PowerShell, Bash and CI.

## 3. Report back to the human

Tell them, concisely:
- Installed (doctor N/10), which integrations are configured, and which are verified running.
- ⚠️ anything skipped (e.g. "Codex CLI not found — skipped its MCP wiring").
- **Action they must take:** *open NEW agent sessions/terminals* — existing sessions won't pick up the hooks until restarted.
- Codex requires review/trust of new or changed hooks in `/hooks`. Never edit its trust store or bypass that review. Until trusted, use MCP check-ins, file claims and message polling.
- One line on what they now have: "Your agents now see each other, lock files they're editing, and a global pre-commit blocks committing a file another live agent holds."

## 4. What you (and every agent) should DO once it's running

This is not just install-and-forget — it changes how you should work when peers
are around. Full protocol: [`docs/AGENT-PROTOCOL.md`](./docs/AGENT-PROTOCOL.md).
The short version:

- **Check the fleet** before starting: MCP `list_active_agents`, or `node cli/status.mjs`.
- **Announce intent:** call `announce_intent` with your task. It warns you if a
  peer is already doing similar work — if you started later, narrow your lane or
  hand off; **don't build the same thing twice.**
- **You'll be auto-blocked** (`exit 2`) from editing a file a peer is *actively*
  editing. Don't force it or ask the human to unlock — it auto-frees within a few
  minutes when they move on; edit elsewhere and retry, or `post_message` them.
- **You hear peers mid-turn:** unread messages appear between your tool calls (a
  `📬` block). Act on them.
- **Before pushing commits you didn't author:** run `pending_push_review` instead
  of asking the human.

## 5. What it changes on the machine (so you can explain / reverse it)

- `~/.claude/settings.json` — adds hooks + a statusline (backup written alongside).
- `~/.codex/hooks.json` (or `$CODEX_HOME/hooks.json`) adds native Codex hooks, with a backup. Remove only handlers marked `x-agent-coord` to uninstall them.
- `git config --global core.hooksPath` → `~/.agent-coord/githooks` (prior value saved to `~/.agent-coord/git-hookspath.prior`).
- `~/.claude.json` / Codex config — adds the `agent-coord` MCP server.
- Creates the store at `~/.agent-coord/` (SQLite). Single-user machine assumed; no secrets stored.

**Uninstall:** `git config --global --unset core.hooksPath` (restore the prior
value if any); `claude mcp remove agent-coord --scope user`; `codex mcp remove
agent-coord`; restore a `~/.claude/settings.json.bak.*`; delete `~/.agent-coord/`.

## 6. Honest limits (don't oversell it to the human)

Hard enforcement is two points only: Claude Code or trusted Codex `PreToolUse` (pre-write block)
and the **git pre-commit** net (every committer, at commit). Everything else is
advisory awareness + commit-time catch. Codex hooks cover native patches and recognized shell writes, not hosted tools or arbitrary scripts. Locks are whole-file. It assumes a
single-user machine (no auth boundary in the store). See [`DESIGN.md` §9](./DESIGN.md).
