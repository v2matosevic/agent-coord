// Task handoff + work-pulling: marking done with a summary notifies dependents'
// owners (directed, with readiness), claiming returns upstream summaries, and
// claim_next_task atomically pulls the best READY task (priority, deps, live
// owners respected).
import { getDb, writeTxn } from "../lib/store.mjs";
import { ensureAgent, markDead } from "../lib/agents.mjs";
import { workspaceId } from "../lib/path-canon.mjs";
import { createTask, claimTask, claimNextTask, updateTask } from "../lib/tasks.mjs";
import { readMessages } from "../lib/messages.mjs";

const db = getDb();
const repo = "/t/handoff-" + process.pid;
const ws = workspaceId(repo);
const [A, B, C] = ["hand-a-" + process.pid, "hand-b-" + process.pid, "hand-c-" + process.pid];
const clean = () =>
  writeTxn(db, () => {
    db.prepare("DELETE FROM tasks WHERE workspace_id=?").run(ws);
    db.prepare("DELETE FROM messages WHERE workspace_id=?").run(ws);
    db.prepare("DELETE FROM agents WHERE agent_id IN (?,?,?)").run(A, B, C);
  });
clean();
for (const id of [A, B, C]) ensureAgent(db, { agentId: id, repoPath: repo, branch: "main" });

const checks = {};

// Pipeline: t1 (API) -> t2 (UI, owned by B) and t3 (docs, waits on t1+t2, owned by B).
const t1 = createTask(db, { workspaceId: ws, title: "Build the API routes", createdBy: A });
const t2 = createTask(db, { workspaceId: ws, title: "Wire the UI", dependsOn: [t1.taskId], createdBy: A });
const t3 = createTask(db, { workspaceId: ws, title: "Write the docs", dependsOn: [t1.taskId, t2.taskId], createdBy: A });
claimTask(db, { taskId: t1.taskId, agentId: A });
claimTask(db, { taskId: t2.taskId, agentId: B });
claimTask(db, { taskId: t3.taskId, agentId: B });
readMessages(db, { agentId: B, workspaceId: ws }); // drain so we only see the notify

// A finishes t1 with a handoff summary -> B (owner of t2 AND t3) is told, with readiness per task.
updateTask(db, { taskId: t1.taskId, agentId: A, status: "done", summary: "REST routes in src/api/, auth via middleware, see routes.test.ts" });
const bMail = readMessages(db, { agentId: B, workspaceId: ws });
const t2Note = bMail.find((m) => m.body.includes(t2.taskId));
const t3Note = bMail.find((m) => m.body.includes(t3.taskId));
checks["dependent owner notified on done"] = !!t2Note && t2Note.to_agent === B;
checks["notify carries the summary"] = !!t2Note && t2Note.body.includes("src/api/");
checks["fully-unblocked says READY"] = !!t2Note && t2Note.body.includes("READY");
checks["partial dep says still waits"] = !!t3Note && t3Note.body.includes("still waits on") && t3Note.body.includes(t2.taskId);

// Claiming a task returns upstream summaries (handoff), not just ownership.
const t4 = createTask(db, { workspaceId: ws, title: "Ship the changelog", dependsOn: [t1.taskId], createdBy: A });
const cClaim = claimTask(db, { taskId: t4.taskId, agentId: C });
checks["claim returns handoff from done deps"] =
  cClaim.granted === true && cClaim.handoff?.length === 1 && cClaim.handoff[0].summary.includes("src/api/");

// claim_next_task: highest-priority READY task wins; dep-blocked and live-owned skipped.
clean();
for (const id of [A, B, C]) ensureAgent(db, { agentId: id, repoPath: repo, branch: "main" });
const p2 = createTask(db, { workspaceId: ws, title: "ready p2", priority: 2 });
const p5 = createTask(db, { workspaceId: ws, title: "blocked p5", priority: 5, dependsOn: ["t-missing"] });
const p0 = createTask(db, { workspaceId: ws, title: "ready p0" });
const taken = createTask(db, { workspaceId: ws, title: "taken by live peer", priority: 9 });
claimTask(db, { taskId: taken.taskId, agentId: A });

const n1 = claimNextTask(db, { workspaceId: ws, agentId: C });
checks["next = highest-priority READY (skips dep-blocked p5, live-owned p9)"] = n1.granted === true && n1.taskId === p2.taskId;
const n2 = claimNextTask(db, { workspaceId: ws, agentId: C });
checks["next again = remaining ready (not re-handed my own claim)"] = n2.granted === true && n2.taskId === p0.taskId;
const n3 = claimNextTask(db, { workspaceId: ws, agentId: C });
checks["board drained -> granted:false"] = n3.granted === false;

// Dead owner: their claimed task becomes pullable again.
markDead(db, A);
const n4 = claimNextTask(db, { workspaceId: ws, agentId: C });
checks["dead owner's task pullable via next"] = n4.granted === true && n4.taskId === taken.taskId;

clean();
let ok = true;
for (const [k, v] of Object.entries(checks)) {
  if (!v) ok = false;
  console.log(`${v ? "✅" : "❌"} ${k}`);
}
console.log(ok ? "PASS ✅ handoff: done→notify(summary,readiness) · claim→handoff · next_task pulls right" : "FAIL ❌");
process.exit(ok ? 0 : 1);
