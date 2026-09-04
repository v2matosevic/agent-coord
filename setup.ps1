# agent-coord installer — idempotent. Wires the coordination layer into Claude
# Code, Codex, and git globally. Safe to re-run.
# Run from anywhere: the root is wherever THIS script lives (your clone).
$ErrorActionPreference = "Stop"
$root = ($PSScriptRoot -replace '\\', '/')
$node = "node"
$flag = "--disable-warning=ExperimentalWarning"

& $node $flag --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(':memory:'); db.exec('CREATE VIRTUAL TABLE runtime_fts USING fts5(content)'); db.close();"
if ($LASTEXITCODE -ne 0) { throw "agent-coord requires Node 22.16+ (22.x) or Node 24+. No configuration was changed." }

Write-Host "== agent-coord setup ==" -ForegroundColor Cyan

# 1. npm deps (only the MCP server needs them)
Write-Host "`n[1/6] npm deps"
Push-Location $root
npm install --no-audit --no-fund | Out-Null
Pop-Location

# 2. Claude hooks + statusline (idempotent merge, self-backs-up)
Write-Host "`n[2/6] Claude hooks"
& $node $flag "$root/cli/install-claude-hooks.mjs"

# 3. Global git pre-commit (all repos)
Write-Host "`n[3/6] global git pre-commit"
& $node $flag "$root/cli/install-global.mjs"

# 4. Codex MCP server (add updates the existing entry without removing it first)
Write-Host "`n[4/6] Codex MCP"
& $node $flag "$root/cli/install-codex-hooks.mjs"
if (Get-Command codex -ErrorAction SilentlyContinue) {
  & codex mcp add agent-coord -- $node $flag "$root/mcp/server.mjs" --tool codex
} else {
  Write-Host "  codex not found — skipped"
}

# 5. Claude MCP server (if claude CLI is available)
Write-Host "`n[5/6] Claude MCP"
if (Get-Command claude -ErrorAction SilentlyContinue) {
  & claude mcp remove agent-coord --scope user 2>$null | Out-Null
  & claude mcp add agent-coord --scope user -- $node $flag "$root/mcp/server.mjs" --tool claude-code
} else {
  Write-Host "  claude CLI not found — skipped"
}

# 6. VS Code extension — install into every detected editor (all windows, current + future)
Write-Host "`n[6/6] VS Code extension"
# Let the Fleet extension find this clone with no per-editor config.
[Environment]::SetEnvironmentVariable('AGENT_COORD_ROOT', $root, 'User')
$env:AGENT_COORD_ROOT = $root
$ext = "$root/vscode-extension"
Push-Location $ext
npx --yes @vscode/vsce package --allow-missing-repository --out "agent-coord-fleet.vsix" 2>&1 | Out-Null
Pop-Location
$vsix = "$ext/agent-coord-fleet.vsix"
$any = $false
foreach ($cli in 'code', 'code-insiders', 'cursor', 'windsurf', 'codium') {
  if (Get-Command $cli -ErrorAction SilentlyContinue) {
    & $cli --install-extension $vsix --force 2>&1 | Out-Null
    Write-Host "  installed into $cli  (reload open windows; new windows auto-load)"
    $any = $true
  }
}
if (-not $any) { Write-Host "  no VS Code-family editor found on PATH" }

Write-Host "`n== health check ==" -ForegroundColor Cyan
& $node $flag "$root/cli/doctor.mjs"
Write-Host "`nDone. New terminals/sessions pick this up automatically." -ForegroundColor Green
