# agent-coord — Tier 0 (presence / awareness)

The dead-simple awareness layer from `../DESIGN.md` §6. Pure Node, zero deps.
No locking, no enforcement yet — it just makes every Claude Code session **see**
the others (same repo first, other windows/repos after) and flags two agents
editing the same file.

## How it works

- Each session gets a stable, speakable name (e.g. `fox`) — claimed from a
  shared pool under `~/.agent-coord/names/` so no two live sessions share one,
  with a deterministic hash pick as the fail-open fallback.
- Hooks write/refresh one JSON file per agent under
  `%USERPROFILE%\.agent-coord\presence\<name>.json`.
- The statusline reads that directory every refresh, shows the live fleet, and
  self-heartbeats so an open-but-idle session stays visible.
- Liveness = file mtime. Active work + the statusline keep it fresh; a clean
  exit deletes the file; a crash goes stale after 3 min and is GC'd after 1h.

## Wiring (already applied to `~/.claude/settings.json`)

| Hook | Script | Purpose |
|---|---|---|
| `SessionStart` | `presence-write.mjs SessionStart` | register |
| `UserPromptSubmit` | `presence-write.mjs UserPromptSubmit` | capture task + refresh |
| `PreToolUse` (`Write\|Edit\|MultiEdit\|NotebookEdit`) | `presence-write.mjs PreEdit` | mark current file |
| `SessionEnd` | `presence-remove.mjs` | deregister |
| `statusLine` | `statusline.mjs` | render fleet + heartbeat |

## Try it without Claude

```bash
echo '{"session_id":"demo","cwd":"B:/Coding/Version2.0"}' | node tier0/statusline.mjs
```

## Limits (by design — this is Tier 0)

Awareness only. It does **not** prevent edits. That is Tier 1 (SQLite store +
MCP server + PreToolUse blocking + git pre-commit). See `../DESIGN.md`.
