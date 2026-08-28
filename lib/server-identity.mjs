import { readSessionLinkAny, readSessionLinkMetaAny } from "./session-link.mjs";
import { ensureAgent, markDead } from "./agents.mjs";
import { releaseAllForAgent } from "./leases.mjs";

// The MCP server resolves its identity ONCE at startup (pollSessionLink, 4s). If
// the SessionStart hook hadn't published the claude.exe -> id link yet — it lost
// the race, or the session RESUMED and the link landed on a fresh pid — the server
// falls back to a random standalone id and, with no reconciliation, shows up as a
// "ghost twin" of the same session for its whole life (splitting locks/messages
// and breaking own-commit recognition in pending_push_review).
//
// Fix: on each tool call until adopted, re-read the link for our anchor pid(s).
// Once it appears, ADOPT it. This is safe because reconciliation runs at the TOP
// of the request handler, before any claim/post — so the standalone id never
// accrues real state; it holds only its own agents row + register log, which we
// tear down. Only ever adopts the link for OUR OWN ancestor process, so it can't
// grab a peer. `ppids` is the candidate set (the walked-up claude.exe pid first,
// then the raw ppid) — see mcp/server.mjs; `ppid` is still accepted for callers
// that resolved a single pid.
export function reconcileServerIdentity(db, { agentId, ppid, ppids, tool, repoPath, branch }) {
  const pids = ppids && ppids.length ? ppids : [ppid].filter(Boolean);
  let linked = null;
  try {
    linked = readSessionLinkAny(pids);
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

// The ALREADY-adopted case: the session renamed itself under a running server.
// /clear (and an in-TUI /resume) gives the hooks a new session_id; the
// SessionStart hook re-publishes the link for the same claude.exe with whatever
// name that session now carries. A server that resolved once at startup would
// keep the old name for its whole life — whoami says one thing, the hooks record
// another (the toad/ferret split, i-647f5cc1). So on each call, follow a link
// that was written AFTER this server started and names someone else. A link
// older than the server is ignored on purpose: it's the pid-reuse case (a dead
// session's link under a recycled pid) and must never rename a live server.
// The old id is NOT torn down here — the hooks own its lifecycle, and a
// /clear'd session's locks go cold on their own.
export function followSessionLink(db, { agentId, ppids, sinceTs, tool, repoPath, branch }) {
  let meta = null;
  try {
    meta = readSessionLinkMetaAny(ppids);
  } catch {}
  if (!meta || meta.agentId === agentId || !(meta.ts > sinceTs)) return { agentId, changed: false };
  ensureAgent(db, { agentId: meta.agentId, tool, repoPath, branch });
  return { agentId: meta.agentId, changed: true, from: agentId };
}
