// Test helper: post a workspace message as the agent for <sessionId> in <cwd>.
// Usage: node test/_post.mjs <sessionId> <cwd> <body...>
import { getDb } from "../lib/store.mjs";
import { resolveAgentId } from "../lib/identity.mjs";
import { gitContext } from "../lib/git-context.mjs";
import { workspaceId } from "../lib/path-canon.mjs";
import { ensureAgent } from "../lib/agents.mjs";
import { postMessage } from "../lib/messages.mjs";

const [sid, cwd, ...rest] = process.argv.slice(2);
const db = getDb();
const id = resolveAgentId({ session_id: sid });
const { repoRoot, branch } = gitContext(cwd);
ensureAgent(db, { agentId: id, repoPath: repoRoot, branch });
postMessage(db, { fromAgent: id, workspaceId: workspaceId(repoRoot), body: rest.join(" ") });
console.log("posted as", id);
