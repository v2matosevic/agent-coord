// lib/insights.mjs — collisionHotspots flags files touched by 2+ agents (and not
// single-agent files), normalizing absolute spellings to repo-relative; and
// pathHistory answers "who touched this" by exact file and by directory prefix.
import { getDb, nowIso, writeTxn } from "../lib/store.mjs";
import { collisionHotspots, pathHistory } from "../lib/insights.mjs";

const db = getDb();
const ws = "testws-insights";
writeTxn(db, () => {
  db.prepare("INSERT OR REPLACE INTO workspaces(workspace_id,repo_path,branch) VALUES(?,?,?)").run(ws, "/repo/proj", "main");
  db.prepare("DELETE FROM activity_log WHERE workspace_id=?").run(ws);
  const ins = db.prepare("INSERT INTO activity_log(ts,agent_id,workspace_id,event,detail) VALUES(?,?,?,?,?)");
  ins.run(nowIso(), "alpha-1", ws, "edit", "src/app.js");
  ins.run(nowIso(), "beta-1", ws, "edit", "src/app.js"); // 2 distinct agents -> hotspot
  ins.run(nowIso(), "beta-1", ws, "edit", "/repo/proj/src/app.js"); // absolute spelling normalizes
  ins.run(nowIso(), "alpha-1", ws, "edit", "src/solo.js"); // 1 agent -> not a hotspot
});

let ok = true;
const check = (c, m) => {
  if (!c) ok = false;
  console.log(`  ${c ? "✓" : "✗"} ${m}`);
};

const hot = collisionHotspots(db, { workspaceId: ws });
const app = hot.find((h) => h.path === "src/app.js");
check(!!app, "src/app.js flagged as a hotspot");
check(app && app.agents.length === 2, "hotspot counts 2 distinct agents (absolute spelling merged)");
check(!hot.find((h) => h.path === "src/solo.js"), "single-agent file is NOT a hotspot");

const hist = pathHistory(db, { workspaceId: ws, path: "src/app.js" });
check(hist.distinctAgents.length === 2 && hist.distinctAgents.includes("alpha-1") && hist.distinctAgents.includes("beta-1"), "query_history returns both agents for the file");

const dir = pathHistory(db, { workspaceId: ws, path: "src" });
check(dir.eventCount >= 3, "directory prefix matches files under it");

const none = pathHistory(db, { workspaceId: ws, path: "does/not/exist.js" });
check(none.eventCount === 0, "unknown path returns no events");

console.log(ok ? "PASS ✅" : "FAIL ❌");
process.exit(ok ? 0 : 1);
