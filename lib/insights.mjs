import { isoAgoMs } from "./store.mjs";

// Shared, read-only analysis over the timeline the system already records
// (activity_log). One source of truth for the insights CLI, the digest writer,
// the just-in-time hotspot warning in claim_files, and the query_history MCP tool.
//
// Privacy: reads ONLY activity_log (never agents.current_task, where verbatim
// client prompts live). Paths are normalized to repo-relative when they sit under
// the workspace root; genuinely cross-repo absolute paths stay their own key.

const normPath = (root, detail) => {
  if (!detail) return detail;
  const d = String(detail).replace(/\\/g, "/");
  if (root) {
    const r = root.replace(/\\/g, "/");
    if (d.toLowerCase() === r.toLowerCase() || d.toLowerCase().startsWith(r.toLowerCase() + "/")) return d.slice(r.length).replace(/^\/+/, "");
  }
  return d;
};

export function repoMap(db) {
  return new Map(db.prepare("SELECT workspace_id, repo_path FROM workspaces").all().map((r) => [r.workspace_id, (r.repo_path || "").replace(/\\/g, "/")]));
}

export function repoName(repos, ws) {
  const p = repos.get(ws);
  return p ? p.replace(/\/+$/, "").split("/").pop() : "?";
}

// Files edited by 2+ distinct agents within the window — serial contention the
// lock structurally can't catch (leases only block CONCURRENT holders). Optionally
// scoped to one workspace (the claim-time warning path wants just this repo).
export function collisionHotspots(db, { windowMs = 7 * 86400000, workspaceId = null } = {}) {
  const cut = isoAgoMs(windowMs);
  const repos = repoMap(db);
  const rows = workspaceId
    ? db.prepare("SELECT workspace_id, agent_id, detail, ts FROM activity_log WHERE event='edit' AND ts > ? AND detail IS NOT NULL AND workspace_id=?").all(cut, workspaceId)
    : db.prepare("SELECT workspace_id, agent_id, detail, ts FROM activity_log WHERE event='edit' AND ts > ? AND detail IS NOT NULL").all(cut);
  const byFile = new Map();
  for (const e of rows) {
    const path = normPath(repos.get(e.workspace_id), e.detail);
    if (!path) continue; // an edit logged against the repo root itself — not a file
    const key = e.workspace_id + " " + path;
    const v = byFile.get(key) || { ws: e.workspace_id, repo: repoName(repos, e.workspace_id), path, agents: new Set(), edits: 0, last: e.ts };
    v.agents.add(e.agent_id);
    v.edits++;
    if (e.ts > v.last) v.last = e.ts;
    byFile.set(key, v);
  }
  return [...byFile.values()]
    .filter((v) => v.agents.size > 1)
    .map((v) => ({ ws: v.ws, repo: v.repo, path: v.path, agents: [...v.agents], edits: v.edits, last: v.last }))
    .sort((a, b) => b.agents.length - a.agents.length || b.edits - a.edits);
}

// Who touched a file (exact) or a directory (prefix) recently — for query_history.
// Scoped to one workspace; returns the distinct agents and the matching events.
export function pathHistory(db, { workspaceId, path, windowMs = 14 * 86400000, limit = 50 }) {
  const cut = isoAgoMs(windowMs);
  const root = repoMap(db).get(workspaceId);
  const q = String(path || "")
    .replace(/\\/g, "/")
    .replace(/^\.?\/+/, "")
    .replace(/\/+$/, "");
  const rows = db
    .prepare("SELECT ts, agent_id, event, detail FROM activity_log WHERE workspace_id=? AND ts > ? AND detail IS NOT NULL AND event IN ('edit','claim','conflict') ORDER BY ts DESC")
    .all(workspaceId, cut);
  const agents = new Set();
  const events = [];
  for (const r of rows) {
    const p = normPath(root, r.detail);
    if (!p) continue;
    if (q && !(p === q || p.startsWith(q + "/"))) continue; // exact file or dir prefix
    agents.add(r.agent_id);
    if (events.length < limit) events.push({ ts: r.ts, agent: r.agent_id, event: r.event, path: p });
  }
  return { path: q, distinctAgents: [...agents], eventCount: events.length, events };
}
