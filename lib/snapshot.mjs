import { writeFileSync, renameSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { COORD_HOME } from "./identity.mjs";
import { DEGRADED_FLAG } from "./store.mjs";
import { getGlobalState } from "./activity.mjs";

// This file is <repo>/lib/snapshot.mjs, so up two dirs is the clone root. We
// stamp it into the snapshot so the VS Code extension can locate cli/state-json.mjs
// for its live-refresh fallback without any configured path.
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// A plain-JSON mirror of the fleet state at COORD_HOME, kept fresh by whatever
// runs often and already holds the DB — primarily the Claude statusline (every
// few seconds per live window). External consumers that can't open the SQLite
// store read this file instead: the VS Code extension host has no node:sqlite,
// and a Finder-launched editor often has no node>=22 on PATH at all (fnm's node
// lives at an ephemeral per-shell path). No subprocess, no native module, no
// PATH dependency. Live readers fall back to `cli/state-json.mjs` only when this
// file is missing or stale.
export const SNAPSHOT_PATH = join(COORD_HOME, "snapshot.json");

export function writeSnapshot(db) {
  try {
    const state = getGlobalState(db);
    state.degraded = existsSync(DEGRADED_FLAG);
    state.generatedAt = new Date().toISOString();
    state.root = REPO_ROOT;
    // Atomic write (temp + rename) so a concurrent reader never sees a torn file.
    const tmp = `${SNAPSHOT_PATH}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, SNAPSHOT_PATH);
  } catch {}
}
