# Codex coordination

Native Codex hooks now provide automatic session check-in, file claims before
patches, recognized shell-write and resource guards, and messages after local
tool calls. The same explicit session context reaches coordination MCP tools,
so a hook claim is recognized as the agent's own claim.

## Enable

Run `node setup.mjs`, then open a new Codex session and review/trust the
agent-coord handlers in `/hooks`. The installer preserves other handlers and
backs up `hooks.json`. It respects `CODEX_HOME`. To install only this component,
run `node cli/install-codex-hooks.mjs`.

`node cli/doctor.mjs` now has ten checks. Its Codex hook check verifies configured
handlers, **not trust, client feature flags, or actual execution**. In a fresh
session, a room brief should appear. An MCP `whoami` call should report
`coordinationMode: native-hooks` and `identityBasis: hook`.

Current hook input, output, tool matching, and trust behavior are documented by
[OpenAI](https://learn.chatgpt.com/docs/hooks). New or changed hook definitions
require review in Codex. Setup does not modify trust or approval settings.

## Identity and presence

- Native hooks carry `session_id` and `cwd`. Before calling an agent-coord MCP
  tool, the hook attaches these as reserved `_coord` metadata. Each request gets
  its own identity and workspace; a shared server PID is never a session key.
- Hooks can distinguish subagents when the host supplies `agent_id`. A host that
  omits it cannot provide separate sibling identities through this adapter.
- Without hooks, `CODEX_THREAD_ID`, when supplied by the host, provides stable
  MCP and git-hook identity. Otherwise the MCP server creates a standalone name.
- MCP-only presence is registered on first use and refreshed while its connection is open. This does not
  renew file leases: re-claim a file before each edit. Closing the transport
  releases randomly named standalone claims. An environment-backed identity
  expires through heartbeat if no native lifecycle hook ends it, so overlapping
  reconnects cannot release each other's claims. Native session claims belong to session lifecycle
  hooks and survive an MCP reconnect.
- An ended native session releases its own claims. Missing lifecycle events
  retain the existing expiry fallback.

## Protection and limits

Patches reserve all source and destination paths in one transaction. A denied
patch rolls back new claims and preserves older claims exactly. Relative patch
paths resolve against the hook's working directory. Shell detection reuses the
existing command rules. It cannot inspect arbitrary scripts, interpreter code,
or every shell construct. Hosted tools do not run these local hooks.

The hook only returns an allow/rewrite result for this integration's own MCP
calls. It never returns an allow decision for shell commands or file edits.
Known conflicts return exit 2. Store or adapter errors fail open with a visible
degraded warning, consistent with the existing system.

The git guard prefers the committing process's session identity over a recent
per-repository marker. It reads NUL-delimited staged paths with rename detection
disabled, so both rename endpoints and non-ASCII names are checked.

This is single-user coordination, not authentication. Session metadata and
local store access are trusted inputs. Old sessions still execute old MCP code
until restarted. A configured hook is not proof that a client runs it.

## Verification and removal

Verified on Windows with Node 22.22.0 on 2026-09-04: all 41 isolated tests passed,
including the actual timed MCP heartbeat and overlapping reconnects. Setup
completed and doctor reported 10/10 configuration checks. Native hook execution
inside a newly trusted Codex session remains an operator verification step.

`npm test` runs each test against an isolated store. `test/codex-hooks.mjs` uses
native event fixtures, real stdio MCP calls, and temporary git repositories to
exercise collision blocking, identity, messages, lifecycle, commit checks, and
idempotent installation. No test messages reach live agents.

To remove native Codex integration, remove only handlers marked
`x-agent-coord: true` from the active `hooks.json`, or restore its backup after
checking for later edits. Restart sessions. MCP and git integrations have their
own uninstall steps in `AGENTS.md`.
