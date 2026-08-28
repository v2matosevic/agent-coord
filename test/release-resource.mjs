// release_resource must tell the truth: it only ever deletes OUR lease, so
// releasing a resource a peer holds returns released:false + heldBy, not a
// success that leaves the shell guard blocking (i-e1e00240: three agents each
// lost 15–30 min waiting on a deploy lock "released" by a non-holder).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const home = mkdtempSync(join(tmpdir(), "coord-relres-"));
process.env.AGENT_COORD_HOME = home;
const { getDb } = await import("../lib/store.mjs");
const { ensureAgent } = await import("../lib/agents.mjs");
const { claimResource } = await import("../lib/leases.mjs");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const db = getDb();
const PEER = "relres-peer-" + process.pid;
ensureAgent(db, { agentId: PEER, repoPath: root, branch: "main" });
claimResource(db, { agentId: PEER, resourceId: "deploy:held-by-peer", reason: "test" });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--disable-warning=ExperimentalWarning", join(root, "mcp", "server.mjs"), "--tool", "codex"],
  env: { ...process.env, AGENT_COORD_HOME: home },
  cwd: root,
});
const client = new Client({ name: "relres", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);
const call = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const checks = {};
const mine = await call("claim_resource", { resource_id: "port:4321" });
checks["own claim granted"] = mine.granted === true;
const relMine = await call("release_resource", { resource_id: "port:4321" });
checks["releasing own lease → released:true"] = relMine.released === true;
const relPeer = await call("release_resource", { resource_id: "deploy:held-by-peer" });
checks["releasing a peer's lease → released:false + heldBy"] = relPeer.released === false && relPeer.heldBy === PEER && /don't hold/i.test(relPeer.note || "");
const relNone = await call("release_resource", { resource_id: "deploy:nobody" });
checks["releasing nothing → released:false, heldBy null"] = relNone.released === false && relNone.heldBy === null;
const still = db.prepare("SELECT agent_id FROM resource_leases WHERE resource_id='deploy:held-by-peer'").get()?.agent_id;
checks["peer's lease untouched"] = still === PEER;

await client.close();
let ok = true;
for (const [k, v] of Object.entries(checks)) {
  if (!v) ok = false;
  console.log(`${v ? "✅" : "❌"} ${k}`);
}
try {
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
} catch {}
console.log(ok ? "PASS ✅ release_resource reports what it did" : "FAIL ❌");
process.exit(ok ? 0 : 1);
