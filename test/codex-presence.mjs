import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const home = mkdtempSync(join(tmpdir(), "coord-presence-"));
process.env.AGENT_COORD_HOME = home;
const { getDb, isoAgoMs } = await import("../lib/store.mjs");
const { HB_THROTTLE_MS, FILE_ACTIVE_MS, DEAD_MS } = await import("../lib/config.mjs");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const db = getDb();
const clients = new Set();
const open = async (thread) => {
  const client = new Client({ name: "presence-test", version: "1" }, { capabilities: {} });
  clients.add(client);
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["--disable-warning=ExperimentalWarning", join(root, "mcp", "server.mjs"), "--tool", "codex"], cwd: root,
    env: { ...process.env, AGENT_COORD_HOME: home, CODEX_THREAD_ID: thread, CLAUDE_CODE_SESSION_ID: "", CLAUDECODE: "", CLAUDE_PID: "" },
  }));
  return client;
};
const call = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  assert.ok(!r.isError, r.content[0].text);
  return JSON.parse(r.content[0].text);
};
const close = async (c) => { await c.close(); clients.delete(c); };
try {
  const first = await open("reconnecting-thread");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agents").get().n, 0, "an unused transport creates no ghost");
  const id = (await call(first, "whoami")).agentId;
  await call(first, "claim_files", { paths: ["presence-fixture.txt"] });
  const second = await open("reconnecting-thread");
  assert.equal((await call(second, "whoami")).agentId, id);
  await close(first);
  assert.equal(db.prepare("SELECT status FROM agents WHERE agent_id=?").get(id).status, "active", "closing the old connection cannot end the reconnected thread");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM file_leases WHERE agent_id=?").get(id).n, 1);

  // Age presence and the claim, then await the actual production timer without
  // making MCP calls. It must restore presence without warming an abandoned file.
  const cold = isoAgoMs(FILE_ACTIVE_MS + 1000);
  db.prepare("UPDATE file_leases SET acquired_at=? WHERE agent_id=?").run(cold, id);
  db.prepare("UPDATE agents SET last_heartbeat=? WHERE agent_id=?").run(isoAgoMs(DEAD_MS + 1000), id);
  rmSync(join(home, "hb", encodeURIComponent(id)), { force: true });
  await new Promise((r) => setTimeout(r, HB_THROTTLE_MS + 500));
  assert.ok(db.prepare("SELECT last_heartbeat FROM agents WHERE agent_id=?").get(id).last_heartbeat > isoAgoMs(DEAD_MS));
  assert.equal(db.prepare("SELECT acquired_at FROM file_leases WHERE agent_id=?").get(id).acquired_at, cold);
  await close(second);
  const standalone = await open("");
  const standaloneId = (await call(standalone, "whoami")).agentId;
  await call(standalone, "claim_files", { paths: ["standalone-fixture.txt"] });
  await close(standalone);
  assert.equal(db.prepare("SELECT status FROM agents WHERE agent_id=?").get(standaloneId).status, "dead");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM file_leases WHERE agent_id=?").get(standaloneId).n, 0);
  console.log("PASS Codex presence: no ghosts, reconnect safety, timed heartbeat without lease renewal, standalone cleanup");
} finally {
  for (const c of clients) await c.close();
  db.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
