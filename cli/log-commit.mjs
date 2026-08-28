import { execFileSync } from "node:child_process";
import { getDb } from "../lib/store.mjs";
import { logActivity } from "../lib/activity.mjs";
import { workspaceId } from "../lib/path-canon.mjs";
import { readCommitterMarker } from "../lib/committer.mjs";
import { agentIdFromEnv } from "../lib/identity.mjs";
import { sessionAnchorPids, readSessionLinkAny } from "../lib/session-link.mjs";

// post-commit hook target: record who made which commit, so a later agent can
// tell whose work is in the unpushed history (pending_push_review keys on it).
// Every agent commits as the human's git user, so git itself carries no agent
// identity — this record is the only attribution there is. Resolution order:
//   1. CLAUDE_CODE_SESSION_ID in our environment — git inherits it from the
//      Claude tool call that ran `git commit`, and it hashes to exactly the
//      session's hook identity. Exact, per-process, no TTL. This is what was
//      missing when 7 sessions in 3 days saw their own minutes-old commits
//      come back "manual" (i-4e28f13d and its 6 recurrences): the marker below
//      is a 30s per-REPO stamp that a chained `npm test && git commit` outlives.
//   2. The committer marker the shell guard drops on `git commit`.
//   3. The session-link under our claude.exe anchor (a commit from a shell that
//      Claude spawned but whose env was scrubbed).
//   4. "manual" — a human or a non-Claude tool. Fails silent.
try {
  const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const head = execFileSync("git", ["log", "-1", "--format=%h%x09%s"], { encoding: "utf8", cwd: repo }).trim();
  let agent = null;
  try {
    agent = agentIdFromEnv();
  } catch {}
  if (!agent) agent = readCommitterMarker(repo);
  if (!agent) {
    try {
      agent = readSessionLinkAny(sessionAnchorPids());
    } catch {}
  }
  logActivity(getDb(), { agentId: agent || "manual", workspaceId: workspaceId(repo), event: "commit", detail: head });
} catch {}
process.exit(0);
