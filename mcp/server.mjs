import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { agentIdFromSession } from "../lib/identity.mjs";
import { gitContext } from "../lib/git-context.mjs";
import { getDb } from "../lib/store.mjs";
import { ensureAgent, heartbeat, setIntent, markDead } from "../lib/agents.mjs";
import { claimFile, releaseFile, claimResource, releaseResource, releaseAllForAgent, peekConflicts } from "../lib/leases.mjs";
import { logActivity, getFleet, getGlobalState } from "../lib/activity.mjs";
import { postMessage, readMessages, findReplies, annotateSenders } from "../lib/messages.mjs";
import { analyzePendingPush } from "../lib/pending-push.mjs";
import { workspaceId, canonicalFilePath } from "../lib/path-canon.mjs";
import { reap } from "../lib/reaper.mjs";
import { pollSessionLinkAny } from "../lib/session-link.mjs";
import { findClaudePid } from "../lib/proc-ancestry.mjs";
import { reconcileServerIdentity } from "../lib/server-identity.mjs";
import { findOverlappingPeers, clearOverlapNotice } from "../lib/overlap.mjs";
import { createTask, claimTask, claimNextTask, updateTask, listTasks } from "../lib/tasks.mjs";
import { recordDecision, listDecisions } from "../lib/decisions.mjs";
import { collisionHotspots, pathHistory } from "../lib/insights.mjs";
import { searchRecords } from "../lib/search.mjs";
import { TOOL_DEFS } from "./tool-defs.mjs";

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
// link for our claude.exe — so the session is ONE agent, not a hook-self plus a
// random MCP twin (which split locks from messages and broke own-commit
// recognition in pending_push_review). Standalone fallback keeps Codex/no-hooks
// working exactly as before.
//
// The hook keys the link on the persistent claude.exe it walks UP to (its own
// parent is a transient wrapper). Our parent can ALSO be a wrapper — an npx/.cmd
// shim or a shell — so the raw process.ppid is not reliably claude.exe. We resolve
// the same anchor the hook does (findClaudePid) and read the link under BOTH it
// and the raw ppid, preferring the walked-up claude pid. BUG 1 (OBSERVED-BUGS-
// 2026-06-18): keying on the raw ppid alone made the server miss the link behind a
// wrapper and mint a random ghost-twin id, so whoami reported one name while the
// hooks recorded this session's leases/commits under another.
const LINK_POLL_MS = Number(process.env.AGENT_COORD_LINK_POLL_MS) || 4000;
const anchorPids = [process.ppid];
if (tool === "claude-code") {
  try {
    const cp = findClaudePid(process.ppid);
    if (cp && cp !== process.ppid) anchorPids.unshift(cp); // prefer the claude.exe anchor
  } catch {}
}
let agentId = null;
if (tool === "claude-code") {
  try {
    agentId = await pollSessionLinkAny(anchorPids, LINK_POLL_MS);
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
    case "whoami": {
      const me = { agentId, tool, repo: repoRoot, branch, workspace: ws };
      // Self-check (BUG 1 defense-in-depth): a claude-code server that never adopted
      // a hook link is the exact signature of the ghost-twin split — the hooks are
      // recording this session's file leases and commits under a DIFFERENT id than
      // the one reported here. Surface it loudly instead of silently handing back a
      // name nothing else agrees with.
      if (tool === "claude-code" && !adopted) {
        me.warning =
          "identity not linked to this session's hooks — your file locks and commits may be recorded under a " +
          "different agent name than this. Check get_global_state for a same-repo twin holding 'your' files, and " +
          "run cli/doctor.mjs. If you just started, retry in a moment (the link may still be landing).";
      }
      return me;
    }
    case "announce_intent": {
      // The declared intent survives prompt-driven current_task rewrites (it's
      // what overlap compares), and announcing resets the escalation counter —
      // "a distinct sub-task clears this" must actually be true. If the new
      // lane still overlaps, advisories resume and re-escalate on their own.
      if (a.task) setIntent(db, agentId, a.task);
      else heartbeat(db, agentId);
      clearOverlapNotice(agentId);
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
        warning = `⚠ Your task overlaps ${p.agentId}, who started before you ("${p.task}"). You're the later starter — narrow your lane (re-announce a distinct sub-task) or post_message to hand off. Don't rebuild what they're already building.`;
      } else if (overlaps.length) {
        const p = overlaps[0];
        warning = `⚠ ${p.agentId} is on overlapping work ("${p.task}") but started after you — you have priority. Consider post_message to split scope cleanly.`;
      }
      return { ok: true, agentId, task: a.task, overlaps, warning };
    }
    case "list_active_agents":
      return { agents: a.scope === "workspace" ? getFleet(db).filter((x) => x.repo_path && workspaceId(x.repo_path) === ws) : getFleet(db) };
    case "post_message":
      postMessage(db, { fromAgent: agentId, workspaceId: ws, body: a.body, toAgent: a.to || null, scope: a.scope || "workspace" });
      return { ok: true };
    case "read_messages": {
      // Annotate each message with whether its sender is still live (BUG 2): the
      // backlog can span hours and prior sessions, so a sender is frequently an
      // agent that has since exited. Flag those so "wrote a message" isn't read as
      // "here now and able to take a hand-off."
      const messages = annotateSenders(db, readMessages(db, { agentId, workspaceId: ws }));
      const gone = [...new Set(messages.filter((m) => !m.from_live).map((m) => m.from_agent))];
      const out = { messages };
      if (gone.length)
        out.note =
          `Senders no longer active: ${gone.join(", ")}. They've exited — don't plan hand-offs to them or treat ` +
          `their messages as live presence; check list_active_agents for who can actually act.`;
      return out;
    }
    case "pending_push_review":
      // Pass the resolved anchor pids so own-commit recognition reads the hook id
      // from the session-link under the claude.exe anchor, not the raw ppid (BUG 1).
      return analyzePendingPush(db, repoRoot || cwd, agentId, { ppids: anchorPids });
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
        const c = createTask(db, { workspaceId: ws, title: a.title, detail: a.detail, dependsOn: a.depends_on, createdBy: agentId, priority: a.priority });
        taskId = c.taskId;
        created = c.created;
      }
      if (!taskId) return { ok: false, error: "pass task_id (claim an existing task) or title (create + claim a new one)" };
      const r = claimTask(db, { taskId, agentId });
      if (!r.granted) return { ok: false, taskId, heldBy: r.conflict?.owner, error: r.error || `already claimed by ${r.conflict?.owner} — pick another task or coordinate` };
      logActivity(db, { agentId, workspaceId: ws, event: "task-claim", detail: taskId });
      return {
        ok: true,
        taskId,
        handoff: r.handoff?.length ? r.handoff : undefined,
        note: created ? "created + claimed" : "claimed an existing task — a peer may have created it, check the board",
      };
    }
    case "claim_next_task": {
      const r = claimNextTask(db, { workspaceId: ws, agentId });
      if (r.granted) logActivity(db, { agentId, workspaceId: ws, event: "task-claim", detail: r.taskId });
      return r;
    }
    case "update_task": {
      const r = updateTask(db, { taskId: a.task_id, agentId, status: a.status, detail: a.detail, summary: a.summary });
      if (r.ok) logActivity(db, { agentId, workspaceId: ws, event: "task-update", detail: `${a.task_id} ${a.status || ""}`.trim() });
      return r;
    }
    case "record_decision": {
      const r = recordDecision(db, { workspaceId: ws, agentId, topic: a.topic, decision: a.decision });
      if (r.ok) logActivity(db, { agentId, workspaceId: ws, event: "decision", detail: `[${r.topic}]` });
      return r;
    }
    case "list_decisions":
      return { decisions: listDecisions(db, { workspaceId: ws }) };
    case "search":
      return { results: searchRecords(db, { workspaceId: ws, query: a.query, kinds: a.kinds, limit: a.limit }) };
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// `instructions` is the one piece of server text that stays in EVERY session's
// context when the client defers tool schemas (Claude Code's tool search does
// this by default) — so it carries the whole protocol in miniature, front-loaded,
// and must stay well under the client's 2KB truncation.
const INSTRUCTIONS =
  "Coordinates ALL AI coding agents on this machine — you are one agent among live peers who may be " +
  "editing the same repo, dev port, or DB right now. Protocol: announce_intent BEFORE starting work " +
  "(warns about duplicate work; later starter narrows its lane); list_active_agents to see who's here; " +
  "post_message/reply to coordinate (delivered to peers mid-turn); claim_resource before dev-server/" +
  "migration/deploy; record_decision to pin choices peers must not contradict; claim_next_task pulls " +
  "ready work from the shared board, update_task(status:done, summary:...) hands off to dependents; " +
  "pending_push_review BEFORE pushing commits you didn't author (instead of asking the human); " +
  "search to full-text query past messages/decisions/tasks ('has this been discussed or built?'). " +
  "File locks self-heal: a blocked file auto-frees minutes after its holder moves on — edit elsewhere " +
  "and retry or post_message the holder; never ask the human to unlock, never force-release a live peer.";

const server = new Server({ name: "agent-coord", version: "1.3.2" }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a = {} } = req.params;
  // If a Claude session started standalone (lost the SessionStart race / resumed),
  // adopt its hook identity as soon as the link appears — before handling the call,
  // so nothing is ever claimed under the throwaway id. Gated to claude-code like the
  // startup adoption: only Claude publishes a hook link, so Codex never adopts one.
  if (!adopted && tool === "claude-code") {
    const r = reconcileServerIdentity(db, { agentId, ppids: anchorPids, tool, repoPath: repoRoot, branch });
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
