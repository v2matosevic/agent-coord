// Native Codex command hook. Does not approve shell/edit permissions. It only
// denies known collisions or adds context. MCP argument rewriting is limited
// to our own coordination tools so hooks and tools use the same thread identity.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { sessionTokenFromId } from "../lib/identity.mjs";
import { codexContext, patchTargets } from "../lib/codex-context.mjs";
import { getDb, setDegraded, clearDegraded } from "../lib/store.mjs";
import { ensureAgentContext, heartbeat, markDead } from "../lib/agents.mjs";
import { findAgentPid } from "../lib/proc-ancestry.mjs";
import { claimOperation, releaseAllForAgent, enqueue } from "../lib/leases.mjs";
import { canonicalFilePath, isRepoRelative } from "../lib/path-canon.mjs";
import { detectWriteTargets } from "../lib/bash-targets.mjs";
import { detectResources } from "../lib/resource-rules.mjs";
import { writeCommitterMarker } from "../lib/committer.mjs";
import { logActivity } from "../lib/activity.mjs";
import { buildRoomBrief } from "../lib/room-brief.mjs";
import { prepareMidTurnContext, preparePostToolContext, markPreparedContextOffered } from "../lib/coord-context.mjs";
import { overlapHardBlock, stripHarnessPreamble } from "../lib/overlap.mjs";
import { writeSnapshotThrottled } from "../lib/snapshot.mjs";
import { finishFileOperation } from "../lib/contention.mjs";
import { deadlineAfter } from "../lib/deadline.mjs";
import { observeGuardDenial } from "../lib/guard-observation.mjs";
import { bindHealthContext, markHealthDenied } from "../lib/runtime-health.mjs";

// PowerShell -Command maps a native exit 2 to shell exit 1. Codex treats 1 as
// a hook failure and continues. Use its documented structured deny with exit 0
// so a known conflict survives the shell boundary without changing hook trust.
function deny(reason) {
  markHealthDenied();
  process.stderr.write(reason + "\n");
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason,
  } }));
  process.exit(0);
}

