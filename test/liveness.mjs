// A dead agent's lease must not block a live claimer, and reap() must remove the
// dead agent. (Liveness = heartbeat freshness; this is the crash-recovery path.)
import { randomUUID } from "node:crypto";
import { getDb, writeTxn, nowIso, isoInSec, isoAgoMs } from "../lib/store.mjs";
import { ensureAgent } from "../lib/agents.mjs";
import { claimFile } from "../lib/leases.mjs";
import { reap } from "../lib/reaper.mjs";

const db = getDb();
const ws = "live-ws-" + process.pid;
const path = "src/y.ts";
const clean = () =>
  writeTxn(db, () => {
    db.prepare("DELETE FROM file_leases WHERE workspace_id=?").run(ws);
    db.prepare("DELETE FROM agents WHERE agent_id IN ('dead-one','live-two')").run();
  });
clean();

// dead agent holds the file: registered, but heartbeat is 40 min stale —
// past both the 3-min blocking threshold AND the 30-min GC threshold.
ensureAgent(db, { agentId: "dead-one", repoPath: "/t", branch: "m" });
writeTxn(db, () => db.prepare("UPDATE agents SET last_heartbeat=? WHERE agent_id='dead-one'").run(isoAgoMs(40 * 60 * 1000)));
writeTxn(db, () =>
  db
    .prepare("INSERT INTO file_leases(lease_id,workspace_id,path,agent_id,mode,reason,acquired_at,expires_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(randomUUID(), ws, path, "dead-one", "exclusive", "x", nowIso(), isoInSec(600)),
);

// live agent claims the same file -> must be GRANTED (dead holder ignored)
ensureAgent(db, { agentId: "live-two", repoPath: "/t", branch: "m" });
const r = claimFile(db, { agentId: "live-two", workspaceId: ws, path, mode: "exclusive", reason: "x" });

reap(db);
const deadGone = !db.prepare("SELECT 1 FROM agents WHERE agent_id='dead-one'").get();
clean();

const pass = r.granted && deadGone;
console.log(`claim over dead holder: ${r.granted ? "GRANTED" : "BLOCKED"} | dead agent reaped: ${deadGone}`);
console.log(pass ? "PASS ✅" : "FAIL ❌");
process.exit(pass ? 0 : 1);
