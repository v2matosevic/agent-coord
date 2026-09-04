import { randomUUID } from "node:crypto";
import { writeTxn, nowIso, isoAgoMs, isoInSec } from "./store.mjs";
import { DEAD_MS, FILE_TTL_SEC, RESOURCE_TTL_SEC, FILE_ACTIVE_MS } from "./config.mjs";
import { recordWaitInTxn, settleWaitsInTxn, observeContention } from "./contention.mjs";

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
  options,
) {
  return writeTxn(db, () => {
    const result = claimFileInTxn(db, options);
    if (!result.granted) observeContention(db, () => recordWaitInTxn(db, options, result.holders));
    return result;
  });
}

// A patch is one operation. A denied file must roll back all new claims and
// preserve any claims we held before this attempt, including their timestamps.
export function claimFiles(db, { paths, ...options }) {
  return claimOperation(db, { ...options, paths });
}

// Reserve the complete operation or nothing, including files and singletons.
// A resource collision must not leave behind an unused file/port reservation.
export function claimOperation(db, { paths = [], resources = [], ...options }) {
  const denied = new Error("operation denied");
  let conflict;
  try {
    return writeTxn(db, () => {
      const results = [];
      for (const path of [...new Set(paths)]) {
        const result = claimFileInTxn(db, { ...options, path });
        if (!result.granted) {
          conflict = { ...result, kind: "file", path };
          throw denied;
        }
        results.push({ path, ...result });
      }
      const resourceResults = [];
      for (const resource of resources) {
        const result = claimResourceInTxn(db, { agentId: options.agentId, ...resource });
        if (!result.granted) {
          conflict = { ...result, kind: "resource", resourceId: resource.resourceId };
          throw denied;
        }
        resourceResults.push({ resourceId: resource.resourceId, ...result });
      }
      return { granted: true, results, resourceResults };
    });
  } catch (e) {
    if (e === denied) {
      // Claims rolled back; keep only the denied attempt's telemetry/queue.
      if (conflict.kind === "file") observeContention(db, () => recordWaitInTxn(db, { ...options, path: conflict.path }, conflict.holders));
      return conflict;
    }
    throw e;
  }
}

