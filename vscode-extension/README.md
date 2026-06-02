# Agent Fleet — VS Code extension

Adds an **Activity Bar icon** (left side) that opens a live **Fleet** panel showing
every AI coding agent coordinating on this machine (via the `agent-coord` layer):
who's active, in which repo/branch, what file they hold, resource leases, queue,
and a live activity feed. A title-bar button opens the same view as a full editor
**tab**.

It reads the fleet by shelling out to your system `node` running
`../cli/state-json.mjs` (so it doesn't depend on VS Code's bundled Node having
`node:sqlite`). Zero extension dependencies.

## Install (pick one)

**A. Unpacked (simplest, no build):**
```powershell
# copy this folder into your VS Code extensions dir, then reload VS Code
$dst = "$HOME\.vscode\extensions\agent-coord-fleet-0.1.0"
Copy-Item -Recurse -Force "<your-clone>/vscode-extension" $dst
# then: Ctrl+Shift+P -> "Developer: Reload Window"
```

**B. Packaged `.vsix`:**
```powershell
cd <your-clone>/vscode-extension
npx @vscode/vsce package --allow-missing-repository
code --install-extension agent-coord-fleet-0.1.0.vsix
```

**C. Dev (try it without installing):** open this folder in VS Code, press **F5**
(Extension Development Host).

After install, click the **fleet icon** in the Activity Bar.

## Settings

- `agentCoord.root` — absolute path to your agent-coord clone. Blank by default;
  auto-resolved from the `AGENT_COORD_ROOT` env var (set by `setup.ps1`). Set it
  here to override.
- `agentCoord.node` — node executable (default `node`)
- `agentCoord.refreshMs` — refresh interval (default `2000`)
