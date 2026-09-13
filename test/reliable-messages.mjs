import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

process.env.AGENT_COORD_HOME ||= mkdtempSync(join(tmpdir(), "coord-reliable-msg-"));
const { getDb } = await import("../lib/store.mjs");
const { reap } = await import("../lib/reaper.mjs");
const { ensureAgent, markDead } = await import("../lib/agents.mjs");
const {
  postMessage,
  readMessages,
  postReliableMessage,
  receiveReliableMessages,
  acknowledgeReliableMessages,
  reliableMessageStatus,
  currentReliableMessage,
  markReliableMessagesOffered,
} = await import("../lib/messages.mjs");
const { prepareMidTurnContext, markPreparedContextOffered } = await import("../lib/coord-context.mjs");

const db = getDb();
const ws = "reliable-ws-" + process.pid;
const sender = "reliable-sender-" + process.pid;
const recipient = "reliable-recipient-" + process.pid;
ensureAgent(db, { agentId: sender, repoPath: "/sender" });
ensureAgent(db, { agentId: recipient, repoPath: "/recipient" });

const messageId = "7fd5d6b8-85b7-4ca5-a237-7b09c8ab9a31";
const body = "STOP\nHANDOFF {\"owner\":\"nobody\"}\nПривет";
const first = postReliableMessage(db, { messageId, fromAgent: sender, toAgent: recipient, workspaceId: ws, body });
assert.equal(currentReliableMessage(db, { recipientAgent: recipient }).message_id, messageId);
const cli = spawnSync(process.execPath, [
  fileURLToPath(new URL("../cli/reliable-current.mjs", import.meta.url)), "--recipient", recipient,
], { env: process.env, encoding: "utf8" });
assert.equal(cli.status, 0, cli.stderr);
const cliCurrent = JSON.parse(cli.stdout);
assert.equal(cliCurrent.version, "agent-coord/reliable-current/v1");
assert.equal(cliCurrent.available, true);
assert.equal(cliCurrent.current.message_id, messageId);
assert.equal(cliCurrent.current.body, body);
const oldHome = mkdtempSync(join(tmpdir(), "coord-old-store-"));
const oldDb = new DatabaseSync(join(oldHome, "state.db"));
oldDb.exec("CREATE TABLE messages(seq INTEGER PRIMARY KEY, body TEXT)");
oldDb.close();
const oldCli = spawnSync(process.execPath, [
  fileURLToPath(new URL("../cli/reliable-current.mjs", import.meta.url)), "--recipient", recipient,
], { env: { ...process.env, AGENT_COORD_HOME: oldHome }, encoding: "utf8" });
assert.equal(oldCli.status, 0, oldCli.stderr);
assert.deepEqual(JSON.parse(oldCli.stdout), {
  version: "agent-coord/reliable-current/v1", available: false, current: null,
});
markDead(db, recipient);
const retry = postReliableMessage(db, { messageId, fromAgent: sender, toAgent: recipient, workspaceId: ws + "-after-cd", body });
ensureAgent(db, { agentId: recipient, repoPath: "/recipient" });
assert.equal(first.message_id, messageId);
assert.equal(first.state, "pending");
assert.equal(retry.message_id, messageId);
assert.equal(retry.deduplicated, true);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reliable_messages WHERE message_id=?").get(messageId).n, 1);
assert.throws(
  () => postReliableMessage(db, { messageId, fromAgent: sender, toAgent: recipient, workspaceId: ws, body: body + "!" }),
  /IDEMPOTENCY_CONFLICT/,
);
const offered = receiveReliableMessages(db, { agentId: recipient, sessionToken: "recipient-session", limit: 5 });
assert.equal(offered.length, 1);
assert.equal(offered[0].message_id, messageId);
assert.equal(offered[0].body, body);
assert.match(offered[0].attempt_id, /^[0-9a-f-]{36}$/);
assert.equal(reliableMessageStatus(db, { agentId: sender, messageId }).state, "leased");

