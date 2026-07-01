import { writeTxn, nowIso, isoAgoMs } from "./store.mjs";
import { DEAD_MS } from "./config.mjs";

export function logActivity(db, { agentId, workspaceId = null, event, detail = null }) {
  writeTxn(db, () =>
    db.prepare(`INSERT INTO activity_log(ts,agent_id,workspace_id,event,detail) VALUES(?,?,?,?,?)`).run(nowIso(), agentId, workspaceId, event, detail),
  );
}

// Live agents + the single file each currently holds (for the statusline/CLI).
// N+1 query, but N is a handful — clearer than a correlated subquery with
// position-sensitive params.
export function getFleet(db) {
  const agents = db
    .prepare(`SELECT agent_id,tool,repo_path,branch,current_task,registered_at,last_heartbeat FROM agents WHERE status='active' AND last_heartbeat > ?`)
    .all(isoAgoMs(DEAD_MS));
  const leaseStmt = db.prepare(`SELECT path,mode FROM file_leases WHERE agent_id=? AND expires_at > ? ORDER BY acquired_at DESC LIMIT 1`);
  const now = nowIso();
  return agents.map((a) => ({ ...a, editing: leaseStmt.get(a.agent_id, now)?.path ?? null }));
}

export function queueDepth(db, workspaceId) {
  const r = db.prepare(`SELECT COUNT(*) c FROM lease_queue WHERE kind='file' AND key LIKE ?`).get(workspaceId + "||%");
  return r?.c ?? 0;
}

export function recentActivity(db, limit = 12) {
  return db.prepare(`SELECT ts,agent_id,event,detail FROM activity_log ORDER BY seq DESC LIMIT ?`).all(limit);
}

// Whole-machine snapshot. Default is COMPLETE lists: this feeds human-facing
// surfaces (menubar, dashboard, snapshot.json -> fleet view, state-json) that
// derive counts and lease-contention badges from list lengths — clipping those
// would hide real conflicts and misreport load exactly when the fleet is
// busiest. `cap` (rows per list) is opt-in for the one consumer whose output
// lands in model context (the MCP get_global_state tool); a capped list keeps
// the newest rows and never truncates silently — the `note` says what was
// clipped, so a partial dump can't read as "that was everything".
export function getGlobalState(db, { cap = 0 } = {}) {
  const now = nowIso();
  if (!(cap > 0)) {
    return {
      agents: getFleet(db),
      fileLeases: db.prepare(`SELECT workspace_id,path,agent_id,mode,expires_at FROM file_leases WHERE expires_at > ?`).all(now),
      resourceLeases: db.prepare(`SELECT resource_id,agent_id,expires_at FROM resource_leases WHERE expires_at > ?`).all(now),
      queue: db.prepare(`SELECT kind,key,agent_id FROM lease_queue`).all(),
      tasks: db.prepare(`SELECT task_id,workspace_id,title,status,owner_agent FROM tasks WHERE status<>'done' ORDER BY created_at`).all(),
      recent: recentActivity(db, 15),
    };
  }
  const over = [];
  // Fetch cap+1 to detect overflow without counting; slice + record the name.
  const take = (name, rows) => (rows.length > cap ? (over.push(name), rows.slice(0, cap)) : rows);
  const state = {
    agents: getFleet(db),
    fileLeases: take("fileLeases", db.prepare(`SELECT workspace_id,path,agent_id,mode,expires_at FROM file_leases WHERE expires_at > ? ORDER BY acquired_at DESC LIMIT ?`).all(now, cap + 1)),
    resourceLeases: take("resourceLeases", db.prepare(`SELECT resource_id,agent_id,expires_at FROM resource_leases WHERE expires_at > ? ORDER BY acquired_at DESC LIMIT ?`).all(now, cap + 1)),
    queue: take("queue", db.prepare(`SELECT kind,key,agent_id FROM lease_queue ORDER BY seq DESC LIMIT ?`).all(cap + 1)),
    tasks: take("tasks", db.prepare(`SELECT task_id,workspace_id,title,status,owner_agent FROM tasks WHERE status<>'done' ORDER BY created_at DESC LIMIT ?`).all(cap + 1)),
    recent: recentActivity(db, 15),
  };
  if (over.length) state.note = `${over.join("/")} capped at ${cap} newest rows — use check_conflicts/list_tasks for a scoped view.`;
  return state;
}
