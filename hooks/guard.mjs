import { readFileSync } from "node:fs";
import { resolveAgentId } from "../lib/identity.mjs";
import { gitContext } from "../lib/git-context.mjs";
import { getDb, setDegraded, clearDegraded } from "../lib/store.mjs";
import { ensureAgent, heartbeat } from "../lib/agents.mjs";
import { claimFile, enqueue } from "../lib/leases.mjs";
import { logActivity } from "../lib/activity.mjs";
import { workspaceId, canonicalFilePath } from "../lib/path-canon.mjs";
import { FILE_ACTIVE_MS } from "../lib/config.mjs";
import { midTurnContext, postToolContextJson } from "../lib/coord-context.mjs";
import { overlapHardBlock, earlierOverlappingPeers } from "../lib/overlap.mjs";

const short = (id) => String(id).replace(/-\d+$/, "");

// PreToolUse (default) on Write|Edit|MultiEdit|NotebookEdit: claim the file, or
// exit 2 to block when another live agent holds it. PostToolUse (--post): just
// refresh heartbeat + log the edit. Always fails OPEN (exit 0) but LOUD (sets
// the degraded flag + stderr) so a store problem never freezes real work.
const POST = process.argv.includes("--post");

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
const fp = input.tool_input?.file_path || input.tool_input?.notebook_path || null;

try {
  const db = getDb();
  const { repoRoot, branch } = gitContext(cwd);
  const ws = workspaceId(repoRoot);
  ensureAgent(db, { agentId, tool: "claude-code", repoPath: repoRoot, branch });

  if (!fp) process.exit(0);
  const path = canonicalFilePath(fp, repoRoot);

  if (POST) {
    heartbeat(db, agentId);
    logActivity(db, { agentId, workspaceId: ws, event: "edit", detail: path });
    // Mid-turn delivery: surface peer messages + duplicate-work advisory between
    // tool calls so a heads-down agent actually hears them. Non-blocking.
    try {
      const ctx = midTurnContext(db, { agentId, workspaceId: ws });
      if (ctx) process.stdout.write(postToolContextJson(ctx));
    } catch {}
    process.exit(0);
  }

  // Escalation (advisory -> block): if I'm the later-starter on overlapping work
  // and have already been advised enough times, my OWN guard stops me from
  // grabbing more of the same area. Escape hatch: announce a narrower lane.
  const dup = overlapHardBlock(db, { agentId, workspaceId: ws });
  if (dup) {
    logActivity(db, { agentId, workspaceId: ws, event: "overlap-block", detail: dup.agentId });
    process.stderr.write(
      `⛔ agent-coord: standing you down — your task duplicates ${short(dup.agentId)}'s, who started before you ` +
        `("${String(dup.task).slice(0, 80)}"). You've been advised and kept editing the same area.\n` +
        `   To proceed: narrow your lane with the announce_intent tool (a distinct sub-task clears this), ` +
        `or post_message ${short(dup.agentId)} to split the work. Don't rebuild what they're already building.\n`,
    );
    process.exit(2);
  }

  const res = claimFile(db, { agentId, workspaceId: ws, repoPath: repoRoot, branch, path, mode: "exclusive", reason: input.tool_name });
  if (!res.granted) {
    enqueue(db, { kind: "file", key: ws + "||" + path, agentId });
    logActivity(db, { agentId, workspaceId: ws, event: "conflict", detail: path });
    // The holder is ACTIVELY editing this file right now (cold leases don't reach
    // here). Tell the model how to self-resolve — it auto-frees when they move
    // on; never escalate to the human or force-release a live peer.
    const mins = Math.max(1, Math.ceil((new Date(res.conflict.acquired_at).getTime() + FILE_ACTIVE_MS - Date.now()) / 60000));
    let extra = `They're editing it now; it auto-frees in ~${mins} min once they move on. Edit another file and retry, or post_message ${short(res.conflict.agent_id)} to coordinate. Don't force-release or ask the human to unlock.`;
    try {
      const dupHolder = earlierOverlappingPeers(db, { agentId, workspaceId: ws, task: db.prepare("SELECT current_task FROM agents WHERE agent_id=?").get(agentId)?.current_task })
        .find((p) => p.agentId === res.conflict.agent_id);
      if (dupHolder)
        extra =
          `⚠ ${short(res.conflict.agent_id)} started before you and is on overlapping work — you're likely DUPLICATING it. ` +
          `Narrow your lane (announce_intent) or post_message to hand off — don't rebuild it.`;
    } catch {}
    process.stderr.write(
      `⛔ agent-coord: "${path}" is held by ${short(res.conflict.agent_id)} (${res.conflict.current_task || "working"}). ${extra}\n`,
    );
    process.exit(2); // blocks the tool; Claude feeds this stderr back to the model
  }

  clearDegraded();
  logActivity(db, { agentId, workspaceId: ws, event: "claim", detail: path });
  process.exit(0);
} catch (e) {
  setDegraded(e);
  process.stderr.write(`⚠ agent-coord DEGRADED: ${e.code || e.message}; proceeding without lock enforcement.\n`);
  process.exit(0);
}
