import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { COORD_HOME } from "./identity.mjs";
import { SCHEMA_VERSION } from "./config.mjs";

export const DB_PATH = join(COORD_HOME, "state.db");
export const DEGRADED_FLAG = join(COORD_HOME, "coord-degraded.flag");
const MAX_RETRIES = 8;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY, tool TEXT, pid INTEGER, proc_start_time TEXT,
  repo_path TEXT, branch TEXT, worktree_path TEXT, current_task TEXT,
  status TEXT DEFAULT 'active', registered_at TEXT, last_heartbeat TEXT, session_token TEXT
);
CREATE TABLE IF NOT EXISTS workspaces (workspace_id TEXT PRIMARY KEY, repo_path TEXT, branch TEXT);
CREATE TABLE IF NOT EXISTS file_leases (
  lease_id TEXT PRIMARY KEY, workspace_id TEXT, path TEXT, agent_id TEXT,
  mode TEXT DEFAULT 'shared', content_hash TEXT, reason TEXT, acquired_at TEXT, expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_leases_ws_path ON file_leases(workspace_id, path);
CREATE TABLE IF NOT EXISTS resource_leases (
  resource_id TEXT PRIMARY KEY, agent_id TEXT, reason TEXT, acquired_at TEXT, expires_at TEXT
);
CREATE TABLE IF NOT EXISTS lease_queue (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, key TEXT, agent_id TEXT, requested_at TEXT, ttl_s INTEGER
);
CREATE TABLE IF NOT EXISTS activity_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, agent_id TEXT, workspace_id TEXT, event TEXT, detail TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, workspace_id TEXT,
  from_agent TEXT, to_agent TEXT, body TEXT, expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_ws ON messages(workspace_id, seq);
CREATE TABLE IF NOT EXISTS message_reads (agent_id TEXT PRIMARY KEY, last_seq INTEGER DEFAULT 0);
`;

let _db = null;

export function getDb() {
  if (_db) return _db;
  mkdirSync(COORD_HOME, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON;");
  db.exec(SCHEMA); // CREATE IF NOT EXISTS — safe under concurrent cold starts
  writeTxn(db, () => {
    const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get();
    if (!row) db.prepare("INSERT INTO schema_version(version) VALUES(?)").run(SCHEMA_VERSION);
    else if (row.version < SCHEMA_VERSION) db.prepare("UPDATE schema_version SET version=?").run(SCHEMA_VERSION); // additive forward migration
    else if (row.version > SCHEMA_VERSION) {
      // A newer install wrote this store. Don't risk incompatible writes silently.
      setDegraded({ code: "SCHEMA_AHEAD", message: `store schema v${row.version} > supported v${SCHEMA_VERSION}` });
    }
  });
  _db = db;
  return db;
}

function isBusy(e) {
  return /busy|locked/i.test(`${e?.code} ${e?.message}`);
}

// Synchronous sleep — node:sqlite is synchronous, so we cannot await. Atomics
// blocks the thread without spinning the CPU.
function sleep(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {}
}

function backoff(i) {
  return Math.min(200, 5 * 2 ** i) + Math.floor(Math.random() * 10);
}

// Every mutation goes through here. BEGIN IMMEDIATE takes the write lock up
// front so contenders queue (via busy_timeout) instead of deadlocking on a
// deferred read->write upgrade. Retry-with-jitter is the backstop if the
// timeout is ever exceeded.
export function writeTxn(db, fn) {
  let lastErr;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (e) {
      if (isBusy(e)) {
        lastErr = e;
        sleep(backoff(i));
        continue;
      }
      throw e;
    }
    try {
      const r = fn(db);
      db.exec("COMMIT");
      return r;
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      if (isBusy(e)) {
        lastErr = e;
        sleep(backoff(i));
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error("writeTxn: retries exhausted");
}

export function readTxn(db, fn) {
  return fn(db);
}

export function nowIso() {
  return new Date().toISOString();
}
export function isoAgoMs(ms) {
  return new Date(Date.now() - ms).toISOString();
}
export function isoInSec(sec) {
  return new Date(Date.now() + sec * 1000).toISOString();
}

export function setDegraded(e) {
  try {
    writeFileSync(DEGRADED_FLAG, `${nowIso()} ${e?.code || ""} ${e?.message || e}\n`);
  } catch {}
}
export function clearDegraded() {
  try {
    rmSync(DEGRADED_FLAG, { force: true });
  } catch {}
}
