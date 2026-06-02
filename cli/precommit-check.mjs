import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getDb, nowIso, isoAgoMs } from "../lib/store.mjs";
import { DEAD_MS, FILE_ACTIVE_MS } from "../lib/config.mjs";
import { workspaceId, canonicalFilePath } from "../lib/path-canon.mjs";
import { readCommitterMarker } from "../lib/committer.mjs";

// This script's own sibling — so the hint below points at the real release.mjs
// wherever the project lives, not a hardcoded path.
const RELEASE = fileURLToPath(new URL("./release.mjs", import.meta.url)).replace(/\\/g, "/");

// The universal cross-agent net. Runs as a git pre-commit hook (any committer:
// Claude, Codex, Cursor, Aider, manual). Blocks the commit (exit 1) if a staged
// file is held by a DIFFERENT live agent's exclusive lease. Fails OPEN — a
// broken store must never wedge `git commit`.

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

try {
  const repoRoot = git(["rev-parse", "--show-toplevel"]);
  const staged = git(["diff", "--cached", "--name-only"]).split(/\r?\n/).filter(Boolean);
  if (!staged.length) process.exit(0);

  const self = readCommitterMarker(repoRoot) || "__none__";
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
  const conflicts = [];
  for (const f of staged) {
    const row = stmt.get(ws, canonicalFilePath(f, repoRoot), deadcut, now, coldcut, self);
    if (row) conflicts.push(row);
  }

  if (conflicts.length) {
    process.stderr.write("\n⛔ agent-coord: commit blocked — staged files are held by other live agents:\n");
    for (const c of conflicts) process.stderr.write(`   • ${c.path}  (held by ${c.agent_id}${c.current_task ? " — " + c.current_task : ""})\n`);
    process.stderr.write(`   Coordinate, or force-release:  node "${RELEASE}" --file <path>\n\n`);
    process.exit(1);
  }
  process.exit(0);
} catch (e) {
  process.stderr.write(`⚠ agent-coord pre-commit skipped (${e.code || e.message})\n`);
  process.exit(0); // fail open
}
