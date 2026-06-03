import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { agentIdFromSession } from "../lib/identity.mjs";
import { gitContext } from "../lib/git-context.mjs";
import { getDb } from "../lib/store.mjs";
import { ensureAgent, heartbeat, markDead } from "../lib/agents.mjs";
import { claimFile, releaseFile, claimResource, releaseResource, releaseAllForAgent, peekConflicts } from "../lib/leases.mjs";
import { logActivity, getFleet, getGlobalState } from "../lib/activity.mjs";
import { postMessage, readMessages, findReplies } from "../lib/messages.mjs";
import { analyzePendingPush } from "../lib/pending-push.mjs";
import { workspaceId, canonicalFilePath } from "../lib/path-canon.mjs";
import { reap } from "../lib/reaper.mjs";
import { pollSessionLink } from "../lib/session-link.mjs";
import { reconcileServerIdentity } from "../lib/server-identity.mjs";
import { findOverlappingPeers } from "../lib/overlap.mjs";
import { createTask, claimTask, updateTask, listTasks } from "../lib/tasks.mjs";
import { collisionHotspots, pathHistory } from "../lib/insights.mjs";
import { TOOL_DEFS } from "./tool-defs.mjs";

const short = (id) => String(id).replace(/-\d+$/, "");

// One stdio MCP server == one agent (clients spawn it per session). This is how
// non-Claude agents (Codex, etc.) get coordination: awareness + model-invoked
// claims. Enforcement for them is the git pre-commit net, not pre-write blocks.

const argFlag = (f) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : null;
};

const tool = argFlag("--tool") || "mcp-agent";
const cwd = process.cwd();
const { repoRoot, branch } = gitContext(cwd);
const ws = workspaceId(repoRoot);
const db = getDb();

// Adopt this Claude session's hook identity if the SessionStart hook published a
// link for our parent claude.exe — so the session is ONE agent, not a hook-self
// plus a random MCP twin (which split locks from messages and broke own-commit
// recognition in pending_push_review). Standalone fallback keeps Codex/no-hooks
// working exactly as before.
let agentId = null;
if (tool === "claude-code") {
  try {
    agentId = await pollSessionLink(process.ppid);
  } catch {}
}
let adopted = !!agentId;
if (!agentId) agentId = agentIdFromSession(randomUUID());

ensureAgent(db, { agentId, tool, repoPath: repoRoot, branch });
reap(db);
if (!adopted) logActivity(db, { agentId, workspaceId: ws, event: "register", detail: `${tool} ${repoRoot || ""}` });

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  // When we ADOPTED the session's hook identity, the session lifecycle (and its
  // SessionEnd hook) owns teardown — releasing here would yank a LIVE session's
  // locks if Claude merely restarts the MCP server. Only a standalone server
  // (Codex / no hooks) cleans up its own identity.
  if (adopted) return;
  try {
    releaseAllForAgent(db, agentId);
    markDead(db, agentId);
    logActivity(db, { agentId, event: "release" });
  } catch {}
}
process.on("SIGINT", () => (cleanup(), process.exit(0)));
process.on("SIGTERM", () => (cleanup(), process.exit(0)));
process.on("exit", cleanup);

const ok = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });
const canon = (p) => canonicalFilePath(p, repoRoot);

