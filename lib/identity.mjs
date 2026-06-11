import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Speakable, single-word agent names. Words are deliberately common,
// easy-to-say English — the operator often addresses agents through voice
// transcription — and the list must stay in sync with tier0/lib/identity.mjs
// so both tiers name a session identically.
//
// A small pool makes pure-hash collisions likely, and a collision silently
// merges two sessions' locks. So a name is CLAIMED, not hashed: the session's
// first resolve claims a free name under <COORD_HOME>/names/ (deterministic
// starting point + linear probe, create-exclusive so two sessions can't win
// the same name), later resolves return the same claim and keep it warm, and
// a claim recycles after NAME_TTL_MS of silence. If the names dir is
// unreachable we fail open to the deterministic hash pick.
const NAMES = [
  "fox", "wolf", "bear", "hawk", "owl", "deer", "duck", "frog",
  "crab", "seal", "goat", "horse", "mouse", "otter", "rabbit", "tiger",
  "lion", "panda", "eagle", "shark", "whale", "snake", "swan", "crow",
  "robin", "badger", "beaver", "bison", "camel", "dolphin", "falcon", "gecko",
  "koala", "llama", "monkey", "moose", "penguin", "turtle", "zebra", "puma",
  "rhino", "hippo", "gorilla", "jaguar", "leopard", "cheetah", "donkey", "ferret",
  "heron", "lobster", "octopus", "parrot", "pelican", "pigeon", "pony", "raccoon",
  "salmon", "sparrow", "squid", "toad", "trout", "walrus", "weasel", "yak",
];

const NAME_TTL_MS = 24 * 3600 * 1000;

// Override with AGENT_COORD_HOME to relocate the store (used by the test harness
// to stay off the live DB, and handy for moving the store off a synced drive).
export const COORD_HOME = process.env.AGENT_COORD_HOME || join(homedir(), ".agent-coord");

export function agentIdFromSession(sessionId) {
  const h = createHash("sha256").update(String(sessionId || "unknown")).digest();
  const start = h.readUInt16BE(0) % NAMES.length;
  const key = h.toString("hex").slice(0, 16);
  try {
    const dir = join(COORD_HOME, "names");
    mkdirSync(dir, { recursive: true });
    const now = new Date();
    for (let i = 0; i < NAMES.length; i++) {
      const name = NAMES[(start + i) % NAMES.length];
      const f = join(dir, name + ".json");
      try {
        writeFileSync(f, JSON.stringify({ session: key }), { flag: "wx" });
        return name;
      } catch {}
      try {
        const st = statSync(f);
        let owner = null;
        try {
          owner = JSON.parse(readFileSync(f, "utf8")).session;
        } catch {}
        if (owner === key) {
          try {
            utimesSync(f, now, now); // keep the claim warm
          } catch {}
          return name;
        }
        if (Date.now() - st.mtimeMs > NAME_TTL_MS) {
          writeFileSync(f, JSON.stringify({ session: key }));
          return name;
        }
      } catch {}
    }
  } catch {}
  // Pool exhausted or store unreachable — deterministic fallback, collision-
  // possible but never blocking.
  return NAMES[start];
}

// Resolve the coordination identity from a hook payload. Claude subagent tool
// calls carry a stable `agent_id` (+ `agent_type`) that the parent's calls lack
// — so each concurrent subagent gets its own identity (and locks against its
// siblings), instead of all collapsing onto the parent session.
export function resolveAgentId(input) {
  const base = agentIdFromSession(input?.session_id || "unknown");
  if (!input?.agent_id) return base;
  const type = String(input.agent_type || "sub").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 12) || "sub";
  const tag = String(input.agent_id).replace(/[^a-z0-9]/gi, "").slice(-6) || "0";
  return `${base}/${type}-${tag}`;
}
