import { readFileSync } from "node:fs";
import { agentIdFromSession } from "./lib/identity.mjs";
import { removePresence } from "./lib/presence-store.mjs";

// Hook entry point for SessionEnd. Removes this agent's presence file so it
// disappears from the fleet immediately on a clean exit (crashes are caught
// by the staleness filter in the statusline).

function readInput() {
  try {
    return JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

const input = readInput();
removePresence(agentIdFromSession(input.session_id || "unknown"));
process.exit(0);
