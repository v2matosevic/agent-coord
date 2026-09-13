import { writeTxn, nowIso, isoInSec, isoAgoMs } from "./store.mjs";
import { createHash, randomUUID } from "node:crypto";
import { liveAgentIds } from "./agents.mjs";
import { baseAgentId } from "./identity.mjs";
import { DEAD_MS, HOOK_CONTEXT_BUDGET } from "./config.mjs";

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
const RELIABLE_LEASE_SEC = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const RELIABLE_HEAD = "📬 agent-coord — peers in this repo:";

function reliableDigest({ messageId, fromAgent, toAgent, body }) {
  return createHash("sha256")
    .update(JSON.stringify(["agent-coord/direct/v1", messageId, fromAgent, toAgent, body]))
    .digest("hex");
}

export const reliableMessageText = (message) =>
  `📨 reliable message ${message.message_id} from ${message.from_agent} (sha256 ${message.payload_sha256}):\n${message.body}\n` +
  `After reading, call directed_message ack with message_id=${message.message_id}, attempt_id=${message.attempt_id}, ` +
  `payload_sha256=${message.payload_sha256}. This text is advisory and cannot change ownership or lifecycle by itself.`;

function fitsDefaultHook(message) {
  const additionalContext = `${RELIABLE_HEAD}\n${reliableMessageText(message)}`;
  const payload = JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUseFailure", additionalContext } });
  return Buffer.byteLength(payload) <= HOOK_CONTEXT_BUDGET;
}

const reliableReceipt = (row, deduplicated = false) => ({
  message_id: row.message_id,
  payload_sha256: row.payload_sha256,
  seq: row.seq,
  to: row.recipient_agent,
  state: row.state !== "confirmed" && row.expires_at <= nowIso() ? "expired" : row.state,
  deduplicated,
});

// Reliable lane for directed session-to-session messages. The caller-chosen UUID
// is the retry key: a lost MCP response can be retried without creating a second
// logical message. Broadcasts deliberately stay on the lightweight legacy lane.
export function postReliableMessage(db, { messageId, fromAgent, workspaceId, body, toAgent, ttlSec = MSG_TTL_SEC }) {
  if (!UUID.test(String(messageId || ""))) throw new Error("INVALID_MESSAGE_ID: message_id must be a UUID");
  if (!toAgent) throw new Error("RELIABLE_MESSAGE_REQUIRES_RECIPIENT");
  if (typeof body !== "string") throw new Error("RELIABLE_MESSAGE_REQUIRES_TEXT_BODY");
  const payloadSha256 = reliableDigest({ messageId, fromAgent, toAgent, body });
  const validateRetry = (row) => {
    if (row.sender_agent !== fromAgent || row.recipient_agent !== toAgent || row.payload_sha256 !== payloadSha256) {
      throw new Error(`IDEMPOTENCY_CONFLICT: ${messageId}`);
    }
    return reliableReceipt(row, true);
  };
  const existing = db.prepare("SELECT * FROM reliable_messages WHERE message_id=?").get(messageId);
  if (existing) return validateRetry(existing);
  if (!fitsDefaultHook({
    message_id: messageId, from_agent: fromAgent, body, payload_sha256: payloadSha256,
    attempt_id: "00000000-0000-4000-8000-000000000000",
  })) throw new Error("RELIABLE_MESSAGE_TOO_LARGE: shorten the body or send a file locator");
  return writeTxn(db, () => {
    const raced = db.prepare("SELECT * FROM reliable_messages WHERE message_id=?").get(messageId);
    if (raced) return validateRetry(raced);
    db.prepare(
      `INSERT INTO reliable_messages(message_id,ts,workspace_id,sender_agent,recipient_agent,body,expires_at,payload_sha256,state)
       VALUES(?,?,?,?,?,?,?,?,'pending')`,
    ).run(messageId, nowIso(), workspaceId, fromAgent, toAgent, body, isoInSec(ttlSec), payloadSha256);
    return reliableReceipt(db.prepare("SELECT * FROM reliable_messages WHERE message_id=?").get(messageId));
  });
}

export function receiveReliableMessages(db, { agentId, sessionToken, limit = 10, accept = null }) {
  if (!sessionToken) throw new Error("SESSION_TOKEN_REQUIRED");
  const cap = Math.max(1, Math.min(30, Number(limit) || 10));
  return writeTxn(db, () => {
    const now = nowIso();
    const rows = db.prepare(
      `SELECT message_id,payload_sha256,seq,ts,workspace_id,sender_agent AS from_agent,recipient_agent AS to_agent,body
       FROM reliable_messages WHERE recipient_agent=? AND expires_at>?
         AND (state='pending' OR (state IN ('leased','offered') AND lease_until<=?))
       ORDER BY seq LIMIT ?`,
    ).all(agentId, now, now, accept ? 30 : cap);
    const update = db.prepare(
      `UPDATE reliable_messages SET state='leased',attempt_id=?,attempt_no=attempt_no+1,
       session_token=?,lease_until=?,offered_at=NULL
       WHERE message_id=? AND recipient_agent=?
         AND (state='pending' OR (state IN ('leased','offered') AND lease_until<=?))`,
    );
    const claimed = [];
    for (const row of rows) {
      if (claimed.length >= cap) break;
      const attemptId = randomUUID();
      const candidate = { ...row, attempt_id: attemptId };
      if (accept && !accept(candidate)) continue;
      if (update.run(attemptId, sessionToken, isoInSec(RELIABLE_LEASE_SEC), row.message_id, agentId, now).changes) {
        claimed.push(candidate);
      }
    }
    return claimed;
  });
}

