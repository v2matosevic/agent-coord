import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { getDb, DB_PATH, writeTxn } from "../lib/store.mjs";
import { observeGuardDenial } from "../lib/guard-observation.mjs";
import { deadlineAfter } from "../lib/deadline.mjs";

assert.ok(process.env.AGENT_COORD_HOME, "run through the isolated runner");
const db = getDb();
const before = db.prepare("PRAGMA busy_timeout").get().timeout;
const writer = new DatabaseSync(DB_PATH);
writer.exec("BEGIN IMMEDIATE");
let called = false;
const start = performance.now();
try {
  observeGuardDenial(db, () => writeTxn(db, () => { called = true; }));
  assert.equal(called, false, "bookkeeping cannot take a writer held by another connection");
  assert.ok(performance.now() - start < 1000, "optional observation returns promptly under contention");
  assert.equal(db.prepare("PRAGMA busy_timeout").get().timeout, before, "scope restores the database timeout");
} finally { writer.exec("ROLLBACK"); writer.close(); }
writeTxn(db, () => { called = true; });
assert.equal(called, true, "an exhausted optional budget does not poison later operations");
getDb({ deadline: deadlineAfter(-1) });
called = false;
observeGuardDenial(db, () => writeTxn(db, () => { called = true; }));
assert.equal(called, false, "an optional scope must not extend an expired outer deadline");
console.log("Guard bookkeeping is bounded, cannot throw into enforcement, and restores the outer wait controls");
