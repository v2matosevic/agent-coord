import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { COORD_HOME } from "./identity.mjs";
import { SCHEMA_VERSION } from "./config.mjs";
import { pruneExitedAgents } from "./liveness.mjs";
import { deadlineAfter, deadlineError, remainingMs } from "./deadline.mjs";

export const DB_PATH = join(COORD_HOME, "state.db");
export const DEGRADED_FLAG = join(COORD_HOME, "coord-degraded.flag");
const MAX_RETRIES = 8;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS schema_readiness (fingerprint TEXT PRIMARY KEY, schema_cookie INTEGER NOT NULL);
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
CREATE INDEX IF NOT EXISTS idx_lease_agent_acquired ON file_leases(agent_id, acquired_at DESC);
CREATE TABLE IF NOT EXISTS resource_leases (
  resource_id TEXT PRIMARY KEY, agent_id TEXT, reason TEXT, acquired_at TEXT, expires_at TEXT
);
CREATE TABLE IF NOT EXISTS lease_queue (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, key TEXT, agent_id TEXT, requested_at TEXT, ttl_s INTEGER
);
CREATE TABLE IF NOT EXISTS activity_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, agent_id TEXT, workspace_id TEXT, event TEXT, detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_activity_edit_workspace_ts ON activity_log(workspace_id,ts) WHERE event='edit' AND detail IS NOT NULL;
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, workspace_id TEXT,
  from_agent TEXT, to_agent TEXT, body TEXT, expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_ws ON messages(workspace_id, seq);
