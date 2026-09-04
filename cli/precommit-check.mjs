import { execFileSync } from "node:child_process";
import { getDb, nowIso, isoAgoMs } from "../lib/store.mjs";
import { DEAD_MS, FILE_ACTIVE_MS } from "../lib/config.mjs";
import { workspaceId, canonicalFilePath } from "../lib/path-canon.mjs";
import { readCommitterMarker } from "../lib/committer.mjs";
import { sessionAnchorPids, readSessionLinkAny } from "../lib/session-link.mjs";
import { baseAgentId, agentIdFromEnv } from "../lib/identity.mjs";

// The universal cross-agent net. Runs as a git pre-commit hook (any committer:
// Claude, Codex, Cursor, Aider, manual). Blocks the commit (exit 1) if a staged
// file is held by a DIFFERENT live agent's exclusive lease. Fails OPEN — a
// broken store must never wedge `git commit`.

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

try {
  const repoRoot = git(["rev-parse", "--show-toplevel"]);
  const staged = execFileSync("git", ["diff", "--cached", "--name-only", "--no-renames", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  if (!staged.length) process.exit(0);

  // A peer's per-repo marker must not override this process's exact identity.
  const fromEnv = agentIdFromEnv();
  const self = fromEnv || readCommitterMarker(repoRoot) || "__none__";
  const ws = workspaceId(repoRoot);
  const db = getDb();
  const stmt = db.prepare(
    `SELECT l.path, l.agent_id, a.current_task
     FROM file_leases l JOIN agents a ON a.agent_id = l.agent_id
     WHERE l.workspace_id=? AND l.path=? AND l.mode='exclusive'
       AND a.status='active' AND a.last_heartbeat > ? AND l.expires_at > ? AND l.acquired_at > ? AND l.agent_id <> ?`,
  );

  const deadcut = isoAgoMs(DEAD_MS);
  const coldcut = isoAgoMs(FILE_ACTIVE_MS);
  const now = nowIso();
  let conflicts = [];
  for (const f of staged) {
    const row = stmt.get(ws, canonicalFilePath(f, repoRoot), deadcut, now, coldcut, self);
    if (row) conflicts.push(row);
  }

  if (conflicts.length) {
    // The marker is a 30s-TTL stamp from the shell guard's PreToolUse — a
    // chained command (`npm test && git commit`) outlives it, and a lease held
    // by this session's SUBAGENT carries a `base/sub-x` id the exact-match SQL
    // above can't see as self. Before blocking, resolve the committing SESSION
    // via the session-link under the walked-up claude.exe anchor (the identity
    // invariant, SYSTEM.md §8) and drop any "conflict" whose holder is the same
    // session family. Lazy on purpose: the process-tree walk runs only when a
    // block is otherwise imminent, so the common clean commit stays cheap.
    // (Field report i-3eeb7ef8: an agent's own shell-claimed .gitignore lease
    // blocked its own commit.)
    let linked = null;
    if (!fromEnv) {
      try { linked = readSessionLinkAny(sessionAnchorPids()); } catch {}
    }
    // Cheapest and exact: the session id Claude exported to the process that ran
    // `git commit` (see cli/log-commit.mjs).
    const selfBases = new Set([self, linked, fromEnv].filter((x) => x && x !== "__none__").map(baseAgentId));
    conflicts = conflicts.filter((c) => !selfBases.has(baseAgentId(c.agent_id)));
  }

  if (conflicts.length) {
    process.stderr.write("\n⛔ agent-coord: commit blocked — staged files are held by other live agents:\n");
    for (const c of conflicts) process.stderr.write(`   • ${c.path}  (held by ${c.agent_id}${c.current_task ? " — " + c.current_task : ""})\n`);
    process.stderr.write("   Coordinate with the holder or wait for the lease to go cold. Do not force-release a live peer.\n\n");
    process.exit(1);
  }
  process.exit(0);
} catch (e) {
  process.stderr.write(`⚠ agent-coord pre-commit skipped (${e.code || e.message})\n`);
  process.exit(0); // fail open
}
