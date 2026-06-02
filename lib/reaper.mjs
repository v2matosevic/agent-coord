import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeTxn, nowIso, isoAgoMs } from "./store.mjs";
import { COORD_HOME } from "./identity.mjs";
import { reapSessionLinks } from "./session-link.mjs";

// Keeps the store from accumulating dead agents / expired leases. No daemon —
// this runs opportunistically (on SessionStart, and throttled from the
// statusline), which is enough churn to stay tidy.

const REAP_AGENT_MS = 30 * 60 * 1000; // drop agents dead/silent longer than this
const MARK = join(COORD_HOME, ".last-reap");
const THROTTLE_MS = 60 * 1000;

export function reap(db) {
  const now = nowIso();
  writeTxn(db, () => {
    db.prepare("DELETE FROM agents WHERE status='dead' OR last_heartbeat < ?").run(isoAgoMs(REAP_AGENT_MS));
    db.prepare("DELETE FROM file_leases WHERE expires_at <= ? OR agent_id NOT IN (SELECT agent_id FROM agents)").run(now);
    db.prepare("DELETE FROM resource_leases WHERE expires_at <= ? OR agent_id NOT IN (SELECT agent_id FROM agents)").run(now);
    db.prepare("DELETE FROM lease_queue WHERE agent_id NOT IN (SELECT agent_id FROM agents)").run();
    db.prepare("DELETE FROM messages WHERE expires_at <= ?").run(now);
    db.prepare("DELETE FROM message_reads WHERE agent_id NOT IN (SELECT agent_id FROM agents)").run();
  });
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {}
  reapSessionLinks();
}

export function reapThrottled(db) {
  try {
    if (existsSync(MARK) && Date.now() - statSync(MARK).mtimeMs < THROTTLE_MS) return;
    writeFileSync(MARK, String(Date.now()));
  } catch {}
  try {
    reap(db);
  } catch {}
}
