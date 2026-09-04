// Exercise the generated hook through the host shell, not a direct Node spawn.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
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
  console.log("generated Codex commands execute through the host shell for all seven events");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
