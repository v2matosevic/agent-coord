// One session, one name — resolved from the environment Claude Code gives every
// child, not from a `--tool` flag or a process-tree race. A host that writes its
// own MCP config (Hephaestus/ADE) spawns the server WITHOUT `--tool claude-code`;
// before this the server registered as an unlinked "mcp-agent" twin beside the
// session's hook identity (i-647f5cc1, i-71ffc7b0, i-a7a120fb, i-d0793813).
// Also covers name retention across /clear and the server following a rename.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const home = mkdtempSync(join(tmpdir(), "coord-idenv-"));
process.env.AGENT_COORD_HOME = home; // isolate BEFORE importing modules that bind COORD_HOME
const { agentIdFromSession, agentIdFromEnv, isClaudeChild, bindSessionName, COORD_HOME } = await import("../lib/identity.mjs");
const { writeSessionLink } = await import("../lib/session-link.mjs");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const checks = {};

// --- unit: env → the same name the hooks compute ---------------------------
const SID = "env-session-" + process.pid;
const hookName = agentIdFromSession(SID);
checks["no env → agentIdFromEnv is null"] = agentIdFromEnv({}) === null && isClaudeChild({}) === false;
checks["env session id → the hook's name"] = agentIdFromEnv({ CLAUDE_CODE_SESSION_ID: SID }) === hookName;
checks["CLAUDECODE alone marks a Claude child"] = isClaudeChild({ CLAUDECODE: "1" }) === true;

// --- unit: /clear name retention (bindSessionName) --------------------------
// A new session id normally hashes to a NEW name; once bound to the window's
// existing name it resolves to that name, stably, and the claim is re-owned.
const SID2 = "after-clear-" + process.pid;
const wouldBe = agentIdFromSession("probe-" + SID2); // just proves names differ in general
checks["binding pins the new session id to the old name"] = bindSessionName(SID2, hookName) && agentIdFromSession(SID2) === hookName;
checks["bound name is stable"] = agentIdFromSession(SID2) === hookName;
checks["claim file now owned by the new session"] = (() => {
  try {
    const owner = JSON.parse(readFileSync(join(COORD_HOME, "names", hookName + ".json"), "utf8")).session;
    return typeof owner === "string" && owner.length === 16 && agentIdFromSession(SID) !== hookName; // the OLD session lost it
  } catch {
    return false;
  }
})();
void wouldBe;

// --- integration: a server spawned WITHOUT --tool, with Claude's env --------
const SID3 = "srv-env-" + process.pid;
const expected = agentIdFromSession(SID3);
const spawn = (args, env) =>
  new StdioClientTransport({
    command: process.execPath,
    args: ["--disable-warning=ExperimentalWarning", join(root, "mcp", "server.mjs"), ...args],
    env: { ...process.env, AGENT_COORD_HOME: home, AGENT_COORD_LINK_POLL_MS: "200", ...env },
    cwd: root,
  });
const open = async (args, env) => {
  const c = new Client({ name: "idenv-test", version: "1.0.0" }, { capabilities: {} });
  await c.connect(spawn(args, env));
  const whoami = async () => JSON.parse((await c.callTool({ name: "whoami", arguments: {} })).content[0].text);
  return { c, whoami };
};

// The Hephaestus shape: no --tool, env carries the session id, NO hook link exists.
const s1 = await open([], { CLAUDE_CODE_SESSION_ID: SID3, CLAUDECODE: "1" });
let me = await s1.whoami();
checks["no --tool + env → tool is claude-code"] = me.tool === "claude-code";
checks["no --tool + env → the hook's name, no link needed"] = me.agentId === expected;
checks["identityBasis reports env"] = me.identityBasis === "env" && me.sessionId === SID3;
checks["env-resolved server does not warn"] = !me.warning;

// A link OLDER than the server (pid reuse / stale file) must not rename it.
mkdirSync(join(home, "session-links"), { recursive: true });
writeFileSync(join(home, "session-links", "pid-" + process.pid + ".json"), JSON.stringify({ agentId: "stale-name", claudePid: process.pid, ts: Date.now() - 60_000 }));
me = await s1.whoami();
checks["stale (older-than-server) link is ignored"] = me.agentId === expected;

// /clear under a running server: the hook re-publishes the link with the new
// name AFTER the server started → the server follows it on its next call.
await new Promise((r) => setTimeout(r, 30));
writeSessionLink(process.pid, "renamed-after-clear");
me = await s1.whoami();
checks["a newer link renames the running server (follows /clear)"] = me.agentId === "renamed-after-clear" && me.identityBasis === "link";
await s1.c.close();

// Codex / bare shell: env scrubbed, no --tool → standalone mcp-agent, as before.
const scrub = { CLAUDE_CODE_SESSION_ID: "", CLAUDECODE: "", CLAUDE_PID: "" };
const s2 = await open([], scrub);
me = await s2.whoami();
checks["no env, no --tool → standalone mcp-agent"] = me.tool === "mcp-agent" && /^[a-z]+$/.test(me.agentId) && me.identityBasis === "standalone";
await s2.c.close();

let ok = true;
for (const [k, v] of Object.entries(checks)) {
  if (!v) ok = false;
  console.log(`${v ? "✅" : "❌"} ${k}`);
}
try {
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
} catch {}
console.log(ok ? "PASS ✅ env-anchored identity + /clear retention + link follow" : "FAIL ❌");
process.exit(ok ? 0 : 1);
