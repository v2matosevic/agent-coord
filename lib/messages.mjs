import { writeTxn, nowIso, isoInSec } from "./store.mjs";
import { liveAgentIds } from "./agents.mjs";
import { baseAgentId } from "./identity.mjs";

// Workspace-scoped agent-to-agent messaging — a lightweight mailbox on top of
// presence + locks so agents in the SAME repo can actually coordinate ("I'm
// mid-refactor on auth, leave lib/auth alone", "API's ready, wire the UI").
// Default scope is the workspace, so BROADCASTS never bleed into each other.
//
// ⭐⭐⭐ A DIRECTED message ignores the room (2026-09-03). Measured on the live
// store the day before: of 77 messages with a `to_agent`, 57 went to agents that
// had exited, 18 were written into a room the recipient's server never reads
// (each server pins its workspace from its own cwd at spawn, and a nested
// checkout is a different room), and 2 would ever deliver. `to:` names the
// reader; the room is a broadcast concept. So the unread predicate below
// delivers anything addressed to you wherever it was posted, and only
// broadcasts (to_agent IS NULL) stay fenced to the room. The `scope` argument
// still decides which room a broadcast lands in; for a directed message it
// only records where the sender was standing.
//
// ⚠ The TTL is SEVEN DAYS, not 24 h. A day's fleet conversation was being
// destroyed the next day with no transcript anywhere; a week is long enough
// for Hephaestus's Room archive to mirror every row before it is reaped.

const MSG_TTL_SEC = 7 * 24 * 60 * 60;

// Raw insert, NO transaction — for callers already inside a writeTxn (e.g. a
// task-completion notify) where a nested BEGIN IMMEDIATE would throw.
export function insertMessage(db, { fromAgent, workspaceId, body, toAgent = null, scope = "workspace", ttlSec = MSG_TTL_SEC }) {
  const ws = scope === "global" ? null : workspaceId;
  return db.prepare("INSERT INTO messages(ts,workspace_id,from_agent,to_agent,body,expires_at) VALUES(?,?,?,?,?,?)").run(nowIso(), ws, fromAgent, toAgent, body, isoInSec(ttlSec));
}

export function postMessage(db, opts) {
  return writeTxn(db, () => insertMessage(db, opts));
}

// The one unread predicate. Delivery, the remainder count, and unreadCount all
// share this WHERE so a future filter change (expiry semantics, scope rules,
// self-message handling) can't desynchronize "what gets delivered" from "what
// gets counted" — the drift that would silently break truncation notices.
//
// Two lanes: addressed TO me from anywhere, or a broadcast in my room (or a
// global one). The old shape ANDed the room with the recipient, which is the
// 2-of-77 bug described at the top of this file.
const UNREAD_WHERE = `seq > ? AND expires_at > ? AND from_agent <> ?
           AND (to_agent = ?
                OR (to_agent IS NULL AND (workspace_id IS NULL OR workspace_id = ?)))`;
const unreadArgs = (last, agentId, workspaceId) => [last, nowIso(), agentId, agentId, workspaceId];

// Messages an agent hasn't seen: addressed to it (any room), or broadcast in
// its workspace (or globally); not its own, not expired. Advances the read
// pointer so each message is delivered once. `limit` (0 = unlimited) caps one
// delivery WITHOUT losing the rest: the pointer only advances past the rows
// actually returned, so a truncated backlog resumes exactly where it stopped.
//
// Returns { messages, remaining, remainingDirected }: `remaining` is the exact
// count still waiting past this batch (computed here, in the same transaction,
// so callers never re-derive it with a twin query or a length===cap heuristic),
// and `remainingDirected` counts how many of those are addressed TO this agent
// — delivery is strictly FIFO (the pointer is a seq watermark, so nothing can
// jump the line), so a directed message behind a broadcast backlog is surfaced
// by callers as an urgent notice instead of waiting its turn silently.
export function readMessages(db, { agentId, workspaceId, advance = true, limit = 0 }) {
  // Empty-mailbox fast path: this runs on every hook event, and the common case
  // is "no mail" — don't take the BEGIN IMMEDIATE write lock just to find that
  // out. A read-only existence probe first; if a message lands between the probe
  // and a skipped txn, the next event (seconds away) delivers it.
  const peekLast = db.prepare("SELECT last_seq FROM message_reads WHERE agent_id=?").get(agentId)?.last_seq ?? 0;
  const any = db.prepare(`SELECT 1 FROM messages WHERE ${UNREAD_WHERE} LIMIT 1`).get(...unreadArgs(peekLast, agentId, workspaceId));
  if (!any) return { messages: [], remaining: 0, remainingDirected: 0 };
  return writeTxn(db, () => {
    const last = db.prepare("SELECT last_seq FROM message_reads WHERE agent_id=?").get(agentId)?.last_seq ?? 0;
    // LIMIT limit+1 detects overflow without materializing the whole backlog;
    // SQLite treats LIMIT -1 as unlimited.
    let rows = db
      .prepare(`SELECT seq, ts, workspace_id, from_agent, to_agent, body FROM messages WHERE ${UNREAD_WHERE} ORDER BY seq ASC LIMIT ?`)
      .all(...unreadArgs(last, agentId, workspaceId), limit > 0 ? limit + 1 : -1);
    let remaining = 0;
    let remainingDirected = 0;
    if (limit > 0 && rows.length > limit) {
      rows = rows.slice(0, limit);
      // to_agent IS NOT NULL is "directed to me" here — UNREAD_WHERE already
      // restricted to_agent to NULL-or-me.
      const rest = db
        .prepare(`SELECT COUNT(*) c, COALESCE(SUM(to_agent IS NOT NULL),0) d FROM messages WHERE ${UNREAD_WHERE}`)
        .get(...unreadArgs(rows[rows.length - 1].seq, agentId, workspaceId));
      remaining = rest?.c ?? 0;
      remainingDirected = rest?.d ?? 0;
    }
    if (advance && rows.length) {
      db.prepare("INSERT INTO message_reads(agent_id,last_seq) VALUES(?,?) ON CONFLICT(agent_id) DO UPDATE SET last_seq=excluded.last_seq").run(agentId, rows[rows.length - 1].seq);
    }
    return { messages: rows, remaining, remainingDirected };
  });
}

