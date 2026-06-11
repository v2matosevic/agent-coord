import { writeTxn, nowIso, isoAgoMs } from "./store.mjs";
import { DEAD_MS } from "./config.mjs";

// Upsert an agent row and refresh its heartbeat. Used at SessionStart and on
// every guarded tool call, so a resumed session (whose SessionStart hook never
// fired) still gets a row — important, because another agent's conflict check
// joins on this row to decide whether a lease holder is alive.
export function ensureAgent(
  db,
  { agentId, tool = "claude-code", repoPath = null, branch = null, task = null, pid = null, sessionToken = null },
) {
  writeTxn(db, () => {
    db.prepare(
      `INSERT INTO agents(agent_id,tool,pid,proc_start_time,repo_path,branch,worktree_path,current_task,status,registered_at,last_heartbeat,session_token)
       VALUES(?,?,?,?,?,?,?,?,'active',?,?,?)
       ON CONFLICT(agent_id) DO UPDATE SET
         tool=excluded.tool,
         repo_path=COALESCE(excluded.repo_path, agents.repo_path),
         branch=COALESCE(excluded.branch, agents.branch),
         current_task=COALESCE(excluded.current_task, agents.current_task),
         status='active',
         last_heartbeat=excluded.last_heartbeat`,
    ).run(agentId, tool, pid, nowIso(), repoPath, branch, null, task, nowIso(), nowIso(), sessionToken);
  });
}

export function heartbeat(db, agentId, task = null) {
  writeTxn(db, () => {
    if (task) {
      db.prepare(`UPDATE agents SET last_heartbeat=?, status='active', current_task=? WHERE agent_id=?`).run(nowIso(), task, agentId);
    } else {
      db.prepare(`UPDATE agents SET last_heartbeat=?, status='active' WHERE agent_id=?`).run(nowIso(), agentId);
    }
  });
}

// announce_intent's write: the declared lane survives prompt-driven
// current_task updates, and overlap detection prefers it (see overlap.mjs).
export function setIntent(db, agentId, intent) {
  writeTxn(db, () => {
    db.prepare(`UPDATE agents SET intent=?, current_task=?, last_heartbeat=?, status='active' WHERE agent_id=?`).run(
      intent, intent, nowIso(), agentId,
    );
  });
}

export function markDead(db, agentId) {
  writeTxn(db, () => db.prepare(`UPDATE agents SET status='dead' WHERE agent_id=?`).run(agentId));
}

export function agentAlive(db, agentId) {
  const row = db
    .prepare(`SELECT 1 FROM agents WHERE agent_id=? AND status='active' AND last_heartbeat > ?`)
    .get(agentId, isoAgoMs(DEAD_MS));
  return !!row;
}
