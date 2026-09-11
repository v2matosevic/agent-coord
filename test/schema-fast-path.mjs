import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getDb } from "../lib/store.mjs";

assert.ok(process.env.AGENT_COORD_HOME, "run through the isolated runner");
const db = getDb();
const probe = () => {
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", fileURLToPath(new URL("_schema-probe.mjs", import.meta.url))],
    { encoding: "utf8", timeout: 5000, windowsHide: true, env: process.env });
  assert.equal(r.status, 0, `fresh reader must finish even while a writer is held: ${r.error || r.stderr}`);
  return JSON.parse(r.stdout);
};
assert.equal(probe().schemaWrites, 0, "unchanged schema must open without DDL or a writer transaction");
db.exec("BEGIN IMMEDIATE");
try {
  assert.equal(probe().schemaWrites, 0, "a warmed store opens while another process holds the writer lock");
} finally { db.exec("ROLLBACK"); }

db.exec("CREATE TABLE unrelated_future_feature (value TEXT)");
assert.ok(probe().schemaWrites > 0, "external DDL invalidates the schema cookie");
assert.equal(probe().schemaWrites, 0, "readiness is refreshed after harmless additive DDL");
db.exec("DROP INDEX idx_lease_agent_acquired");
assert.ok(probe().schemaWrites > 0, "a missing index must be repaired");
assert.ok(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='idx_lease_agent_acquired'").get());
assert.equal(probe().schemaWrites, 0);

db.prepare("DELETE FROM schema_readiness").run();
assert.ok(probe().schemaWrites > 0, "a missing readiness record takes the migration path");
assert.equal(probe().schemaWrites, 0);
assert.equal(db.prepare("SELECT version FROM schema_version").get().version, 2);
console.log("Warm schema opens without a writer; external DDL and missing readiness repair on the next open");
