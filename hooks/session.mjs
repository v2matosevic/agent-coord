import { readFileSync, statSync, writeFileSync } from "node:fs";
import { DEAD_MS } from "../lib/config.mjs";
import { stripHarnessPreamble } from "../lib/overlap.mjs";
import { writeSnapshotThrottled } from "../lib/snapshot.mjs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAgentId, bindSessionName, COORD_HOME } from "../lib/identity.mjs";
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
import { writeSessionLink, cachedClaudePid, parentBaseFromProc, readSessionLinkMeta } from "../lib/session-link.mjs";

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

// One window, one name. /clear (and an in-TUI /resume) hands the SAME claude
// process a NEW session_id, which would hash to a new name — the human's
// statusline flips mid-conversation, the still-running MCP server keeps the old
// one, and peers see "toad" go dead while "ferret" appears. If the claude
// process we're under already published a link whose agent is still live, that
// name is this window's: bind the new session id to it. Only a link under OUR
// OWN ancestor process qualifies, so no session can inherit a peer's name; a
// dead holder (no fresh heartbeat marker) is not retained, so a recycled pid
// can't resurrect an exited agent's identity.
let claudePidNow = null;
let retained = null;
if (MODE === "register" && !input?.agent_id && input?.session_id && input?.source && input.source !== "startup") {
  try {
    claudePidNow = findClaudePid(process.ppid);
    const prev = readSessionLinkMeta(claudePidNow);
    if (prev?.agentId && !prev.agentId.includes("/")) {
      let liveMarker = false;
      try {
        liveMarker = Date.now() - statSync(join(COORD_HOME, "hb", encodeURIComponent(prev.agentId))).mtimeMs < DEAD_MS;
      } catch {}
      if (liveMarker && bindSessionName(input.session_id, prev.agentId)) retained = prev.agentId;
    }
  } catch {}
}
const agentId = retained || resolveAgentId(input, { parentBase }); // parent for session events; distinct id for subagent events

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
      const pids = new Set([Number(process.env.CLAUDE_PID) || null, cachedClaudePid(input.session_id), claudePidNow || findClaudePid(process.ppid)].filter(Boolean));
      for (const pid of pids) writeSessionLink(pid, agentId, input.session_id);
    } catch {}
    if (retained) logActivity(db, { agentId, workspaceId: workspaceId(repoRoot), event: "identity-retain", detail: input.source });
    // Room brief: SessionStart stdout lands in context, so the agent arrives
    // knowing who's here, the board, and standing decisions — no tool calls.
    try {
      const brief = buildRoomBrief(db, { agentId, workspaceId: workspaceId(repoRoot), repoRoot, wrap: (s) => s + "\n" });
      if (brief) process.stdout.write(brief + "\n");
    } catch {}
    // Self-learning upkeep: regenerate the per-project hotspot/ROI digests at
    // most once a day, spawned DETACHED so SessionStart never waits on it.
    // Stamp the marker before spawning so two sessions starting together can't
    // double-run. AGENT_COORD_DIGEST=0 opts out (the test runner sets it).
    try {
      if (process.env.AGENT_COORD_DIGEST !== "0") {
        const mark = join(COORD_HOME, ".last-digest");
        let due = true;
        try {
          due = Date.now() - statSync(mark).mtimeMs > 86400000;
        } catch {}
        if (due) {
          writeFileSync(mark, String(Date.now()));
          const digest = fileURLToPath(new URL("../cli/digest.mjs", import.meta.url));
          spawn(process.execPath, ["--disable-warning=ExperimentalWarning", digest], { detached: true, stdio: "ignore" }).unref();
        }
      }
    } catch {}
  } else if (MODE === "prompt") {
    const { repoRoot, branch } = ctx();
    ensureAgent(db, { agentId, tool: "claude-code", repoPath: repoRoot, branch });
    // A host harness may prefix the prompt with context that is not the task
    // (Hephaestus: "[Hephaestus] Local time: … Treat this as the current moment;
    // it is host context…"). Recorded verbatim, that preamble was every ADE
    // session's current_task and Jaccard-matched every other ADE session in the
    // repo (i-d0793813, i-be3653b1). Strip it before the prompt becomes a task.
    const task = typeof input.prompt === "string" ? stripHarnessPreamble(input.prompt).replace(/\s+/g, " ").trim().slice(0, 100) : null;
    // Resume boilerplate isn't a task — a relaunched session's synthetic
    // "Continue where you left off" would otherwise become its current_task and
    // Jaccard-match every other generic prompt (the gilt-hawk false positive).
    const boilerplate = task && /^continue where you left off/i.test(task);
    if (task && !boilerplate) heartbeat(db, agentId, task);
    else heartbeat(db, agentId);
    writeSnapshotThrottled(db);
    // Same delivery as mid-turn (messages + freed files + overlap advisory) —
    // UserPromptSubmit stdout is injected into context. `wrap` accounts for the
    // trailing newline this hook writes, so the budget matches the real payload.
    const ctxText = midTurnContext(db, { agentId, workspaceId: workspaceId(repoRoot), wrap: (s) => s + "\n" });
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
