// Compare the claim-time history lookup with and without its partial index.
// All data is synthetic and in memory; nothing opens the live store.
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { collisionHotspots } from "../lib/insights.mjs";

const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE workspaces(workspace_id TEXT PRIMARY KEY,repo_path TEXT);
CREATE TABLE activity_log(seq INTEGER PRIMARY KEY,ts TEXT,agent_id TEXT,workspace_id TEXT,event TEXT,detail TEXT);
INSERT INTO workspaces VALUES('fixture-target','/fixture/target');`);
const stmt = db.prepare("INSERT INTO activity_log(ts,agent_id,workspace_id,event,detail) VALUES(?,?,?,?,?)");
const now = new Date().toISOString();
const old = "2000-01-01T00:00:00.000Z";
db.exec("BEGIN");
for (let i = 0; i < 140000; i++) {
  const relevant = i % 200 === 0;
  stmt.run(relevant ? now : old, `fixture-peer-${i % 3}`, relevant ? "fixture-target" : "fixture-other",
    relevant || i % 5 === 0 ? "edit" : "claim", `src/file-${i % 7}.mjs`);
}
db.exec("COMMIT");
const sql = "SELECT workspace_id,agent_id,detail,ts FROM activity_log WHERE event='edit' AND ts>? AND detail IS NOT NULL AND workspace_id=?";
const cut = new Date(Date.now() - 7 * 86400000).toISOString();
const measure = () => {
  const values = [];
  let result;
  for (let i = 0; i < 53; i++) {
    const start = performance.now();
    result = collisionHotspots(db, { workspaceId: "fixture-target" });
    if (i >= 3) values.push(performance.now() - start);
  }
  values.sort((a, b) => a - b);
  return { samples: values.length, p50Ms: values[24], p95Ms: values[47], result,
    plan: db.prepare("EXPLAIN QUERY PLAN " + sql).all(cut, "fixture-target").map(r => r.detail) };
};
const before = measure();
const indexStarted = performance.now();
db.exec("CREATE INDEX idx_activity_edit_workspace_ts ON activity_log(workspace_id,ts) WHERE event='edit' AND detail IS NOT NULL");
const indexBuildMs = performance.now() - indexStarted;
const after = measure();
if (JSON.stringify(before.result) !== JSON.stringify(after.result)) throw new Error("index changed hotspot results");
const report = { measuredAt: new Date().toISOString(), node: process.version, platform: process.platform,
  fixture: { rows: 140000, relevantEditRows: 700, storage: "in memory", warmups: 3 },
  before: { ...before, result: { hotspots: before.result.length } },
  after: { ...after, result: { hotspots: after.result.length } }, indexBuildMs,
  identicalResults: true, limits: "Synthetic query comparison, not total task latency. Partial index is maintained only for edits with a path." };
const out = process.argv.indexOf("--out");
if (out >= 0) writeFileSync(process.argv[out + 1], JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
db.close();
