import { writeTxn, nowIso, setDegraded } from "./store.mjs";
import { DEAD_MS, FILE_ACTIVE_MS, FILE_TTL_SEC } from "./config.mjs";

export const WAIT_RETENTION_MS = 7 * 86400000;
const iso = (ms) => new Date(ms).toISOString();
const ms = (v) => new Date(v).getTime();

// Observability must not turn a known collision into a fail-open write.
// A savepoint rolls back only telemetry if its table/trigger fails, leaving the
// surrounding lease transaction and its denial/grant decision intact.
export function observeContention(db, fn) {
  try {
    db.exec("SAVEPOINT coord_observation");
    const result = fn();
    db.exec("RELEASE coord_observation");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK TO coord_observation; RELEASE coord_observation"); } catch {}
    setDegraded(error);
    process.stderr.write(`agent-coord: contention observation unavailable: ${error.message}\n`);
  }
}

// Metrics share the lease gates, but never change or grant a lease. Returned
// end times for expiry are modeled deadlines; release/claim are observed times.
function state(db, row, now) {
  const waiter = db.prepare("SELECT status,last_heartbeat FROM agents WHERE agent_id=?").get(row.agent_id);
  if (!waiter || waiter.status !== "active" || ms(waiter.last_heartbeat) + DEAD_MS <= now) {
    return { at: Math.min(now, waiter?.status === "active" ? ms(waiter.last_heartbeat) + DEAD_MS : now), outcome: "abandoned" };
  }
  if (ms(row.started_at) + FILE_TTL_SEC * 1000 <= now) return { at: ms(row.started_at) + FILE_TTL_SEC * 1000, outcome: "wait-expired" };
  const holders = db.prepare(`SELECT l.*,a.status,a.last_heartbeat FROM file_leases l LEFT JOIN agents a USING(agent_id)
    WHERE l.workspace_id=? AND l.path=? AND l.agent_id<>?`).all(row.workspace_id, row.path, row.agent_id)
    .filter(h => row.mode === "exclusive" || h.mode === "exclusive");
  const deadlines = holders.map(h => {
    if (h.status !== "active") return { at: now, outcome: "holder-ended" };
    const gates = [
      { at: ms(h.acquired_at) + FILE_ACTIVE_MS, outcome: "cold" },
      { at: ms(h.expires_at), outcome: "lease-expired" },
      { at: ms(h.last_heartbeat) + DEAD_MS, outcome: "holder-silent" },
    ];
    return gates.sort((a, b) => a.at - b.at)[0];
  });
  if (deadlines.some(d => d.at > now)) return null;
  return deadlines.sort((a, b) => b.at - a.at)[0] || { at: now, outcome: "available" };
}

function close(db, row, at, outcome) {
  db.prepare("UPDATE file_waits SET ended_at=?,outcome=? WHERE wait_id=? AND ended_at IS NULL")
    .run(iso(Math.max(ms(row.started_at), at)), outcome, row.wait_id);
}

// Caller owns a transaction. Scope to a path/agent on ordinary mutations;
// only the throttled reaper scans all pending episodes.
export function settleWaitsInTxn(db, { workspaceId, path, agentId, cancel = false, now = Date.now(), outcome } = {}) {
  const where = ["ended_at IS NULL"], values = [];
  for (const [column, value] of [["workspace_id", workspaceId], ["path", path], ["agent_id", agentId]]) {
    if (value !== undefined) { where.push(column + "=?"); values.push(value); }
  }
  for (const row of db.prepare("SELECT * FROM file_waits WHERE " + where.join(" AND ")).all(...values)) {
    const end = cancel ? { at: now, outcome: outcome || "cancelled" } : state(db, row, now);
    if (end) close(db, row, end.at, end.outcome === "available" && outcome ? outcome : end.outcome);
  }
}

export function recordWaitInTxn(db, { workspaceId, path, agentId, mode = "exclusive" }, holders) {
  settleWaitsInTxn(db, { workspaceId, path });
  const now = nowIso();
  const key = workspaceId + "||" + path;
  const continuing = db.prepare("SELECT 1 FROM file_waits WHERE workspace_id=? AND path=? AND agent_id=? AND ended_at IS NULL").get(workspaceId, path, agentId);
  if (!continuing) db.prepare("DELETE FROM lease_queue WHERE kind='file' AND key=? AND agent_id=?").run(key, agentId);
  const kind = holders.some(h => h.activity_state === "editing") ? "editing"
    : holders.every(h => h.activity_state === "reserved") ? "reservation" : "unknown";
  db.prepare(`INSERT INTO file_waits(workspace_id,path,agent_id,mode,started_at,last_attempt_at,editing_attempts,reservation_attempts,unknown_attempts)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,path,agent_id) WHERE ended_at IS NULL DO UPDATE SET
    last_attempt_at=excluded.last_attempt_at, mode=excluded.mode, attempts=attempts+1,
    editing_attempts=editing_attempts+excluded.editing_attempts,
    reservation_attempts=reservation_attempts+excluded.reservation_attempts,
    unknown_attempts=unknown_attempts+excluded.unknown_attempts`)
    .run(workspaceId, path, agentId, mode, now, now, Number(kind === "editing"), Number(kind === "reservation"), Number(kind === "unknown"));
  // Central enqueue covers MCP claims as well as native guards. Legacy callers'
  // enqueue() is idempotent and must not count a second attempt.
  if (!db.prepare("SELECT 1 FROM lease_queue WHERE kind='file' AND key=? AND agent_id=?").get(key, agentId)) {
    db.prepare("INSERT INTO lease_queue(kind,key,agent_id,requested_at,ttl_s) VALUES('file',?,?,?,?)").run(key, agentId, now, FILE_TTL_SEC);
  }
}

