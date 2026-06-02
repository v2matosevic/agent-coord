import { existsSync } from "node:fs";
import { getDb, DEGRADED_FLAG } from "../lib/store.mjs";
import { getGlobalState } from "../lib/activity.mjs";
import { reapThrottled } from "../lib/reaper.mjs";

// Machine-readable fleet snapshot for external consumers (the VS Code extension).
// Reuses the same store/queries as the dashboard. One line of JSON to stdout.
const db = getDb();
reapThrottled(db);
const state = getGlobalState(db);
state.degraded = existsSync(DEGRADED_FLAG);
process.stdout.write(JSON.stringify(state));
