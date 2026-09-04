// Native Codex command hook. Does not approve shell/edit permissions. It only
// denies known collisions or adds context. MCP argument rewriting is limited
// to our own coordination tools so hooks and tools use the same thread identity.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { codexContext, patchTargets } from "../lib/codex-context.mjs";
import { getDb, setDegraded, clearDegraded } from "../lib/store.mjs";
import { ensureAgent, heartbeatFresh, heartbeat, markDead } from "../lib/agents.mjs";
import { claimFiles, claimResource, releaseAllForAgent, enqueue } from "../lib/leases.mjs";
import { canonicalFilePath, isRepoRelative } from "../lib/path-canon.mjs";
import { detectWriteTargets } from "../lib/bash-targets.mjs";
import { detectResources } from "../lib/resource-rules.mjs";
import { writeCommitterMarker } from "../lib/committer.mjs";
import { logActivity } from "../lib/activity.mjs";
import { buildRoomBrief } from "../lib/room-brief.mjs";
import { midTurnContext, postToolContext } from "../lib/coord-context.mjs";
import { overlapHardBlock, stripHarnessPreamble } from "../lib/overlap.mjs";
import { writeSnapshotThrottled } from "../lib/snapshot.mjs";

try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const ctx = codexContext(input);
  const { agentId, repoRoot, branch, ws } = ctx;
  const event = input.hook_event_name;
  const db = getDb();
  if (event === "SessionEnd" || event === "SubagentStop") {
    // SubagentStop without a child id must never tear down its parent.
    if (event === "SubagentStop" && !input.agent_id) process.exit(0);
    releaseAllForAgent(db, agentId);
    markDead(db, agentId);
    logActivity(db, { agentId, workspaceId: ws, event: "release" });
    writeSnapshotThrottled(db);
    process.exit(0);
  }
  if (!heartbeatFresh(agentId) || ["SessionStart", "SubagentStart", "UserPromptSubmit"].includes(event)) {
    ensureAgent(db, { agentId, tool: "codex", repoPath: repoRoot || ctx.cwd, branch });
  }
  if (event === "SessionStart" || event === "SubagentStart") {
    const brief = buildRoomBrief(db, { agentId, workspaceId: ws, repoRoot, wrap: (s) => s + "\n" });
    if (brief) process.stdout.write(brief + "\n");
  } else if (event === "UserPromptSubmit") {
    const task = typeof input.prompt === "string" ? stripHarnessPreamble(input.prompt).replace(/\s+/g, " ").trim().slice(0, 100) : null;
    heartbeat(db, agentId, task && !/^continue where you left off/i.test(task) ? task : null);
    const context = midTurnContext(db, { agentId, workspaceId: ws, wrap: (s) => s + "\n" });
    if (context) process.stdout.write(context + "\n");
  } else if (event === "PostToolUse") {
    const out = postToolContext(db, { agentId, workspaceId: ws });
    if (out) process.stdout.write(out);
  } else if (event === "PreToolUse") {
    const tool = input.tool_name || "";
    const args = input.tool_input || {};
    if (/^mcp__agent[_-]coord__/.test(tool)) {
      // This is request-local: parent and child calls sharing one MCP transport
      // cannot rename each other. Preserve all original model arguments.
      const _coord = { session_id: input.session_id, cwd: input.cwd };
      if (input.agent_id) _coord.agent_id = input.agent_id;
      if (input.agent_type) _coord.agent_type = input.agent_type;
      process.stdout.write(JSON.stringify({ hookSpecificOutput: {
        hookEventName: event, permissionDecision: "allow", updatedInput: { ...args, _coord },
      } }));
    } else {
      const shell = /^(?:Bash|PowerShell|exec_command|shell_command)$/.test(tool);
      const command = args.command ?? args.cmd ?? "";
      const cwd = typeof args.workdir === "string" ? resolve(ctx.cwd, args.workdir) : ctx.cwd;
      let paths = [];
      if (tool === "apply_patch") paths = patchTargets(args).map((p) => canonicalFilePath(resolve(cwd, p), repoRoot));
      else if (shell && repoRoot) paths = detectWriteTargets(command, repoRoot, cwd);
      else if (args.file_path) paths = [canonicalFilePath(resolve(cwd, args.file_path), repoRoot)];
      if (paths.some(isRepoRelative)) {
        const duplicate = overlapHardBlock(db, { agentId, workspaceId: ws });
        if (duplicate) {
          process.stderr.write(`agent-coord: task overlaps ${duplicate.agentId}. Announce a distinct task before editing.\n`);
          process.exit(2);
        }
      }
      const result = paths.length ? claimFiles(db, { agentId, workspaceId: ws, repoPath: repoRoot, branch, paths, reason: tool }) : { granted: true };
      if (!result.granted) {
        enqueue(db, { kind: "file", key: ws + "||" + result.path, agentId });
        logActivity(db, { agentId, workspaceId: ws, event: "conflict", detail: result.path });
        process.stderr.write(`agent-coord: "${result.path}" is held by ${result.conflict.agent_id}. Edit elsewhere or coordinate; the lease frees when they move on.\n`);
        process.exit(2);
      }
      if (shell) {
        const isCommit = /\bgit\s+commit\b/.test(command);
        if (isCommit) writeCommitterMarker(repoRoot, agentId);
        else for (const resource of detectResources(command, { workspaceId: ws, repoRoot })) {
          const r = claimResource(db, { agentId, resourceId: resource.resourceId, reason: resource.label });
          if (!r.granted) {
            process.stderr.write(`agent-coord: ${resource.resourceId} is held by ${r.conflict.agent_id}. Wait or coordinate.\n`);
            process.exit(2);
          }
        }
      }
      for (const path of paths) logActivity(db, { agentId, workspaceId: ws, event: "claim", detail: path });
    }
  }
  clearDegraded();
  writeSnapshotThrottled(db);
} catch (e) {
  setDegraded(e);
  process.stderr.write(`agent-coord DEGRADED: ${e.message}; coordination hook skipped.\n`);
}
