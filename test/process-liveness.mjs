import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getDb, writeTxn, isoAgoMs } from "../lib/store.mjs";
import { ensureAgent, ensureAgentContext, agentAlive, keepAlive, markDead } from "../lib/agents.mjs";
import { processRunning } from "../lib/liveness.mjs";
import { claimFile, claimResource, peekConflicts, enqueue } from "../lib/leases.mjs";
import { getFleet, getGlobalState } from "../lib/activity.mjs";
import { writeSnapshot, SNAPSHOT_PATH } from "../lib/snapshot.mjs";
import { COORD_HOME } from "../lib/identity.mjs";

const db = getDb();
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
await once(child, "spawn");
try {
  assert.equal(processRunning(child.pid), true);
  assert.equal(processRunning(null), null);
  assert.equal(processRunning(-1), null);
  ensureAgent(db, { agentId: "closed", ownerPid: child.pid });
  ensureAgent(db, { agentId: "live", ownerPid: process.pid });
  ensureAgent(db, { agentId: "unknown" });
  assert.equal(claimFile(db, { agentId: "closed", workspaceId: "ws", path: "x" }).granted, true);
  assert.equal(claimResource(db, { agentId: "closed", resourceId: "test-resource" }).granted, true);
  enqueue(db, { agentId: "closed", kind: "file", key: "ws||waiting" });
  assert.equal(peekConflicts(db, { workspaceId: "ws", path: "x", agentId: "live" }).length, 1);
  writeSnapshot(db);
  const frozenSnapshot = readFileSync(SNAPSHOT_PATH, "utf8");

  const exited = once(child, "exit");
  child.kill();
  await exited;
  assert.equal(processRunning(child.pid), false);
  // No three-minute sleep or lifecycle hook. The first conflict read detects it.
  assert.deepEqual(peekConflicts(db, { workspaceId: "ws", path: "x", agentId: "live" }), []);
  assert.equal(agentAlive(db, "closed"), false);
  assert.equal(claimResource(db, { agentId: "live", resourceId: "test-resource" }).granted, true);
  assert.deepEqual(getFleet(db).map((a) => a.agent_id).sort(), ["live", "unknown"]);
  for (const cap of [0, 1]) {
    const state = getGlobalState(db, { cap });
    for (const key of ["fileLeases", "resourceLeases", "queue"]) {
      assert.equal(state[key].some((r) => r.agent_id === "closed"), false, key);
    }
  }
  // AD's existing reader prefers marker mtime over snapshot heartbeat. Even a
  // frozen snapshot cannot resurrect this identity once its marker is cold.
  assert.equal(readFileSync(SNAPSHOT_PATH, "utf8"), frozenSnapshot);
  assert.ok(Date.now() - statSync(join(COORD_HOME, "hb", "closed")).mtimeMs > 180000);
  keepAlive(db, "closed");
  assert.equal(agentAlive(db, "closed"), false, "background heartbeat must not revive a closed session");

  // Resume replaces the old process even while context and heartbeat are warm.
  ensureAgentContext(db, { agentId: "closed", tool: "codex", repoPath: null, branch: null, ownerPid: process.pid });
  assert.equal(agentAlive(db, "closed"), true);
  ensureAgentContext(db, { agentId: "closed", tool: "codex", repoPath: null, branch: null, ownerPid: child.pid });
  assert.equal(db.prepare("SELECT owner_pid FROM agents WHERE agent_id='closed'").get().owner_pid, child.pid);
  assert.equal(agentAlive(db, "closed"), false);
  ensureAgent(db, { agentId: "closed" });
  assert.equal(agentAlive(db, "closed"), true, "resume without a resolved owner must not inherit a known dead PID");
  assert.equal(db.prepare("SELECT owner_pid FROM agents WHERE agent_id='closed'").get().owner_pid, null);
  markDead(db, "closed");
  markDead(db, "live");
  keepAlive(db, "live");
  assert.equal(agentAlive(db, "live"), false, "connected MCP must respect explicit SessionEnd");
  assert.ok(Date.now() - statSync(join(COORD_HOME, "hb", "live")).mtimeMs > 180000);
  ensureAgent(db, { agentId: "live", ownerPid: process.pid });
  assert.equal(agentAlive(db, "live"), true, "a real event may resume the same identity");
  // A live PID is only a veto on declaring process death, never an exemption
  // from the original activity timeout (shared hosts serve several threads).
  writeTxn(db, () => db.prepare("UPDATE agents SET last_heartbeat=? WHERE agent_id='live'").run(isoAgoMs(181000)));
  assert.equal(agentAlive(db, "live"), false);
  console.log("PASS: exited owners stop blocking immediately; live/unknown owners preserved; AD stale snapshot overridden; background cannot revive; resume updates ownership");
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill();
}
