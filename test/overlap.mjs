// Overlap / duplicate-work detection: similar tasks flag, divergent tasks don't,
// the tiebreaker picks the later-starter, and the advisory throttles + counts.
import { getDb, writeTxn } from "../lib/store.mjs";
import { ensureAgent, heartbeat } from "../lib/agents.mjs";
import { workspaceId } from "../lib/path-canon.mjs";
import {
  taskSimilarity,
  findOverlappingPeers,
  earlierOverlappingPeers,
  shouldNotifyOverlap,
  overlapAdvisoryCount,
  clearOverlapNotice,
} from "../lib/overlap.mjs";

const db = getDb();
const repo = "/t/overlap-" + process.pid;
const ws = workspaceId(repo);
const [EARLY, LATE, OTHER] = ["ov-early-" + process.pid, "ov-late-" + process.pid, "ov-other-" + process.pid];
const ids = [EARLY, LATE, OTHER];
const clean = () => writeTxn(db, () => db.prepare(`DELETE FROM agents WHERE agent_id IN (${ids.map(() => "?").join(",")})`).run(...ids));
clean();
ids.forEach(clearOverlapNotice);

const PROMPT = "overhaul the reports module: revenue expenses vat clients products dynamic data filters exports";

// EARLY registers first, LATE second (same prompt = duplicate), OTHER does unrelated social-media work.
ensureAgent(db, { agentId: EARLY, repoPath: repo, branch: "main" });
heartbeat(db, EARLY, PROMPT);
// force LATE to have a strictly-later registered_at
const bump = (id, ts) => writeTxn(db, () => db.prepare("UPDATE agents SET registered_at=? WHERE agent_id=?").run(ts, id));
bump(EARLY, "2026-06-02T07:00:00.000Z");
ensureAgent(db, { agentId: LATE, repoPath: repo, branch: "main" });
heartbeat(db, LATE, PROMPT);
bump(LATE, "2026-06-02T07:01:00.000Z");
ensureAgent(db, { agentId: OTHER, repoPath: repo, branch: "main" });
heartbeat(db, OTHER, "elevate our social media strategy: content calendar instagram tiktok engagement growth");

const simSame = taskSimilarity(PROMPT, PROMPT);
const simDiff = taskSimilarity(PROMPT, "elevate our social media strategy content calendar instagram growth");

// LATE should see EARLY as an earlier overlapping peer it must defer to.
const lateOverlaps = findOverlappingPeers(db, { agentId: LATE, workspaceId: ws, task: PROMPT });
const lateMustYield = earlierOverlappingPeers(db, { agentId: LATE, workspaceId: ws, task: PROMPT });
// EARLY overlaps LATE too, but is NOT the one that yields.
const earlyMustYield = earlierOverlappingPeers(db, { agentId: EARLY, workspaceId: ws, task: PROMPT });
// OTHER overlaps nobody.
const otherOverlaps = findOverlappingPeers(db, { agentId: OTHER, workspaceId: ws, task: "elevate our social media strategy content calendar instagram growth" });

// Differentiating clears it: LATE announces a distinct lane.
heartbeat(db, LATE, "build the VAT report only: oss reverse-charge quarterly pdf export");
const afterDiff = earlierOverlappingPeers(db, { agentId: LATE, workspaceId: ws, task: "build the VAT report only oss reverse-charge quarterly pdf export" });

// Advisory throttle + escalation count.
clearOverlapNotice(LATE);
const first = shouldNotifyOverlap(LATE);
const secondImmediate = shouldNotifyOverlap(LATE); // within cooldown -> false
const countAfterOne = overlapAdvisoryCount(LATE);

clean();
ids.forEach(clearOverlapNotice);

const checks = {
  "same-prompt similarity is high": simSame > 0.9,
  "different-topic similarity is low": simDiff < 0.5,
  "LATE sees EARLY as overlapping": lateOverlaps.some((p) => p.agentId === EARLY),
  "LATE must yield to EARLY": lateMustYield.length === 1 && lateMustYield[0].agentId === EARLY,
  "EARLY does NOT yield (started first)": earlyMustYield.length === 0,
  "unrelated OTHER flags nobody": otherOverlaps.length === 0,
  "differentiating clears the must-yield": afterDiff.length === 0,
  "first advisory fires": first === true,
  "immediate re-advisory throttled": secondImmediate === false,
  "advisory count increments": countAfterOne === 1,
};

let ok = true;
for (const [k, v] of Object.entries(checks)) {
  if (!v) ok = false;
  console.log(`${v ? "✅" : "❌"} ${k}`);
}
console.log(`sim(same)=${simSame.toFixed(2)} sim(diff)=${simDiff.toFixed(2)}`);
console.log(ok ? "PASS ✅ overlap detection + tiebreaker + throttle" : "FAIL ❌");
process.exit(ok ? 0 : 1);
