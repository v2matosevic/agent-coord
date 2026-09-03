// Workspace-scoped messaging: broadcast + directed delivery, read-once,
// cross-workspace isolation FOR BROADCASTS (a directed message crosses rooms),
// and no self-delivery.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate BEFORE importing modules that bind COORD_HOME: global broadcasts in
// the LIVE store deliver to every workspace, so an un-isolated run inherits
// whatever real agents posted that day (bit us 2026-06-10).
process.env.AGENT_COORD_HOME ||= mkdtempSync(join(tmpdir(), "coord-msg-"));
const { getDb, writeTxn, isoAgoMs } = await import("../lib/store.mjs");
const { ensureAgent, heartbeat } = await import("../lib/agents.mjs");
const { postMessage, readMessages, unreadCount, annotateSenders } = await import("../lib/messages.mjs");

const db = getDb();
const wsA = "msg-wsA-" + process.pid;
const wsB = "msg-wsB-" + process.pid;
const [A, B, C] = ["msg-a-" + process.pid, "msg-b-" + process.pid, "msg-c-" + process.pid];
const clean = () =>
  writeTxn(db, () => {
    db.prepare("DELETE FROM messages WHERE workspace_id IN (?,?)").run(wsA, wsB);
    db.prepare("DELETE FROM message_reads WHERE agent_id IN (?,?,?)").run(A, B, C);
    db.prepare("DELETE FROM agents WHERE agent_id IN (?,?,?)").run(A, B, C);
  });
clean();
for (const id of [A, B, C]) ensureAgent(db, { agentId: id, repoPath: "/t", branch: "m" });

postMessage(db, { fromAgent: A, workspaceId: wsA, body: "hello room" }); // broadcast in wsA
postMessage(db, { fromAgent: A, workspaceId: wsA, body: "hey B", toAgent: B }); // directed to B
postMessage(db, { fromAgent: C, workspaceId: wsB, body: "other repo" }); // different workspace
// ⭐ Directed from ANOTHER room (the 2-of-77 bug): C's server is pinned to wsB,
// B listens in wsA. `to:` must be enough.
postMessage(db, { fromAgent: C, workspaceId: wsB, body: "B, from the other repo", toAgent: B });

const bMsgs = readMessages(db, { agentId: B, workspaceId: wsA }).messages; // broadcast + directed + cross-room directed = 3
const aMsgs = readMessages(db, { agentId: A, workspaceId: wsA }).messages; // own messages excluded = 0
const bAgain = readMessages(db, { agentId: B, workspaceId: wsA }).messages; // already read = 0
const cUnread = unreadCount(db, { agentId: C, workspaceId: wsA }); // broadcast only (not directed-to-B) = 1
const aCross = unreadCount(db, { agentId: A, workspaceId: wsA }); // C's wsB broadcast stays fenced; C's directed-to-B is not A's = 0

clean();

// --- sender liveness annotation (BUG 2) ------------------------------------
// A backlog message's author may have EXITED; from_live must reflect CURRENT
// presence, and a since-exited subagent of a still-live session counts as present.
const wsL = "msg-live-" + process.pid;
const [LIVE, GONE, READER] = ["live-" + process.pid, "gone-" + process.pid, "rdr-" + process.pid];
const SUB = LIVE + "/explore-ab12"; // a subagent of LIVE's session
const cleanLive = () =>
  writeTxn(db, () => {
    db.prepare("DELETE FROM messages WHERE workspace_id=?").run(wsL);
    db.prepare("DELETE FROM message_reads WHERE agent_id=?").run(READER);
    db.prepare("DELETE FROM agents WHERE agent_id IN (?,?,?)").run(LIVE, GONE, SUB);
  });
