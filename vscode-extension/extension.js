const vscode = require("vscode");
const { execFile } = require("node:child_process");
const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const os = require("node:os");

// Data path, in order of preference:
//   1. Read ~/.agent-coord/snapshot.json directly. The Claude statusline rewrites
//      it every few seconds, so while any agent is live it's fresh — and reading a
//      file needs no subprocess, no node:sqlite, and no node>=22 on the extension
//      host PATH (fnm's node lives at an ephemeral per-shell path the host can't
//      see). This is the common, zero-config case.
//   2. If the snapshot is missing or stale, shell out to the SYSTEM node running
//      cli/state-json.mjs to read the store live (this also rewrites the snapshot).
//      The repo path comes from the snapshot's own `root` field, else config/env.
// Zero extension dependencies.

const SNAPSHOT = join(os.homedir(), ".agent-coord", "snapshot.json");
const STALE_MS = 12000; // snapshot older than this → try a live refresh via node
const NODE_CANDIDATES = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];

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

function readSnapshot() {
  try {
    return JSON.parse(readFileSync(SNAPSHOT, "utf8"));
  } catch {
    return null;
  }
}

const ageMs = (iso) => {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? Date.now() - t : Infinity;
};

// Fallback: read the store live. Tries the configured node, then PATH `node`,
// then common absolute installs. Roots itself from the snapshot or config/env.
function fetchViaNode(snap, cb) {
  const cfg = vscode.workspace.getConfiguration("agentCoord");
  const root = cfg.get("root") || (snap && snap.root) || process.env.AGENT_COORD_ROOT || "";
  if (!root) return cb(null);
  const configured = cfg.get("node");
  const candidates = [configured, "node", ...NODE_CANDIDATES].filter(Boolean);
  const script = join(root, "cli", "state-json.mjs");
  let i = 0;
  const tryNext = () => {
    if (i >= candidates.length) return cb(null);
    const node = candidates[i++];
    execFile(node, ["--disable-warning=ExperimentalWarning", script], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err) return tryNext();
      try {
        cb(JSON.parse(stdout));
      } catch {
        tryNext();
      }
    });
  };
  tryNext();
}

function startPolling(target) {
  const ms = vscode.workspace.getConfiguration("agentCoord").get("refreshMs") || 2000;
  const poll = () => {
    const snap = readSnapshot();
    if (snap && ageMs(snap.generatedAt) < STALE_MS) {
      try {
        target.postMessage(snap);
      } catch {}
      return;
    }
    // Snapshot missing or stale: attempt a live read, fall back to the old snapshot.
    fetchViaNode(snap, (live) => {
      let payload;
      if (live) payload = live;
      else if (snap) payload = { ...snap, stale: true };
      else
        payload = {
          agents: [],
          fileLeases: [],
          resourceLeases: [],
          queue: [],
          tasks: [],
          recent: [],
          error: "No fleet data yet. Start a Claude or Codex session (its statusline keeps this view fresh). If agents are running and this persists, set agentCoord.root to your agent-coord clone.",
        };
      try {
        target.postMessage(payload);
      } catch {}
    });
  };
  poll();
  const handle = setInterval(poll, ms);
  return { stop: () => clearInterval(handle), poll };
}

// Open a claimed file in the editor when clicked in the webview. Lease paths are
// repo-relative POSIX; resolve against the holding agent's repo_path.
function openClaim(msg) {
  if (!msg || !msg.path) return;
  let abs = msg.path;
  if (msg.repo && !abs.startsWith("/")) abs = join(msg.repo, msg.path);
  vscode.workspace.openTextDocument(vscode.Uri.file(abs)).then(
    (doc) => vscode.window.showTextDocument(doc, { preview: true }),
    () => vscode.window.showWarningMessage(`agent-coord: couldn't open ${abs}`),
  );
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
    view.webview.onDidReceiveMessage((m) => {
      if (m && m.type === "open") openClaim(m);
      if (m && m.type === "ready" && this.poll) this.poll();
    });
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
      panel.webview.onDidReceiveMessage((m) => m && m.type === "open" && openClaim(m));
      panel.onDidDispose(() => p.stop());
    }),
  );
}

module.exports = { activate, deactivate() {} };