export function finishFileOperation(db, { agentId, operationId }) {
  if (!operationId || !db.prepare("SELECT 1 FROM file_leases WHERE agent_id=? AND operation_id=? AND activity_state='editing'").get(agentId, operationId)) return;
  writeTxn(db, () => db.prepare("UPDATE file_leases SET activity_state='reserved',operation_id=NULL WHERE agent_id=? AND operation_id=?")
    .run(agentId, operationId));
}

// Read first, acknowledge only lines that fit the existing hook context budget.
// Stale/expired waiters never create durable mailbox messages for the holder.
export function holderWaitNotices(db, { agentId, workspaceId, limit = 3, now = Date.now() }) {
  const rows = db.prepare(`SELECT DISTINCT w.* FROM file_waits w JOIN file_leases l
    ON l.workspace_id=w.workspace_id AND l.path=w.path
    WHERE w.ended_at IS NULL AND w.workspace_id=? AND l.agent_id=? AND w.agent_id<>?
    AND (w.mode='exclusive' OR l.mode='exclusive')
    AND NOT EXISTS(SELECT 1 FROM file_wait_notices n WHERE n.wait_id=w.wait_id AND n.holder_id=?)
    ORDER BY w.wait_id LIMIT 100`).all(workspaceId, agentId, agentId, agentId);
  const current = db.prepare("SELECT status,last_heartbeat FROM agents WHERE agent_id=?").get(agentId);
  if (current?.status !== "active" || ms(current.last_heartbeat) + DEAD_MS <= now) return [];
  return rows.filter(row => {
    if (state(db, row, now)) return false;
    const lease = db.prepare("SELECT acquired_at,expires_at FROM file_leases WHERE workspace_id=? AND path=? AND agent_id=?")
      .get(workspaceId, row.path, agentId);
    return lease && ms(lease.acquired_at) + FILE_ACTIVE_MS > now && ms(lease.expires_at) > now;
  }).slice(0, limit).map(row => ({ waitId: row.wait_id, agentId: row.agent_id, path: row.path, startedAt: row.started_at }));
}

export function ackHolderNotices(db, holderId, waitIds) {
  if (!waitIds.length) return [];
  return writeTxn(db, () => {
    const claimed = [];
    for (const id of waitIds) {
      const row = db.prepare("SELECT * FROM file_waits WHERE wait_id=? AND ended_at IS NULL").get(id);
      if (!row || state(db, row, Date.now())) continue;
      const held = db.prepare(`SELECT 1 FROM file_leases l JOIN agents a USING(agent_id)
        WHERE l.workspace_id=? AND l.path=? AND l.agent_id=? AND a.status='active'
        AND a.last_heartbeat>? AND l.acquired_at>? AND l.expires_at>? AND (l.mode='exclusive' OR ?='exclusive')`)
        .get(row.workspace_id, row.path, holderId, iso(Date.now() - DEAD_MS), iso(Date.now() - FILE_ACTIVE_MS), nowIso(), row.mode);
      if (!held) continue;
      const r = db.prepare("INSERT OR IGNORE INTO file_wait_notices(wait_id,holder_id,notified_at) VALUES(?,?,?)").run(id, holderId, nowIso());
      if (r.changes) claimed.push(id);
    }
    return claimed;
  });
}

export function reapContentionInTxn(db, now = Date.now()) {
  settleWaitsInTxn(db, { now });
  db.prepare("DELETE FROM file_waits WHERE ended_at < ?").run(iso(now - WAIT_RETENTION_MS));
  db.prepare("DELETE FROM file_wait_notices WHERE wait_id NOT IN (SELECT wait_id FROM file_waits)").run();
}

export function contentionStats(db, { workspaceId, windowMs = WAIT_RETENTION_MS, now = Date.now() } = {}) {
  const where = workspaceId ? " AND workspace_id=?" : "";
  const args = [iso(now - Math.min(windowMs, WAIT_RETENTION_MS)), ...(workspaceId ? [workspaceId] : [])];
  const rows = db.prepare("SELECT * FROM file_waits WHERE started_at>=?" + where).all(...args);
  const files = new Map();
  for (const row of rows) {
    const key = row.workspace_id + "||" + row.path;
    const file = files.get(key) || { workspaceId: row.workspace_id, path: row.path, episodes: 0, attempts: 0,
      editingAttempts: 0, reservationAttempts: 0, unknownAttempts: 0, waitMs: 0, maxWaitMs: 0, pending: 0, outcomes: {} };
    const end = row.ended_at ? { at: ms(row.ended_at), outcome: row.outcome } : state(db, row, now);
    const duration = Math.max(0, (end?.at ?? now) - ms(row.started_at));
    file.episodes++; file.attempts += row.attempts;
    file.editingAttempts += row.editing_attempts; file.reservationAttempts += row.reservation_attempts; file.unknownAttempts += row.unknown_attempts;
    file.waitMs += duration; file.maxWaitMs = Math.max(file.maxWaitMs, duration);
    file.pending += Number(!end);
    const outcome = end?.outcome || "waiting";
    file.outcomes[outcome] = (file.outcomes[outcome] || 0) + 1;
    files.set(key, file);
  }
  return [...files.values()].sort((a, b) => b.waitMs - a.waitMs || b.episodes - a.episodes);
}
