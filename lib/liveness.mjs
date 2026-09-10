import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COORD_HOME } from "./identity.mjs";
import { writeTxn } from "./store.mjs";

// Permission errors and unknown owners are not evidence of death. Never use a
// hook's transient parent PID as the owner: only a resolved agent process.
export function processRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "ESRCH" ? false : null; }
}

export function endHeartbeat(agentId) {
  try {
    mkdirSync(join(COORD_HOME, "hb"), { recursive: true });
    const path = join(COORD_HOME, "hb", encodeURIComponent(String(agentId)));
    writeFileSync(path, "ended");
    // AD reads the mtime, falling back to its snapshot when a marker is absent.
    // Keep a cold marker so an older snapshot cannot revive an ended session.
    utimesSync(path, new Date(0), new Date(0));
  } catch {}
}

export function pruneExitedAgents(db) {
  const exited = db.prepare("SELECT agent_id, owner_pid FROM agents WHERE status='active' AND owner_pid IS NOT NULL")
    .all().filter((row) => processRunning(row.owner_pid) === false);
  if (!exited.length) return 0;
  return writeTxn(db, () => {
    let count = 0;
    for (const row of exited) {
      // A resumed session can replace its owner between the read and this txn.
      const changed = db.prepare("UPDATE agents SET status='dead' WHERE agent_id=? AND owner_pid=? AND status='active'")
        .run(row.agent_id, row.owner_pid).changes;
      if (changed) { endHeartbeat(row.agent_id); count += changed; }
    }
    return count;
  });
}