function claimFileInTxn(
  db,
  { agentId, workspaceId, repoPath = null, branch = null, path, mode = "exclusive", ttlSec = FILE_TTL_SEC, reason = null, contentHash = null, operationId = null },
) {
    upsertWorkspace(db, workspaceId, repoPath, branch);
    observeContention(db, () => settleWaitsInTxn(db, { workspaceId, path }));
    const coldcut = isoAgoMs(FILE_ACTIVE_MS);
    const holders = db
      .prepare(
        `SELECT l.lease_id, l.agent_id, l.mode, l.acquired_at, l.activity_state, a.current_task
         FROM file_leases l JOIN agents a ON a.agent_id = l.agent_id
         WHERE l.workspace_id=? AND l.path=? AND l.agent_id<>?
           AND a.status='active' AND a.last_heartbeat > ? AND l.expires_at > ? AND l.acquired_at > ?`,
      )
      .all(workspaceId, path, agentId, isoAgoMs(DEAD_MS), nowIso(), coldcut);

    const blocking = mode === "exclusive" ? holders : holders.filter((h) => h.mode === "exclusive");
    if (blocking.length) return { granted: false, conflict: blocking[0], holders: blocking };

    observeContention(db, () => settleWaitsInTxn(db, { workspaceId, path, agentId, cancel: true, outcome: "acquired" }));

    // Granting: clear our own prior lease AND any cold leases from others on this
    // path (we're effectively taking over a file they walked away from). Also
    // drop our own waiter entry — we're no longer waiting for it.
    db.prepare(`DELETE FROM file_leases WHERE workspace_id=? AND path=? AND (agent_id=? OR acquired_at <= ?)`).run(workspaceId, path, agentId, coldcut);
    db.prepare(`DELETE FROM lease_queue WHERE kind='file' AND key=? AND agent_id=?`).run(workspaceId + "||" + path, agentId);
    const leaseId = randomUUID();
    db.prepare(
      `INSERT INTO file_leases(lease_id,workspace_id,path,agent_id,mode,content_hash,reason,acquired_at,expires_at,activity_state,operation_id)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(leaseId, workspaceId, path, agentId, mode, contentHash, reason, nowIso(), isoInSec(ttlSec), operationId ? "editing" : "reserved", operationId);
    return { granted: true, leaseId };
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
    observeContention(db, () => settleWaitsInTxn(db, { workspaceId, path }));
    const r = db.prepare(`DELETE FROM file_leases WHERE workspace_id=? AND path=? AND agent_id=?`).run(workspaceId, path, agentId);
    observeContention(db, () => {
      settleWaitsInTxn(db, { workspaceId, path, agentId, cancel: true });
      settleWaitsInTxn(db, { workspaceId, path, outcome: "released" });
    });
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

// Drain this agent's file waits: every block enqueues a waiter (guard.mjs), and
// this answers "did anything I was blocked on free up since?" — the holder
// released it, went cold, or died. Freed waits are returned ONCE (the row is
// consumed) so the mid-turn channel can say "you can edit it now" exactly once.
// Expired waits (past ttl_s) are dropped silently — by then the turn that
// wanted the file is long over.
export function freedFileWaits(db, { agentId, workspaceId }) {
  const prefix = workspaceId + "||";
  const rows = db
    .prepare(`SELECT seq, key, requested_at, ttl_s FROM lease_queue WHERE kind='file' AND agent_id=? AND key LIKE ?`)
    .all(agentId, prefix + "%");
  if (!rows.length) return [];
  const freed = [];
  const drop = [];
  for (const r of rows) {
    const path = r.key.slice(prefix.length);
    const expired = new Date(r.requested_at).getTime() + (r.ttl_s || FILE_TTL_SEC) * 1000 < Date.now();
    if (expired) {
      drop.push(r.seq);
      continue;
    }
    if (!peekConflicts(db, { workspaceId, path, agentId }).length) {
      freed.push(path);
      drop.push(r.seq);
    }
  }
  if (drop.length) writeTxn(db, () => drop.forEach((s) => db.prepare(`DELETE FROM lease_queue WHERE seq=?`).run(s)));
  return freed;
}

// A singleton lease keyed by an opaque resourceId. Scope lives in the KEY, not
// here: a machine-wide resource (a TCP port) uses a global id so two repos
// contend, while a per-project one (a deploy target) folds the workspace into the
// id so unrelated repos don't (see resource-rules.mjs; BUG 3A). This function just
// enforces "one live holder per id" whatever that id encodes.
export function claimResource(db, options) {
  return writeTxn(db, () => claimResourceInTxn(db, options));
}

function claimResourceInTxn(db, { agentId, resourceId, ttlSec = RESOURCE_TTL_SEC, reason = null }) {
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
}

export function releaseResource(db, { agentId, resourceId }) {
  return writeTxn(db, () => db.prepare(`DELETE FROM resource_leases WHERE resource_id=? AND agent_id=?`).run(resourceId, agentId).changes);
}

export function releaseAllForAgent(db, agentId) {
  return writeTxn(db, () => {
    const paths = db.prepare("SELECT workspace_id,path FROM file_leases WHERE agent_id=?").all(agentId);
    observeContention(db, () => {
      for (const p of paths) settleWaitsInTxn(db, { workspaceId: p.workspace_id, path: p.path });
      settleWaitsInTxn(db, { agentId, cancel: true, outcome: "abandoned" });
    });
    const f = db.prepare(`DELETE FROM file_leases WHERE agent_id=?`).run(agentId).changes;
    observeContention(db, () => {
      for (const p of paths) settleWaitsInTxn(db, { workspaceId: p.workspace_id, path: p.path, outcome: "released" });
    });
    const r = db.prepare(`DELETE FROM resource_leases WHERE agent_id=?`).run(agentId).changes;
    db.prepare(`DELETE FROM lease_queue WHERE agent_id=?`).run(agentId);
    return { files: f, resources: r };
  });
}
