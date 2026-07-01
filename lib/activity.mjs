import { writeTxn, nowIso, isoAgoMs } from "./store.mjs";
import { DEAD_MS, STATE_LIST_MAX } from "./config.mjs";

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

// Whole-machine snapshot for the MCP tool. Each list is capped (this lands in
// model context) but never silently: fetch cap+1, and when a list overflows say
// so in `note` with the pointed tool for the full view — a truncated dump must
// not read as "that was everything".
export function getGlobalState(db) {
  const now = nowIso();
  const cap = (rows) => (rows.length > STATE_LIST_MAX ? rows.slice(0, STATE_LIST_MAX) : rows);
  const fileLeases = db
    .prepare(`SELECT workspace_id,path,agent_id,mode,expires_at FROM file_leases WHERE expires_at > ? ORDER BY acquired_at DESC LIMIT ?`)
    .all(now, STATE_LIST_MAX + 1);
  const queue = db.prepare(`SELECT kind,key,agent_id FROM lease_queue ORDER BY seq DESC LIMIT ?`).all(STATE_LIST_MAX + 1);
  const tasks = db
    .prepare(`SELECT task_id,workspace_id,title,status,owner_agent FROM tasks WHERE status<>'done' ORDER BY created_at DESC LIMIT ?`)
    .all(STATE_LIST_MAX + 1);
  const over = [fileLeases.length > STATE_LIST_MAX && "fileLeases", queue.length > STATE_LIST_MAX && "queue", tasks.length > STATE_LIST_MAX && "tasks"].filter(Boolean);
  const state = {
    agents: getFleet(db),
    fileLeases: cap(fileLeases),
    resourceLeases: db.prepare(`SELECT resource_id,agent_id,expires_at FROM resource_leases WHERE expires_at > ?`).all(now),
    queue: cap(queue),
    tasks: cap(tasks),
    recent: recentActivity(db, 15),
  };
  if (over.length) state.note = `${over.join("/")} capped at ${STATE_LIST_MAX} newest rows — use check_conflicts/list_tasks for a scoped view.`;
  return state;
}