CREATE TABLE IF NOT EXISTS message_reads (agent_id TEXT PRIMARY KEY, last_seq INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY, workspace_id TEXT, title TEXT, status TEXT DEFAULT 'open',
  owner_agent TEXT, depends_on TEXT, detail TEXT, created_by TEXT, created_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_ws ON tasks(workspace_id);
CREATE TABLE IF NOT EXISTS decisions (
  decision_id TEXT PRIMARY KEY, workspace_id TEXT, agent_id TEXT,
  topic TEXT, decision TEXT, ts TEXT
);
CREATE INDEX IF NOT EXISTS idx_decisions_ws ON decisions(workspace_id, ts);
CREATE TABLE IF NOT EXISTS issues (
  issue_id TEXT PRIMARY KEY, ts TEXT, updated_at TEXT,
  workspace_id TEXT, repo_path TEXT, project TEXT, agent_id TEXT, branch TEXT,
  severity TEXT DEFAULT 'medium', kind TEXT DEFAULT 'bug', title TEXT, body TEXT,
  area TEXT, tags TEXT, status TEXT DEFAULT 'open',
  resolution TEXT, resolved_by TEXT, resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status, ts);
CREATE INDEX IF NOT EXISTS idx_issues_ws ON issues(workspace_id);
CREATE TABLE IF NOT EXISTS file_waits (
  wait_id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL,
  path TEXT NOT NULL, agent_id TEXT NOT NULL, mode TEXT NOT NULL,
  started_at TEXT NOT NULL, last_attempt_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 1,
  editing_attempts INTEGER NOT NULL DEFAULT 0, reservation_attempts INTEGER NOT NULL DEFAULT 0,
  unknown_attempts INTEGER NOT NULL DEFAULT 0, ended_at TEXT, outcome TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wait_open ON file_waits(workspace_id,path,agent_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_wait_path ON file_waits(workspace_id,path,ended_at);
CREATE INDEX IF NOT EXISTS idx_wait_retention ON file_waits(ended_at);
CREATE TABLE IF NOT EXISTS file_wait_notices (
  wait_id INTEGER NOT NULL, holder_id TEXT NOT NULL, notified_at TEXT NOT NULL,
  PRIMARY KEY(wait_id,holder_id)
);
`;
// Note: the tasks/decisions/issues tables are purely additive and never read by
// older code, so they ship WITHOUT a SCHEMA_VERSION bump — that keeps long-running
// v2 MCP servers in the live fleet from tripping the "schema ahead" degraded flag.
// Unlike the workspace-scoped, short-lived coordination tables, `issues` is a
// CROSS-PROJECT, durable incident log: rows carry their origin (workspace/repo/
// project) but are meant to be surveyed globally and never auto-expire — it's the
// "come back later and see what went wrong" record, not live coordination chatter.

// Additive column migrations, same no-bump rationale: older code never selects
// these columns explicitly, and INSERTs with explicit column lists stay valid.
// Runs inside the IMMEDIATE schema txn so two cold-starting processes can't
// both ALTER (the second sees the column and skips).
const TASK_COLUMNS = [
  ["summary", "TEXT"], // completion handoff: what was built / gotchas, for dependents
  ["priority", "INTEGER DEFAULT 0"], // claim_next_task picks highest first
];
const AGENT_COLUMNS = [
  ["owner_pid", "INTEGER"], // resolved long-lived client, never a hook wrapper
  // announce_intent's declared lane. Overlap detection compares this over raw
  // prompt text, so a resumed session's "Continue where you left off" prompt
  // can't clobber a deliberately differentiated intent (the gilt-hawk false
  // positive: every UserPromptSubmit rewrote current_task, so re-announcing
  // never stuck).
  ["intent", "TEXT"],
];
function ensureTaskColumns(db) {
  const have = new Set(db.prepare("PRAGMA table_info(tasks)").all().map((c) => c.name));
  for (const [name, type] of TASK_COLUMNS) {
    if (!have.has(name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
  }
  const haveAgents = new Set(db.prepare("PRAGMA table_info(agents)").all().map((c) => c.name));
  for (const [name, type] of AGENT_COLUMNS) {
    if (!haveAgents.has(name)) db.exec(`ALTER TABLE agents ADD COLUMN ${name} ${type}`);
  }
  const haveLeases = new Set(db.prepare("PRAGMA table_info(file_leases)").all().map((c) => c.name));
  for (const [name, type] of [["activity_state", "TEXT"], ["operation_id", "TEXT"]]) {
    if (!haveLeases.has(name)) db.exec(`ALTER TABLE file_leases ADD COLUMN ${name} ${type}`);
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_lease_operation ON file_leases(agent_id,operation_id)");
}

let _db = null;
const deadlines = new WeakMap();

// The compatibility version deliberately does not change for additive upgrades.
// Include both DDL and column migrations so a new checkout cannot trust an old
// readiness record. Separate fingerprints let compatible versions coexist.
const SCHEMA_FINGERPRINT = createHash("sha256")
  .update(SCHEMA).update(JSON.stringify([SCHEMA_VERSION, TASK_COLUMNS, AGENT_COLUMNS]))
  .update(ensureTaskColumns.toString()).digest("hex");

function schemaReady(db) {
  try {
    // Read the readiness marker, compatibility version and SQLite's DDL counter
    // together. External schema changes invalidate the fast path; the counter
    // is only READ, never assigned. Ordinary opens need no writer transaction.
    const row = db.prepare(`SELECT version, EXISTS(
      SELECT 1 FROM schema_readiness WHERE fingerprint=?
        AND schema_cookie=(SELECT schema_version FROM pragma_schema_version)
    ) AS ready FROM schema_version LIMIT 1`).get(SCHEMA_FINGERPRINT);
    return row && row.version >= SCHEMA_VERSION && row.ready;
  } catch (error) {
    if (/no such table/i.test(error.message)) return false;
    throw error;
  }
}

export function getDb({ deadline = Infinity } = {}) {
  if (_db) {
    if (Number.isFinite(deadline)) deadlines.set(_db, Math.min(deadlines.get(_db) ?? Infinity, deadline));
    pruneExitedAgents(_db);
    return _db;
  }
  mkdirSync(COORD_HOME, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  deadlines.set(db, deadline);
  try {
    db.exec(`PRAGMA busy_timeout=${remainingMs(deadline)}; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;`);
    if (!schemaReady(db)) {
      writeTxn(db, () => {
        db.exec(SCHEMA);
        ensureTaskColumns(db);
        const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get();
        if (!row) db.prepare("INSERT INTO schema_version(version) VALUES(?)").run(SCHEMA_VERSION);
        else if (row.version < SCHEMA_VERSION) db.prepare("UPDATE schema_version SET version=?").run(SCHEMA_VERSION);
        const cookie = db.prepare("PRAGMA schema_version").get().schema_version;
        db.prepare("INSERT INTO schema_readiness(fingerprint,schema_cookie) VALUES(?,?) ON CONFLICT(fingerprint) DO UPDATE SET schema_cookie=excluded.schema_cookie")
          .run(SCHEMA_FINGERPRINT, cookie);
      });
    }
    // Even a cached schema must still warn when a newer incompatible version
    // has touched the store. Data changes do not move SQLite's DDL counter.
    const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get();
    if (row?.version > SCHEMA_VERSION) {
      setDegraded({ code: "SCHEMA_AHEAD", message: `store schema v${row.version} > supported v${SCHEMA_VERSION}` });
    }
  } catch (error) {
    db.close();
    if (Number.isFinite(deadline) && isBusy(error)) throw deadlineError();
    throw error;
  }
  _db = db;
  pruneExitedAgents(db);
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
  const deadline = deadlines.get(db) ?? Infinity;
  let lastErr;
  for (let i = 0; i < MAX_RETRIES; i++) {
    if (Number.isFinite(deadline)) db.exec(`PRAGMA busy_timeout=${remainingMs(deadline)}`);
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (e) {
      if (isBusy(e)) {
        lastErr = e;
        sleep(remainingMs(deadline, backoff(i)));
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
        sleep(remainingMs(deadline, backoff(i)));
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

// Optional bookkeeping may use less of a hook's remaining wait budget, never
// extend it. Restore both controls so the scope cannot poison a later operation.
export function withWriteBudget(db, milliseconds, fn) {
  const previous = deadlines.get(db) ?? Infinity;
  const timeout = db.prepare("PRAGMA busy_timeout").get().timeout;
  deadlines.set(db, Math.min(previous, deadlineAfter(milliseconds)));
  try { return fn(); }
  finally {
    deadlines.set(db, previous);
    db.exec(`PRAGMA busy_timeout=${timeout}`);
  }
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
