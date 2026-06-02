import { existsSync } from "node:fs";
import { getDb, DEGRADED_FLAG } from "../lib/store.mjs";
import { getFleet, recentActivity } from "../lib/activity.mjs";

// `coord status` — one-shot fleet table for the terminal.
const db = getDb();
const fleet = getFleet(db);

console.log(`agent-coord — ${fleet.length} live agent${fleet.length === 1 ? "" : "s"}`);
if (existsSync(DEGRADED_FLAG)) console.log("  ⚠ DEGRADED flag present — lock enforcement may be off");
console.log("");

if (!fleet.length) {
  console.log("  (none)");
} else {
  for (const a of fleet) {
    const repo = a.repo_path ? a.repo_path.split("/").pop() : "—";
    const doing = a.editing ? "⚙ " + a.editing : a.current_task || "";
    console.log(`  ${a.agent_id.padEnd(20)} ${String(a.tool).padEnd(12)} ${`${repo}@${a.branch || "?"}`.padEnd(24)} ${doing}`);
  }
}

console.log("\nrecent activity:");
const rows = recentActivity(db, 10).reverse();
if (!rows.length) console.log("  (none)");
for (const e of rows) console.log(`  ${e.ts.slice(11, 19)}  ${String(e.agent_id).padEnd(20)} ${e.event.padEnd(9)} ${e.detail || ""}`);
