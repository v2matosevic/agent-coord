// Waiter notifications: an exit-2 block enqueues a waiter (guard.mjs); when the
// file frees (release / cold / death) the waiter hears it ONCE via the mid-turn
// channel instead of blind-retrying. Also: granting a claim consumes your own
// waiter row, and expired waits drop silently.
import { getDb, writeTxn, nowIso } from "../lib/store.mjs";
import { ensureAgent } from "../lib/agents.mjs";
import { workspaceId } from "../lib/path-canon.mjs";
import { claimFile, releaseFile, enqueue, freedFileWaits } from "../lib/leases.mjs";
import { midTurnContext } from "../lib/coord-context.mjs";

const db = getDb();
const repo = "/t/waiter-" + process.pid;
const ws = workspaceId(repo);
const [A, B] = ["waiter-a-" + process.pid, "waiter-b-" + process.pid];
const FILE = "src/auth.ts";
const clean = () =>
  writeTxn(db, () => {
    db.prepare("DELETE FROM file_leases WHERE workspace_id=?").run(ws);
    db.prepare("DELETE FROM lease_queue WHERE key LIKE ?").run(ws + "||%");
    db.prepare("DELETE FROM messages WHERE workspace_id=?").run(ws);
    db.prepare("DELETE FROM agents WHERE agent_id IN (?,?)").run(A, B);
  });
clean();
ensureAgent(db, { agentId: A, repoPath: repo, branch: "main" });
ensureAgent(db, { agentId: B, repoPath: repo, branch: "main" });

const checks = {};

// A holds the file (warm). B is blocked and enqueued — exactly what guard.mjs does.
const aClaim = claimFile(db, { agentId: A, workspaceId: ws, repoPath: repo, path: FILE });
const bClaim = claimFile(db, { agentId: B, workspaceId: ws, repoPath: repo, path: FILE });
checks["A holds, B blocked"] = aClaim.granted === true && bClaim.granted === false;
enqueue(db, { kind: "file", key: ws + "||" + FILE, agentId: B });

// Still held -> nothing freed, waiter row stays.
checks["no notify while held"] = freedFileWaits(db, { agentId: B, workspaceId: ws }).length === 0;
checks["waiter row kept while held"] =
  !!db.prepare("SELECT 1 FROM lease_queue WHERE kind='file' AND key=? AND agent_id=?").get(ws + "||" + FILE, B);

// A releases -> B hears it once, through the same channel guard.mjs injects.
releaseFile(db, { agentId: A, workspaceId: ws, path: FILE });
const ctx = midTurnContext(db, { agentId: B, workspaceId: ws });
checks["freed file surfaces mid-turn"] = !!ctx && ctx.includes("✅") && ctx.includes(FILE);
checks["delivered exactly once"] = (midTurnContext(db, { agentId: B, workspaceId: ws }) || "").includes(FILE) === false;

// Grant consumes your own waiter row (no stale "it's free" after you already have it).
claimFile(db, { agentId: A, workspaceId: ws, repoPath: repo, path: FILE });
const blocked2 = claimFile(db, { agentId: B, workspaceId: ws, repoPath: repo, path: FILE });
enqueue(db, { kind: "file", key: ws + "||" + FILE, agentId: B });
releaseFile(db, { agentId: A, workspaceId: ws, path: FILE });
const bGets = claimFile(db, { agentId: B, workspaceId: ws, repoPath: repo, path: FILE });
checks["B claims after release"] = blocked2.granted === false && bGets.granted === true;
checks["grant consumes own waiter row"] = freedFileWaits(db, { agentId: B, workspaceId: ws }).length === 0;

// Expired wait drops silently (the turn that wanted it is long over).
writeTxn(db, () =>
  db
    .prepare("INSERT INTO lease_queue(kind,key,agent_id,requested_at,ttl_s) VALUES('file',?,?,?,60)")
    .run(ws + "||old.ts", B, new Date(Date.now() - 10 * 60 * 1000).toISOString()),
);
checks["expired wait drops silently"] =
  freedFileWaits(db, { agentId: B, workspaceId: ws }).length === 0 &&
  !db.prepare("SELECT 1 FROM lease_queue WHERE key=? AND agent_id=?").get(ws + "||old.ts", B);

clean();
let ok = true;
for (const [k, v] of Object.entries(checks)) {
  if (!v) ok = false;
  console.log(`${v ? "✅" : "❌"} ${k}`);
}
console.log(ok ? "PASS ✅ waiter notifications: block→enqueue→free→notify-once" : "FAIL ❌");
process.exit(ok ? 0 : 1);
