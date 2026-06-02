import { readFileSync } from "node:fs";
import { resolveAgentId } from "../lib/identity.mjs";
import { gitContext } from "../lib/git-context.mjs";
import { getDb, setDegraded } from "../lib/store.mjs";
import { ensureAgent, markDead, heartbeat } from "../lib/agents.mjs";
import { releaseAllForAgent } from "../lib/leases.mjs";
import { readMessages } from "../lib/messages.mjs";
import { logActivity } from "../lib/activity.mjs";
import { workspaceId } from "../lib/path-canon.mjs";
import { reap } from "../lib/reaper.mjs";
import { findClaudePid } from "../lib/proc-ancestry.mjs";
import { writeSessionLink, cachedClaudePid } from "../lib/session-link.mjs";

// Lifecycle hook. Modes:
//   --register        SessionStart      -> register parent agent
//   --prompt          UserPromptSubmit  -> capture the task
//   --subagent-start  SubagentStart     -> register a subagent (distinct id)
//   --subagent-stop   SubagentStop      -> release that subagent
//   --release         SessionEnd        -> release parent agent
const args = process.argv.slice(2);
const MODE = args.includes("--release")
  ? "release"
  : args.includes("--prompt")
    ? "prompt"
    : args.includes("--subagent-start")
      ? "sub-start"
      : args.includes("--subagent-stop")
        ? "sub-stop"
        : "register";

function readInput() {
  try {
    return JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

const input = readInput();
const agentId = resolveAgentId(input); // parent for session events; distinct id for subagent events

try {
  const db = getDb();
  const ctx = () => gitContext(input.cwd || process.cwd());

  if (MODE === "register") {
    const { repoRoot, branch } = ctx();
    ensureAgent(db, { agentId, tool: "claude-code", repoPath: repoRoot, branch, pid: process.ppid });
    logActivity(db, { agentId, workspaceId: workspaceId(repoRoot), event: "register", detail: repoRoot });
    reap(db);
    // Publish claude.exe -> our id so this session's stdio MCP server adopts the
    // SAME identity (no ghost twin). Cached per session_id so resume/compact
    // SessionStarts skip the one-time process-tree walk.
    try {
      const claudePid = cachedClaudePid(input.session_id) || findClaudePid(process.ppid);
      if (claudePid) writeSessionLink(claudePid, agentId, input.session_id);
    } catch {}
  } else if (MODE === "prompt") {
    const { repoRoot, branch } = ctx();
    ensureAgent(db, { agentId, tool: "claude-code", repoPath: repoRoot, branch });
    const task = typeof input.prompt === "string" ? input.prompt.replace(/\s+/g, " ").trim().slice(0, 100) : null;
    if (task) heartbeat(db, agentId, task);
    // Deliver unread peer messages into context (UserPromptSubmit stdout is injected).
    const ws = workspaceId(repoRoot);
    const msgs = readMessages(db, { agentId, workspaceId: ws });
    if (msgs.length) {
      process.stdout.write(
        "📬 agent-coord — new messages from other agents in this workspace:\n" +
          msgs.map((m) => `  • ${m.from_agent}${m.to_agent ? " (to you)" : ""}: ${m.body}`).join("\n") +
          "\n",
      );
    }
  } else if (MODE === "sub-start") {
    const { repoRoot, branch } = ctx();
    ensureAgent(db, { agentId, tool: "claude-code", repoPath: repoRoot, branch, task: input.agent_type || "subagent" });
    logActivity(db, { agentId, workspaceId: workspaceId(repoRoot), event: "subagent-start", detail: input.agent_type });
  } else {
    // sub-stop or release — same teardown, different id resolved above
    releaseAllForAgent(db, agentId);
    markDead(db, agentId);
    logActivity(db, { agentId, event: MODE === "sub-stop" ? "subagent-stop" : "release" });
  }
} catch (e) {
  setDegraded(e);
}
process.exit(0);
