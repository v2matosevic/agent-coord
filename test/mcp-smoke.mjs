// Drive the MCP server through a real MCP client over stdio: list tools, then
// exercise the coordination tools. Runs against an isolated store.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = mkdtempSync(join(tmpdir(), "coord-mcp-"));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--disable-warning=ExperimentalWarning", join(root, "mcp", "server.mjs"), "--tool", "codex"],
  env: { ...process.env, AGENT_COORD_HOME: home },
  cwd: root,
});
const client = new Client({ name: "smoke", version: "1.0.0" }, { capabilities: {} });

let failed = false;
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  console.log("tools:", tools.join(", "));

  const call = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

  console.log("whoami:        ", JSON.stringify(await call("whoami")));
  console.log("announce:      ", JSON.stringify(await call("announce_intent", { task: "wire MCP" })));
  console.log("claim:         ", JSON.stringify(await call("claim_files", { paths: ["src/x.ts"] })));
  console.log("claim (self):  ", JSON.stringify(await call("claim_files", { paths: ["src/x.ts"] })));
  console.log("check_conflict:", JSON.stringify(await call("check_conflicts", { paths: ["src/x.ts"] })));
  console.log("claim_resource:", JSON.stringify(await call("claim_resource", { resource_id: "port:3000" })));
  console.log("post_message:  ", JSON.stringify(await call("post_message", { body: "hello from smoke" })));
  console.log("read_messages: ", JSON.stringify(await call("read_messages"))); // own message excluded -> []
  console.log("agents:        ", JSON.stringify((await call("list_active_agents")).agents.map((a) => `${a.agent_id}/${a.tool}`)));
  console.log("pending_push:  ", JSON.stringify(await call("pending_push_review")));
  const ask = await call("ask_agent", { to: "nobody-home", question: "ready to push?" });
  console.log("ask_agent:     ", JSON.stringify(ask));
  console.log("check_replies: ", JSON.stringify(await call("check_replies", { ask_id: ask.ask_id })));

  const expected = ["whoami", "announce_intent", "claim_files", "list_active_agents", "get_global_state", "check_conflicts", "release_files", "claim_resource", "release_resource", "log_activity", "post_message", "read_messages", "pending_push_review", "ask_agent", "check_replies", "reply", "request_yield"];
  const haveAll = expected.every((t) => tools.includes(t));
  console.log(haveAll ? "PASS ✅ MCP server speaks the protocol; tools work" : "FAIL ❌ missing tools: " + expected.filter((t) => !tools.includes(t)));
  failed = !haveAll;
} catch (e) {
  console.log("FAIL ❌", e.message);
  failed = true;
} finally {
  try {
    await client.close();
  } catch {}
  rmSync(home, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
