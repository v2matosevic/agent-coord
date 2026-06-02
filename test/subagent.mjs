// Two subagents of ONE parent session must get distinct identities and lock
// against each other (not collapse onto the parent and silently co-edit).
import { getDb, writeTxn } from "../lib/store.mjs";
import { ensureAgent } from "../lib/agents.mjs";
import { claimFile } from "../lib/leases.mjs";
import { resolveAgentId } from "../lib/identity.mjs";

const db = getDb();
const idP = resolveAgentId({ session_id: "sess-parent" });
const idA = resolveAgentId({ session_id: "sess-parent", agent_id: "subagent-aaaaaa", agent_type: "Explore" });
const idB = resolveAgentId({ session_id: "sess-parent", agent_id: "subagent-bbbbbb", agent_type: "Explore" });

const ws = "sub-ws-" + process.pid;
const path = "src/shared.ts";
writeTxn(db, () => db.prepare("DELETE FROM file_leases WHERE workspace_id=?").run(ws));
ensureAgent(db, { agentId: idA, repoPath: "/t", branch: "m" });
ensureAgent(db, { agentId: idB, repoPath: "/t", branch: "m" });

const rA = claimFile(db, { agentId: idA, workspaceId: ws, path, mode: "exclusive", reason: "x" });
const rB = claimFile(db, { agentId: idB, workspaceId: ws, path, mode: "exclusive", reason: "x" });

writeTxn(db, () => {
  db.prepare("DELETE FROM file_leases WHERE workspace_id=?").run(ws);
  db.prepare("DELETE FROM agents WHERE agent_id IN (?,?)").run(idA, idB);
});

const distinct = idA !== idB && idA !== idP && idB !== idP;
const blocks = rA.granted && !rB.granted && rB.conflict?.agent_id === idA;
console.log(`parent=${idP}`);
console.log(`subA=${idA}  subB=${idB}`);
console.log(`distinct=${distinct} | A granted=${rA.granted} | B blocked by A=${blocks}`);
console.log(distinct && blocks ? "PASS ✅ subagents have distinct ids and lock against siblings" : "FAIL ❌");
process.exit(distinct && blocks ? 0 : 1);
