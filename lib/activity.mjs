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

export function getGlobalState(db) {
  const now = nowIso();
  return {
    agents: getFleet(db),
    fileLeases: db.prepare(`SELECT workspace_id,path,agent_id,mode,expires_at FROM file_leases WHERE expires_at > ?`).all(now),
    resourceLeases: db.prepare(`SELECT resource_id,agent_id,expires_at FROM resource_leases WHERE expires_at > ?`).all(now),
    queue: db.prepare(`SELECT kind,key,agent_id FROM lease_queue`).all(),
    recent: recentActivity(db, 15),
  };
}
