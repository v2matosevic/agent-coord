// Exercise the generated hook through the host shell, not a direct Node spawn.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CODEX_EVENTS, codexHooks } from "../lib/codex-install.mjs";

const temp = mkdtempSync(join(tmpdir(), "coord-hook-command-"));
try {
  // PowerShell interpolation and apostrophes must remain literal path content.
  const root = join(temp, process.platform === "win32" ? "repo with spaces $cash 'quoted'" : "repo with spaces");
  mkdirSync(join(root, "hooks"), { recursive: true });
  writeFileSync(join(root, "hooks", "codex.mjs"), `
    import { readFileSync } from "node:fs";
    process.stdout.write(JSON.stringify(JSON.parse(readFileSync(0, "utf8"))));
  `);
  const hooks = codexHooks(root);
  for (const event of CODEX_EVENTS) {
    const handler = hooks[event][0].hooks[0];
    const windows = process.platform === "win32";
    const command = windows ? handler.commandWindows ?? handler.command : handler.command;
    const result = spawnSync(windows ? "pwsh" : "/bin/sh",
      windows ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-c", command],
      { cwd: temp, input: JSON.stringify({ hook_event_name: event, literal: "$value 'quote'" }), encoding: "utf8", timeout: 15000, windowsHide: true });
    assert.equal(result.status, 0, `${event}: ${result.error || result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), { hook_event_name: event, literal: "$value 'quote'" });
    if (["SessionEnd", "SubagentStop"].includes(event)) {
      assert.equal(handler.additionalContextLimit, undefined, `${event} cannot emit additionalContext`);
    } else assert.equal(handler.additionalContextLimit, 8000);
  }
  // Success alone missed a safety defect: pwsh -Command turns native exit 2
  // into 1, which Codex treats as fail-open. Exercise the real adapter's deny.
  const repoRoot = fileURLToPath(new URL("../", import.meta.url));
  const work = join(temp, "real-repo");
  mkdirSync(work);
  assert.equal(spawnSync("git", ["init", "-q", work]).status, 0);
  const handler = codexHooks(repoRoot).PreToolUse[0].hooks[0];
  const windows = process.platform === "win32";
  const command = windows ? handler.commandWindows : handler.command;
  const invoke = (session_id) => spawnSync(windows ? "pwsh" : "/bin/sh",
    windows ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-c", command], {
      cwd: work, env: { ...process.env, AGENT_COORD_HOME: join(temp, "real-store") },
      input: JSON.stringify({ session_id, cwd: work, hook_event_name: "PreToolUse", tool_name: "apply_patch",
        tool_input: { command: "*** Begin Patch\n*** Add File: held.txt\n+test\n*** End Patch" } }),
      encoding: "utf8", timeout: 15000, windowsHide: true,
    });
  const owner = invoke("holder");
  assert.equal(owner.status, 0, owner.stderr);
  assert.equal(owner.stdout, "");
  const denied = invoke("waiter");
  assert.equal(denied.status, 0, denied.stderr);
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.match(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason, /held by/);
  console.log("generated Codex commands execute through the host shell for all seven events");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
