import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { isoAgoMs, nowIso } from "./store.mjs";
import { COORD_HOME, baseAgentId } from "./identity.mjs";
import { workspaceId } from "./path-canon.mjs";
import { DEAD_MS, OVERLAP_THRESHOLD, OVERLAP_MIN_TOKENS, OVERLAP_NOTICE_COOLDOWN_MS, OVERLAP_ESCALATE_AFTER } from "./config.mjs";

// Duplicate-work detection — the gap behind the coral-mole standoff: two agents
// launched on one vague prompt each pick the SAME work, and the only collision
// point (file leases) fires too late and only blocks the loser without ever
// saying "you two are doing the same thing." This is a CHEAP lexical heuristic
// (NOT ML): tokenize each agent's task to significant words and Jaccard them.
// Same prompt -> ~1.0; genuinely different lanes -> low. The escape hatch is for
// agents to differentiate via announce_intent (which rewrites current_task), so
// a legit divide-the-work pair clears itself while true duplicates stay flagged.

const STOP = new Set([
  "this", "that", "with", "from", "into", "your", "await", "take", "look", "make", "have", "will",
  "them", "they", "what", "when", "here", "there", "then", "than", "some", "more", "most", "also",
  "just", "like", "over", "need", "want", "both", "were", "been", "being", "does", "done", "each",
  "very", "much", "such", "only", "other", "which", "while", "about", "after", "before", "could",
  "would", "should", "their", "these", "those", "going", "lets", "trying", "fix", "fixing", "work",
  "working", "help", "code", "system", "issue", "issues", "improve", "better", "thing", "things",
]);

// Host-harness context prepended to a user prompt is not the user's task.
// Hephaestus/ADE sends "[Hephaestus] Local time: 2026-08-26 20:47:54 +02:00
// (Wednesday). Treat this as the current moment; it is host context, not part
// of the user's message." before the real text. Match the shape — a bracketed
// harness tag, "Local time:", then everything up to the end of the "host
// context" sentence (or the timestamp sentence when that tail is absent) — so a
// stored task from a pre-fix hook is neutralized on read as well as on write.
const PREAMBLE_HEAD = String.raw`^\s*\[[^\]\n]{1,40}\]\s*Local time:[^\n]*?`;
// Longest tail first — an alternation would stop at the earliest match (the
// weekday) and leave "Treat this as the current moment…" behind as the task.
const PREAMBLE_RES = [
  new RegExp(PREAMBLE_HEAD + String.raw`not part of the user'?s message\.?\s*`, "i"),
  new RegExp(PREAMBLE_HEAD + String.raw`current moment[;.]?\s*(?:it is host context[^.]*\.?)?\s*`, "i"),
  new RegExp(PREAMBLE_HEAD + String.raw`\([A-Za-z]+\)\.\s*(?:treat this as[^.;]*[.;]?)?\s*`, "i"),
];
export function stripHarnessPreamble(s) {
  s = String(s || "");
  for (const re of PREAMBLE_RES) {
    if (re.test(s)) return s.replace(re, "");
  }
  return s;
}

export function taskTokens(s) {
  return new Set(
    stripHarnessPreamble(s)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOP.has(w)),
  );
}

