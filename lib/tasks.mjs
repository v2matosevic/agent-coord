import { randomUUID } from "node:crypto";
import { writeTxn, nowIso, isoAgoMs } from "./store.mjs";
import { insertMessage } from "./messages.mjs";
import { DEAD_MS } from "./config.mjs";

// Shared task board — the structural answer to "two agents on one vague prompt
// build the same thing." Instead of inferring overlap from task TEXT (overlap.mjs),
// agents claim discrete units of work here: claim a task and every other agent
// sees it's taken. Workspace-scoped (a per-repo board), atomic claims (one winner
// under a race, like file leases), dead-owner auto-reclaim, and a simple
// depends_on list so a blocked task is visible.
//
// Beyond collision-avoidance, the board is a PIPELINE: finishing a task with a
// `summary` hands that context to whoever depends on it (delivered as a directed
// message the moment you mark done, and returned as `handoff` when they claim),
// and claimNextTask lets an idle agent pull the best ready unit of work.

const STATUSES = new Set(["open", "claimed", "done", "blocked"]);
const shortId = () => "t-" + randomUUID().replace(/-/g, "").slice(0, 6);
const normTitle = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const depList = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
const liveSet = (db) =>
  new Set(db.prepare("SELECT agent_id FROM agents WHERE status='active' AND last_heartbeat>?").all(isoAgoMs(DEAD_MS)).map((r) => r.agent_id));

// Completed-dependency context for a task: what was built upstream, so the
// claimer starts informed instead of re-discovering it. No txn — call inside one.
function handoffFor(db, task) {
  const deps = depList(task.depends_on);
  if (!deps.length) return [];
  return deps
    .map((id) => db.prepare("SELECT task_id, title, status, summary, detail FROM tasks WHERE task_id=?").get(id))
    .filter((t) => t && t.status === "done" && (t.summary || t.detail))
    .map((t) => ({ task_id: t.task_id, title: t.title, summary: t.summary || t.detail }));
}

// Create a task. Dedups against an existing non-done task with the same
// normalized title in this workspace, so two agents announcing the same work
// land on ONE task (returns {created:false} for the existing one).
export function createTask(db, { workspaceId, title, detail = null, dependsOn = null, createdBy = null, priority = 0 }) {
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
      `INSERT INTO tasks(task_id,workspace_id,title,status,owner_agent,depends_on,detail,created_by,created_at,updated_at,priority)
       VALUES(?,?,?,'open',NULL,?,?,?,?,?,?)`,
    ).run(id, workspaceId, title, deps, detail, createdBy, nowIso(), nowIso(), Number(priority) || 0);
    return { taskId: id, created: true };
  });
}

// Atomic claim: succeeds if the task is unowned, owned by me, or owned by a DEAD
// agent (auto-reclaim). Blocks only on a LIVE different owner. On grant, returns
// `handoff` — the summaries of its completed dependencies.
export function claimTask(db, { taskId, agentId }) {
  return writeTxn(db, () => {
    const t = db.prepare("SELECT * FROM tasks WHERE task_id=?").get(taskId);
    if (!t) return { granted: false, error: "no such task" };
    if (t.owner_agent && t.owner_agent !== agentId && t.status !== "done") {
      const ownerLive = db
        .prepare("SELECT 1 FROM agents WHERE agent_id=? AND status='active' AND last_heartbeat>?")
        .get(t.owner_agent, isoAgoMs(DEAD_MS));
      if (ownerLive) return { granted: false, conflict: { owner: t.owner_agent } };
    }
    db.prepare("UPDATE tasks SET owner_agent=?, status='claimed', updated_at=? WHERE task_id=?").run(agentId, nowIso(), taskId);
    return { granted: true, taskId, title: t.title, detail: t.detail, handoff: handoffFor(db, t) };
  });
}

