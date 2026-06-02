import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

// Human-memorable, deterministic agent names derived from the session id.
// Same session id -> same name across every hook + the statusline, with no
// shared mapping file (stateless).
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

export const COORD_HOME = join(homedir(), ".agent-coord");
export const PRESENCE_DIR = join(COORD_HOME, "presence");

export function agentIdFromSession(sessionId) {
  const h = createHash("sha256").update(String(sessionId || "unknown")).digest();
  const adj = ADJECTIVES[h[0] % ADJECTIVES.length];
  const animal = ANIMALS[h[1] % ANIMALS.length];
  const num = (h.readUInt16BE(2) % 9000) + 1000; // 1000-9999
  return `${adj}-${animal}-${num}`;
}
