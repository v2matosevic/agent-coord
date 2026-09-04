import assert from "node:assert/strict";
import { getDb, writeTxn } from "../lib/store.mjs";
import { ensureAgent } from "../lib/agents.mjs";
import { claimFile, claimFiles, claimOperation, claimResource, releaseFile, releaseAllForAgent, enqueue } from "../lib/leases.mjs";
import { contentionStats, finishFileOperation, holderWaitNotices, reapContentionInTxn, WAIT_RETENTION_MS } from "../lib/contention.mjs";
import { midTurnContext } from "../lib/coord-context.mjs";
import { DEAD_MS, FILE_ACTIVE_MS, FILE_TTL_SEC } from "../lib/config.mjs";

assert.ok(process.env.AGENT_COORD_HOME, "run through the isolated test runner");
const RealDate = Date;
let now = Date.now();
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
};
const db = getDb(), ws = "contention";
const alive = (id) => ensureAgent(db, { agentId: id, repoPath: "/contention" });
const claim = (id, path = "held.txt", extra = {}) => claimFile(db, { agentId: id, workspaceId: ws, path, ...extra });
const release = (id, path = "held.txt") => releaseFile(db, { agentId: id, workspaceId: ws, path });
const stat = (path = "held.txt") => contentionStats(db, { workspaceId: ws }).find(f => f.path === path);
const notice = (id) => midTurnContext(db, { agentId: id, workspaceId: ws });
try {
  for (const id of ["a", "b", "c"]) alive(id);
  claim("a", "held.txt", { operationId: "edit-one" });
  assert.equal(claim("b").granted, false);
  enqueue(db, { kind: "file", key: ws + "||held.txt", agentId: "b" });
  assert.equal(stat().attempts, 1, "legacy enqueue does not count retries");
  assert.equal(stat().editingAttempts, 1);
  finishFileOperation(db, { agentId: "c", operationId: "edit-one" });
  assert.equal(db.prepare("SELECT activity_state FROM file_leases WHERE agent_id='a'").get().activity_state, "editing");
  finishFileOperation(db, { agentId: "a", operationId: "edit-one" });
  now += 1000;
  claim("b"); claim("b");
  assert.equal(stat().episodes, 1);
  assert.equal(stat().attempts, 3);
  assert.equal(stat().reservationAttempts, 2);
  assert.equal(stat().waitMs, 1000);
  const tiny = midTurnContext(db, { agentId: "a", workspaceId: ws, budget: 60 });
  assert.ok(!tiny?.includes("safe handoff point"));
  assert.equal(holderWaitNotices(db, { agentId: "a", workspaceId: ws }).length, 1, "unfitted notice remains pending");
  assert.match(notice("a"), /b is waiting.*held.txt.*safe handoff point/);
  assert.ok(!notice("a"), "one holder notice per episode");
  claim("b");
  assert.ok(!notice("a"), "retry does not spam holder");
  now += 9000;
  release("a");
  assert.equal(stat().waitMs, 10000);
  assert.deepEqual(stat().outcomes, { released: 1 });
  assert.match(notice("b"), /held.txt.*Reclaim/);
  assert.equal(claim("b").granted, true);
  assert.equal(stat().waitMs, 10000, "later acquisition does not inflate contention duration");
  assert.equal(contentionStats(db, { workspaceId: "other" }).length, 0);

  // A new block after release is a new episode, with a new holder notice.
  release("b"); claim("a"); claim("b");
  assert.equal(stat().episodes, 2);
  assert.match(notice("a"), /b is waiting/);
  release("b");
  assert.equal(stat().outcomes.cancelled, 1);
  assert.ok(!notice("a"));

  // Multiple shared holders: one release cannot falsely finish an exclusive wait.
  claim("a", "shared.txt", { mode: "shared" });
  claim("c", "shared.txt", { mode: "shared" });
  claim("b", "shared.txt");
  release("a", "shared.txt");
  assert.equal(stat("shared.txt").pending, 1);
  assert.equal(holderWaitNotices(db, { agentId: "a", workspaceId: ws }).length, 0);
  assert.match(notice("c"), /shared.txt/);
  release("c", "shared.txt");
  assert.equal(stat("shared.txt").pending, 0);

  // A denied multi-file operation adds only its actual blocker episode.
  const before = db.prepare("SELECT * FROM file_leases WHERE agent_id='a' AND path='held.txt'").get();
  const denied = claimFiles(db, { agentId: "b", workspaceId: ws, paths: ["free.txt", "held.txt"], operationId: "batch" });
  assert.equal(denied.granted, false);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM file_leases WHERE path='free.txt'").get().n, 0);
  assert.deepEqual(db.prepare("SELECT * FROM file_leases WHERE agent_id='a' AND path='held.txt'").get(), before);
  assert.equal(stat("free.txt"), undefined);
  claimResource(db, { agentId: "a", resourceId: "port:12345" });
  assert.equal(claimOperation(db, { agentId: "b", workspaceId: ws, paths: ["free.txt"], resources: [{ resourceId: "port:12345" }] }).granted, false);
  assert.equal(stat("free.txt"), undefined, "resource denial is not file contention");

  // Exact modeled expiry boundaries, including live-but-idle reservations.
  claim("a", "expiry.txt", { ttlSec: 2 }); claim("b", "expiry.txt");
  now += 2500;
  assert.equal(stat("expiry.txt").waitMs, 2000);
  assert.equal(stat("expiry.txt").outcomes["lease-expired"], 1);
  claim("a", "cold.txt"); claim("b", "cold.txt");
  now += FILE_ACTIVE_MS + 100;
  alive("a"); alive("b");
  assert.equal(stat("cold.txt").waitMs, FILE_ACTIVE_MS);
  assert.equal(stat("cold.txt").outcomes.cold, 1);
  claim("a", "abandoned.txt"); claim("b", "abandoned.txt");
  now += DEAD_MS + 100;
  alive("a");
  assert.equal(stat("abandoned.txt").waitMs, DEAD_MS);
  assert.equal(stat("abandoned.txt").outcomes.abandoned, 1);
  assert.equal(holderWaitNotices(db, { agentId: "a", workspaceId: ws }).length, 0, "stale waiter never nags a live holder");
  alive("b");
  claim("a", "silent.txt"); claim("b", "silent.txt");
  now += DEAD_MS + 100; alive("b");
  assert.equal(stat("silent.txt").waitMs, DEAD_MS);
  assert.equal(stat("silent.txt").outcomes["holder-silent"], 1);

  alive("a");
  claim("a", "long-wait.txt"); claim("b", "long-wait.txt");
  now += FILE_TTL_SEC * 1000 + 1; alive("a"); alive("b");
  // Holder kept renewing while the waiter never retried this particular path.
  db.prepare("UPDATE file_leases SET acquired_at=?,expires_at=? WHERE path='long-wait.txt'").run(new Date().toISOString(), new Date(now + 10000).toISOString());
  assert.equal(stat("long-wait.txt").outcomes["wait-expired"], 1);
  assert.equal(stat("long-wait.txt").waitMs, FILE_TTL_SEC * 1000);

  claim("a", "legacy.txt");
  db.prepare("UPDATE file_leases SET activity_state=NULL WHERE path='legacy.txt'").run();
  claim("b", "legacy.txt");
  assert.equal(stat("legacy.txt").unknownAttempts, 1);
  releaseAllForAgent(db, "b");
  assert.equal(stat("legacy.txt").outcomes.abandoned, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM file_leases WHERE path='legacy.txt' AND agent_id='a'").get().n, 1);

  const changes = () => db.prepare("SELECT total_changes() n").get().n;
  const count = changes();
  contentionStats(db); contentionStats(db);
  finishFileOperation(db, { agentId: "a", operationId: "unrelated-read" });
  assert.equal(changes(), count, "read-only reporting and unrelated post events do not write");
  // A telemetry failure must never let a known conflicting write through.
  claim("a", "failure.txt");
  db.exec("CREATE TRIGGER refuse_metric BEFORE INSERT ON file_waits BEGIN SELECT RAISE(ABORT,'planted telemetry failure'); END");
  assert.equal(claim("b", "failure.txt").granted, false);
  assert.equal(claimFiles(db, { agentId: "b", workspaceId: ws, paths: ["rollback.txt", "failure.txt"] }).granted, false);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM file_leases WHERE path='rollback.txt'").get().n, 0);
  assert.equal(claim("b", "uncontended.txt").granted, true);
  db.exec("DROP TRIGGER refuse_metric");
  writeTxn(db, () => reapContentionInTxn(db));
  now += WAIT_RETENTION_MS + 1;
  writeTxn(db, () => reapContentionInTxn(db));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM file_waits").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM file_wait_notices").get().n, 0);
  console.log("Wait episodes/retries, duration, operation state, budget-aware notices, expiry, cancellation, rollback and retention passed");
} finally { globalThis.Date = RealDate; }