// Pull the next unit of work: the highest-priority READY task (every dep done,
// not held by a live peer, not explicitly 'blocked'). One atomic pick-and-claim,
// so two idle agents draining the board can't grab the same task. This is what
// turns a fleet plus a seeded board into a self-scheduling work pool.
export function claimNextTask(db, { workspaceId, agentId }) {
  return writeTxn(db, () => {
    const rows = db.prepare("SELECT * FROM tasks WHERE workspace_id=? AND status<>'done'").all(workspaceId);
    const done = new Set(
      db.prepare("SELECT task_id FROM tasks WHERE workspace_id=? AND status='done'").all(workspaceId).map((r) => r.task_id),
    );
    const live = liveSet(db);
    const candidates = rows
      .filter((t) => t.status !== "blocked")
      .filter((t) => !t.owner_agent || (t.owner_agent !== agentId && !live.has(t.owner_agent))) // unowned, or dead-owner reclaim; never re-hand me my own
      .filter((t) => depList(t.depends_on).every((d) => done.has(d)))
      .sort((a, b) => (b.priority || 0) - (a.priority || 0) || String(a.created_at).localeCompare(String(b.created_at)));
    if (!candidates.length) return { granted: false, reason: "no ready unclaimed tasks on this board" };
    const t = candidates[0];
    db.prepare("UPDATE tasks SET owner_agent=?, status='claimed', updated_at=? WHERE task_id=?").run(agentId, nowIso(), t.task_id);
    return { granted: true, taskId: t.task_id, title: t.title, detail: t.detail, priority: t.priority || 0, handoff: handoffFor(db, t) };
  });
}

// Update status/detail/summary. status='open' also unclaims (releases ownership).
// Marking 'done' notifies the owner of every task that depends on this one —
// a directed message carrying the summary, so downstream work starts informed
// the moment it unblocks (delivered mid-turn via the 📬 channel).
export function updateTask(db, { taskId, agentId = null, status = null, detail = null, summary = null }) {
  return writeTxn(db, () => {
    const t = db.prepare("SELECT * FROM tasks WHERE task_id=?").get(taskId);
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
    if (summary != null) {
      sets.push("summary=?");
      vals.push(summary);
    }
    sets.push("updated_at=?");
    vals.push(nowIso());
    vals.push(taskId);
    db.prepare(`UPDATE tasks SET ${sets.join(",")} WHERE task_id=?`).run(...vals);

    if (status === "done" && t.status !== "done") notifyDependents(db, { task: t, finisher: agentId, summary });
    return { ok: true, taskId };
  });
}

// No txn — runs inside updateTask's. Tell each dependent task's owner their
// dependency finished (and whether they're fully unblocked now).
function notifyDependents(db, { task, finisher, summary }) {
  const ws = task.workspace_id;
  const dependents = db
    .prepare("SELECT * FROM tasks WHERE workspace_id=? AND status<>'done' AND depends_on IS NOT NULL")
    .all(ws)
    .filter((d) => depList(d.depends_on).includes(task.task_id));
  if (!dependents.length) return;
  const done = new Set(db.prepare("SELECT task_id FROM tasks WHERE workspace_id=? AND status='done'").all(ws).map((r) => r.task_id));
  done.add(task.task_id);
  for (const d of dependents) {
    if (!d.owner_agent || d.owner_agent === finisher) continue;
    const waiting = depList(d.depends_on).filter((x) => !done.has(x));
    const state = waiting.length ? `still waits on ${waiting.join(", ")}` : "READY now";
    insertMessage(db, {
      fromAgent: finisher || "task-board",
      workspaceId: ws,
      toAgent: d.owner_agent,
      body: `✔ dependency done: ${task.task_id} "${task.title}"${summary ? ` — ${summary}` : ""}. Your task ${d.task_id} "${d.title}" ${state}.`,
    });
  }
}

export function releaseTask(db, { taskId, agentId }) {
  return updateTask(db, { taskId, agentId, status: "open" });
}

// The board for a workspace, each task tagged with owner liveness + dependency
// readiness (ready = every dep is done; blockedBy = the deps that aren't).
export function listTasks(db, { workspaceId }) {
  const rows = db.prepare("SELECT * FROM tasks WHERE workspace_id=? ORDER BY created_at").all(workspaceId);
  const done = new Set(rows.filter((r) => r.status === "done").map((r) => r.task_id));
  const live = liveSet(db);
  return rows.map((r) => {
    const deps = depList(r.depends_on);
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
      summary: r.summary || null,
      priority: r.priority || 0,
    };
  });
}