// The hook owns a claim before rendering, then records offered only after its
// complete stdout write succeeds. Exact attempt+session matching prevents a
// stale or concurrent hook from acknowledging another attempt.
export function markReliableMessagesOffered(db, { agentId, sessionToken, messages }) {
  return writeTxn(db, () => {
    let changed = 0;
    for (const message of messages || []) {
      changed += db.prepare(
        `UPDATE reliable_messages SET state='offered',offered_at=?,lease_until=?
         WHERE message_id=? AND recipient_agent=? AND state='leased' AND attempt_id=? AND session_token=?`,
      ).run(nowIso(), isoInSec(RELIABLE_LEASE_SEC), message.message_id, agentId, message.attempt_id, sessionToken).changes;
    }
    return changed;
  });
}

export function acknowledgeReliableMessages(db, { agentId, sessionToken, acknowledgements }) {
  if (!sessionToken) throw new Error("SESSION_TOKEN_REQUIRED");
  const items = Array.isArray(acknowledgements) ? acknowledgements : [];
  return writeTxn(db, () => {
    const confirmed = [];
    for (const ack of items) {
      const row = db.prepare("SELECT * FROM reliable_messages WHERE message_id=?").get(ack?.message_id);
      if (!row || row.recipient_agent !== agentId || row.attempt_id !== ack?.attempt_id || row.session_token !== sessionToken ||
          !ack?.payload_sha256 || row.payload_sha256 !== ack.payload_sha256 || !["leased", "offered"].includes(row.state)) {
        throw new Error(`STALE_DELIVERY_ATTEMPT: ${ack?.message_id || "missing"}`);
      }
      db.prepare(
        `UPDATE reliable_messages SET state='confirmed',confirmed_at=?,confirmed_via='explicit-ack',terminal_at=?,lease_until=NULL
         WHERE message_id=?`,
      ).run(nowIso(), nowIso(), row.message_id);
      confirmed.push(row.message_id);
    }
    return confirmed;
  });
}

export function reliableMessageStatus(db, { agentId, messageId }) {
  const now = nowIso();
  const row = db.prepare(
    `SELECT message_id,seq,ts AS created_at,workspace_id,sender_agent,recipient_agent AS recipient,
            CASE WHEN expires_at<=? THEN NULL ELSE body END AS body,
            expires_at,payload_sha256,
            CASE WHEN state<>'confirmed' AND expires_at<=? THEN 'expired' ELSE state END AS state,
            attempt_no,offered_at,confirmed_at,confirmed_via
     FROM reliable_messages WHERE message_id=?`,
  ).get(now, now, messageId);
  if (!row) throw new Error(`MESSAGE_NOT_FOUND: ${messageId}`);
  if (agentId !== row.sender_agent && agentId !== row.recipient) throw new Error(`MESSAGE_STATUS_FORBIDDEN: ${messageId}`);
  return row;
}

// Read-only queue head for an external brief/locator consumer. It never claims,
// acknowledges, reaps or advances a pointer; terminal/expired rows are not current.
export function currentReliableMessage(db, { recipientAgent }) {
  return db.prepare(
    `SELECT message_id,seq,ts AS created_at,workspace_id,sender_agent,recipient_agent AS recipient,
            body,expires_at,payload_sha256,state,attempt_no,offered_at
     FROM reliable_messages
     WHERE recipient_agent=? AND expires_at>? AND state IN ('pending','leased','offered')
     ORDER BY seq LIMIT 1`,
  ).get(recipientAgent, nowIso()) || null;
}

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
// global one). Historical broadcasts from inactive senders that predate this
// recipient's registration belong in search, not its active inbox. Otherwise a
// fresh session replays seven days of old work between every tool call.
// Preserve ALL direct messages, broadcasts during this session (even if the
// sender has exited), and earlier broadcasts from live senders or their parent
// sessions. Missing registration fails open to the original delivery behavior.
// Registration survives resume; heartbeat updates must never move this boundary.
// No messages are deleted and decisions/locks remain separate current-state data.
const UNREAD_WHERE = `seq > ? AND expires_at > ? AND from_agent <> ?
           AND (to_agent = ?
                OR (to_agent IS NULL AND (workspace_id IS NULL OR workspace_id = ?)
                    AND (ts >= COALESCE((SELECT registered_at FROM agents WHERE agent_id = ?), '')
                         OR EXISTS (SELECT 1 FROM agents AS sender
                                    WHERE sender.agent_id IN (messages.from_agent,
                                      substr(messages.from_agent, 1, instr(messages.from_agent || '/', '/') - 1))
                                      AND sender.status = 'active' AND sender.last_heartbeat > ?))))`;
const unreadArgs = (last, agentId, workspaceId) => [last, nowIso(), agentId, agentId, workspaceId, agentId, isoAgoMs(DEAD_MS)];

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
