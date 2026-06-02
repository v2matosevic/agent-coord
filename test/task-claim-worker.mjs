// Child process for the task-claim race test: register, claim ONE task, print
// GRANTED or BLOCKED. Run concurrently by test/tasks.mjs against the shared store.
import { getDb } from "../lib/store.mjs";
import { ensureAgent } from "../lib/agents.mjs";
import { claimTask } from "../lib/tasks.mjs";

const [, , ws, taskId, agentId, repo] = process.argv;
const db = getDb();
ensureAgent(db, { agentId, repoPath: repo, branch: "main" });
const r = claimTask(db, { taskId, agentId });
process.stdout.write(r.granted ? "GRANTED" : "BLOCKED");
process.exit(0);