// Crash after receive: once the old lease is stale, the same logical message is
// replayed with a fresh attempt. The stale process cannot ACK the new attempt.
db.prepare("UPDATE reliable_messages SET lease_until='2000-01-01T00:00:00.000Z' WHERE message_id=?").run(messageId);
const replayed = receiveReliableMessages(db, { agentId: recipient, sessionToken: "recipient-resumed", limit: 5 });
assert.equal(replayed.length, 1);
assert.equal(replayed[0].message_id, messageId);
assert.equal(replayed[0].body, body);
assert.notEqual(replayed[0].attempt_id, offered[0].attempt_id);

assert.throws(
  () => acknowledgeReliableMessages(db, { agentId: recipient, sessionToken: "recipient-session", acknowledgements: [{
    message_id: messageId, attempt_id: offered[0].attempt_id, payload_sha256: first.payload_sha256,
  }] }),
  /STALE_DELIVERY_ATTEMPT/,
);
const ack = acknowledgeReliableMessages(db, {
  agentId: recipient,
  sessionToken: "recipient-resumed",
  acknowledgements: [{ message_id: messageId, attempt_id: replayed[0].attempt_id, payload_sha256: first.payload_sha256 }],
});
assert.deepEqual(ack, [messageId]);
const done = reliableMessageStatus(db, { agentId: sender, messageId });
assert.equal(done.state, "confirmed");
assert.equal(done.confirmed_via, "explicit-ack");
db.prepare("UPDATE reliable_messages SET expires_at='2000-01-01T00:00:00.000Z' WHERE message_id=?").run(messageId);
const agedDone = reliableMessageStatus(db, { agentId: sender, messageId });
assert.equal(agedDone.state, "confirmed");
assert.equal(agedDone.body, null);
assert.throws(() => reliableMessageStatus(db, { agentId: "stranger", messageId }), /MESSAGE_STATUS_FORBIDDEN/);

const hookId = "9ba44706-3dda-4a25-8d79-76bc06c99fb9";
postReliableMessage(db, { messageId: hookId, fromAgent: sender, toAgent: recipient, workspaceId: ws, body: "hook body" });
const hookOffer = receiveReliableMessages(db, { agentId: recipient, sessionToken: "hook-session", limit: 1 });
assert.equal(hookOffer[0].message_id, hookId);
assert.equal(markReliableMessagesOffered(db, {
  agentId: recipient, sessionToken: "hook-session", eventId: "event-1", messages: hookOffer,
}), 1);
assert.throws(() => acknowledgeReliableMessages(db, {
  agentId: recipient, sessionToken: "hook-session", acknowledgements: [{ message_id: hookId, attempt_id: hookOffer[0].attempt_id }],
}), /STALE_DELIVERY_ATTEMPT/);
acknowledgeReliableMessages(db, {
  agentId: recipient, sessionToken: "hook-session",
  acknowledgements: [{ message_id: hookId, attempt_id: hookOffer[0].attempt_id, payload_sha256: hookOffer[0].payload_sha256 }],
});
assert.equal(reliableMessageStatus(db, { agentId: sender, messageId: hookId }).confirmed_via, "explicit-ack");

// Reliable delivery gets the next hook boundary, but legacy mail remains unread
// and arrives normally afterwards.
const mixedRecipient = "reliable-mixed-recipient-" + process.pid;
ensureAgent(db, { agentId: mixedRecipient, repoPath: "/mixed-recipient" });
postMessage(db, { fromAgent: sender, toAgent: mixedRecipient, workspaceId: ws, body: "legacy survives" });
const mixedId = "f3f10ea5-5180-4c80-87c7-838a450efea4";
postReliableMessage(db, { messageId: mixedId, fromAgent: sender, toAgent: mixedRecipient, workspaceId: ws, body: "reliable first" });
const mixed = prepareMidTurnContext(db, {
  agentId: mixedRecipient, sessionToken: "mixed-session", workspaceId: ws,
});
assert.match(mixed.text, /reliable first/);
assert.doesNotMatch(mixed.text, /legacy survives/);
assert.equal(markPreparedContextOffered(db, mixed), 1);
assert.deepEqual(
  readMessages(db, { agentId: mixedRecipient, workspaceId: ws }).messages.map((message) => message.body),
  ["legacy survives"],
);

