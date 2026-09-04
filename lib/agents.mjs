import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeTxn, nowIso, isoAgoMs } from "./store.mjs";
import { COORD_HOME } from "./identity.mjs";
import { DEAD_MS, HB_THROTTLE_MS } from "./config.mjs";

// Local heartbeat marker — the write-lock diet for the hot path. Hooks fire on
// every tool call and each used to open a BEGIN IMMEDIATE txn just to bump
// last_heartbeat by a few seconds. The marker file's mtime records the last
// SUCCESSFUL DB heartbeat for this agent on this machine (the store is
// machine-local, so a local file can't lie about a remote writer); while it's
// fresh (< HB_THROTTLE_MS, well under DEAD_MS) a bare heartbeat is a no-op and
// callers may skip ensureAgent too. Every skip is fail-open to correctness:
// any fs error reads as "not fresh" → full DB path. markDead removes the
// marker so a released/ended agent is re-registered by its next event, not
// silently skipped while its row says dead.
const hbPath = (agentId) => join(COORD_HOME, "hb", encodeURIComponent(String(agentId)));

export function heartbeatFresh(agentId) {
  try {
    return Date.now() - statSync(hbPath(agentId)).mtimeMs < HB_THROTTLE_MS;
  } catch {
    return false;
  }
}

function touchHeartbeat(agentId) {
  try {
    mkdirSync(join(COORD_HOME, "hb"), { recursive: true });
    writeFileSync(hbPath(agentId), "");
  } catch {}
}

function clearHeartbeat(agentId) {
  try {
    rmSync(hbPath(agentId), { force: true });
  } catch {}
}

// Upsert an agent row and refresh its heartbeat. Used at SessionStart and on
// every guarded tool call, so a resumed session (whose SessionStart hook never
// fired) still gets a row — important, because another agent's conflict check
// joins on this row to decide whether a lease holder is alive.
export function ensureAgent(
  db,
  { agentId, tool = "claude-code", repoPath = null, branch = null, task = null, pid = null, sessionToken = null, replaceContext = false },
) {
  writeTxn(db, () => {
    db.prepare(
      `INSERT INTO agents(agent_id,tool,pid,proc_start_time,repo_path,branch,worktree_path,current_task,status,registered_at,last_heartbeat,session_token)
       VALUES(?,?,?,?,?,?,?,?,'active',?,?,?)
       ON CONFLICT(agent_id) DO UPDATE SET
         tool=excluded.tool,
         repo_path=CASE WHEN ? THEN excluded.repo_path ELSE COALESCE(excluded.repo_path, agents.repo_path) END,
         branch=CASE WHEN ? THEN excluded.branch ELSE COALESCE(excluded.branch, agents.branch) END,
         current_task=COALESCE(excluded.current_task, agents.current_task),
         status='active',
         last_heartbeat=excluded.last_heartbeat`,
    ).run(agentId, tool, pid, nowIso(), repoPath, branch, null, task, nowIso(), nowIso(), sessionToken, Number(replaceContext), Number(replaceContext));
  });
  touchHeartbeat(agentId);
}

// Presence throttling must not suppress a real workspace/branch/tool change.
// Read the row on the warm path; only a changed context needs a write.
export function ensureAgentContext(db, options) {
  const row = heartbeatFresh(options.agentId)
    ? db.prepare("SELECT tool, repo_path, branch, status FROM agents WHERE agent_id=?").get(options.agentId)
    : null;
  if (!row || row.status !== "active" || row.tool !== options.tool ||
      row.repo_path !== (options.repoPath ?? null) || row.branch !== (options.branch ?? null)) {
    ensureAgent(db, { ...options, replaceContext: true });
  }
}

// A bare heartbeat (no task) is skipped while the marker is fresh — the DB row
// is at most HB_THROTTLE_MS stale, which every liveness check tolerates
// (DEAD_MS is 4x). A task-carrying heartbeat always writes (it changes state).
export function heartbeat(db, agentId, task = null) {
  if (!task && heartbeatFresh(agentId)) return;
  writeTxn(db, () => {
    if (task) {
      db.prepare(`UPDATE agents SET last_heartbeat=?, status='active', current_task=? WHERE agent_id=?`).run(nowIso(), task, agentId);
    } else {
      db.prepare(`UPDATE agents SET last_heartbeat=?, status='active' WHERE agent_id=?`).run(nowIso(), agentId);
    }
  });
  touchHeartbeat(agentId);
}

// announce_intent's write: the declared lane survives prompt-driven
// current_task updates, and overlap detection prefers it (see overlap.mjs).
export function setIntent(db, agentId, intent) {
  writeTxn(db, () => {
    db.prepare(`UPDATE agents SET intent=?, current_task=?, last_heartbeat=?, status='active' WHERE agent_id=?`).run(
      intent, intent, nowIso(), agentId,
    );
  });
  touchHeartbeat(agentId);
}

export function markDead(db, agentId) {
  writeTxn(db, () => db.prepare(`UPDATE agents SET status='dead' WHERE agent_id=?`).run(agentId));
  // Drop the marker so the next event fully re-registers this id instead of
  // skipping ensureAgent against a row that now says dead.
  clearHeartbeat(agentId);
}

export function agentAlive(db, agentId) {
  const row = db
    .prepare(`SELECT 1 FROM agents WHERE agent_id=? AND status='active' AND last_heartbeat > ?`)
    .get(agentId, isoAgoMs(DEAD_MS));
  return !!row;
}

// The set of agent ids that are live RIGHT NOW (active + recent heartbeat) — the
// same liveness gate getFleet/conflict checks use. One query, handed to callers
// that must classify many references at once (e.g. annotating message senders).
export function liveAgentIds(db) {
  return new Set(
    db
      .prepare(`SELECT agent_id FROM agents WHERE status='active' AND last_heartbeat > ?`)
      .all(isoAgoMs(DEAD_MS))
      .map((r) => r.agent_id),
  );
}
