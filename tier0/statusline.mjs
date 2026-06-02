import { readFileSync } from "node:fs";
import { agentIdFromSession } from "./lib/identity.mjs";
import { gitContext } from "./lib/git-context.mjs";
import {
  listPresence,
  writePresence,
  readExisting,
  prune,
} from "./lib/presence-store.mjs";

// Claude Code statusline command. Renders the live fleet (this window's repo
// first, other windows/repos after) and flags two agents editing the same file
// in red. Also self-heartbeats so an open-but-idle session stays visible.

const STALE_MS = 3 * 60 * 1000; // hide agents not refreshed in 3 min
const GC_MS = 60 * 60 * 1000; // delete presence files older than 1h
const MAX_SHOWN = 6;
const COLOR = !process.env.NO_COLOR;

const wrap = (code, s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const accent = (s) => wrap("38;2;204;35;35", s); // brand red (#cc2323)
const dim = (s) => wrap("2", s);

function readInput() {
  try {
    return JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

function shorten(s, n = 22) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function shortName(id) {
  return id.replace(/-\d+$/, "");
}

function detailOf(a) {
  if (a.editing) return ` ⚙ ${shorten(a.editing)}`;
  if (a.task) return ` “${shorten(a.task, 26)}”`;
  return "";
}

function heartbeat(myId, sessionId, cwd) {
  try {
    const prev = readExisting(myId);
    const base =
      prev ??
      (() => {
        const g = gitContext(cwd);
        return {
          agentId: myId,
          tool: "claude-code",
          sessionId,
          cwd,
          repoRoot: g.repoRoot,
          repoName: g.repoName,
          branch: g.branch,
          task: null,
          editing: null,
          lastTool: null,
          startedAt: new Date().toISOString(),
        };
      })();
    writePresence({ ...base, lastEvent: "statusline", updatedAt: new Date().toISOString() });
  } catch {}
}

function render() {
  const input = readInput();
  const sessionId = input.session_id || "unknown";
  const myId = agentIdFromSession(sessionId);
  const cwd = input.cwd || input.workspace?.current_dir || process.cwd();

  heartbeat(myId, sessionId, cwd);

  const now = Date.now();
  const live = listPresence().filter((a) => now - (a._mtimeMs ?? 0) < STALE_MS);
  prune(GC_MS);

  const me = live.find((a) => a.agentId === myId);
  const myRepo = me?.repoRoot ?? gitContext(cwd).repoRoot;
  const others = live.filter((a) => a.agentId !== myId);

  const sameRepo = (a) => a.repoRoot && myRepo && a.repoRoot === myRepo;
  const here = others.filter(sameRepo);
  const elsewhere = others.filter((a) => !sameRepo(a));

  // Same-file collision among everyone in my repo (including me).
  const byFile = new Map();
  for (const a of [...here, ...(me ? [me] : [])]) {
    if (!a.editing) continue;
    byFile.set(a.editing, [...(byFile.get(a.editing) || []), a.agentId]);
  }
  const conflicts = new Set(
    [...byFile.entries()].filter(([, v]) => v.length > 1).map(([k]) => k),
  );

  const total = live.length;
  if (total <= 1) {
    process.stdout.write(dim("◆ coord: solo"));
    return;
  }

  const fmt = (a, withRepo) => {
    if (a.editing && conflicts.has(a.editing)) {
      return accent("⚠ " + shortName(a.agentId) + detailOf(a));
    }
    const repoTag = withRepo && a.repoName ? dim(a.repoName + ":") : "";
    return repoTag + shortName(a.agentId) + dim(detailOf(a));
  };

  const group = (agents, withRepo) => {
    const shown = agents.slice(0, MAX_SHOWN).map((a) => fmt(a, withRepo));
    const extra = agents.length > MAX_SHOWN ? dim(` +${agents.length - MAX_SHOWN}`) : "";
    return shown.join(dim(" · ")) + extra;
  };

  const parts = [accent("◆") + " " + total + " agents"];
  if (here.length) parts.push("here: " + group(here, false));
  if (elsewhere.length) parts.push(group(elsewhere, true));

  let line = parts.join(dim(" │ "));
  if (conflicts.size) line = accent("⚠ SAME FILE ") + line;
  process.stdout.write(line);
}

try {
  render();
} catch {
  process.stdout.write("");
}
