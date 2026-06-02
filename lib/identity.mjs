import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

// Human-memorable, deterministic agent names from the session id — same id maps
// to the same name in every hook, the statusline, and the CLI, with no shared
// mapping file.
const ADJECTIVES = [
  "amber", "jade", "ruby", "slate", "cobalt", "ivory", "umber", "onyx",
  "coral", "sage", "rust", "teal", "gilt", "ash", "cedar", "flint",
  "indigo", "crimson", "moss", "pewter",
];
const ANIMALS = [
  "fox", "wolf", "hawk", "lynx", "heron", "otter", "raven", "stag",
  "boar", "crane", "ibis", "viper", "gull", "marten", "bison", "egret",
  "wren", "shrike", "lark", "mole",
];

// Override with AGENT_COORD_HOME to relocate the store (used by the test harness
// to stay off the live DB, and handy for moving the store off a synced drive).
export const COORD_HOME = process.env.AGENT_COORD_HOME || join(homedir(), ".agent-coord");

export function agentIdFromSession(sessionId) {
  const h = createHash("sha256").update(String(sessionId || "unknown")).digest();
  const adj = ADJECTIVES[h[0] % ADJECTIVES.length];
  const animal = ANIMALS[h[1] % ANIMALS.length];
  const num = (h.readUInt16BE(2) % 9000) + 1000;
  return `${adj}-${animal}-${num}`;
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