// Jaccard similarity of two task strings (or pre-tokenized Sets).
export function taskSimilarity(a, b) {
  const A = a instanceof Set ? a : taskTokens(a);
  const B = b instanceof Set ? b : taskTokens(b);
  if (A.size < OVERLAP_MIN_TOKENS || B.size < OVERLAP_MIN_TOKENS) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

// Live peers in MY workspace whose current task overlaps mine, each tagged with
// whether I started LATER (the deterministic tiebreaker for who should yield:
// later-starter stands down; exact-tie broken by agent_id so both agents agree).
export function findOverlappingPeers(db, { agentId, workspaceId: ws, task, threshold = OVERLAP_THRESHOLD }) {
  const myTokens = taskTokens(task);
  if (myTokens.size < OVERLAP_MIN_TOKENS) return [];
  const myReg = db.prepare("SELECT registered_at FROM agents WHERE agent_id=?").get(agentId)?.registered_at || nowIso();
  // A peer's announced intent beats its raw prompt text — prompts are noisy
  // (resume boilerplate, vague one-liners) while an intent is a deliberate
  // declaration of lane.
  const rows = db
    .prepare(
      `SELECT agent_id, COALESCE(intent, current_task) AS task, registered_at, repo_path FROM agents
       WHERE status='active' AND last_heartbeat > ? AND agent_id <> ?`,
    )
    .all(isoAgoMs(DEAD_MS), agentId);

  const myBase = baseAgentId(agentId);
  const out = [];
  for (const r of rows) {
    if (!r.repo_path || workspaceId(r.repo_path) !== ws) continue;
    // Never flag my own session family (parent, siblings, children share a base):
    // a fan-out of subagents all run the umbrella task, which is collaboration,
    // not duplicate work. Cross-session peers (different base) still flag.
    if (baseAgentId(r.agent_id) === myBase) continue;
    const sim = taskSimilarity(myTokens, taskTokens(r.task));
    if (sim < threshold) continue;
    const peerReg = r.registered_at || "";
    const iStartedLater = myReg > peerReg || (myReg === peerReg && agentId > r.agent_id);
    out.push({ agentId: r.agent_id, task: r.task, sim: Math.round(sim * 100) / 100, registeredAt: peerReg, iStartedLater });
  }
  return out.sort((a, b) => b.sim - a.sim);
}

// Peer(s) I should defer to — overlapping AND started before me. If this is
// non-empty I'm the duplicate; differentiate (announce_intent) or stand down.
export function earlierOverlappingPeers(db, args) {
  return findOverlappingPeers(db, args).filter((p) => p.iStartedLater);
}

// --- soft-advisory rate limiting + escalation counter -----------------------
// The advisory recomputes every edit, so without a throttle it would spam. We
// stamp a per-agent marker and only re-emit past the cooldown; the count of
// stamps is the escalation signal (after N advisories the later-starter's
// pre-edit guard hard-blocks — "advisory then escalate").

const NOTICE_DIR = join(COORD_HOME, "overlap-notices");
const noticeFile = (agentId) => join(NOTICE_DIR, encodeURIComponent(agentId) + ".json");

function readNotice(agentId) {
  try {
    return JSON.parse(readFileSync(noticeFile(agentId), "utf8"));
  } catch {
    return { count: 0, last: 0 };
  }
}

// Returns true (and stamps) if it's time to surface the advisory again; false
// while still inside the cooldown window. `count` accumulates across the task.
export function shouldNotifyOverlap(agentId, cooldownMs = OVERLAP_NOTICE_COOLDOWN_MS) {
  const n = readNotice(agentId);
  const now = Date.now();
  if (now - (n.last || 0) < cooldownMs) return false;
  try {
    mkdirSync(NOTICE_DIR, { recursive: true });
    writeFileSync(noticeFile(agentId), JSON.stringify({ count: (n.count || 0) + 1, last: now }));
  } catch {}
  return true;
}

// How many advisories this agent has already been shown (drives escalation).
export function overlapAdvisoryCount(agentId) {
  return readNotice(agentId).count || 0;
}

// Reset when the overlap clears (agent differentiated, or peer went away) so a
// later, unrelated overlap starts its escalation count fresh.
export function clearOverlapNotice(agentId) {
  try {
    writeFileSync(noticeFile(agentId), JSON.stringify({ count: 0, last: 0 }));
  } catch {}
}

// The escalation gate ("advisory then escalate"): the later-starter's
// OWN pre-edit guard hard-blocks once it has ignored enough advisories while the
// overlap with an earlier peer persists. Returns the peer to defer to, or null
// if not time to block (no overlap, I'm the earlier starter, or count too low).
// Reads current_task from the store so the caller only needs ids.
export function overlapHardBlock(db, { agentId, workspaceId: ws, threshold = OVERLAP_ESCALATE_AFTER }) {
  const task = db.prepare("SELECT COALESCE(intent, current_task) AS task FROM agents WHERE agent_id=?").get(agentId)?.task;
  if (!task) return null;
  if (overlapAdvisoryCount(agentId) < threshold) return null;
  return earlierOverlappingPeers(db, { agentId, workspaceId: ws, task })[0] || null;
}
