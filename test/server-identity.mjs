// The MCP server's late identity adoption: a server that started standalone (lost
// the SessionStart race / resumed) must adopt this session's hook id once the
// link appears, tearing down the throwaway twin — and must NOT touch anything when
// there's no link or it's already correct.
import { getDb } from "../lib/store.mjs";
import { ensureAgent } from "../lib/agents.mjs";
import { claimFile } from "../lib/leases.mjs";
import { workspaceId } from "../lib/path-canon.mjs";
import { writeSessionLink } from "../lib/session-link.mjs";
import { reconcileServerIdentity } from "../lib/server-identity.mjs";

const db = getDb();
const repo = "/t/srvid-" + process.pid;
const ws = workspaceId(repo);
const PPID = 990000 + (process.pid % 1000);
const STANDALONE = "srv-standalone-" + process.pid;
const HOOK = "srv-hook-" + process.pid;
const ctx = { tool: "claude-code", repoPath: repo, branch: "main" };

const agentRow = (id) => db.prepare("SELECT status FROM agents WHERE agent_id=?").get(id);
const leaseCount = (id) => db.prepare("SELECT COUNT(*) c FROM file_leases WHERE agent_id=?").get(id).c;

const checks = {};

// 1) No link for our pid → no change, not adopted.
ensureAgent(db, { agentId: STANDALONE, ...ctx });
let r = reconcileServerIdentity(db, { agentId: STANDALONE, ppid: PPID, ...ctx });
checks["no link → unchanged + not adopted"] = r.agentId === STANDALONE && r.adopted === false;

// 2) Link appears → adopt it, release + kill the standalone twin.
claimFile(db, { agentId: STANDALONE, workspaceId: ws, repoPath: repo, branch: "main", path: "x.ts", mode: "exclusive" });
writeSessionLink(PPID, HOOK);
r = reconcileServerIdentity(db, { agentId: STANDALONE, ppid: PPID, ...ctx });
checks["link appears → adopts hook id"] = r.agentId === HOOK && r.adopted === true && r.migratedFrom === STANDALONE;
checks["standalone twin marked dead"] = agentRow(STANDALONE)?.status === "dead";
checks["standalone leases released"] = leaseCount(STANDALONE) === 0;
checks["adopted id is a registered agent"] = !!agentRow(HOOK);

// 3) Already the linked id → adopted, idempotent.
r = reconcileServerIdentity(db, { agentId: HOOK, ppid: PPID, ...ctx });
checks["already correct → adopted, no migration"] = r.agentId === HOOK && r.adopted === true && !r.migratedFrom;

let ok = true;
for (const [k, v] of Object.entries(checks)) {
  if (!v) ok = false;
  console.log(`${v ? "✅" : "❌"} ${k}`);
}
console.log(ok ? "PASS ✅ late identity adoption" : "FAIL ❌");
process.exit(ok ? 0 : 1);
