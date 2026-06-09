// Shared task board: create + dedup, atomic claim (one winner under a race),
// dead-owner auto-reclaim, dependency readiness, and status updates.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, writeTxn } from "../lib/store.mjs";
import { ensureAgent, markDead } from "../lib/agents.mjs";
import { workspaceId } from "../lib/path-canon.mjs";
import { createTask, claimTask, updateTask, listTasks } from "../lib/tasks.mjs";

const db = getDb();
const repo = "/t/tasks-" + process.pid;
const ws = workspaceId(repo);
const [A, B] = ["task-a-" + process.pid, "task-b-" + process.pid];
const clean = () =>
  writeTxn(db, () => {
    db.prepare("DELETE FROM tasks WHERE workspace_id=?").run(ws);
    db.prepare("DELETE FROM agents WHERE agent_id IN (?,?)").run(A, B);
  });
clean();
ensureAgent(db, { agentId: A, repoPath: repo, branch: "main" });
ensureAgent(db, { agentId: B, repoPath: repo, branch: "main" });

const checks = {};

// create + dedup
const t1 = createTask(db, { workspaceId: ws, title: "Build the VAT report", createdBy: A });
const t1dup = createTask(db, { workspaceId: ws, title: "build the vat report", createdBy: B }); // normalized same
checks["create returns an id"] = !!t1.taskId && t1.created === true;
checks["dedup: same title -> same task"] = t1dup.taskId === t1.taskId && t1dup.created === false;

// a second, dependent task
const t2 = createTask(db, { workspaceId: ws, title: "Wire VAT report into the dashboard", dependsOn: [t1.taskId], createdBy: A });

// claim + conflict
const aClaim = claimTask(db, { taskId: t1.taskId, agentId: A });
const bBlocked = claimTask(db, { taskId: t1.taskId, agentId: B });
checks["A claims the task"] = aClaim.granted === true;
checks["B blocked on A's live claim"] = bBlocked.granted === false && bBlocked.conflict.owner === A;

// dependency readiness: t2 depends on t1 (not done yet) -> blocked
let board = listTasks(db, { workspaceId: ws });
const t2row = board.find((r) => r.task_id === t2.taskId);
checks["dependent task not ready while dep open"] = t2row.ready === false && t2row.blockedBy.includes(t1.taskId);

// finish t1 -> t2 becomes ready
updateTask(db, { taskId: t1.taskId, status: "done" });
board = listTasks(db, { workspaceId: ws });
checks["dependent task ready once dep done"] = board.find((r) => r.task_id === t2.taskId).ready === true;

// dead-owner auto-reclaim: B claims t2, B dies, A can take it
claimTask(db, { taskId: t2.taskId, agentId: B });
markDead(db, B);
const aReclaim = claimTask(db, { taskId: t2.taskId, agentId: A });
checks["dead owner's task is reclaimable"] = aReclaim.granted === true;

clean();

// atomic claim race: many processes claim ONE task -> exactly one winner.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
writeTxn(db, () => {
  db.prepare("DELETE FROM tasks WHERE workspace_id=?").run(ws);
  db.prepare("DELETE FROM agents WHERE agent_id LIKE ?").run("race-" + process.pid + "-%");
});
const raceTask = createTask(db, { workspaceId: ws, title: "race target " + process.pid });
const N = 12;
const kids = Array.from({ length: N }, (_, i) =>
  spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(root, "test", "_task-claim-worker.mjs"), ws, raceTask.taskId, `race-${process.pid}-${i}`, repo], {
    env: { ...process.env },
    encoding: "utf8",
  }),
);
const winners = kids.filter((k) => k.stdout && k.stdout.trim() === "GRANTED").length;
checks["exactly one winner under a claim race"] = winners === 1;
writeTxn(db, () => {
  db.prepare("DELETE FROM tasks WHERE workspace_id=?").run(ws);
  db.prepare("DELETE FROM agents WHERE agent_id LIKE ?").run("race-" + process.pid + "-%");
});

let ok = true;
for (const [k, v] of Object.entries(checks)) {
  if (!v) ok = false;
  console.log(`${v ? "✅" : "❌"} ${k}`);
}
console.log(`race winners=${winners} (want 1)`);
console.log(ok ? "PASS ✅ task board: create/dedup/claim/deps/reclaim/race" : "FAIL ❌");
process.exit(ok ? 0 : 1);
