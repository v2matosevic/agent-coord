import { execFileSync } from "node:child_process";
import { getDb } from "../lib/store.mjs";
import { logActivity } from "../lib/activity.mjs";
import { workspaceId } from "../lib/path-canon.mjs";
import { readCommitterMarker } from "../lib/committer.mjs";

// post-commit hook target: record who made which commit, so a later agent can
// tell whose work is in the unpushed history. Agent = the committer marker the
// Bash guard set on `git commit` (else "manual"). Fails silent.
try {
  const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const head = execFileSync("git", ["log", "-1", "--format=%h%x09%s"], { encoding: "utf8", cwd: repo }).trim();
  const agent = readCommitterMarker(repo) || "manual";
  logActivity(getDb(), { agentId: agent, workspaceId: workspaceId(repo), event: "commit", detail: head });
} catch {}
process.exit(0);
