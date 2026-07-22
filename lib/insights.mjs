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

// The payoff counters — what coordination actually DID over the window, from
// events already logged: hard blocks (a concurrent same-file edit or resource
// collision that did NOT happen), duplicate-work stand-downs, yield requests,
// and how many file blocks resolved THEMSELVES (the blocked agent later got
// the same path — the warm/cold self-heal working with no human involved).
// Powers the "what it saved you" line in insights/digest and the dashboard.
export function coordinationROI(db, { windowMs = 7 * 86400000, workspaceId = null } = {}) {
  const cut = isoAgoMs(windowMs);
  const sql =
    "SELECT ts, agent_id, workspace_id, event, detail FROM activity_log WHERE ts > ? AND event IN ('conflict','resource-conflict','overlap-block','yield-request','claim','edit')" +
    (workspaceId ? " AND workspace_id=?" : "");
  const rows = workspaceId ? db.prepare(sql).all(cut, workspaceId) : db.prepare(sql).all(cut);
  // Latest claim/edit per (agent, ws, path) — a conflict with a LATER one of
  // these from the same agent on the same path means the block self-resolved.
  const later = new Map();
  for (const r of rows) {
    if (r.event !== "claim" && r.event !== "edit") continue;
    const k = r.agent_id + "|" + r.workspace_id + "|" + r.detail;
    if (!later.has(k) || later.get(k) < r.ts) later.set(k, r.ts);
  }
  const counts = { conflict: 0, "resource-conflict": 0, "overlap-block": 0, "yield-request": 0 };
  let selfHealed = 0;
  const agents = new Set();
  for (const r of rows) {
    agents.add(r.agent_id);
    if (!(r.event in counts)) continue;
    counts[r.event]++;
    if (r.event === "conflict" && (later.get(r.agent_id + "|" + r.workspace_id + "|" + r.detail) || "") > r.ts) selfHealed++;
  }
  return {
    windowMs,
    fileBlocks: counts.conflict,
    resourceBlocks: counts["resource-conflict"],
    dupWorkBlocks: counts["overlap-block"],
    yieldRequests: counts["yield-request"],
    selfHealedBlocks: selfHealed,
    activeAgents: agents.size,
  };
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
