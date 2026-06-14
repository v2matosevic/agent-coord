import { readFileSync } from "node:fs";
import { resolveAgentId } from "../lib/identity.mjs";
import { gitContext } from "../lib/git-context.mjs";
import { getDb, setDegraded } from "../lib/store.mjs";
import { ensureAgent, markDead, heartbeat } from "../lib/agents.mjs";
import { releaseAllForAgent } from "../lib/leases.mjs";
import { logActivity } from "../lib/activity.mjs";
import { midTurnContext } from "../lib/coord-context.mjs";
import { buildRoomBrief } from "../lib/room-brief.mjs";
import { workspaceId } from "../lib/path-canon.mjs";
import { reap } from "../lib/reaper.mjs";
import { findClaudePid } from "../lib/proc-ancestry.mjs";
import { writeSessionLink, cachedClaudePid, parentBaseFromProc } from "../lib/session-link.mjs";

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
// Subagent events: pin the base to the parent session's claimed name (via the
// claude.exe session-link) so a subagent shares its parent's identity even when
// Claude hands it a different session_id. Parent events resolve normally.
const parentBase = input?.agent_id ? parentBaseFromProc(process.ppid) : null;
const agentId = resolveAgentId(input, { parentBase }); // parent for session events; distinct id for subagent events

try {
  const db = getDb();
  const ctx = () => gitContext(input.cwd || process.cwd());

  if (MODE === "register") {
    const { repoRoot, branch } = ctx();
    ensureAgent(db, { agentId, tool: "claude-code", repoPath: repoRoot, branch, pid: process.ppid });
    logActivity(db, { agentId, workspaceId: workspaceId(repoRoot), event: "register", detail: repoRoot });
    reap(db);
    // Publish claude.exe -> our id so this session's stdio MCP server adopts the
    // SAME identity (no ghost twin). On RESUME the cached pid is the OLD claude.exe,
    // so we ALSO resolve the current one and link both — otherwise the resumed
    // session's new MCP server (parented by the new pid) finds no link and stays a
    // standalone twin. Re-resolving costs one process-walk per SessionStart (rare).
    try {
      const pids = new Set([cachedClaudePid(input.session_id), findClaudePid(process.ppid)].filter(Boolean));
      for (const pid of pids) writeSessionLink(pid, agentId, input.session_id);
    } catch {}
    // Room brief: SessionStart stdout lands in context, so the agent arrives
    // knowing who's here, the board, and standing decisions — no tool calls.
    try {
      const brief = buildRoomBrief(db, { agentId, workspaceId: workspaceId(repoRoot), repoRoot });
      if (brief) process.stdout.write(brief + "\n");
    } catch {}
  } else if (MODE === "prompt") {
    const { repoRoot, branch } = ctx();
    ensureAgent(db, { agentId, tool: "claude-code", repoPath: repoRoot, branch });
    const task = typeof input.prompt === "string" ? input.prompt.replace(/\s+/g, " ").trim().slice(0, 100) : null;
    // Resume boilerplate isn't a task — a relaunched session's synthetic
    // "Continue where you left off" would otherwise become its current_task and
    // Jaccard-match every other generic prompt (the gilt-hawk false positive).
    const boilerplate = task && /^continue where you left off/i.test(task);
    if (task && !boilerplate) heartbeat(db, agentId, task);
    else heartbeat(db, agentId);
    // Same delivery as mid-turn (messages + freed files + overlap advisory) —
    // UserPromptSubmit stdout is injected into context.
    const ctxText = midTurnContext(db, { agentId, workspaceId: workspaceId(repoRoot) });
    if (ctxText) process.stdout.write(ctxText + "\n");
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
