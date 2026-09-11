// Lightweight native Codex entry point. Metadata forwarding and irrelevant
// pre-tool events do not load SQLite, resolve identities or inspect repositories.
import { readFileSync } from "node:fs";
import { deadlineAfter } from "../lib/deadline.mjs";

try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const event = input.hook_event_name;
  const args = input.tool_input || {};
  // Includes runtime module loading. Leave room for the host shell, especially
  // SessionEnd, whose configured host timeout is only three seconds.
  const deadline = deadlineAfter(event === "SessionEnd" ? 1000 : 1500);
  if (event === "SubagentStop" && !input.agent_id) process.exit(0);
  if (event === "PreToolUse") {
    const tool = input.tool_name || "";
    if (/^mcp__agent[_-]coord__/.test(tool)) {
      if (typeof input.session_id !== "string" || !input.session_id.trim() || typeof input.cwd !== "string" || !input.cwd.trim()) {
        throw new Error("Codex coordination requires session_id and cwd");
      }
      const _coord = { session_id: input.session_id, cwd: input.cwd };
      if (input.agent_id) _coord.agent_id = input.agent_id;
      if (input.agent_type) _coord.agent_type = input.agent_type;
      process.stdout.write(JSON.stringify({ hookSpecificOutput: {
        hookEventName: event, permissionDecision: "allow", updatedInput: { ...args, _coord },
      } }));
      process.exit(0);
    }
    // PostToolUse retains heartbeat and message delivery for these tools.
    if (!/^(?:Bash|PowerShell|exec_command|shell_command|apply_patch)$/.test(tool) && !args.file_path) process.exit(0);
  }
  const { runCodexHook } = await import("./codex-runtime.mjs");
  runCodexHook(input, deadline);
} catch (error) {
  try { (await import("../lib/store.mjs")).setDegraded(error); } catch {}
  process.stderr.write("agent-coord DEGRADED: " + error.message + "; coordination hook skipped.\n");
}
