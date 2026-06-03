import { existsSync } from "node:fs";
import { getDb, DEGRADED_FLAG } from "../lib/store.mjs";
import { getGlobalState } from "../lib/activity.mjs";
import { reapThrottled } from "../lib/reaper.mjs";
import { writeSnapshot } from "../lib/snapshot.mjs";

// Machine-readable fleet snapshot for external consumers (the VS Code extension's
// live-refresh fallback). Reuses the same store/queries as the dashboard. One
// line of JSON to stdout, and it refreshes the on-disk snapshot.json cache too.
const db = getDb();
reapThrottled(db);
writeSnapshot(db);
const state = getGlobalState(db);
state.degraded = existsSync(DEGRADED_FLAG);
state.generatedAt = new Date().toISOString();
process.stdout.write(JSON.stringify(state));
