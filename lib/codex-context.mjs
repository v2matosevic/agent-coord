import { resolve } from "node:path";
import { resolveAgentId } from "./identity.mjs";
import { gitContext } from "./git-context.mjs";
import { workspaceId } from "./path-canon.mjs";

// Explicit session data, never a shared app-server PID or the most recent
// session in a directory. One Codex host can serve several concurrent threads.
export function codexContext(input) {
  if (!input || typeof input.session_id !== "string" || !input.session_id.trim()) {
    throw new Error("Codex coordination requires a non-empty session_id");
  }
  if (typeof input.cwd !== "string" || !input.cwd.trim()) {
    throw new Error("Codex coordination requires cwd");
  }
  const cwd = resolve(input.cwd);
  const { repoRoot, branch } = gitContext(cwd);
  const agentId = resolveAgentId({ ...input, session_id: input.session_id.trim() });
  return { agentId, tool: "codex", cwd, repoRoot, branch, ws: workspaceId(repoRoot || cwd), basis: "hook", adopted: true, sessionId: input.session_id.trim(), anchorPids: [] };
}

// Documented hook shape: apply_patch arrives as tool_input.command. Also accept
// the direct tool shape for callers driving the adapter in their own harness.
export function patchTargets(input) {
  const patch = typeof input === "string" ? input : input?.command ?? input?.patch ?? input?.input;
  if (typeof patch !== "string" || !patch.startsWith("*** Begin Patch")) {
    throw new Error("Cannot inspect apply_patch input: expected a patch command");
  }
  const paths = [];
  for (const line of patch.split(/\r?\n/)) {
    const m = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
    if (m) paths.push(m[1]);
  }
  return [...new Set(paths)];
}
