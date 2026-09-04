import assert from "node:assert/strict";
import { readdirSync, readFileSync, utimesSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { agentIdFromSession, bindSessionName, COORD_HOME } from "../lib/identity.mjs";
import * as tier0 from "../tier0/lib/identity.mjs";
import { getDb } from "../lib/store.mjs";
import { ensureAgent } from "../lib/agents.mjs";
import { claimFile, releaseAllForAgent } from "../lib/leases.mjs";
import { postMessage, readMessages } from "../lib/messages.mjs";

assert.ok(process.env.AGENT_COORD_HOME, "run via test/run-all.mjs in an isolated store");
const names = Array.from({ length: 160 }, (_, i) => agentIdFromSession(`session-${i}`));
assert.equal(new Set(names).size, 160, "pool exhaustion must never merge sessions");
assert.ok(names.slice(0, 64).every(n => /^[a-z]+$/.test(n)));
assert.ok(names.slice(64).every(n => /^[a-z]+-[a-f0-9]{16}$/.test(n)));
for (let i = 0; i < names.length; i++) {
  assert.equal(agentIdFromSession(`session-${i}`), names[i]);
  assert.equal(tier0.agentIdFromSession(`session-${i}`), names[i], "tiers agree");
}
const dir = join(COORD_HOME, "names");
const old = new Date(Date.now() - 25 * 3600 * 1000);
for (const f of readdirSync(dir).filter(f => f.endsWith(".json"))) utimesSync(join(dir, f), old, old);
assert.ok(!names.includes(agentIdFromSession("after-silence")), "silence cannot inherit old mail/history");
assert.equal(agentIdFromSession("session-0"), names[0]);
const saved = readFileSync(join(dir, names[0] + ".json"));
rmSync(join(dir, names[0] + ".json")); // only this isolated test's own claim
assert.equal(agentIdFromSession("session-100"), names[100], "overflow stays pinned when a hole opens");
writeFileSync(join(dir, names[0] + ".json"), saved);
assert.equal(bindSessionName("resumed", names[1]), true);
assert.equal(agentIdFromSession("resumed"), names[1]);
assert.equal(tier0.agentIdFromSession("resumed"), names[1]);
assert.notEqual(agentIdFromSession("session-1"), names[1]);

const db = getDb(), ws = "isolation";
const [a, b] = names.slice(100, 102);
for (const agentId of [a, b]) ensureAgent(db, { agentId, tool: "codex", repoPath: "/isolation", branch: "main" });
assert.equal(claimFile(db, { agentId: a, workspaceId: ws, path: "held.txt" }).granted, true);
assert.equal(claimFile(db, { agentId: b, workspaceId: ws, path: "held.txt" }).granted, false);
postMessage(db, { fromAgent: a, toAgent: b, workspaceId: ws, body: "recipient-only" });
assert.equal(readMessages(db, { agentId: a, workspaceId: ws }).messages.length, 0);
assert.equal(readMessages(db, { agentId: b, workspaceId: ws }).messages[0].body, "recipient-only");
releaseAllForAgent(db, b);
assert.equal(db.prepare("SELECT agent_id FROM file_leases WHERE path='held.txt'").get().agent_id, a);

const resolveChild = (sid) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["--input-type=module", "-e",
    `import {agentIdFromSession} from './lib/identity.mjs'; console.log(agentIdFromSession(${JSON.stringify(sid)}))`],
    { env: process.env, windowsHide: true });
  let out = "";
  child.stdout.on("data", c => out += c);
  child.on("error", reject);
  child.on("exit", code => code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${code}`)));
});
assert.equal(new Set(await Promise.all(Array.from({ length: 12 }, () => resolveChild("same-concurrent-session")))).size, 1);
assert.equal(new Set(await Promise.all(Array.from({ length: 12 }, (_, i) => resolveChild(`concurrent-${i}`)))).size, 12);
console.log("160 stable identities; stale ownership, tier parity, mail/lease isolation, concurrent processes passed");
