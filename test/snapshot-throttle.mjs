// snapshot.json must stay fresh from the paths every session runs (hooks + MCP
// handler), not only from a TUI statusline — and refreshing must be cheap: a
// stat, and a rewrite at most once per SNAPSHOT_MAX_AGE_MS (i-da708fe8).
import { existsSync, statSync, utimesSync, readFileSync } from "node:fs";
import { getDb } from "../lib/store.mjs";
import { writeSnapshotThrottled, SNAPSHOT_PATH, SNAPSHOT_MAX_AGE_MS } from "../lib/snapshot.mjs";

const db = getDb();
const checks = {};

checks["missing snapshot → written"] = writeSnapshotThrottled(db) === true && existsSync(SNAPSHOT_PATH);
const first = statSync(SNAPSHOT_PATH).mtimeMs;
checks["fresh snapshot → skipped"] = writeSnapshotThrottled(db) === false && statSync(SNAPSHOT_PATH).mtimeMs === first;
const old = new Date(Date.now() - SNAPSHOT_MAX_AGE_MS - 1000);
utimesSync(SNAPSHOT_PATH, old, old);
checks["stale snapshot → rewritten"] = writeSnapshotThrottled(db) === true && statSync(SNAPSHOT_PATH).mtimeMs > old.getTime() + 500;
const body = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
checks["snapshot carries generatedAt + agents"] = typeof body.generatedAt === "string" && Array.isArray(body.agents);

let ok = true;
for (const [k, v] of Object.entries(checks)) {
  if (!v) ok = false;
  console.log(`${v ? "✅" : "❌"} ${k}`);
}
console.log(ok ? "PASS ✅ snapshot refresh is throttled, not statusline-bound" : "FAIL ❌");
process.exit(ok ? 0 : 1);
