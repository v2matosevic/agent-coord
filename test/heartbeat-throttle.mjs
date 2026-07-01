// Heartbeat throttle: bare heartbeats are skipped while the local marker is
// fresh (< HB_THROTTLE_MS since the last real DB write) — the hot-path
// write-lock diet — but anything that changes state (a task, an intent, a
// stale marker, a markDead) still hits the store. Fail-open: no marker means
// no skip.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_COORD_HOME ||= mkdtempSync(join(tmpdir(), "coord-hb-"));
const { utimesSync } = await import("node:fs");
const { getDb, writeTxn, isoAgoMs } = await import("../lib/store.mjs");
const { ensureAgent, heartbeat, heartbeatFresh, markDead, agentAlive } = await import("../lib/agents.mjs");
const { COORD_HOME } = await import("../lib/identity.mjs");

const db = getDb();
const A = "hb-a-" + process.pid;
const SUB = A + "/explore-ab12"; // subagent ids contain "/" — the marker path must survive it
const hbOf = (id) => db.prepare("SELECT last_heartbeat FROM agents WHERE agent_id=?").get(id)?.last_heartbeat;
const backdateDb = (id) => writeTxn(db, () => db.prepare("UPDATE agents SET last_heartbeat=? WHERE agent_id=?").run(isoAgoMs(60000), id));
const ageMarker = (id) => {
  const old = new Date(Date.now() - 10 * 60000);
  utimesSync(join(COORD_HOME, "hb", encodeURIComponent(id)), old, old);
};

const checks = {};

ensureAgent(db, { agentId: A, repoPath: "/t", branch: "m" });
checks["ensureAgent leaves a fresh marker"] = heartbeatFresh(A) === true;

// Bare heartbeat while fresh: SKIPPED — the backdated DB row stays backdated.
backdateDb(A);
heartbeat(db, A);
checks["bare heartbeat skipped while fresh"] = hbOf(A) < isoAgoMs(30000);

// Task-carrying heartbeat: always writes, even while fresh.
heartbeat(db, A, "real work");
checks["task heartbeat always writes"] = hbOf(A) > isoAgoMs(5000);

// Stale marker: bare heartbeat writes again.
backdateDb(A);
ageMarker(A);
checks["stale marker -> bare heartbeat writes"] = (heartbeat(db, A), hbOf(A) > isoAgoMs(5000));

// markDead clears the marker so the next event re-registers instead of skipping.
markDead(db, A);
checks["markDead clears the marker"] = heartbeatFresh(A) === false;
ensureAgent(db, { agentId: A, repoPath: "/t", branch: "m" });
checks["re-register revives"] = agentAlive(db, A) === true;

// Subagent id with "/" round-trips through the marker path.
ensureAgent(db, { agentId: SUB, repoPath: "/t", branch: "m" });
checks["subagent id marker works"] = heartbeatFresh(SUB) === true;

writeTxn(db, () => db.prepare("DELETE FROM agents WHERE agent_id IN (?,?)").run(A, SUB));

let ok = true;
for (const [k, v] of Object.entries(checks)) {
  if (!v) ok = false;
  console.log(`${v ? "✅" : "❌"} ${k}`);
}
console.log(ok ? "PASS ✅ heartbeat throttle: skip when fresh, write on state change, clear on death" : "FAIL ❌");
process.exit(ok ? 0 : 1);
