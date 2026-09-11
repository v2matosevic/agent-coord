import assert from "node:assert/strict";
import { getDb, nowIso } from "../lib/store.mjs";
import { collisionHotspots } from "../lib/insights.mjs";

assert.ok(process.env.AGENT_COORD_HOME, "run through the isolated runner");
const db = getDb();
db.prepare("INSERT INTO workspaces(workspace_id,repo_path) VALUES(?,?)").run("fixture-workspace", "/fixture/repo");
const insert = db.prepare("INSERT INTO activity_log(ts,agent_id,workspace_id,event,detail) VALUES(?,?,?,?,?)");
const ts = nowIso();
insert.run(ts, "fixture-a", "fixture-workspace", "edit", "/fixture/repo/src/main.mjs");
insert.run(ts, "fixture-b", "fixture-workspace", "edit", "src/main.mjs");
insert.run(ts, "fixture-c", "fixture-workspace", "claim", "src/main.mjs");
insert.run(ts, "fixture-d", "fixture-other", "edit", "src/main.mjs");
insert.run("2000-01-01", "fixture-e", "fixture-workspace", "edit", "src/main.mjs");
const result = collisionHotspots(db, { workspaceId: "fixture-workspace" });
assert.equal(result.length, 1);
assert.equal(result[0].path, "src/main.mjs");
assert.equal(result[0].edits, 2);
assert.deepEqual(result[0].agents.sort(), ["fixture-a", "fixture-b"]);
const plan = db.prepare("EXPLAIN QUERY PLAN SELECT workspace_id,agent_id,detail,ts FROM activity_log WHERE event='edit' AND ts>? AND detail IS NOT NULL AND workspace_id=?")
  .all("2026-01-01", "fixture-workspace");
assert.ok(plan.some(r => r.detail.includes("SEARCH activity_log USING INDEX idx_activity_edit_workspace_ts")));
console.log("Claim-time hotspot lookup uses an indexed workspace/time range and keeps normalized, scoped results");
