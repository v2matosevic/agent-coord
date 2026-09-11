import { readFileSync } from "node:fs";
import { resolveAgentId } from "../lib/identity.mjs";
import { gitContext } from "../lib/git-context.mjs";
import { getDb, setDegraded } from "../lib/store.mjs";
import { ensureAgent, heartbeatFresh } from "../lib/agents.mjs";
import { claimOperation, enqueue } from "../lib/leases.mjs";
import { logActivity } from "../lib/activity.mjs";
import { workspaceId } from "../lib/path-canon.mjs";
import { detectResources } from "../lib/resource-rules.mjs";
import { detectWriteTargets } from "../lib/bash-targets.mjs";
import { writeCommitterMarker } from "../lib/committer.mjs";
import { parentBaseFromProc } from "../lib/session-link.mjs";
import { notify } from "../lib/notify.mjs";
import { observeGuardDenial } from "../lib/guard-observation.mjs";

// PreToolUse on Bash/PowerShell: claim machine-wide singletons (dev port / dev
// DB / deploy) the command would touch, blocking with exit 2 if another live
// agent holds one. Also claims files the command would WRITE (Set-Content /
// sed -i / redirects) — same lease as the edit guard, so shell edits block on a
// peer's warm hold AND keep the holder's own lease warm. Also stamps a
// committer marker on `git commit` so the pre-commit hook can tell a
// self-commit from a cross-agent one. Fails open but loud.

function readInput() {
  try {
    return JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

const input = readInput();
// Subagent shell edits: inherit the parent session's base name (see session-link).
const parentBase = input?.agent_id ? parentBaseFromProc(process.ppid) : null;
const agentId = resolveAgentId(input, { parentBase });
const cwd = input.cwd || process.cwd();
const command = input.tool_input?.command || "";

try {
  const db = getDb();
  const { repoRoot, branch } = gitContext(cwd);
  const ws = workspaceId(repoRoot);
  // Fires on every shell call — skip the upsert write txn while the local
  // heartbeat marker is fresh (see guard.mjs / lib/agents.mjs).
  if (!heartbeatFresh(agentId)) ensureAgent(db, { agentId, tool: "claude-code", repoPath: repoRoot, branch });

  const isCommit = /\bgit\s+commit\b/.test(command);
  if (isCommit) writeCommitterMarker(repoRoot, agentId);

  // A shell command is one operation: a refused file or resource rolls back
  // ALL new reservations, including renewals of claims already owned. A git
  // commit only uses its marker; words in its message are not write targets.
  if (!isCommit) {
    const resources = detectResources(command, { workspaceId: ws, repoRoot })
      .map(r => ({ resourceId: r.resourceId, reason: r.label }));
    const paths = repoRoot ? detectWriteTargets(command, repoRoot, cwd) : [];
    const res = paths.length || resources.length
      ? claimOperation(db, { agentId, workspaceId: ws, repoPath: repoRoot, branch, paths, resources,
        mode: "exclusive", reason: "bash-write", operationId: input.tool_use_id })
      : { granted: true };
    if (!res.granted) {
      if (res.kind === "resource") {
        const label = resources.find(r => r.resourceId === res.resourceId)?.reason || "shared resource";
        observeGuardDenial(db, () => logActivity(db, { agentId, workspaceId: ws, event: "resource-conflict", detail: res.resourceId }));
        process.stderr.write(
          `⛔ agent-coord: ${label} (${res.resourceId}) is in use by ${res.conflict.agent_id} ` +
            `(${res.conflict.current_task || "working"}). Running this now would collide — wait or coordinate.\n`,
        );
        process.exit(2);
      }
      const path = res.path;
      observeGuardDenial(db, () => {
        enqueue(db, { kind: "file", key: ws + "||" + path, agentId });
        logActivity(db, { agentId, workspaceId: ws, event: "conflict", detail: path });
      });
      notify({ title: "⛔ agent-coord — blocked (shell)", message: `"${path}" is held by ${res.conflict.agent_id}.`, key: `block:${path}`, sound: true });
      process.stderr.write(
        `⛔ agent-coord: this command writes "${path}", held by ${res.conflict.agent_id} (${res.conflict.current_task || "working"}). ` +
          `It auto-frees when they move on — wait, target another file, or post_message to coordinate. Don't force it.\n`,
      );
      process.exit(2);
    }
    for (const r of resources) logActivity(db, { agentId, workspaceId: ws, event: "resource-claim", detail: r.resourceId });
    for (const path of paths) logActivity(db, { agentId, workspaceId: ws, event: "claim", detail: path });
  }
  process.exit(0);
} catch (e) {
  setDegraded(e);
  process.stderr.write(`⚠ agent-coord DEGRADED: ${e.code || e.message}; proceeding without resource guard.\n`);
  process.exit(0);
}
