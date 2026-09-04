import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { getDb } from "../lib/store.mjs";
import { ensureAgent } from "../lib/agents.mjs";
import { claimFile } from "../lib/leases.mjs";

assert.ok(process.env.AGENT_COORD_HOME, "run through the isolated runner");
const db = getDb();
for (const agentId of ["holder", "waiter"]) ensureAgent(db, { agentId, repoPath: "/concurrent" });
claimFile(db, { agentId: "holder", workspaceId: "ws", path: "held.txt" });
const run = (code) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", code], { env: process.env, windowsHide: true });
  let stdout = "", stderr = "";
  p.stdout.on("data", c => stdout += c); p.stderr.on("data", c => stderr += c);
  p.on("error", reject); p.on("exit", c => c === 0 ? resolve(stdout) : reject(new Error(stderr)));
});
await Promise.all(Array.from({ length: 8 }, () => run(`import {getDb} from './lib/store.mjs'; import {claimFile} from './lib/leases.mjs';
  claimFile(getDb(),{agentId:'waiter',workspaceId:'ws',path:'held.txt'});`)));
const waits = db.prepare("SELECT * FROM file_waits").all();
assert.equal(waits.length, 1);
assert.equal(waits[0].attempts, 8);
const messages = await Promise.all(Array.from({ length: 8 }, () => run(`import {getDb} from './lib/store.mjs';import {midTurnContext} from './lib/coord-context.mjs';
  console.log(midTurnContext(getDb(),{agentId:'holder',workspaceId:'ws'}) || '');`)));
assert.equal(messages.filter(s => s.includes('waiter is waiting')).length, 1, "concurrent delivery cannot spam the holder");
assert.equal(db.prepare("SELECT COUNT(*) n FROM file_wait_notices").get().n, 1);
console.log("Eight concurrent retries form one episode and eight context events emit one notice");
