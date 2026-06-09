import { isoAgoMs } from "./store.mjs";
import { workspaceId as wsOf } from "./path-canon.mjs";
import { listTasks } from "./tasks.mjs";
import { listDecisions } from "./decisions.mjs";
import { unreadCount } from "./messages.mjs";
import { DEAD_MS } from "./config.mjs";

// Session-start room brief — SessionStart hook stdout lands in the agent's
// context, so an arriving agent starts INFORMED instead of having to remember
// to call list_active_agents/list_tasks: who's live here, what the board holds,
// the standing decisions, and whether mail is waiting. Returns null when
// there's nothing to say (alone + empty board) so the solo case stays silent.

const short = (id) => String(id).replace(/-\d+$/, "");
const ago = (ts) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 60000));
  return m < 1 ? "active now" : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
};

export function buildRoomBrief(db, { agentId, workspaceId, repoRoot }) {
  const lines = [];

  // Live peers in this room — excluding me and my own subagents.
  const peers = db
    .prepare("SELECT agent_id, current_task, last_heartbeat, repo_path FROM agents WHERE status='active' AND last_heartbeat>? AND agent_id<>?")
    .all(isoAgoMs(DEAD_MS), agentId)
    .filter((a) => a.repo_path && wsOf(a.repo_path) === workspaceId)
    .filter((a) => !a.agent_id.startsWith(agentId + "/"));
  for (const p of peers.slice(0, 5)) {
    lines.push(`  • ${short(p.agent_id)} — "${String(p.current_task || "working").slice(0, 90)}" (${ago(p.last_heartbeat)})`);
  }
  if (peers.length > 5) lines.push(`  • …and ${peers.length - 5} more (list_active_agents)`);

  // Board: what's ready to pick up, what's taken, what's done.
  const tasks = listTasks(db, { workspaceId });
  const open = tasks.filter((t) => t.status === "open" || (t.status === "claimed" && !t.ownerLive));
  const ready = open.filter((t) => t.ready);
  const claimed = tasks.filter((t) => t.status === "claimed" && t.ownerLive);
  const doneN = tasks.filter((t) => t.status === "done").length;
  if (tasks.length) {
    const readyStr = ready
      .slice(0, 3)
      .map((t) => `${t.task_id} "${t.title.slice(0, 50)}"${t.priority ? ` p${t.priority}` : ""}`)
      .join(", ");
    const claimedStr = claimed
      .slice(0, 3)
      .map((t) => `${t.task_id} → ${short(t.owner)}`)
      .join(", ");
    lines.push(
      `  ▦ board: ${ready.length} ready${readyStr ? ` (${readyStr})` : ""} · ${claimed.length} claimed${claimedStr ? ` (${claimedStr})` : ""} · ${doneN} done — claim_next_task to pull work`,
    );
  }

  // Standing decisions (latest per topic) — don't contradict these.
  const decisions = listDecisions(db, { workspaceId, limit: 3 });
  for (const d of decisions) lines.push(`  📌 [${d.topic}] ${String(d.decision).slice(0, 90)} (${short(d.by)})`);

  // Waiting mail (delivered in full at the first prompt / next mid-turn).
  const unread = unreadCount(db, { agentId, workspaceId });
  if (unread) lines.push(`  ✉ ${unread} unread message${unread > 1 ? "s" : ""} — arriving with your first prompt`);

  if (!lines.length) return null;
  const name = (repoRoot || "").replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || "this repo";
  return `🏠 agent-coord — ${name}: you are ${agentId}.${peers.length ? ` ${peers.length} peer${peers.length > 1 ? "s" : ""} here now:` : " You're alone here right now."}\n` + lines.join("\n");
}
