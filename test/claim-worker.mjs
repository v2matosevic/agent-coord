// One racer process: register, attempt an EXCLUSIVE claim on a shared path,
// print the outcome. Spawned N-up by concurrency.mjs.
// args: <agentId> <workspaceId> <path>
import { getDb } from "../lib/store.mjs";
import { ensureAgent } from "../lib/agents.mjs";
import { claimFile } from "../lib/leases.mjs";

const [agentId, ws, path] = process.argv.slice(2);
try {
  const db = getDb();
  ensureAgent(db, { agentId, repoPath: "/test/repo", branch: "main" });
  const res = claimFile(db, { agentId, workspaceId: ws, path, mode: "exclusive", reason: "race" });
  process.stdout.write(res.granted ? "GRANTED" : "CONFLICT");
} catch (e) {
  process.stdout.write("ERROR:" + (e.code || e.message));
}
