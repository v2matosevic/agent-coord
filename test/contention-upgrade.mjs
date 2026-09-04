import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

assert.ok(process.env.AGENT_COORD_HOME, "run through the isolated runner");
mkdirSync(process.env.AGENT_COORD_HOME, { recursive: true });
const old = new DatabaseSync(join(process.env.AGENT_COORD_HOME, "state.db"));
old.exec(`CREATE TABLE schema_version(version INTEGER NOT NULL); INSERT INTO schema_version VALUES(2);
  CREATE TABLE file_leases(lease_id TEXT PRIMARY KEY,workspace_id TEXT,path TEXT,agent_id TEXT,mode TEXT,content_hash TEXT,reason TEXT,acquired_at TEXT,expires_at TEXT);
  INSERT INTO file_leases VALUES('old-lease','workspace','held.txt','old-agent','exclusive',NULL,'legacy','2026-09-01','2099-01-01');`);
old.close();
const { getDb } = await import("../lib/store.mjs");
const db = getDb();
assert.equal(db.prepare("SELECT version FROM schema_version").get().version, 2);
const lease = db.prepare("SELECT * FROM file_leases WHERE lease_id='old-lease'").get();
assert.equal(lease.agent_id, "old-agent");
assert.equal(lease.activity_state, null);
assert.equal(lease.operation_id, null);
assert.equal(db.prepare("SELECT COUNT(*) n FROM file_waits").get().n, 0);
// Legacy explicit-column writes still work after the additive migration.
db.prepare("INSERT INTO file_leases(lease_id,workspace_id,path,agent_id) VALUES('another','workspace','other.txt','old-agent')").run();
assert.equal(db.prepare("SELECT COUNT(*) n FROM file_leases").get().n, 2);
console.log("Warm schema v2 upgrade preserves leases and legacy writers without a version bump");
