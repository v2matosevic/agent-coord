import { getDb } from "../lib/store.mjs";
import { contentionStats, WAIT_RETENTION_MS } from "../lib/contention.mjs";
import { gitContext } from "../lib/git-context.mjs";
import { workspaceId } from "../lib/path-canon.mjs";

const here = process.argv.includes("--here");
const root = here ? gitContext(process.cwd()).repoRoot : null;
if (here && !root) throw new Error("--here requires a git checkout");
const files = contentionStats(getDb(), here ? { workspaceId: workspaceId(root) } : {});
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ retentionDays: WAIT_RETENTION_MS / 86400000, files }, null, 2));
} else {
  console.log("Per-file contention, last 7 days (read-only; wait episodes, not throughput)");
  if (!files.length) console.log("No recorded waits in this window.");
  for (const f of files) {
    console.log(`${f.workspaceId}/${f.path}: ${f.episodes} episodes, ${f.attempts} blocked attempts, ${(f.waitMs / 1000).toFixed(1)} waiter-seconds, ${f.pending} pending`);
    console.log(`  Holder observations: ${f.editingAttempts} command in flight, ${f.reservationAttempts} reserved, ${f.unknownAttempts} unknown; outcomes ${JSON.stringify(f.outcomes)}`);
  }
}
