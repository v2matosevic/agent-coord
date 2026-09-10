import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getDb } from "../lib/store.mjs";
import { agentAlive, markDead } from "../lib/agents.mjs";
import { statSync } from "node:fs";
import { join } from "node:path";
import { COORD_HOME } from "../lib/identity.mjs";

const db = getDb();
const client = new Client({ name: "lifecycle", version: "1" }, { capabilities: {} });
const transport = new StdioClientTransport({ command: process.execPath,
  args: ["mcp/server.mjs", "--tool", "codex"], env: { ...process.env, CODEX_THREAD_ID: "lifecycle-thread" } });
try {
  await client.connect(transport);
  const call = async (name) => JSON.parse((await client.callTool({ name, arguments: {} })).content[0].text);
  const { agentId } = await call("whoami");
  assert.equal(agentAlive(db, agentId), true);
  markDead(db, agentId);
  // Leave the real MCP transport connected beyond its watchdog tick. Previously
  // the env-identity keepalive used ensureAgentContext and undid SessionEnd.
  await new Promise((resolve) => setTimeout(resolve, 6100));
  assert.equal(agentAlive(db, agentId), false);
  assert.ok(Date.now() - statSync(join(COORD_HOME, "hb", encodeURIComponent(agentId))).mtimeMs > 180000);
  await call("whoami");
  assert.equal(agentAlive(db, agentId), true, "explicit resumed tool call registers again");
  await client.close();
  assert.equal(agentAlive(db, agentId), true, "one env transport closing must not end a shared session");
  console.log("PASS: real MCP keepalive does not resurrect SessionEnd; explicit resume and reconnect remain safe");
} finally { await client.close(); }
