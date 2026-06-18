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
const { writeSessionLink, readSessionLink, readSessionLinkAny, pollSessionLink, pollSessionLinkAny, sessionAnchorPids, cachedClaudePid, reapSessionLinks } =
  await import("../lib/session-link.mjs");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const checks = {};

// --- unit: link + cache roundtrip ------------------------------------------
writeSessionLink(424242, "umber-crane-3034", "sess-abc");
checks["link roundtrips"] = readSessionLink(424242) === "umber-crane-3034";
checks["poll finds link"] = (await pollSessionLink(424242, 500)) === "umber-crane-3034";
checks["cache roundtrips"] = cachedClaudePid("sess-abc") === 424242;
checks["missing link -> null"] = readSessionLink(999999) === null;
checks["poll gives up -> null"] = (await pollSessionLink(999999, 300)) === null;

// --- unit: multi-candidate resolution (BUG 1) ------------------------------
// The MCP server offers several candidate anchor pids (claude.exe first, then its
// raw ppid) because a wrapper may sit between it and claude.exe. Resolution picks
// the first candidate that has a link.
checks["readSessionLinkAny finds the link behind a non-linked first candidate"] = readSessionLinkAny([777777, 424242]) === "umber-crane-3034";
checks["readSessionLinkAny prefers the first candidate that resolves"] = readSessionLinkAny([424242, 999999]) === "umber-crane-3034";
checks["readSessionLinkAny → null when no candidate has a link"] = readSessionLinkAny([777777, 888888]) === null;
checks["pollSessionLinkAny resolves across candidates"] = (await pollSessionLinkAny([777777, 424242], 500)) === "umber-crane-3034";

// --- unit: the canonical anchor resolver (BUG 1 prevention) ----------------
// sessionAnchorPids is the ONE place that decides which pids to look up — so no
// caller hand-rolls process.ppid and silently reintroduces the asymmetry.
const BOGUS = 99999999; // no process, so no claude ancestor → just the raw pid
const anchors = sessionAnchorPids(BOGUS);
checks["sessionAnchorPids off a non-Claude tree → just the raw pid"] = anchors.length === 1 && anchors[0] === BOGUS;
const dflt = sessionAnchorPids();
checks["sessionAnchorPids includes the raw ppid as the fallback (last)"] = dflt[dflt.length - 1] === process.ppid;
checks["sessionAnchorPids has no duplicate pids"] = new Set(dflt).size === dflt.length;

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
const spawn = (toolArg, env = {}) =>
  new StdioClientTransport({
    command: process.execPath,
    args: ["--disable-warning=ExperimentalWarning", join(root, "mcp", "server.mjs"), "--tool", toolArg],
    env: { ...process.env, AGENT_COORD_HOME: home, ...env },
    cwd: root,
  });
const whoamiVia = async (toolArg, env = {}) => {
  const c = new Client({ name: "link-test", version: "1.0.0" }, { capabilities: {} });
  await c.connect(spawn(toolArg, env));
  try {
    return JSON.parse((await c.callTool({ name: "whoami", arguments: {} })).content[0].text);
  } finally {
    await c.close();
  }
};

const claude = await whoamiVia("claude-code");
const codex = await whoamiVia("codex");
checks["claude server adopts hook id"] = claude.agentId === "adopted-otter-1234";
checks["adopted claude server has no warning"] = !claude.warning;
checks["codex server stays standalone"] = typeof codex.agentId === "string" && codex.agentId !== "adopted-otter-1234" && /^[a-z]+$/.test(codex.agentId);

// Self-check (BUG 1): a claude-code server that finds NO hook link is the ghost-twin
// signature — it must NOT silently report a name, it must flag the divergence. Use a
// fresh empty home (no link) + a short poll so it gives up fast.
const noLinkHome = mkdtempSync(join(tmpdir(), "coord-link-nolink-"));
const standalone = await whoamiVia("claude-code", { AGENT_COORD_HOME: noLinkHome, AGENT_COORD_LINK_POLL_MS: "200" });
checks["unlinked claude server warns about identity"] = typeof standalone.warning === "string" && /identity not linked/i.test(standalone.warning);
checks["unlinked claude server still returns a usable id"] = /^[a-z]+$/.test(standalone.agentId);
try {
  rmSync(noLinkHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
} catch {} // Windows can hold the just-exited server's SQLite file a beat; temp dir is disposable

let ok = true;
for (const [k, v] of Object.entries(checks)) {
  if (!v) ok = false;
  console.log(`${v ? "✅" : "❌"} ${k}`);
}
console.log(`claude adopted=${claude.agentId} | codex standalone=${codex.agentId} | unlinked=${standalone.agentId} (warns=${!!standalone.warning})`);
try {
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
} catch {}
console.log(ok ? "PASS ✅ identity unification handshake" : "FAIL ❌");
process.exit(ok ? 0 : 1);
