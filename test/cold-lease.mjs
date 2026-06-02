// Cold-lease self-healing: a warm lease blocks (real concurrent edit), but once
// the holder stops touching the file (acquired_at older than FILE_ACTIVE_MS) the
// lease goes cold — a waiting agent takes the file automatically, no force-release
// and no human. Also verifies the stale lease is swept on takeover and that a
// cold lease isn't reported as a conflict / doesn't block a commit-time check.
import { getDb, writeTxn, isoAgoMs } from "../lib/store.mjs";
import { ensureAgent } from "../lib/agents.mjs";
import { claimFile, peekConflicts } from "../lib/leases.mjs";
import { workspaceId } from "../lib/path-canon.mjs";
import { FILE_ACTIVE_MS } from "../lib/config.mjs";

const db = getDb();
const repo = "/t/cold-" + process.pid;
const ws = workspaceId(repo);
const [A, B] = ["cold-a-" + process.pid, "cold-b-" + process.pid];
const path = "src/widget.ts";
const clean = () =>
  writeTxn(db, () => {
    db.prepare("DELETE FROM agents WHERE agent_id IN (?,?)").run(A, B);
    db.prepare("DELETE FROM file_leases WHERE workspace_id=?").run(ws);
  });
clean();
ensureAgent(db, { agentId: A, repoPath: repo, branch: "main" });
ensureAgent(db, { agentId: B, repoPath: repo, branch: "main" });

const checks = {};

// A claims the file (warm) -> B is blocked, and sees it as a conflict.
const aClaim = claimFile(db, { agentId: A, workspaceId: ws, repoPath: repo, path });
const bBlockedWarm = claimFile(db, { agentId: B, workspaceId: ws, repoPath: repo, path });
checks["A's warm lease granted"] = aClaim.granted === true;
checks["B blocked while A is warm"] = bBlockedWarm.granted === false && bBlockedWarm.conflict.agent_id === A;
checks["warm lease shows as conflict"] = peekConflicts(db, { workspaceId: ws, path, agentId: B }).length === 1;

// A moves on: backdate its lease past the active window -> it goes cold.
writeTxn(db, () => db.prepare("UPDATE file_leases SET acquired_at=? WHERE agent_id=? AND path=?").run(isoAgoMs(FILE_ACTIVE_MS + 60_000), A, path));

checks["cold lease is NOT a conflict"] = peekConflicts(db, { workspaceId: ws, path, agentId: B }).length === 0;
const bTakesOver = claimFile(db, { agentId: B, workspaceId: ws, repoPath: repo, path });
checks["B auto-takes the cold file"] = bTakesOver.granted === true;

// The stale lease was swept; B now holds it warm, and A would be blocked if it returned.
const leases = db.prepare("SELECT agent_id FROM file_leases WHERE workspace_id=? AND path=?").all(ws, path);
checks["only one lease remains (B)"] = leases.length === 1 && leases[0].agent_id === B;
const aReturns = claimFile(db, { agentId: A, workspaceId: ws, repoPath: repo, path });
checks["A now blocked by B's warm lease"] = aReturns.granted === false && aReturns.conflict.agent_id === B;

clean();
let ok = true;
for (const [k, v] of Object.entries(checks)) {
  if (!v) ok = false;
  console.log(`${v ? "✅" : "❌"} ${k}`);
}
console.log(ok ? "PASS ✅ cold-lease self-healing (no force-release, no human)" : "FAIL ❌");
process.exit(ok ? 0 : 1);
