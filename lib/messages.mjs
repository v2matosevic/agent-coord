import { writeTxn, nowIso, isoInSec } from "./store.mjs";

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
// pointer so each message is delivered once.
export function readMessages(db, { agentId, workspaceId, advance = true }) {
  return writeTxn(db, () => {
    const last = db.prepare("SELECT last_seq FROM message_reads WHERE agent_id=?").get(agentId)?.last_seq ?? 0;
    const rows = db
      .prepare(
        `SELECT seq, ts, workspace_id, from_agent, to_agent, body FROM messages
         WHERE seq > ? AND expires_at > ? AND from_agent <> ?
           AND (workspace_id IS NULL OR workspace_id = ?)
           AND (to_agent IS NULL OR to_agent = ?)
         ORDER BY seq ASC`,
      )
      .all(last, nowIso(), agentId, workspaceId, agentId);
    if (advance && rows.length) {
      db.prepare("INSERT INTO message_reads(agent_id,last_seq) VALUES(?,?) ON CONFLICT(agent_id) DO UPDATE SET last_seq=excluded.last_seq").run(agentId, rows[rows.length - 1].seq);
    }
    return rows;
  });
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
