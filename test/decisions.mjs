// Decision log + room brief: decisions are workspace-scoped, latest-per-topic,
// broadcast to peers (not echoed to self); the session-start brief shows peers,
// board, decisions, and unread mail — and stays silent when there's nothing.
import { getDb, writeTxn } from "../lib/store.mjs";
import { ensureAgent } from "../lib/agents.mjs";
import { workspaceId } from "../lib/path-canon.mjs";
import { recordDecision, listDecisions } from "../lib/decisions.mjs";
import { readMessages, postMessage } from "../lib/messages.mjs";
import { createTask } from "../lib/tasks.mjs";
import { buildRoomBrief } from "../lib/room-brief.mjs";

const db = getDb();
const repo = "/t/decide-" + process.pid;
const ws = workspaceId(repo);
const [A, B] = ["dec-a-" + process.pid, "dec-b-" + process.pid];
const clean = () =>
  writeTxn(db, () => {
    db.prepare("DELETE FROM decisions WHERE workspace_id=?").run(ws);
    db.prepare("DELETE FROM tasks WHERE workspace_id=?").run(ws);
    db.prepare("DELETE FROM messages WHERE workspace_id=?").run(ws);
    db.prepare("DELETE FROM agents WHERE agent_id IN (?,?)").run(A, B);
  });
clean();
ensureAgent(db, { agentId: A, repoPath: repo, branch: "main", task: "auth refactor" });
ensureAgent(db, { agentId: B, repoPath: repo, branch: "main" });

const checks = {};

// Record + supersede: latest per topic wins.
checks["rejects empty"] = recordDecision(db, { workspaceId: ws, agentId: A, topic: "", decision: "x" }).ok === false;
recordDecision(db, { workspaceId: ws, agentId: A, topic: "auth", decision: "JWT in httpOnly cookies" });
recordDecision(db, { workspaceId: ws, agentId: A, topic: "auth", decision: "server sessions after all" });
recordDecision(db, { workspaceId: ws, agentId: A, topic: "db", decision: "drizzle, no raw SQL" });
const ds = listDecisions(db, { workspaceId: ws });
checks["latest per topic, newest first"] =
  ds.length === 2 && ds[0].topic === "db" && ds[1].topic === "auth" && ds[1].decision.includes("sessions");

// Broadcast: peers hear it; the author doesn't get their own echo.
const bMail = readMessages(db, { agentId: B, workspaceId: ws });
checks["peer hears the decision"] = bMail.some((m) => m.body.includes("📌") && m.body.includes("[db]"));
checks["author not echoed"] = !readMessages(db, { agentId: A, workspaceId: ws }).some((m) => m.body.includes("📌"));

// Room brief: B arrives -> sees peer A, the board, decisions, unread mail.
createTask(db, { workspaceId: ws, title: "open work item", priority: 3 });
postMessage(db, { fromAgent: A, workspaceId: ws, toAgent: B, body: "heads up" });
const brief = buildRoomBrief(db, { agentId: B, workspaceId: ws, repoRoot: repo });
checks["brief: self-identity"] = !!brief && brief.includes(`you are ${B}`);
checks["brief: shows peer + its task"] = !!brief && brief.includes(A) && brief.includes("auth refactor");
checks["brief: board with ready count + priority"] = !!brief && brief.includes("1 ready") && brief.includes("p3");
checks["brief: standing decisions"] = !!brief && brief.includes("[db]") && brief.includes("[auth]");
checks["brief: unread mail"] = !!brief && brief.includes("✉ 1 unread");

// Empty room -> silent (no noise for the solo case).
const emptyWs = workspaceId("/t/decide-empty-" + process.pid);
checks["empty room -> null brief"] = buildRoomBrief(db, { agentId: B, workspaceId: emptyWs, repoRoot: "/t/x" }) === null;

clean();
let ok = true;
for (const [k, v] of Object.entries(checks)) {
  if (!v) ok = false;
  console.log(`${v ? "✅" : "❌"} ${k}`);
}
console.log(ok ? "PASS ✅ decisions: record/supersede/broadcast · room brief informs, silent when empty" : "FAIL ❌");
process.exit(ok ? 0 : 1);
