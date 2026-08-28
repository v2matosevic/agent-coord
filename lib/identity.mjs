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

// Claude Code exports the session id into the environment of EVERY child it
// spawns — hooks, the Bash/PowerShell tool, git and its hooks, and each stdio
// MCP server. It is the one identity anchor every process of a session shares
// without a process-tree walk, a race, or a `--tool` flag: hash it the same way
// the hooks hash their payload's session_id and every path names the session
// identically. Null outside Claude (Codex, a bare shell), so callers fall back.
export function sessionIdFromEnv(env = process.env) {
  const v = env.CLAUDE_CODE_SESSION_ID;
  return v && String(v).trim() ? String(v).trim() : null;
}

// True when this process was spawned (at any depth) by a Claude Code session.
export function isClaudeChild(env = process.env) {
  return !!(sessionIdFromEnv(env) || env.CLAUDECODE);
}

// The hook identity of the session that spawned this process, or null.
export function agentIdFromEnv(env = process.env) {
  const sid = sessionIdFromEnv(env);
  return sid ? agentIdFromSession(sid) : null;
}

const sessionKey = (sessionId) => createHash("sha256").update(String(sessionId || "unknown")).digest();

// Pin a session id to an ALREADY-CLAIMED name. Used when a running Claude process
// changes its session id under us (/clear, in-TUI /resume): the terminal, its
// MCP server and the human all still see the same window, so it keeps the same
// name. The name's claim file is re-owned by the new session key (so it stays
// warm and can't be stolen), and a by-session pointer makes agentIdFromSession
// answer with it before probing — pure addition, so every existing session
// resolves exactly as before.
export function bindSessionName(sessionId, name) {
  if (!sessionId || !name) return false;
  try {
    const key = sessionKey(sessionId).toString("hex").slice(0, 16);
    const dir = join(COORD_HOME, "names");
    mkdirSync(join(dir, "by-session"), { recursive: true });
    writeFileSync(join(dir, name + ".json"), JSON.stringify({ session: key }));
    writeFileSync(join(dir, "by-session", key + ".json"), JSON.stringify({ name, ts: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

export function agentIdFromSession(sessionId) {
  const h = sessionKey(sessionId);
  const start = h.readUInt16BE(0) % NAMES.length;
  const key = h.toString("hex").slice(0, 16);
  try {
    const dir = join(COORD_HOME, "names");
    mkdirSync(dir, { recursive: true });
    const now = new Date();
    // A bound name (see bindSessionName) wins, as long as the claim still says
    // this session owns it — otherwise the pointer is stale and probing decides.
    try {
      const bound = JSON.parse(readFileSync(join(dir, "by-session", key + ".json"), "utf8")).name;
      if (bound && JSON.parse(readFileSync(join(dir, bound + ".json"), "utf8")).session === key) {
        try {
          utimesSync(join(dir, bound + ".json"), now, now);
        } catch {}
        return bound;
      }
    } catch {}
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

// The base (session) part of an agent id — everything before the first "/".
// A parent session is just "horse"; its subagents are "horse/explore-ab12".
// Same base == same Claude session family (parent + its subagents + siblings).
export function baseAgentId(agentId) {
  return String(agentId || "").split("/")[0];
}

// Resolve the coordination identity from a hook payload. Claude subagent tool
// calls carry a stable `agent_id` (+ `agent_type`) that the parent's calls lack
// — so each concurrent subagent gets its own identity (and locks against its
// siblings), instead of all collapsing onto the parent session.
//
// `opts.parentBase` pins the base to the PARENT session's claimed name. Claude
// does not guarantee a subagent's hook payload carries the parent's session_id —
// when it carries a different one, `agentIdFromSession` would claim a SEPARATE
// codename for the whole fan-out (e.g. parent "horse", subagents "goat/..."),
// making one session look like two and tripping duplicate-work stand-downs
// between an agent and its own siblings. Callers resolve the parent base from
// the session-link (see parentBaseFromProc) and pass it here so the family
// shares one base. Falls back to the session_id hash when no link is resolvable
// (no regression for Codex / no-hooks setups).
export function resolveAgentId(input, opts = {}) {
  if (!input?.agent_id) return agentIdFromSession(input?.session_id || "unknown");
  const base = baseAgentId(opts.parentBase) || agentIdFromSession(input?.session_id || "unknown");
  const type = String(input.agent_type || "sub").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 12) || "sub";
  const tag = String(input.agent_id).replace(/[^a-z0-9]/gi, "").slice(-6) || "0";
  return `${base}/${type}-${tag}`;
}
