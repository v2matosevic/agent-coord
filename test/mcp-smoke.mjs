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

  const me = await call("whoami");
  console.log("whoami:        ", JSON.stringify(me));
  // announce is the one-call check-in: must carry the room brief (identity even
  // when alone) — for a hookless agent (Codex) this is its ONLY awareness channel.
  const ann = await call("announce_intent", { task: "wire MCP" });
  console.log("announce:      ", JSON.stringify(ann));
  const briefOk = typeof ann.brief === "string" && ann.brief.includes(`you are ${me.agentId}`);
  console.log("announce brief:", briefOk ? "ok (identity present)" : "BROKEN: " + JSON.stringify(ann.brief));
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
  console.log("claim_task:    ", JSON.stringify(await call("claim_task", { title: "demo: wire the thing" })));
  console.log("list_tasks:    ", JSON.stringify((await call("list_tasks")).tasks.map((t) => `${t.task_id}:${t.status}`)));

  // Issue log: file one, see it listed open, resolve it, see it drop from the open list.
  const rep = await call("report_issue", { title: "smoke: flaky build", body: "EPERM on rename", severity: "high", kind: "build" });
  console.log("report_issue:  ", JSON.stringify(rep));
  const openBefore = (await call("list_issues")).issues;
  console.log("list_issues:   ", JSON.stringify(openBefore.map((i) => `${i.issue_id}:${i.severity}:${i.status}`)));
  console.log("resolve_issue: ", JSON.stringify(await call("resolve_issue", { issue_id: rep.issueId, resolution: "pinned vite, retry-on-EPERM" })));
  const openAfter = (await call("list_issues")).issues;
  const issueWorks = !!rep.issueId && openBefore.some((i) => i.issue_id === rep.issueId) && !openAfter.some((i) => i.issue_id === rep.issueId);
  console.log("issue lifecycle:", issueWorks ? "ok (filed → listed → resolved → cleared)" : "BROKEN");

  const expected = ["whoami", "announce_intent", "claim_files", "list_active_agents", "get_global_state", "check_conflicts", "release_files", "claim_resource", "release_resource", "log_activity", "post_message", "read_messages", "pending_push_review", "ask_agent", "check_replies", "reply", "request_yield", "list_tasks", "claim_task", "update_task", "report_issue", "list_issues", "resolve_issue"];
  const haveAll = expected.every((t) => tools.includes(t));
  console.log(
    haveAll && issueWorks && briefOk
      ? "PASS ✅ MCP server speaks the protocol; tools work"
      : "FAIL ❌ " + (!haveAll ? "missing tools: " + expected.filter((t) => !tools.includes(t)) : !issueWorks ? "issue lifecycle broken" : "announce brief broken"),
  );
  failed = !haveAll || !issueWorks || !briefOk;
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