// Delivery candidates WITHOUT consuming them — the read half of a peek/ack pair.
//
// readMessages above decides "what you get" and "what's now read" in one step,
// which is right for a caller that renders everything it is handed. A hook can't:
// it has a hard byte budget (see lib/budget.mjs) and only discovers how many
// bodies fit AFTER rendering them. Consuming first meant every message past the
// budget was marked read and then dropped on the floor — silently. So a hook
// peeks, fits, then acks exactly the prefix it actually delivered.
//
// Returns `rows` (the oldest `limit` unread, seq ASC) plus `stranded`: directed
// messages sitting BEHIND that window. Delivery is a single seq watermark, so a
// message addressed to this agent can otherwise be stuck behind a broadcast
// backlog for several events; it gets pulled forward instead. `unfetched` is how
// many unread rows neither list covers — the ack must never step over those.
export function peekUnread(db, { agentId, workspaceId, limit = 0, directedLookahead = 0 }) {
  const last = db.prepare("SELECT last_seq FROM message_reads WHERE agent_id=?").get(agentId)?.last_seq ?? 0;
  const args = unreadArgs(last, agentId, workspaceId);
  const rows = db
    .prepare(`SELECT seq, ts, workspace_id, from_agent, to_agent, body FROM messages WHERE ${UNREAD_WHERE} ORDER BY seq ASC LIMIT ?`)
    .all(...args, limit > 0 ? limit : -1);
  if (!rows.length) return { rows: [], stranded: [], total: 0, totalDirected: 0, unfetched: 0, windowEnd: last };
  const tot = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(to_agent IS NOT NULL),0) d FROM messages WHERE ${UNREAD_WHERE}`).get(...args);
  const windowEnd = rows[rows.length - 1].seq;
  const stranded =
    directedLookahead > 0 && (tot?.c ?? 0) > rows.length
      ? db
          .prepare(`SELECT seq, ts, workspace_id, from_agent, to_agent, body FROM messages WHERE ${UNREAD_WHERE} AND to_agent IS NOT NULL AND seq>? ORDER BY seq ASC LIMIT ?`)
          .all(...args, windowEnd, directedLookahead)
      : [];
  return {
    rows,
    stranded,
    total: tot?.c ?? rows.length,
    totalDirected: tot?.d ?? 0,
    unfetched: Math.max(0, (tot?.c ?? rows.length) - rows.length - stranded.length),
    windowEnd,
  };
}

// The ack half: mark everything up to and including `seq` read. Monotonic — a
// concurrent event that already delivered further can never be walked backwards,
// which would re-deliver messages an agent has seen.
export function ackMessages(db, { agentId, seq }) {
  if (!seq) return;
  return writeTxn(db, () =>
    db
      .prepare("INSERT INTO message_reads(agent_id,last_seq) VALUES(?,?) ON CONFLICT(agent_id) DO UPDATE SET last_seq=MAX(message_reads.last_seq, excluded.last_seq)")
      .run(agentId, seq),
  );
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
  return db.prepare(`SELECT COUNT(*) c FROM messages WHERE ${UNREAD_WHERE}`).get(...unreadArgs(last, agentId, workspaceId))?.c ?? 0;
}
