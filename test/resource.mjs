// Resource singleton: two agents contend for the same machine-wide resource
// (e.g. a dev DB migration) — exactly one may hold it at a time.
import { getDb, writeTxn } from "../lib/store.mjs";
import { ensureAgent } from "../lib/agents.mjs";
import { claimResource } from "../lib/leases.mjs";

const db = getDb();
const rid = "db:test-" + process.pid;
writeTxn(db, () => db.prepare("DELETE FROM resource_leases WHERE resource_id=?").run(rid));

ensureAgent(db, { agentId: "res-A", repoPath: "/t", branch: "m" });
ensureAgent(db, { agentId: "res-B", repoPath: "/t", branch: "m" });

const a = claimResource(db, { agentId: "res-A", resourceId: rid, reason: "migrate" });
const b = claimResource(db, { agentId: "res-B", resourceId: rid, reason: "migrate" });

console.log(`A: ${a.granted ? "GRANTED" : "denied"} | B: ${b.granted ? "granted" : "DENIED by " + b.conflict?.agent_id}`);

writeTxn(db, () => db.prepare("DELETE FROM resource_leases WHERE resource_id=?").run(rid));
const pass = a.granted && !b.granted;
console.log(pass ? "PASS ✅ one resource holder at a time" : "FAIL ❌");
process.exit(pass ? 0 : 1);
