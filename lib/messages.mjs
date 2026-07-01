import { writeTxn, nowIso, isoInSec } from "./store.mjs";
import { liveAgentIds } from "./agents.mjs";
import { baseAgentId } from "./identity.mjs";

// Workspace-scoped agent-to-agent messaging — a lightweight mailbox on top of
// presence + locks so agents in the SAME repo can actually coordinate ("I'm
// mid-refactor on auth, leave lib/auth alone", "API's ready, wire the UI").
// Default scope is the workspace, so projects never bleed into each other.

const MSG_TTL_SEC = 24 * 60 * 60;

// Raw insert, NO transaction — for callers already inside a writeTxn (e.g. a
// task-completion notify) where a nested BEGIN IMMEDIATE would throw.
export function insertMessage(db, { fromAgent, workspaceId, body, toAgent = null, scope = "workspace", ttlSec = MSG_TTL_SEC }) {
  const ws = scope === "global" ? null : workspaceId;
  return db.prepare("INSERT INTO messages(ts,workspace_id,from_agent,to_agent,body,expires_at) VALUES(?,?,?,?,?,?)").run(nowIso(), ws, fromAgent, toAgent, body, isoInSec(ttlSec));
}

export function postMessage(db, opts) {
  return writeTxn(db, () => insertMessage(db, opts));
}

// Messages an agent hasn't seen: in its workspace (or global broadcasts),
// addressed to it or to everyone, not its own, not expired. Advances the read
// pointer so each message is delivered once. `limit` (0 = unlimited) caps one
// delivery WITHOUT losing the rest: the pointer only advances past the rows
// actually returned, so a truncated backlog resumes exactly where it stopped
// on the next call — a cap on context per turn, never on delivery.
export function readMessages(db, { agentId, workspaceId, advance = true, limit = 0 }) {
  return writeTxn(db, () => {
    const last = db.prepare("SELECT last_seq FROM message_reads WHERE agent_id=?").get(agentId)?.last_seq ?? 0;
    let rows = db
      .prepare(
        `SELECT seq, ts, workspace_id, from_agent, to_agent, body FROM messages
         WHERE seq > ? AND expires_at > ? AND from_agent <> ?
           AND (workspace_id IS NULL OR workspace_id = ?)
           AND (to_agent IS NULL OR to_agent = ?)
         ORDER BY seq ASC`,
      )
      .all(last, nowIso(), agentId, workspaceId, agentId);
    if (limit > 0 && rows.length > limit) rows = rows.slice(0, limit);
    if (advance && rows.length) {
      db.prepare("INSERT INTO message_reads(agent_id,last_seq) VALUES(?,?) ON CONFLICT(agent_id) DO UPDATE SET last_seq=excluded.last_seq").run(agentId, rows[rows.length - 1].seq);
    }
    return rows;
  });
}

// Stamp each message with whether its SENDER is still live right now. A
// read_messages backlog can span hours and prior sessions, so the author of a
// message is frequently an agent that has since EXITED — treating "wrote a message
// in the backlog" as "currently here and able to act" produced bad hand-off plans
// (BUG 2, OBSERVED-BUGS-2026-06-18). An agent counts as present if its exact id OR
// its parent session (same base) is live, so a message from a since-exited subagent
// of a still-live session isn't falsely marked gone. Pass a precomputed `live` set
// to annotate several batches against one snapshot.
export function annotateSenders(db, messages, live = null) {
  if (!messages?.length) return messages || [];
  const set = live || liveAgentIds(db);
  return messages.map((m) => ({ ...m, from_live: set.has(m.from_agent) || set.has(baseAgentId(m.from_agent)) }));
}

// Replies to a specific ask (a directed message tagged [re:<askId>]) — for the
// asker to poll without disturbing its normal unread pointer.
export function findReplies(db, { agentId, askId }) {
  return db
    .prepare("SELECT seq, ts, from_agent, body FROM messages WHERE to_agent=? AND body LIKE ? AND expires_at>? ORDER BY seq ASC")
    .all(agentId, `%[re:${askId}]%`, nowIso());
}

export function unreadCount(db, { agentId, workspaceId }) {
  const last = db.prepare("SELECT last_seq FROM message_reads WHERE agent_id=?").get(agentId)?.last_seq ?? 0;
  return (
    db
      .prepare(
        `SELECT COUNT(*) c FROM messages
         WHERE seq > ? AND expires_at > ? AND from_agent <> ?
           AND (workspace_id IS NULL OR workspace_id = ?) AND (to_agent IS NULL OR to_agent = ?)`,
      )
      .get(last, nowIso(), agentId, workspaceId, agentId)?.c ?? 0
  );
}
