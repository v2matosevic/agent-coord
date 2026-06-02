import { readFileSync } from "node:fs";
import { resolveAgentId } from "../lib/identity.mjs";
import { gitContext } from "../lib/git-context.mjs";
import { getDb, setDegraded } from "../lib/store.mjs";
import { ensureAgent } from "../lib/agents.mjs";
import { claimResource } from "../lib/leases.mjs";
import { logActivity } from "../lib/activity.mjs";
import { workspaceId } from "../lib/path-canon.mjs";
import { detectResources } from "../lib/resource-rules.mjs";
import { writeCommitterMarker } from "../lib/committer.mjs";

// PreToolUse on Bash: claim machine-wide singletons (dev port / dev DB / deploy)
// the command would touch, blocking with exit 2 if another live agent holds one.
// Also stamps a committer marker on `git commit` so the pre-commit hook can tell
// a self-commit from a cross-agent one. Fails open but loud.

function readInput() {
  try {
    return JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

const input = readInput();
const agentId = resolveAgentId(input);
const cwd = input.cwd || process.cwd();
const command = input.tool_input?.command || "";

try {
  const db = getDb();
  const { repoRoot, branch } = gitContext(cwd);
  const ws = workspaceId(repoRoot);
  ensureAgent(db, { agentId, tool: "claude-code", repoPath: repoRoot, branch });

  const isCommit = /\bgit\s+commit\b/.test(command);
  if (isCommit) writeCommitterMarker(repoRoot, agentId);

  // A git commit is never itself a port/DB/deploy use — skip resource detection so
  // a message mentioning "deploy"/"migrate" (incl. -m and heredoc/-F forms) can't trip it.
  if (!isCommit) {
    for (const r of detectResources(command)) {
      const res = claimResource(db, { agentId, resourceId: r.resourceId, reason: r.label });
      if (!res.granted) {
        logActivity(db, { agentId, workspaceId: ws, event: "resource-conflict", detail: r.resourceId });
        process.stderr.write(
          `⛔ agent-coord: ${r.label} (${r.resourceId}) is in use by ${res.conflict.agent_id} ` +
            `(${res.conflict.current_task || "working"}). Running this now would collide — wait or coordinate.\n`,
        );
        process.exit(2);
      }
      logActivity(db, { agentId, workspaceId: ws, event: "resource-claim", detail: r.resourceId });
    }
  }
  process.exit(0);
} catch (e) {
  setDegraded(e);
  process.stderr.write(`⚠ agent-coord DEGRADED: ${e.code || e.message}; proceeding without resource guard.\n`);
  process.exit(0);
}