function handle(name, a) {
  switch (name) {
    case "whoami":
      return { agentId, tool, repo: repoRoot, branch, workspace: ws };
    case "announce_intent": {
      heartbeat(db, agentId, a.task || null);
      logActivity(db, { agentId, workspaceId: ws, event: "intent", detail: a.task });
      if (a.task) postMessage(db, { fromAgent: agentId, workspaceId: ws, body: "▶ " + a.task, scope: "workspace" });
      // Tell the announcer immediately if a peer is already on the same work, so
      // two agents on one vague prompt de-conflict up front instead of building
      // the same thing twice. Deterministic tiebreaker: later-starter yields.
      const overlaps = a.task ? findOverlappingPeers(db, { agentId, workspaceId: ws, task: a.task }) : [];
      const mustYield = overlaps.filter((p) => p.iStartedLater);
      let warning = null;
      if (mustYield.length) {
        const p = mustYield[0];
        warning = `⚠ Your task overlaps ${short(p.agentId)}, who started before you ("${p.task}"). You're the later starter — narrow your lane (re-announce a distinct sub-task) or post_message to hand off. Don't rebuild what they're already building.`;
      } else if (overlaps.length) {
        const p = overlaps[0];
        warning = `⚠ ${short(p.agentId)} is on overlapping work ("${p.task}") but started after you — you have priority. Consider post_message to split scope cleanly.`;
      }
      return { ok: true, agentId, task: a.task, overlaps, warning };
    }
    case "list_active_agents":
      return { agents: a.scope === "workspace" ? getFleet(db).filter((x) => x.repo_path && workspaceId(x.repo_path) === ws) : getFleet(db) };
    case "post_message":
      postMessage(db, { fromAgent: agentId, workspaceId: ws, body: a.body, toAgent: a.to || null, scope: a.scope || "workspace" });
      return { ok: true };
    case "read_messages":
      return { messages: readMessages(db, { agentId, workspaceId: ws }) };
    case "pending_push_review":
      return analyzePendingPush(db, repoRoot || cwd, agentId);
    case "ask_agent": {
      const askId = randomUUID().slice(0, 8);
      postMessage(db, { fromAgent: agentId, workspaceId: ws, body: `❓[ask:${askId}] ${a.question}`, toAgent: a.to, scope: "workspace" });
      return { ask_id: askId, note: "Delivered. The peer answers only if it's live and takes a turn — poll check_replies; if none and the peer isn't in list_active_agents, fall back (don't wait forever)." };
    }
    case "check_replies":
      return { replies: findReplies(db, { agentId, askId: a.ask_id }) };
    case "reply":
      postMessage(db, { fromAgent: agentId, workspaceId: ws, body: `↩[re:${a.ask_id}] ${a.answer}`, toAgent: a.to, scope: "workspace" });
      return { ok: true };
    case "request_yield":
      postMessage(db, {
        fromAgent: agentId,
        workspaceId: ws,
        body: `🛑[yield] ${a.reason || "I'm already building this — please stand down so we don't duplicate."}`,
        toAgent: a.to,
        scope: "workspace",
      });
      logActivity(db, { agentId, workspaceId: ws, event: "yield-request", detail: a.to });
      return {
        ok: true,
        note: "Delivered. The peer hears this between its tool calls (mid-turn). If it agrees, it should release_files and stop. If it's not live and doesn't reply, proceed.",
      };
    case "get_global_state":
      return getGlobalState(db);
    case "check_conflicts":
      return {
        conflicts: (a.paths || [])
          .map((p) => ({ path: canon(p), holders: peekConflicts(db, { workspaceId: ws, path: canon(p), agentId }) }))
          .filter((c) => c.holders.length),
      };
    case "claim_files": {
      // Just-in-time self-learning: flag a file as a known multi-agent hotspot so
      // the claimer reviews for duplicate/contradictory work before editing it.
      const hot = new Map(collisionHotspots(db, { workspaceId: ws }).map((h) => [h.path, h]));
      return {
        results: (a.paths || []).map((p) => {
          const cp = canon(p);
          const r = claimFile(db, { agentId, workspaceId: ws, repoPath: repoRoot, branch, path: cp, mode: a.mode || "exclusive", reason: a.reason });
          const out = { path: cp, granted: r.granted, heldBy: r.granted ? null : r.conflict?.agent_id };
          const h = hot.get(cp);
          if (h) out.hotspot = `⚠ ${h.agents.length} agents edited this in the last 7d — check for duplicate/contradictory work (query_history for detail).`;
          return out;
        }),
      };
    }
    case "query_history":
      return pathHistory(db, { workspaceId: ws, path: a.path, windowMs: (Number(a.days) > 0 ? Number(a.days) : 14) * 86400000 });
    case "release_files":
      if (a.paths?.length) a.paths.forEach((p) => releaseFile(db, { agentId, workspaceId: ws, path: canon(p) }));
      else releaseAllForAgent(db, agentId);
      return { released: a.paths || "all" };
    case "claim_resource": {
      const r = claimResource(db, { agentId, resourceId: a.resource_id, reason: a.reason });
      return { granted: r.granted, heldBy: r.granted ? null : r.conflict?.agent_id };
    }
    case "release_resource":
      releaseResource(db, { agentId, resourceId: a.resource_id });
      return { released: a.resource_id };
    case "log_activity":
      logActivity(db, { agentId, workspaceId: ws, event: a.event, detail: a.detail });
      return { ok: true };
    case "list_tasks":
      return { tasks: listTasks(db, { workspaceId: ws }) };
    case "claim_task": {
      let taskId = a.task_id;
      let created = false;
      if (!taskId && a.title) {
        const c = createTask(db, { workspaceId: ws, title: a.title, detail: a.detail, dependsOn: a.depends_on, createdBy: agentId });
        taskId = c.taskId;
        created = c.created;
      }
      if (!taskId) return { ok: false, error: "pass task_id (claim an existing task) or title (create + claim a new one)" };
      const r = claimTask(db, { taskId, agentId });
      if (!r.granted) return { ok: false, taskId, heldBy: r.conflict?.owner, error: r.error || `already claimed by ${r.conflict?.owner} — pick another task or coordinate` };
      logActivity(db, { agentId, workspaceId: ws, event: "task-claim", detail: taskId });
      return { ok: true, taskId, note: created ? "created + claimed" : "claimed an existing task — a peer may have created it, check the board" };
    }
    case "update_task": {
      const r = updateTask(db, { taskId: a.task_id, agentId, status: a.status, detail: a.detail });
      if (r.ok) logActivity(db, { agentId, workspaceId: ws, event: "task-update", detail: `${a.task_id} ${a.status || ""}`.trim() });
      return r;
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

const server = new Server({ name: "agent-coord", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a = {} } = req.params;
  // If a Claude session started standalone (lost the SessionStart race / resumed),
  // adopt its hook identity as soon as the link appears — before handling the call,
  // so nothing is ever claimed under the throwaway id. Gated to claude-code like the
  // startup adoption: only Claude publishes a hook link, so Codex never adopts one.
  if (!adopted && tool === "claude-code") {
    const r = reconcileServerIdentity(db, { agentId, ppid: process.ppid, tool, repoPath: repoRoot, branch });
    if (r.adopted) {
      agentId = r.agentId;
      adopted = true;
    }
  }
  heartbeat(db, agentId);
  try {
    return ok(handle(name, a));
  } catch (e) {
    return { content: [{ type: "text", text: JSON.stringify({ error: e.message }) }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
