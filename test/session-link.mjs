// Identity unification: the claude.exe-keyed handshake the SessionStart hook
// writes and the MCP server reads. Verifies the link store roundtrips + TTL
// reap, and — end to end — that a server spawned with --tool claude-code ADOPTS
// the published id (one agent per session) instead of minting a random twin,
// while a standalone (Codex) server still self-identifies.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const home = mkdtempSync(join(tmpdir(), "coord-link-"));
process.env.AGENT_COORD_HOME = home; // isolate BEFORE importing modules that bind COORD_HOME
const { writeSessionLink, readSessionLink, pollSessionLink, cachedClaudePid, reapSessionLinks } = await import("../lib/session-link.mjs");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const checks = {};

// --- unit: link + cache roundtrip ------------------------------------------
writeSessionLink(424242, "umber-crane-3034", "sess-abc");
checks["link roundtrips"] = readSessionLink(424242) === "umber-crane-3034";
checks["poll finds link"] = (await pollSessionLink(424242, 500)) === "umber-crane-3034";
checks["cache roundtrips"] = cachedClaudePid("sess-abc") === 424242;
checks["missing link -> null"] = readSessionLink(999999) === null;
checks["poll gives up -> null"] = (await pollSessionLink(999999, 300)) === null;

// --- unit: TTL reap drops a stale link, keeps a fresh one ------------------
mkdirSync(join(home, "session-links"), { recursive: true });
writeFileSync(join(home, "session-links", "pid-111111.json"), JSON.stringify({ agentId: "old", ts: Date.now() - 13 * 3600 * 1000 }));
reapSessionLinks();
checks["stale link reaped"] = readSessionLink(111111) === null;
checks["fresh link survives reap"] = readSessionLink(424242) === "umber-crane-3034";

// --- integration: a --tool claude-code server adopts the link --------------
// The spawned server's parent IS this test process, so a link keyed to our pid
// is what it reads via process.ppid.
writeSessionLink(process.pid, "adopted-otter-1234", "sess-live");
const spawn = (toolArg) =>
  new StdioClientTransport({
    command: process.execPath,
    args: ["--disable-warning=ExperimentalWarning", join(root, "mcp", "server.mjs"), "--tool", toolArg],
    env: { ...process.env, AGENT_COORD_HOME: home },
    cwd: root,
  });
const whoamiVia = async (toolArg) => {
  const c = new Client({ name: "link-test", version: "1.0.0" }, { capabilities: {} });
  await c.connect(spawn(toolArg));
  try {
    return JSON.parse((await c.callTool({ name: "whoami", arguments: {} })).content[0].text).agentId;
  } finally {
    await c.close();
  }
};

const claudeId = await whoamiVia("claude-code");
const codexId = await whoamiVia("codex");
checks["claude server adopts hook id"] = claudeId === "adopted-otter-1234";
checks["codex server stays standalone"] = typeof codexId === "string" && codexId !== "adopted-otter-1234" && /^[a-z]+$/.test(codexId);

let ok = true;
for (const [k, v] of Object.entries(checks)) {
  if (!v) ok = false;
  console.log(`${v ? "✅" : "❌"} ${k}`);
}
console.log(`claude adopted=${claudeId} | codex standalone=${codexId}`);
rmSync(home, { recursive: true, force: true });
console.log(ok ? "PASS ✅ identity unification handshake" : "FAIL ❌");
process.exit(ok ? 0 : 1);
