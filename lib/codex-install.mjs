import { join } from "node:path";

export const CODEX_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "SessionEnd", "SubagentStart", "SubagentStop"];

export function codexHooks(root, node = process.execPath) {
  const executable = node.replace(/\\/g, "/");
  const script = join(root, "hooks", "codex.mjs").replace(/\\/g, "/");
  const command = `"${executable}" --disable-warning=ExperimentalWarning "${script}"`;
  // Codex uses PowerShell on Windows: a quoted executable needs the call
  // operator. Single quotes also keep dollar signs in install paths literal.
  const quotePowerShell = (path) => `'${path.replace(/'/g, "''")}'`;
  const windowsCommand = process.platform === "win32"
    ? { commandWindows: `& ${quotePowerShell(executable)} --disable-warning=ExperimentalWarning ${quotePowerShell(script)}` }
    : {};
  return Object.fromEntries(CODEX_EVENTS.map((event) => [event, [{
    hooks: [{ type: "command", command, ...windowsCommand, timeout: event === "SessionEnd" ? 3 : 10,
      ...(["SessionEnd", "SubagentStop"].includes(event) ? {} : { additionalContextLimit: 8000 }), "x-agent-coord": true }],
  }]]));
}

// Replace only our handlers. Never widen a shared group's matcher: another
// user's handler in that group must keep its original matching semantics.
export function mergeCodexHooks(existing, wanted) {
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) throw new Error("Invalid hook config: expected an object");
  const next = structuredClone(existing);
  next.hooks ||= {};
  if (typeof next.hooks !== "object" || Array.isArray(next.hooks)) throw new Error("Invalid hooks: expected an object");
  for (const [event, groups] of Object.entries(next.hooks)) {
    if (!Array.isArray(groups)) throw new Error(`Invalid hooks.${event}: expected an array`);
    next.hooks[event] = groups.map((group) => ({ ...group,
      hooks: (group.hooks || []).filter((h) => h["x-agent-coord"] !== true),
    })).filter((group) => group.hooks.length);
  }
  for (const [event, groups] of Object.entries(wanted)) {
    next.hooks[event] = [...(next.hooks[event] || []), ...groups];
  }
  return next;
}
