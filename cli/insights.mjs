import { getDb, isoAgoMs } from "../lib/store.mjs";
import { collisionHotspots, repoMap, repoName, coordinationROI } from "../lib/insights.mjs";

// Read-only, stdout-only retro over the timeline the system already records.
// The analysis lives in lib/insights.mjs (shared with the digest writer, the
// claim-time hotspot warning, and the query_history MCP tool); this is just its
// terminal face. Flagship signal: the SAME file edited by 2+ distinct agents,
// which the lock layer structurally cannot catch (leases only block CONCURRENT
// holders; serial same-file work leaves no conflict).

const args = process.argv.slice(2);
const sinceArg = (() => {
  const i = args.indexOf("--since");
  return i >= 0 ? args[i + 1] : "7d";
})();
const m = String(sinceArg).match(/^(\d+)([dh])$/);
const windowMs = m ? Number(m[1]) * (m[2] === "d" ? 86400000 : 3600000) : 7 * 86400000;

const db = getDb();
const repos = repoMap(db);
const norm = (ws, detail) => {
  if (!detail) return detail;
  const d = detail.replace(/\\/g, "/");
  const root = repos.get(ws);
  if (root && (d.toLowerCase() === root.toLowerCase() || d.toLowerCase().startsWith(root.toLowerCase() + "/"))) return d.slice(root.length).replace(/^\/+/, "");
  return d;
};

const collisions = collisionHotspots(db, { windowMs });
const conflicts = db
  .prepare("SELECT ts, agent_id, workspace_id, event, detail FROM activity_log WHERE event IN ('conflict','resource-conflict') AND ts > ? ORDER BY ts DESC")
  .all(isoAgoMs(windowMs));

console.log(`agent-coord insights — last ${sinceArg}  (read-only)\n`);

const roi = coordinationROI(db, { windowMs });
console.log("▶ What coordination did:");
console.log(`   ${roi.fileBlocks} concurrent-edit collision${roi.fileBlocks === 1 ? "" : "s"} blocked (${roi.selfHealedBlocks} self-healed — the blocked agent got the file later, no human)`);
console.log(`   ${roi.resourceBlocks} resource collision${roi.resourceBlocks === 1 ? "" : "s"} blocked · ${roi.dupWorkBlocks} duplicate-work stand-down${roi.dupWorkBlocks === 1 ? "" : "s"} · ${roi.yieldRequests} yield request${roi.yieldRequests === 1 ? "" : "s"} · ${roi.activeAgents} agents active`);

console.log("\n▶ Same file, 2+ agents — review for duplicated / contradictory work:");
if (!collisions.length) console.log("   none");
for (const c of collisions.slice(0, 30)) {
  console.log(`   ${c.repo}/${c.path}  — ${c.agents.length} agents, ${c.edits} edits  [${c.agents.join(", ")}]`);
}

console.log("\n▶ Conflicts the lock blocked (it did its job):");
if (!conflicts.length) console.log("   none");
for (const c of conflicts.slice(0, 30)) {
  console.log(`   ${c.ts.slice(5, 19)}  ${c.event}  ${repoName(repos, c.workspace_id)}/${norm(c.workspace_id, c.detail)}  (${c.agent_id})`);
}
