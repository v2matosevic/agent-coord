import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "owner-fixture", version: "1" }, { capabilities: {} });
const transport = new StdioClientTransport({ command: process.env.COORD_TEST_NODE,
  args: ["mcp/server.mjs", "--tool", "codex"],
  env: { ...process.env, CODEX_THREAD_ID: "owner-exit-fixture", CLAUDE_PID: "" } });
await client.connect(transport);
const result = await client.callTool({ name: "whoami", arguments: {} });
process.send({ ...JSON.parse(result.content[0].text), serverPid: transport.pid });
setInterval(() => {}, 1000);
