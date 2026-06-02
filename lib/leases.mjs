import { randomUUID } from "node:crypto";
import { writeTxn, nowIso, isoAgoMs, isoInSec } from "./store.mjs";
import { DEAD_MS, FILE_TTL_SEC, RESOURCE_TTL_SEC, FILE_ACTIVE_MS } from "./config.mjs";

function upsertWorkspace(db, ws, repoPath, branch) {
  db.prepare(
    `INSERT INTO workspaces(workspace_id,repo_path,branch) VALUES(?,?,?)
     ON CONFLICT(workspace_id) DO UPDATE SET repo_path=excluded.repo_path, branch=excluded.branch`,
  ).run(ws, repoPath, branch);
}

// The load-bearing operation. The conflict check and the lease insert run in
// ONE BEGIN IMMEDIATE transaction, so under N concurrent claimers exactly one
// can win — that atomicity is the whole guarantee.
//
// A lease blocks only if its holder is a DIFFERENT agent that is still alive
// (recent heartbeat), unexpired, AND still "warm" — it touched THIS file within
// FILE_ACTIVE_MS. A cold lease (holder moved on) does not block: the waiting
// agent takes the file automatically, so a past edit never wedges a live session.
// Requesting `exclusive` conflicts with any warm live lease; `shared` only with a
// warm live `exclusive` lease.
export function claimFile(
  db,
  { agentId, workspaceId, repoPath = null, branch = null, path, mode = "exclusive", ttlSec = FILE_TTL_SEC, reason = null, contentHash = null },
) {
  return writeTxn(db, () => {
    upsertWorkspace(db, workspaceId, repoPath, branch);
    const coldcut = isoAgoMs(FILE_ACTIVE_MS);
    const holders = db
      .prepare(
        `SELECT l.lease_id, l.agent_id, l.mode, l.acquired_at, a.current_task
         FROM file_leases l JOIN agents a ON a.agent_id = l.agent_id
         WHERE l.workspace_id=? AND l.path=? AND l.agent_id<>?
           AND a.status='active' AND a.last_heartbeat > ? AND l.expires_at > ? AND l.acquired_at > ?`,
      )
      .all(workspaceId, path, agentId, isoAgoMs(DEAD_MS), nowIso(), coldcut);

    const blocking = mode === "exclusive" ? holders : holders.filter((h) => h.mode === "exclusive");
    if (blocking.length) return { granted: false, conflict: blocking[0], holders: blocking };

    // Granting: clear our own prior lease AND any cold leases from others on this
    // path (we're effectively taking over a file they walked away from).
    db.prepare(`DELETE FROM file_leases WHERE workspace_id=? AND path=? AND (agent_id=? OR acquired_at <= ?)`).run(workspaceId, path, agentId, coldcut);
    const leaseId = randomUUID();
    db.prepare(
      `INSERT INTO file_leases(lease_id,workspace_id,path,agent_id,mode,content_hash,reason,acquired_at,expires_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(leaseId, workspaceId, path, agentId, mode, contentHash, reason, nowIso(), isoInSec(ttlSec));
    return { granted: true, leaseId };
  });
}

// Read-only conflict check (no claim) — for awareness tools / the MCP server.
// Same warmth gate as claimFile: a cold lease isn't a real conflict.
export function peekConflicts(db, { workspaceId, path, agentId = "__none__", mode = "exclusive" }) {
  const holders = db
    .prepare(
      `SELECT l.agent_id, l.mode, l.acquired_at, a.current_task FROM file_leases l JOIN agents a ON a.agent_id=l.agent_id
       WHERE l.workspace_id=? AND l.path=? AND l.agent_id<>? AND a.status='active' AND a.last_heartbeat>? AND l.expires_at>? AND l.acquired_at>?`,
    )
    .all(workspaceId, path, agentId, isoAgoMs(DEAD_MS), nowIso(), isoAgoMs(FILE_ACTIVE_MS));
  return mode === "exclusive" ? holders : holders.filter((h) => h.mode === "exclusive");
}

export function releaseFile(db, { agentId, workspaceId, path }) {
  return writeTxn(db, () => {
    const r = db.prepare(`DELETE FROM file_leases WHERE workspace_id=? AND path=? AND agent_id=?`).run(workspaceId, path, agentId);
    db.prepare(`DELETE FROM lease_queue WHERE kind='file' AND key=? AND agent_id=?`).run(workspaceId + "||" + path, agentId);
    return { released: r.changes };
  });
}

export function enqueue(db, { kind, key, agentId, ttlSec = FILE_TTL_SEC }) {
  writeTxn(db, () => {
    const ex = db.prepare(`SELECT seq FROM lease_queue WHERE kind=? AND key=? AND agent_id=?`).get(kind, key, agentId);
    if (!ex) db.prepare(`INSERT INTO lease_queue(kind,key,agent_id,requested_at,ttl_s) VALUES(?,?,?,?,?)`).run(kind, key, agentId, nowIso(), ttlSec);
  });
}

// Machine-wide singletons (ports, dev DB, deploy/DNS) — orthogonal to rooms, so
// two agents in different repos still contend.
export function claimResource(db, { agentId, resourceId, ttlSec = RESOURCE_TTL_SEC, reason = null }) {
  return writeTxn(db, () => {
    const holder = db
      .prepare(
        `SELECT r.agent_id, a.current_task FROM resource_leases r JOIN agents a ON a.agent_id=r.agent_id
         WHERE r.resource_id=? AND r.agent_id<>? AND a.status='active' AND a.last_heartbeat > ? AND r.expires_at > ?`,
      )
      .get(resourceId, agentId, isoAgoMs(DEAD_MS), nowIso());
    if (holder) return { granted: false, conflict: holder };
    db.prepare(
      `INSERT INTO resource_leases(resource_id,agent_id,reason,acquired_at,expires_at) VALUES(?,?,?,?,?)
       ON CONFLICT(resource_id) DO UPDATE SET agent_id=excluded.agent_id, reason=excluded.reason, acquired_at=excluded.acquired_at, expires_at=excluded.expires_at`,
    ).run(resourceId, agentId, reason, nowIso(), isoInSec(ttlSec));
    return { granted: true };
  });
}

export function releaseResource(db, { agentId, resourceId }) {
  return writeTxn(db, () => db.prepare(`DELETE FROM resource_leases WHERE resource_id=? AND agent_id=?`).run(resourceId, agentId).changes);
}

export function releaseAllForAgent(db, agentId) {
  return writeTxn(db, () => {
    const f = db.prepare(`DELETE FROM file_leases WHERE agent_id=?`).run(agentId).changes;
    const r = db.prepare(`DELETE FROM resource_leases WHERE agent_id=?`).run(agentId).changes;
    db.prepare(`DELETE FROM lease_queue WHERE agent_id=?`).run(agentId);
    return { files: f, resources: r };
  });
}
