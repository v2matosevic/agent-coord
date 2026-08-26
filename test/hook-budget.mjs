// Hook stdout vs Claude Code's 8192-byte cliff (issue i-77824feb).
//
// Claude Code persists any hook stdout over 8192 bytes to a temp file and shows
// the model only the first 2000 characters. Nothing exits non-zero, nothing
// warns. Mid-turn delivery ALSO advances the read pointer, so every message past
// that preview used to be marked read and lost to every agent, forever.
//
// This exercises the exact strings the hooks write — guard.mjs wraps its context
// in postToolContextJson (which JSON-escapes every newline, so the wire size is
// bigger than the string length), session.mjs writes the raw text plus "\n".
import { getDb, writeTxn } from "../lib/store.mjs";
import { ensureAgent } from "../lib/agents.mjs";
import { workspaceId } from "../lib/path-canon.mjs";
import { midTurnContext, postToolContextJson } from "../lib/coord-context.mjs";
import { postMessage, unreadCount } from "../lib/messages.mjs";
import { buildRoomBrief } from "../lib/room-brief.mjs";
import { MSG_DELIVER_MAX } from "../lib/config.mjs";

const CLIFF = 8192; // the hard limit in the Claude Code bundle — not ours to move
const bytes = (s) => Buffer.byteLength(s, "utf8");

const db = getDb();
const P = process.pid;
const repo = "/t/budget-" + P;
const ws = workspaceId(repo);
const SND = "bud-snd-" + P;
const RCV = "bud-rcv-" + P;
const DIR = "bud-dir-" + P;
const ids = [SND, RCV, DIR];

const clean = () =>
  writeTxn(db, () => {
    db.prepare(`DELETE FROM messages WHERE from_agent=?`).run(SND);
    db.prepare(`DELETE FROM message_reads WHERE agent_id IN (${ids.map(() => "?").join(",")})`).run(...ids);
    db.prepare(`DELETE FROM agents WHERE agent_id IN (${ids.map(() => "?").join(",")})`).run(...ids);
  });
clean();
for (const id of ids) ensureAgent(db, { agentId: id, repoPath: repo, branch: "main" });

// A realistic fat message: prose with word boundaries, so a truncator has
// somewhere to cut. 4 KB each — the field reports measured 12–28 KB payloads.
const FAT = "refactoring the billing pipeline and everything downstream of it ".repeat(64).slice(0, 4096);

const checks = {};
const sizes = [];
// Both hook write shapes, measured as the hook actually writes them.
const asPostTool = (ctx) => postToolContextJson(ctx, "PostToolUse");
const asStdout = (ctx) => ctx + "\n";
const record = (label, payload) => {
  sizes.push(`${label}=${bytes(payload)}B`);
  return bytes(payload) <= CLIFF;
};

// ── 1) 20 × 4 KB broadcasts: every write stays under the cliff ────────────────
for (let i = 1; i <= 20; i++) postMessage(db, { fromAgent: SND, workspaceId: ws, body: `[m${i}] ${FAT}` });
const unreadBefore = unreadCount(db, { agentId: RCV, workspaceId: ws });

const ctx1 = midTurnContext(db, { agentId: RCV, workspaceId: ws, wrap: asPostTool });
checks["PostToolUse write ≤ 8192B"] = !!ctx1 && record("posttool", asPostTool(ctx1));
checks["UserPromptSubmit write ≤ 8192B"] = !!ctx1 && record("stdout", asStdout(ctx1));

// ── 2) It says what it cut ───────────────────────────────────────────────────
const shortened = Number(/(\d+)\s+(?:message[s]?\s+)?shortened/.exec(ctx1 || "")?.[1] ?? 0);
const notShown = Number(/(\d+)\s+not shown/.exec(ctx1 || "")?.[1] ?? 0);
checks["says how many were shortened"] = shortened > 0;
checks["says how many were withheld"] = notShown > 0;
checks["counts add up to the backlog"] = unreadBefore === 20;

// ── 3) Withheld messages are STILL UNREAD, and arrive next event ─────────────
const unreadAfter = unreadCount(db, { agentId: RCV, workspaceId: ws });
checks["withheld stay unread"] = unreadAfter === notShown && unreadAfter > 0;
const ctx2 = midTurnContext(db, { agentId: RCV, workspaceId: ws, wrap: asPostTool });
checks["next event delivers more"] = !!ctx2 && record("posttool-2", asPostTool(ctx2));
checks["backlog drains, never grows"] = unreadCount(db, { agentId: RCV, workspaceId: ws }) < unreadAfter;
// Drain fully — a stuck pointer would spin here forever.
let guard = 0;
while (unreadCount(db, { agentId: RCV, workspaceId: ws }) > 0 && guard++ < 40) {
  const c = midTurnContext(db, { agentId: RCV, workspaceId: ws, wrap: asPostTool });
  if (c && !record("drain", asPostTool(c))) checks["PostToolUse write ≤ 8192B"] = false;
}
checks["backlog drains completely"] = guard < 40 && unreadCount(db, { agentId: RCV, workspaceId: ws }) === 0;

// ── 4) A directed message behind 15 broadcasts lands in the FIRST batch ──────
for (let i = 1; i <= MSG_DELIVER_MAX; i++) postMessage(db, { fromAgent: SND, workspaceId: ws, body: `[b${i}] ${FAT}` });
postMessage(db, { fromAgent: SND, workspaceId: ws, toAgent: DIR, body: "[URGENT-DIRECT] stand down on lib/auth please" });
const dirCtx = midTurnContext(db, { agentId: DIR, workspaceId: ws, wrap: asPostTool });
checks["directed msg jumps the broadcast queue"] = !!dirCtx && /URGENT-DIRECT/.test(dirCtx);
checks["directed batch write ≤ 8192B"] = !!dirCtx && record("directed", asPostTool(dirCtx));

// ── 5) Empty inbox stays silent ──────────────────────────────────────────────
const quiet = midTurnContext(db, { agentId: SND, workspaceId: ws, wrap: asPostTool });
checks["empty inbox produces no output"] = quiet === null;

// ── 6) The session-start room brief obeys the same cliff ─────────────────────
const brief = buildRoomBrief(db, { agentId: RCV, workspaceId: ws, repoRoot: repo });
checks["room brief write ≤ 8192B"] = !!brief && record("brief", asStdout(brief));
// Force the clamp with an absurd budget: the identity line must survive and the
// trim must announce itself (a brief that quietly loses its tail is the same
// silent failure one size down).
const tight = buildRoomBrief(db, { agentId: RCV, workspaceId: ws, repoRoot: repo, budget: 260, wrap: asStdout });
checks["room brief clamps and says so"] = bytes(asStdout(tight)) <= 260 && /you are /.test(tight) && /trimmed/.test(tight);

clean();

let ok = true;
for (const [k, v] of Object.entries(checks)) {
  if (!v) ok = false;
  console.log(`${v ? "✅" : "❌"} ${k}`);
}
console.log(`   sizes: ${sizes.join(" ")} (cliff ${CLIFF}B)`);
console.log(ok ? "PASS ✅ hook writes stay under the 8192B cliff, nothing delivered is lost" : "FAIL ❌");
process.exit(ok ? 0 : 1);
