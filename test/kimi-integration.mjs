import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "coord-kimi-"));
process.env.AGENT_COORD_HOME = home;
const { agentIdFromSession, sessionIdFromEnv } = await import("../lib/identity.mjs");
const capture = "ade-terminal-8cf2b699-a4eb-44d5-8b2b-771eaee5b8db";
const env = { ...process.env, AGENT_COORD_HOME: home, AGENT_COORD_SESSION_ID: capture, AGENT_COORD_TOOL: "kimi-code", CODEX_THREAD_ID: "outer-codex", CLAUDE_CODE_SESSION_ID: "outer-claude", CLAUDECODE: "1", AGENT_COORD_NOTIFY: "0", AGENT_COORD_DIGEST: "0" };
assert.equal(sessionIdFromEnv(env, "kimi-code"), capture);
assert.equal(sessionIdFromEnv(env), capture);
assert.equal(sessionIdFromEnv({ CODEX_THREAD_ID: "outer" }, "kimi-code"), null);
const expected = agentIdFromSession(capture);
function hook(event, extra = {}) {
  const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(root, "hooks/kimi.mjs")], {
    env, input: JSON.stringify({ hook_event_name: event, session_id: "kimi-actual-session", cwd: root, ...extra }), encoding: "utf8", windowsHide: true,
  });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}
assert.match(hook("SessionStart", { source: "startup" }), new RegExp(expected));
const client = new Client({ name: "kimi-test", version: "1" }, { capabilities: {} });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--disable-warning=ExperimentalWarning", join(root, "mcp/server.mjs")], cwd: root, env }));
const call = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
try {
  const me = await call("whoami");
  assert.equal(me.agentId, expected);
  assert.equal(me.tool, "kimi-code");
  assert.equal(me.sessionId, capture);
  assert.equal(me.identityBasis, "env");
  await call("announce_intent", { task: "Kimi identity regression" });
  const claim = await call("claim_files", { paths: ["test/kimi-owned-fixture.txt"] });
  assert.equal(claim.results[0].granted, true);
  hook("UserPromptSubmit", { prompt: "Keep Kimi identity stable" });
  hook("SessionStart", { source: "resume", session_id: "different-resumed-kimi-session" });
  assert.equal((await call("whoami")).agentId, expected);
  hook("SessionHeartbeat");
  const state = await call("list_active_agents");
  assert.equal(state.agents.filter((a) => a.agent_id === expected && a.tool === "kimi-code").length, 1);
  hook("SessionEnd");
} finally { await client.close(); }
console.log("Kimi: native hooks, MCP, file claims and resumed launch share one identity; outer clients ignored");
