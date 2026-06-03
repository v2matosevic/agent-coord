import { readSessionLink } from "./session-link.mjs";
import { ensureAgent, markDead } from "./agents.mjs";
import { releaseAllForAgent } from "./leases.mjs";

// The MCP server resolves its identity ONCE at startup (pollSessionLink, 4s). If
// the SessionStart hook hadn't published the claude.exe -> id link yet — it lost
// the race, or the session RESUMED and the link landed on a fresh pid — the server
// falls back to a random standalone id and, with no reconciliation, shows up as a
// "ghost twin" of the same session for its whole life (splitting locks/messages
// and breaking own-commit recognition in pending_push_review).
//
// Fix: on each tool call until adopted, re-read the link for our parent pid. Once
// it appears, ADOPT it. This is safe because reconciliation runs at the TOP of the
// request handler, before any claim/post — so the standalone id never accrues real
// state; it holds only its own agents row + register log, which we tear down. Only
// ever adopts the link for OUR OWN parent process, so it can't grab a peer.
export function reconcileServerIdentity(db, { agentId, ppid, tool, repoPath, branch }) {
  let linked = null;
  try {
    linked = readSessionLink(ppid);
  } catch {}
  if (!linked) return { agentId, adopted: false };
  if (linked === agentId) return { agentId, adopted: true };
  try {
    releaseAllForAgent(db, agentId); // standalone id holds nothing meaningful this early
    markDead(db, agentId); // stop the abandoned twin from showing as live
  } catch {}
  ensureAgent(db, { agentId: linked, tool, repoPath, branch });
  return { agentId: linked, adopted: true, migratedFrom: agentId };
}
