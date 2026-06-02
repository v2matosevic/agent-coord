// Workspace-scoped messaging: broadcast + directed delivery, read-once,
// cross-workspace isolation, and no self-delivery.
import { getDb, writeTxn } from "../lib/store.mjs";
import { ensureAgent } from "../lib/agents.mjs";
import { postMessage, readMessages, unreadCount } from "../lib/messages.mjs";

const db = getDb();
const wsA = "msg-wsA-" + process.pid;
const wsB = "msg-wsB-" + process.pid;
const [A, B, C] = ["msg-a-" + process.pid, "msg-b-" + process.pid, "msg-c-" + process.pid];
const clean = () =>
  writeTxn(db, () => {
    db.prepare("DELETE FROM messages WHERE workspace_id IN (?,?)").run(wsA, wsB);
    db.prepare("DELETE FROM message_reads WHERE agent_id IN (?,?,?)").run(A, B, C);
    db.prepare("DELETE FROM agents WHERE agent_id IN (?,?,?)").run(A, B, C);
  });
clean();
for (const id of [A, B, C]) ensureAgent(db, { agentId: id, repoPath: "/t", branch: "m" });

postMessage(db, { fromAgent: A, workspaceId: wsA, body: "hello room" }); // broadcast in wsA
postMessage(db, { fromAgent: A, workspaceId: wsA, body: "hey B", toAgent: B }); // directed to B
postMessage(db, { fromAgent: C, workspaceId: wsB, body: "other repo" }); // different workspace

const bMsgs = readMessages(db, { agentId: B, workspaceId: wsA }); // broadcast + directed = 2
const aMsgs = readMessages(db, { agentId: A, workspaceId: wsA }); // own messages excluded = 0
const bAgain = readMessages(db, { agentId: B, workspaceId: wsA }); // already read = 0
const cUnread = unreadCount(db, { agentId: C, workspaceId: wsA }); // broadcast only (not directed-to-B) = 1

clean();
const pass = bMsgs.length === 2 && aMsgs.length === 0 && bAgain.length === 0 && cUnread === 1;
console.log(`B sees ${bMsgs.length} (want 2) | A sees own ${aMsgs.length} (want 0) | B re-read ${bAgain.length} (want 0) | C unread ${cUnread} (want 1)`);
console.log(pass ? "PASS ✅ workspace-scoped, directed, read-once, no self-delivery" : "FAIL ❌");
process.exit(pass ? 0 : 1);
