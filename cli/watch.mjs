import { existsSync } from "node:fs";
import { getDb, DEGRADED_FLAG } from "../lib/store.mjs";
import { getFleet, recentActivity, queueDepth } from "../lib/activity.mjs";

// Live fleet view — no daemon, just a refresh loop. Ctrl-C to exit.
const db = getDb();

function render() {
  const fleet = getFleet(db);
  const lines = [];
  lines.push(`agent-coord — ${fleet.length} live agent${fleet.length === 1 ? "" : "s"}   (refresh 2s, Ctrl-C to quit)`);
  if (existsSync(DEGRADED_FLAG)) lines.push("⚠ DEGRADED — lock enforcement may be off");
  lines.push("");
  for (const a of fleet) {
    const repo = a.repo_path ? a.repo_path.split("/").pop() : "—";
    const doing = a.editing ? "⚙ " + a.editing : a.current_task || "";
    lines.push(`  ${a.agent_id.padEnd(20)} ${String(a.tool).padEnd(12)} ${`${repo}@${a.branch || "?"}`.padEnd(22)} ${doing}`);
  }
  lines.push("", "recent:");
  for (const e of recentActivity(db, 8).reverse()) lines.push(`  ${e.ts.slice(11, 19)}  ${String(e.agent_id).padEnd(20)} ${e.event} ${e.detail || ""}`);
  console.clear();
  console.log(lines.join("\n"));
}

render();
setInterval(render, 2000);