const clippedId = "420a2ef0-a682-45f3-a13f-f75133618406";
postReliableMessage(db, { messageId: clippedId, fromAgent: sender, toAgent: recipient, workspaceId: ws, body: "must remain pending" });
const clipped = prepareMidTurnContext(db, { agentId: recipient, sessionToken: "clip-session", workspaceId: ws, budget: 24 });
assert.equal(markPreparedContextOffered(db, clipped), 0);
assert.equal(reliableMessageStatus(db, { agentId: sender, messageId: clippedId }).state, "pending");
assert.throws(() => postReliableMessage(db, {
  messageId: "676496f4-3947-42a2-a197-3ee46f2eaa1f", fromAgent: sender, toAgent: recipient,
  workspaceId: ws, body: "\u0000".repeat(2000),
}), /RELIABLE_MESSAGE_TOO_LARGE/);

const raceId = "bc7427d2-853f-4c74-a00a-73513df63447";
const raceRecipient = "reliable-race-recipient-" + process.pid;
ensureAgent(db, { agentId: raceRecipient, repoPath: "/race-recipient" });
postReliableMessage(db, { messageId: raceId, fromAgent: sender, toAgent: raceRecipient, workspaceId: ws, body: "one active attempt" });
const claim = () => new Promise((resolve, reject) => {
  const code = `import {getDb} from './lib/store.mjs';import {receiveReliableMessages} from './lib/messages.mjs';` +
    `console.log(receiveReliableMessages(getDb(),{agentId:'${raceRecipient}',sessionToken:'race-session',limit:1}).length);`;
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", code], { env: process.env });
  let out = "", err = "";
  child.stdout.on("data", (chunk) => out += chunk);
  child.stderr.on("data", (chunk) => err += chunk);
  child.on("error", reject);
  child.on("exit", (status) => status === 0 ? resolve(out.trim()) : reject(new Error(err)));
});
const claims = await Promise.all(Array.from({ length: 8 }, claim));
assert.equal(claims.filter((n) => n === "1").length, 1);
assert.equal(claims.filter((n) => n === "0").length, 7);

const expiredId = "f91705da-a8ff-4f97-a83a-fd689162b463";
postReliableMessage(db, { messageId: expiredId, fromAgent: sender, toAgent: recipient, workspaceId: ws, body: "expired receipt", ttlSec: -1 });
assert.equal(reliableMessageStatus(db, { agentId: sender, messageId: expiredId }).state, "expired");
assert.equal(reliableMessageStatus(db, { agentId: sender, messageId: expiredId }).body, null);
reap(db);
assert.equal(reliableMessageStatus(db, { agentId: sender, messageId: expiredId }).state, "expired");
assert.equal(db.prepare("SELECT body FROM reliable_messages WHERE message_id=?").get(expiredId).body, null);

// Terminal receipts survive their minimum 30-day window, then opportunistic
// cleanup can remove them.
const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reliable_messages WHERE message_id=?").get(messageId).n, 1);
db.prepare("UPDATE reliable_messages SET terminal_at=? WHERE message_id=?").run(daysAgo(29), messageId);
reap(db);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reliable_messages WHERE message_id=?").get(messageId).n, 1);
db.prepare("UPDATE reliable_messages SET terminal_at=? WHERE message_id=?").run(daysAgo(31), messageId);
reap(db);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reliable_messages WHERE message_id=?").get(messageId).n, 0);

// Message bodies are opaque. Merely delivering control-looking words cannot
// mutate presence or ownership state.
assert.equal(db.prepare("SELECT status FROM agents WHERE agent_id=?").get(recipient).status, "active");
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM file_leases").get().n, 0);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM resource_leases").get().n, 0);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, 0);

console.log("PASS reliable directed messages: exact retry, crash replay, exact ack, sender-visible status, opaque body");
