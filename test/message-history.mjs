// A new worker needs current coordination, not a replay of the archive.
import assert from "node:assert/strict";
import { getDb, isoAgoMs, writeTxn } from "../lib/store.mjs";
import { ensureAgent, markDead } from "../lib/agents.mjs";
import { postMessage, readMessages, unreadCount } from "../lib/messages.mjs";
import { midTurnContext } from "../lib/coord-context.mjs";
import { buildRoomBrief } from "../lib/room-brief.mjs";
import { searchRecords } from "../lib/search.mjs";
import { workspaceId } from "../lib/path-canon.mjs";

const db = getDb();
const repo = "/t/message-history";
const ws = workspaceId(repo);
const reader = "history-reader";
const gone = "history-gone";
const live = "history-live";
for (const agentId of [reader, gone, live]) ensureAgent(db, { agentId, repoPath: repo, branch: "main" });
writeTxn(db, () => db.prepare("UPDATE agents SET registered_at=? WHERE agent_id=?").run(isoAgoMs(60_000), reader));
const old = isoAgoMs(2 * 24 * 60 * 60 * 1000);
const send = (fromAgent, body, options = {}, historical = true) => {
  const result = postMessage(db, { fromAgent, workspaceId: ws, body, ...options });
  if (historical) writeTxn(db, () => db.prepare("UPDATE messages SET ts=? WHERE seq=?").run(old, result.lastInsertRowid));
};
for (let i = 0; i < 774; i++) send(gone, `archiveprobe ${i}: previous release is complete`);
send(live, "[LIVE-HOLD] shared release is still running");
send(`${live}/worker`, "[LIVE-SUB] parent still owns this work");
send(gone, "[DIRECT] preserve this handoff", { toAgent: reader, workspaceId: "different-room" });
send(gone, "[CURRENT] completed after you joined", {}, false);
send(gone, "[OTHER-ROOM] hidden", { workspaceId: "different-room" }, false);
send(reader, "[SELF] hidden", {}, false);
send(gone, "[EXPIRED] hidden", { ttlSec: -1 }, false);
markDead(db, gone);
const stored = db.prepare("SELECT COUNT(*) n FROM messages").get().n;

assert.equal(unreadCount(db, { agentId: reader, workspaceId: ws }), 4, "pre-session inactive broadcasts are history, not inbox");
const first = readMessages(db, { agentId: reader, workspaceId: ws, limit: 2, advance: false });
assert.equal(first.messages.length, 2);
assert.equal(first.remaining, 2);
assert.equal(first.remainingDirected, 1);
const context = midTurnContext(db, { agentId: reader, workspaceId: ws });
for (const marker of ["LIVE-HOLD", "LIVE-SUB", "DIRECT", "CURRENT"]) assert.ok(context.includes(marker), marker);
for (const marker of ["archiveprobe", "OTHER-ROOM", "SELF", "EXPIRED"]) assert.ok(!context.includes(marker), marker);
assert.equal(unreadCount(db, { agentId: reader, workspaceId: ws }), 0);
assert.equal(midTurnContext(db, { agentId: reader, workspaceId: ws }), null, "no replay on the next event");
assert.equal(db.prepare("SELECT COUNT(*) n FROM messages").get().n, stored, "history is never deleted");
assert.ok(searchRecords(db, { workspaceId: ws, query: "archiveprobe", kinds: ["message"], limit: 2 }).length > 0, "history remains searchable");
assert.ok(buildRoomBrief(db, { agentId: reader, workspaceId: ws, repoRoot: repo }).includes("search"));

// A resumed session retains messages sent during its original lifetime.
ensureAgent(db, { agentId: "history-resumed", repoPath: repo });
writeTxn(db, () => db.prepare("UPDATE agents SET registered_at=? WHERE agent_id=?").run(isoAgoMs(3 * 24 * 60 * 60 * 1000), "history-resumed"));
markDead(db, "history-resumed");
ensureAgent(db, { agentId: "history-resumed", repoPath: repo });
assert.ok(unreadCount(db, { agentId: "history-resumed", workspaceId: ws }) >= 774, "resuming must not reset the inbox boundary");
assert.ok(unreadCount(db, { agentId: "unregistered-reader", workspaceId: ws }) >= 774, "missing registration must preserve delivery");
console.log(JSON.stringify({ historicalBroadcasts: 774, actionableMessages: 4, deliveredBytes: Buffer.byteLength(context), nextEvent: "silent", history: "searchable", resumedSession: "preserved" }));
