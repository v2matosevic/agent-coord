// End-to-end duplicate-work flow as the hooks drive it: the later-starter gets a
// mid-turn advisory, escalates to a hard block after enough advisories, and the
// block clears the moment it differentiates its lane. Exercises the exact
// helpers guard.mjs calls (midTurnContext + overlapHardBlock).
import { getDb, writeTxn } from "../lib/store.mjs";
import { ensureAgent, heartbeat } from "../lib/agents.mjs";
import { workspaceId } from "../lib/path-canon.mjs";
import { midTurnContext } from "../lib/coord-context.mjs";
import { overlapHardBlock, shouldNotifyOverlap, clearOverlapNotice } from "../lib/overlap.mjs";
import { OVERLAP_ESCALATE_AFTER } from "../lib/config.mjs";

const db = getDb();
const repo = "/t/ovflow-" + process.pid;
const ws = workspaceId(repo);
const [EARLY, LATE] = ["ovf-early-" + process.pid, "ovf-late-" + process.pid];
const clean = () => writeTxn(db, () => db.prepare("DELETE FROM agents WHERE agent_id IN (?,?)").run(EARLY, LATE));
clean();
[EARLY, LATE].forEach(clearOverlapNotice);

const TASK = "overhaul the reports module revenue expenses vat clients products dynamic filters exports";
const bump = (id, ts) => writeTxn(db, () => db.prepare("UPDATE agents SET registered_at=? WHERE agent_id=?").run(ts, id));
ensureAgent(db, { agentId: EARLY, repoPath: repo, branch: "main" });
heartbeat(db, EARLY, TASK);
bump(EARLY, "2026-06-02T07:00:00.000Z");
ensureAgent(db, { agentId: LATE, repoPath: repo, branch: "main" });
heartbeat(db, LATE, TASK);
bump(LATE, "2026-06-02T07:02:00.000Z");

const checks = {};

// 1) LATE's first mid-turn context carries the duplicate-work advisory; EARLY's does not.
const lateCtx = midTurnContext(db, { agentId: LATE, workspaceId: ws });
checks["later-starter is advised"] = !!lateCtx && /duplicate-work/.test(lateCtx);
const earlyCtx = midTurnContext(db, { agentId: EARLY, workspaceId: ws });
checks["earlier-starter is NOT advised"] = !earlyCtx || !/duplicate-work/.test(earlyCtx);

// 2) Not escalated yet (only 1 advisory so far).
checks["no hard-block before threshold"] = overlapHardBlock(db, { agentId: LATE, workspaceId: ws }) === null;

// 3) After enough advisories, LATE's pre-edit guard would hard-block; EARLY never does.
for (let i = 0; i < OVERLAP_ESCALATE_AFTER; i++) shouldNotifyOverlap(LATE, 0); // simulate advisories across cooldowns
const block = overlapHardBlock(db, { agentId: LATE, workspaceId: ws });
checks["later-starter hard-blocks after threshold"] = !!block && block.agentId === EARLY;
checks["earlier-starter never hard-blocks"] = overlapHardBlock(db, { agentId: EARLY, workspaceId: ws }) === null;

// 4) Differentiating clears it: LATE announces a distinct lane.
heartbeat(db, LATE, "build only the VAT report: oss reverse-charge quarterly pdf generation");
const afterCtx = midTurnContext(db, { agentId: LATE, workspaceId: ws }); // also resets the escalation counter
checks["no advisory after differentiating"] = !afterCtx || !/duplicate-work/.test(afterCtx);
checks["hard-block lifts after differentiating"] = overlapHardBlock(db, { agentId: LATE, workspaceId: ws }) === null;

clean();
[EARLY, LATE].forEach(clearOverlapNotice);

let ok = true;
for (const [k, v] of Object.entries(checks)) {
  if (!v) ok = false;
  console.log(`${v ? "✅" : "❌"} ${k}`);
}
console.log(ok ? "PASS ✅ advisory -> escalate -> clear-on-differentiate" : "FAIL ❌");
process.exit(ok ? 0 : 1);
