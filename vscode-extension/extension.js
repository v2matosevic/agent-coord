const vscode = require("vscode");
const { execFile } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

// VS Code's extension-host Node may not ship node:sqlite, so we never read the
// store in-process — we shell out to the SYSTEM node running cli/state-json.mjs
// and push the result into the webview. Zero extension dependencies.

function nonce() {
  const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let t = "";
  for (let i = 0; i < 24; i++) t += c[Math.floor(Math.random() * c.length)];
  return t;
}

function getHtml(ctx) {
  const n = nonce();
  let html = readFileSync(join(ctx.extensionPath, "media", "fleet.html"), "utf8");
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';`;
  html = html.replace("<head>", `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp}">`);
  return html.replace(/__NONCE__/g, n);
}

function fetchState(cb) {
  const cfg = vscode.workspace.getConfiguration("agentCoord");
  // Portable: the setting wins, else AGENT_COORD_ROOT (setup.ps1 sets this), so
  // the extension finds the project wherever it was cloned — no baked-in path.
  const root = cfg.get("root") || process.env.AGENT_COORD_ROOT || "";
  const node = cfg.get("node") || "node";
  const empty = { agents: [], fileLeases: [], resourceLeases: [], queue: [], recent: [], degraded: false };
  if (!root) return cb({ ...empty, error: "Set agentCoord.root (or the AGENT_COORD_ROOT env var) to your agent-coord clone path." });
  execFile(node, ["--disable-warning=ExperimentalWarning", `${root}/cli/state-json.mjs`], { timeout: 8000, windowsHide: true }, (err, stdout) => {
    if (err) return cb({ ...empty, error: err.message });
    try {
      cb(JSON.parse(stdout));
    } catch {
      cb({ ...empty, error: "bad json" });
    }
  });
}

function startPolling(target) {
  const ms = vscode.workspace.getConfiguration("agentCoord").get("refreshMs") || 2000;
  const poll = () => fetchState((s) => {
    try {
      target.postMessage(s);
    } catch {}
  });
  poll();
  const handle = setInterval(poll, ms);
  return { stop: () => clearInterval(handle), poll };
}

class FleetProvider {
  constructor(ctx) {
    this.ctx = ctx;
  }
  resolveWebviewView(view) {
    view.webview.options = { enableScripts: true };
    view.webview.html = getHtml(this.ctx);
    const p = startPolling(view.webview);
    this.poll = p.poll;
    view.onDidDispose(() => p.stop());
  }
}

function activate(ctx) {
  const provider = new FleetProvider(ctx);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider("agentCoordFleet", provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("agentCoord.refresh", () => provider.poll && provider.poll()),
    vscode.commands.registerCommand("agentCoord.openDashboard", () => {
      const panel = vscode.window.createWebviewPanel("agentCoordPanel", "Agent Fleet", vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
      });
      panel.webview.html = getHtml(ctx);
      const p = startPolling(panel.webview);
      panel.onDidDispose(() => p.stop());
    }),
  );
}

module.exports = { activate, deactivate() {} };
