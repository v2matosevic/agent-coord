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
import { findOverlappingPeers } from "../lib/overlap.mjs";
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
const adopted = !!agentId;
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
    case "claim_files":
      return {
        results: (a.paths || []).map((p) => {
          const cp = canon(p);
          const r = claimFile(db, { agentId, workspaceId: ws, repoPath: repoRoot, branch, path: cp, mode: a.mode || "exclusive", reason: a.reason });
          return { path: cp, granted: r.granted, heldBy: r.granted ? null : r.conflict?.agent_id };
        }),
      };
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
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

const server = new Server({ name: "agent-coord", version: "0.1.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a = {} } = req.params;
  heartbeat(db, agentId);
  try {
    return ok(handle(name, a));
  } catch (e) {
    return { content: [{ type: "text", text: JSON.stringify({ error: e.message }) }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
