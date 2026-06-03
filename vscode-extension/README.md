# Agent Fleet — VS Code extension

Adds an **Activity Bar icon** (left side) that opens a live **Fleet** panel showing
every AI coding agent coordinating on this machine (via the `agent-coord` layer):
who's active, in which repo/branch, what they're working on, every file and
resource they hold, the shared task board, the contention queue, and a live
activity feed. A title-bar button opens the same view as a full editor **tab**.
Click any file chip to open that file.

## How it gets its data (no config needed)

It reads `~/.agent-coord/snapshot.json` directly — a plain-JSON mirror of the
fleet that the Claude statusline rewrites every few seconds while any agent is
live. Reading a file means **no subprocess, no `node:sqlite`, and no dependency
on a `node` binary being on the editor's PATH** (which matters: fnm's node lives
at an ephemeral per-shell path a Finder-launched editor can't see). If the
snapshot is missing or stale, the extension falls back to shelling out to your
system `node` running `../cli/state-json.mjs`, rooting itself from the snapshot.
Zero extension dependencies.

## Install (macOS)

**A. Unpacked (simplest, no build):**
```sh
cp -R "<your-clone>/vscode-extension" "$HOME/.vscode/extensions/agent-coord-fleet-1.0.0"
# then in VS Code: Cmd+Shift+P → "Developer: Reload Window"
```

**B. Packaged `.vsix`:**
```sh
cd <your-clone>/vscode-extension
npx @vscode/vsce package --allow-missing-repository
code --install-extension agent-coord-fleet-1.0.0.vsix
```

**C. Dev (try it without installing):** open the `vscode-extension` folder in VS
Code and press **F5** (Extension Development Host).

After install, click the **fleet dot** in the Activity Bar (left rail). It works
out of the box whenever a Claude session is running (that keeps the snapshot
fresh).

> Windows: copy into `%USERPROFILE%\.vscode\extensions\agent-coord-fleet-1.0.0`
> and reload. `setup.ps1` sets `AGENT_COORD_ROOT` for the node fallback.

## Settings (all optional)

- `agentCoord.root` — absolute path to your agent-coord clone. Only used by the
  live-refresh fallback, and auto-resolved from the snapshot's own `root` field
  or the `AGENT_COORD_ROOT` env var. Set it to override.
- `agentCoord.node` — node executable for the fallback (default `node`; the
  extension also tries `/opt/homebrew/bin/node` and `/usr/local/bin/node`).
- `agentCoord.refreshMs` — refresh interval (default `2000`).
