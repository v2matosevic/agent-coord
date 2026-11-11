// The unread check runs on every hook event, for every agent. Without an index
// on the recipient it walks the mailbox from the agent's read pointer, and an
// agent with no pointer yet (every fresh session) walks all seven days of it.
// idx_messages_to(to_agent, seq) turns both lanes of the unread predicate, and
// the reply lookup, into index searches. This pins the plan, the answers, and
// that a store created before the index gets it on the next open.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getDb, nowIso } from "../lib/store.mjs";
import { ensureAgent } from "../lib/agents.mjs";
import { UNREAD_WHERE, unreadArgs, postMessage, readMessages, peekUnread, unreadCount, findReplies } from "../lib/messages.mjs";

assert.ok(process.env.AGENT_COORD_HOME, "run through the isolated runner");
const __dir = dirname(fileURLToPath(import.meta.url));
const db = getDb();
const hasIndex = () => db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_messages_to'").get() !== undefined;
const plan = (sql, ...args) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((r) => r.detail);

assert.ok(hasIndex(), "a new store has the recipient index");

const [ME, PEER, OTHER] = ["inbox-me", "inbox-peer", "inbox-other"];
const [ROOM, ELSEWHERE] = ["inbox-room", "inbox-elsewhere"];
for (const id of [ME, PEER, OTHER]) ensureAgent(db, { agentId: id, repoPath: "/fixture", branch: "main" });

// Enough rows that a plan choice is about the shape of the query, not an empty table.
for (let i = 0; i < 40; i++) postMessage(db, { fromAgent: PEER, workspaceId: ELSEWHERE, body: `noise ${i}`, toAgent: OTHER });
postMessage(db, { fromAgent: PEER, workspaceId: ROOM, body: "room broadcast" });
postMessage(db, { fromAgent: PEER, workspaceId: ELSEWHERE, body: "other room broadcast" });
postMessage(db, { fromAgent: PEER, workspaceId: ELSEWHERE, body: "direct from another room", toAgent: ME });
postMessage(db, { fromAgent: PEER, workspaceId: ROOM, body: "answer [re:ask-1]", toAgent: ME });
postMessage(db, { fromAgent: ME, workspaceId: ROOM, body: "my own broadcast" });
postMessage(db, { fromAgent: PEER, workspaceId: ROOM, body: "expired direct", toAgent: ME, ttlSec: -60 });
postMessage(db, { fromAgent: PEER, workspaceId: null, scope: "global", body: "global broadcast" });

// Plan: both lanes of the unread predicate search the recipient index.
const probe = plan(`SELECT 1 FROM messages WHERE ${UNREAD_WHERE} LIMIT 1`, ...unreadArgs(0, ME, ROOM));
assert.ok(
  probe.filter((d) => d.includes("SEARCH messages USING INDEX idx_messages_to (to_agent=? AND seq>?)")).length >= 2,
  `unread probe walks the mailbox: ${probe.join(" | ")}`,
);
assert.ok(!probe.some((d) => d.includes("SCAN messages")), `unread probe scans: ${probe.join(" | ")}`);
const replies = plan("SELECT seq, ts, from_agent, body FROM messages WHERE to_agent=? AND body LIKE ? AND expires_at>? ORDER BY seq ASC", ME, "%[re:ask-1]%", nowIso());
assert.ok(replies.some((d) => d.includes("USING INDEX idx_messages_to (to_agent=?")), `reply lookup scans: ${replies.join(" | ")}`);

// Answers: the index changes how rows are found, never which or in what order.
const expected = ["room broadcast", "direct from another room", "answer [re:ask-1]", "global broadcast"];
assert.equal(unreadCount(db, { agentId: ME, workspaceId: ROOM }), expected.length);
const peek = peekUnread(db, { agentId: ME, workspaceId: ROOM, limit: 2, directedLookahead: 5 });
assert.deepEqual(peek.rows.map((m) => m.body), expected.slice(0, 2));
assert.deepEqual(peek.stranded.map((m) => m.body), ["answer [re:ask-1]"]);
assert.equal(peek.total, expected.length);
assert.equal(peek.totalDirected, 2);
assert.deepEqual(findReplies(db, { agentId: ME, askId: "ask-1" }).map((m) => m.body), ["answer [re:ask-1]"]);
const first = readMessages(db, { agentId: ME, workspaceId: ROOM, limit: 3 });
assert.deepEqual(first.messages.map((m) => m.body), expected.slice(0, 3));
assert.equal(first.remaining, 1);
assert.equal(first.remainingDirected, 0);
const rest = readMessages(db, { agentId: ME, workspaceId: ROOM });
assert.deepEqual(rest.messages.map((m) => m.body), expected.slice(3));
assert.equal(unreadCount(db, { agentId: ME, workspaceId: ROOM }), 0);
// With a read pointer the search starts past it.
postMessage(db, { fromAgent: PEER, workspaceId: ELSEWHERE, body: "later direct", toAgent: ME });
assert.deepEqual(readMessages(db, { agentId: ME, workspaceId: ROOM }).messages.map((m) => m.body), ["later direct"]);

// Upgrade: a store without the index (created by an older checkout, or one that
// lost it) is repaired by the next process that opens it.
db.exec("DROP INDEX idx_messages_to");
assert.ok(!hasIndex());
execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(__dir, "_open-store.mjs")], { stdio: "ignore" });
assert.ok(hasIndex(), "the next open restores the recipient index");

console.log("Unread checks and reply lookups search the recipient index, deliver the same messages in the same order, and an older store gains the index on open");