cleanLive();
for (const id of [LIVE, GONE, SUB]) ensureAgent(db, { agentId: id, repoPath: "/t", branch: "m" });
heartbeat(db, LIVE); // fresh
heartbeat(db, SUB); // fresh — but we'll delete its row to prove base-fallback
writeTxn(db, () => db.prepare("UPDATE agents SET last_heartbeat=? WHERE agent_id=?").run(isoAgoMs(10 * 60 * 1000), GONE)); // exited (heartbeat 10m old > DEAD_MS)
postMessage(db, { fromAgent: LIVE, workspaceId: wsL, body: "I'm here" });
postMessage(db, { fromAgent: GONE, workspaceId: wsL, body: "was here hours ago" });
postMessage(db, { fromAgent: SUB, workspaceId: wsL, body: "subagent note" });
// Drop SUB's own row so its presence can only come from its live base (LIVE).
writeTxn(db, () => db.prepare("DELETE FROM agents WHERE agent_id=?").run(SUB));
const annotated = annotateSenders(db, readMessages(db, { agentId: READER, workspaceId: wsL }).messages);
const live = Object.fromEntries(annotated.map((m) => [m.from_agent, m.from_live]));
cleanLive();

const liveOk = live[LIVE] === true && live[GONE] === false && live[SUB] === true;

// --- capped, lossless batch reads -------------------------------------------
// A limited read must return at most `limit` messages, advance the pointer only
// past what it returned (backlog drains across calls, nothing skipped or
// redelivered), report the EXACT remainder itself, and flag when any of the
// remainder is a directed-to-me message stuck behind broadcasts (the urgent
// case callers must surface immediately).
const wsQ = "msg-cap-" + process.pid;
const [SND, RCV] = ["cap-s-" + process.pid, "cap-r-" + process.pid];
const cleanCap = () =>
  writeTxn(db, () => {
    db.prepare("DELETE FROM messages WHERE workspace_id=?").run(wsQ);
    db.prepare("DELETE FROM message_reads WHERE agent_id=?").run(RCV);
    db.prepare("DELETE FROM agents WHERE agent_id IN (?,?)").run(SND, RCV);
  });
cleanCap();
for (const id of [SND, RCV]) ensureAgent(db, { agentId: id, repoPath: "/t", branch: "m" });
for (let i = 1; i <= 4; i++) postMessage(db, { fromAgent: SND, workspaceId: wsQ, body: "m" + i });
postMessage(db, { fromAgent: SND, workspaceId: wsQ, body: "m5-yield", toAgent: RCV }); // directed, LAST in line
const batch1 = readMessages(db, { agentId: RCV, workspaceId: wsQ, limit: 2 });
const batch2 = readMessages(db, { agentId: RCV, workspaceId: wsQ, limit: 2 });
const batch3 = readMessages(db, { agentId: RCV, workspaceId: wsQ, limit: 2 });
const drained = unreadCount(db, { agentId: RCV, workspaceId: wsQ });
cleanCap();
const seen = [...batch1.messages, ...batch2.messages, ...batch3.messages].map((m) => m.body).join(",");
const capOk =
  batch1.messages.length === 2 && batch1.remaining === 3 && batch1.remainingDirected === 1 && // yield stuck behind broadcasts -> flagged
  batch2.messages.length === 2 && batch2.remaining === 1 && batch2.remainingDirected === 1 &&
  batch3.messages.length === 1 && batch3.remaining === 0 && batch3.remainingDirected === 0 && // final batch: nothing left
  drained === 0 && seen === "m1,m2,m3,m4,m5-yield";

const pass = bMsgs.length === 3 && aMsgs.length === 0 && bAgain.length === 0 && cUnread === 1 && aCross === 0 && liveOk && capOk;
console.log(`B sees ${bMsgs.length} (want 3, one cross-room) | A sees own ${aMsgs.length} (want 0) | B re-read ${bAgain.length} (want 0) | C unread ${cUnread} (want 1) | A cross ${aCross} (want 0)`);
console.log(`from_live: LIVE=${live[LIVE]} GONE=${live[GONE]} SUB(base-fallback)=${live[SUB]} (want true,false,true)`);
console.log(`capped reads: 2+2+1 in order, remaining ${batch1.remaining},${batch2.remaining},${batch3.remaining} (want 3,1,0), directed-flag ${batch1.remainingDirected},${batch2.remainingDirected},${batch3.remainingDirected} (want 1,1,0) -> ${capOk ? "ok" : "BROKEN: " + seen}`);
console.log(pass ? "PASS ✅ workspace-scoped, directed, read-once, no self-delivery, sender liveness, lossless capped reads" : "FAIL ❌");
process.exit(pass ? 0 : 1);
