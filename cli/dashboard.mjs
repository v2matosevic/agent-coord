import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { getDb, DEGRADED_FLAG } from "../lib/store.mjs";
import { getGlobalState } from "../lib/activity.mjs";
import { collisionHotspots, coordinationROI } from "../lib/insights.mjs";
import { reapThrottled } from "../lib/reaper.mjs";
import { PAGE } from "./dashboard-ui.mjs";

// Live fleet dashboard. A read-only view ON TOP of the store (not a source of
// truth) — start it on demand, kill it any time. Usage: node cli/dashboard.mjs [port]
const PORT = Number(process.argv[2]) || 7777;
const db = getDb();

const server = createServer((req, res) => {
  if (req.url.startsWith("/api/insights")) {
    // Heavier scan than /api/state (full activity window) — the page polls it
    // on its own slow cadence, not every tick.
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ roi: coordinationROI(db), hotspots: collisionHotspots(db).slice(0, 12) }));
    return;
  }
  if (req.url.startsWith("/api/state")) {
    reapThrottled(db);
    const state = getGlobalState(db);
    state.degraded = existsSync(DEGRADED_FLAG);
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(state));
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE);
});

server.listen(PORT, "127.0.0.1", () => console.log(`agent-coord dashboard → http://localhost:${PORT}`));