export function runCodexHook(input, deadline) {
let uncheckedWrite = input.hook_event_name === "PreToolUse";
try {
  const args = input.tool_input || {};
  const event = input.hook_event_name;
  const toolName = input.tool_name || "";
  const localTool = /^(?:Bash|PowerShell|exec_command|shell_command|apply_patch)$/.test(input.tool_name || "");
  const executionCwd = localTool && typeof args.workdir === "string" && typeof input.cwd === "string"
    ? resolve(input.cwd, args.workdir) : input.cwd;
  const ctx = codexContext({ ...input, cwd: executionCwd }, { deadline });
  const { agentId, repoRoot, branch, ws } = ctx;
  const sessionToken = sessionTokenFromId(agentId);
  bindHealthContext({ agentId, ws });
  let planned;
  if (event === "PreToolUse") {
    const shell = /^(?:Bash|PowerShell|exec_command|shell_command)$/.test(toolName);
    const command = args.command ?? args.cmd ?? "";
    let paths = [];
    if (toolName === "apply_patch") paths = patchTargets(args).map((p) => canonicalFilePath(resolve(ctx.cwd, p), repoRoot));
    else if (shell && repoRoot) paths = detectWriteTargets(command, repoRoot, ctx.cwd);
    else if (args.file_path) paths = [canonicalFilePath(resolve(ctx.cwd, args.file_path), repoRoot)];
    const isCommit = shell && /\bgit\s+commit\b/.test(command);
    const resources = shell && !isCommit ? detectResources(command, { workspaceId: ws, repoRoot })
      .map((r) => ({ resourceId: r.resourceId, reason: r.label })) : [];
    uncheckedWrite = !!(paths.length || resources.length || isCommit);
    planned = { paths, resources, isCommit };
  }
  const db = getDb({ deadline });
  if (event === "SessionEnd" || event === "SubagentStop") {
    // SubagentStop without a child id must never tear down its parent.
    if (event === "SubagentStop" && !input.agent_id) process.exit(0);
    releaseAllForAgent(db, agentId);
    markDead(db, agentId);
    logActivity(db, { agentId, workspaceId: ws, event: "release" });
    writeSnapshotThrottled(db, 0);
    process.exit(0);
  }
  ensureAgentContext(db, { agentId, tool: "codex", repoPath: repoRoot || ctx.cwd, branch,
    ownerPid: event === "SessionStart" || event === "SubagentStart"
      ? findAgentPid(undefined, undefined, undefined, { deadline: Math.min(deadline, deadlineAfter(1000)) }) : null });
  if (event === "SessionStart" || event === "SubagentStart") {
    const brief = buildRoomBrief(db, { agentId, workspaceId: ws, repoRoot, wrap: (s) => s + "\n" });
    if (brief) process.stdout.write(brief + "\n");
  } else if (event === "UserPromptSubmit") {
    const task = typeof input.prompt === "string" ? stripHarnessPreamble(input.prompt).replace(/\s+/g, " ").trim().slice(0, 100) : null;
    heartbeat(db, agentId, task && !/^continue where you left off/i.test(task) ? task : null);
    const delivery = prepareMidTurnContext(db, { agentId, sessionToken, workspaceId: ws, wrap: (s) => s + "\n" });
    if (delivery.text) {
      writeFileSync(1, delivery.text + "\n");
      markPreparedContextOffered(db, delivery);
    }
  } else if (event === "PostToolUse") {
    finishFileOperation(db, { agentId, operationId: input.tool_use_id });
    const delivery = preparePostToolContext(db, { agentId, sessionToken, workspaceId: ws });
    if (delivery.text) {
      writeFileSync(1, delivery.text);
      markPreparedContextOffered(db, delivery);
    }
  } else if (event === "PreToolUse") {
    const { paths, resources, isCommit } = planned;
    if (paths.some(isRepoRelative)) {
      const duplicate = overlapHardBlock(db, { agentId, workspaceId: ws });
      if (duplicate) {
        deny(`agent-coord: task overlaps ${duplicate.agentId}. Announce a distinct task before editing.`);
      }
    }
    const result = paths.length || resources.length
      ? claimOperation(db, { agentId, workspaceId: ws, repoPath: repoRoot, branch, paths, resources, reason: toolName, operationId: input.tool_use_id })
      : { granted: true };
    if (!result.granted) {
      if (result.kind === "resource") {
        observeGuardDenial(db, () => logActivity(db, { agentId, workspaceId: ws, event: "resource-conflict", detail: result.resourceId }));
        deny(`agent-coord: ${result.resourceId} is held by ${result.conflict.agent_id}. Wait or coordinate.`);
      }
      observeGuardDenial(db, () => {
        enqueue(db, { kind: "file", key: ws + "||" + result.path, agentId });
        logActivity(db, { agentId, workspaceId: ws, event: "conflict", detail: result.path });
      });
      deny(`agent-coord: "${result.path}" is held by ${result.conflict.agent_id}. Edit elsewhere or coordinate; the lease frees when they move on.`);
    }
    uncheckedWrite = false; // ownership was verified; optional telemetry may fail
    if (isCommit) writeCommitterMarker(repoRoot, agentId);
    for (const r of resources) logActivity(db, { agentId, workspaceId: ws, event: "resource-claim", detail: r.resourceId });
    for (const path of paths) logActivity(db, { agentId, workspaceId: ws, event: "claim", detail: path });
  }
  clearDegraded();
  writeSnapshotThrottled(db);
} catch (e) {
  setDegraded(e);
  if (e.code === "COORD_DEADLINE" && uncheckedWrite) {
    deny("agent-coord: coordination time budget exhausted; file/resource ownership is unverified. Retry after the store is available.");
  }
  process.stderr.write(`agent-coord DEGRADED: ${e.message}; coordination hook skipped.\n`);
}
}
