import assert from "node:assert/strict";
import { getDb, nowIso } from "../lib/store.mjs";
import { getFleet } from "../lib/activity.mjs";

assert.ok(process.env.AGENT_COORD_HOME, "run through the isolated runner");
const db = getDb();
const now = nowIso();
const agent = db.prepare("INSERT INTO agents(agent_id,tool,status,registered_at,last_heartbeat) VALUES(?,'codex',?,?,?)");
for (const id of ["editing-peer", "empty-peer", "dead-peer", "stale-peer"]) {
  agent.run(id, id === "dead-peer" ? "dead" : "active", now, id === "stale-peer" ? "2000-01-01" : now);
}
const lease = db.prepare("INSERT INTO file_leases(lease_id,path,agent_id,acquired_at,expires_at) VALUES(?,?,?,?,?)");
lease.run("old", "old.ts", "editing-peer", "2026-01-01", "2099-01-01");
lease.run("new", "current.ts", "editing-peer", "2026-02-01", "2099-01-01");
lease.run("expired", "expired.ts", "editing-peer", "2026-03-01", "2000-01-01");
lease.run("inactive", "dead.ts", "dead-peer", "2026-04-01", "2099-01-01");
const fleet = getFleet(db);
assert.equal(fleet.length, 2);
assert.equal(fleet.find(a => a.agent_id === "editing-peer").editing, "current.ts");
assert.equal(fleet.find(a => a.agent_id === "empty-peer").editing, null);
assert.deepEqual(Object.keys(fleet[0]).sort(), ["agent_id", "tool", "repo_path", "branch", "current_task", "registered_at", "last_heartbeat", "editing"].sort());
const plan = db.prepare("EXPLAIN QUERY PLAN SELECT path FROM file_leases WHERE agent_id=? AND expires_at>? ORDER BY acquired_at DESC LIMIT 1").all("editing-peer", now);
assert.ok(plan.some(r => r.detail.includes("idx_lease_agent_acquired")), "latest lease must use the owner/time index");
assert.ok(plan.every(r => !r.detail.includes("TEMP B-TREE")), "latest lease needs no per-agent sort");
console.log("Fleet keeps its full public shape, latest unexpired lease and active-only rows, with an indexed lookup");
