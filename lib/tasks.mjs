import { randomUUID } from "node:crypto";
import { writeTxn, nowIso, isoAgoMs } from "./store.mjs";
import { DEAD_MS } from "./config.mjs";

// Shared task board — the structural answer to "two agents on one vague prompt
// build the same thing." Instead of inferring overlap from task TEXT (overlap.mjs),
// agents claim discrete units of work here: claim a task and every other agent
// sees it's taken. Workspace-scoped (a per-repo board), atomic claims (one winner
// under a race, like file leases), dead-owner auto-reclaim, and a simple
// depends_on list so a blocked task is visible.

const STATUSES = new Set(["open", "claimed", "done", "blocked"]);
const shortId = () => "t-" + randomUUID().replace(/-/g, "").slice(0, 6);
const normTitle = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// Create a task. Dedups against an existing non-done task with the same
// normalized title in this workspace, so two agents announcing the same work
// land on ONE task (returns {created:false} for the existing one).
export function createTask(db, { workspaceId, title, detail = null, dependsOn = null, createdBy = null }) {
  return writeTxn(db, () => {
    const want = normTitle(title);
    if (want) {
      const dup = db
        .prepare("SELECT task_id, title FROM tasks WHERE workspace_id=? AND status<>'done'")
        .all(workspaceId)
        .find((r) => normTitle(r.title) === want);
      if (dup) return { taskId: dup.task_id, created: false };
    }
    const id = shortId();
    const deps = Array.isArray(dependsOn) ? dependsOn.join(",") : dependsOn || null;
    db.prepare(
      `INSERT INTO tasks(task_id,workspace_id,title,status,owner_agent,depends_on,detail,created_by,created_at,updated_at)
       VALUES(?,?,?,'open',NULL,?,?,?,?,?)`,
    ).run(id, workspaceId, title, deps, detail, createdBy, nowIso(), nowIso());
    return { taskId: id, created: true };
  });
}

// Atomic claim: succeeds if the task is unowned, owned by me, or owned by a DEAD
// agent (auto-reclaim). Blocks only on a LIVE different owner.
export function claimTask(db, { taskId, agentId }) {
  return writeTxn(db, () => {
    const t = db.prepare("SELECT task_id, owner_agent, status FROM tasks WHERE task_id=?").get(taskId);
    if (!t) return { granted: false, error: "no such task" };
    if (t.owner_agent && t.owner_agent !== agentId && t.status !== "done") {
      const ownerLive = db
        .prepare("SELECT 1 FROM agents WHERE agent_id=? AND status='active' AND last_heartbeat>?")
        .get(t.owner_agent, isoAgoMs(DEAD_MS));
      if (ownerLive) return { granted: false, conflict: { owner: t.owner_agent } };
    }
    db.prepare("UPDATE tasks SET owner_agent=?, status='claimed', updated_at=? WHERE task_id=?").run(agentId, nowIso(), taskId);
    return { granted: true, taskId };
  });
}

// Update status/detail. status='open' also unclaims (releases ownership).
export function updateTask(db, { taskId, agentId = null, status = null, detail = null }) {
  return writeTxn(db, () => {
    const t = db.prepare("SELECT task_id FROM tasks WHERE task_id=?").get(taskId);
    if (!t) return { ok: false, error: "no such task" };
    if (status && !STATUSES.has(status)) return { ok: false, error: `bad status (use ${[...STATUSES].join("|")})` };
    const sets = [],
      vals = [];
    if (status) {
      sets.push("status=?");
      vals.push(status);
      if (status === "open") sets.push("owner_agent=NULL");
    }
    if (detail != null) {
      sets.push("detail=?");
      vals.push(detail);
    }
    sets.push("updated_at=?");
    vals.push(nowIso());
    vals.push(taskId);
    db.prepare(`UPDATE tasks SET ${sets.join(",")} WHERE task_id=?`).run(...vals);
    return { ok: true, taskId };
  });
}

export function releaseTask(db, { taskId, agentId }) {
  return updateTask(db, { taskId, agentId, status: "open" });
}

// The board for a workspace, each task tagged with owner liveness + dependency
// readiness (ready = every dep is done; blockedBy = the deps that aren't).
export function listTasks(db, { workspaceId }) {
  const rows = db.prepare("SELECT * FROM tasks WHERE workspace_id=? ORDER BY created_at").all(workspaceId);
  const done = new Set(rows.filter((r) => r.status === "done").map((r) => r.task_id));
  const live = new Set(
    db.prepare("SELECT agent_id FROM agents WHERE status='active' AND last_heartbeat>?").all(isoAgoMs(DEAD_MS)).map((r) => r.agent_id),
  );
  return rows.map((r) => {
    const deps = (r.depends_on || "").split(",").map((s) => s.trim()).filter(Boolean);
    const blockedBy = deps.filter((d) => !done.has(d));
    return {
      task_id: r.task_id,
      title: r.title,
      status: r.status,
      owner: r.owner_agent,
      ownerLive: r.owner_agent ? live.has(r.owner_agent) : false,
      dependsOn: deps,
      ready: blockedBy.length === 0,
      blockedBy,
      detail: r.detail,
    };
  });
}
