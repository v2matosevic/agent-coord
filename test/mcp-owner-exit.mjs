import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "../lib/store.mjs";
import { agentAlive } from "../lib/agents.mjs";
import { COORD_HOME } from "../lib/identity.mjs";
import { processRunning } from "../lib/liveness.mjs";

const db = getDb();
// Give a real Node client a native agent executable name. This tests the same
// process ancestry resolver used in AD, without launching a paid agent session.
const exe = join(COORD_HOME, process.platform === "win32" ? "codex.exe" : "codex");
copyFileSync(process.execPath, exe);
const owner = fork("test/_mcp-owner.mjs", [], { execPath: exe, windowsHide: true,
  stdio: ["ignore", "ignore", "pipe", "ipc"],
  env: { ...process.env, COORD_TEST_NODE: process.execPath } });
let serverPid;
try {
  const [identity] = await once(owner, "message");
  serverPid = identity.serverPid;
  assert.equal(db.prepare("SELECT owner_pid FROM agents WHERE agent_id=?").get(identity.agentId).owner_pid, owner.pid);
  assert.equal(agentAlive(db, identity.agentId), true);
  const exit = once(owner, "exit");
  owner.kill();
  await exit;
  assert.equal(agentAlive(db, identity.agentId), false, "native owner exit must invalidate its fresh heartbeat");
  console.log("PASS: real native client ancestry binds correct PID; abrupt client exit is detected without SessionEnd");
} finally {
  if (owner.exitCode === null && owner.signalCode === null) owner.kill();
  // Only this fixture's own MCP child, never a process-name sweep.
  if (serverPid && processRunning(serverPid) === true) { try { process.kill(serverPid); } catch {} }
}
