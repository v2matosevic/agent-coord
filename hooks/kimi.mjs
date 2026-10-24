// Kimi Code's native hook payload uses the Claude-compatible event fields.
// ADE's per-launch capture owns coordination, even after /new or /resume.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let input;
try { input = JSON.parse(readFileSync(0, "utf8")); } catch { process.exit(0); }
if (!input || typeof input !== "object") process.exit(0);
const session = process.env.AGENT_COORD_SESSION_ID || input.session_id;
if (typeof session !== "string" || !session.trim()) process.exit(0);
input.session_id = session;
const event = input.hook_event_name;
let script;
let args = [];
if (event === "SessionStart") { script = "session.mjs"; args = ["--register"]; }
else if (event === "UserPromptSubmit") { script = "session.mjs"; args = ["--prompt"]; }
else if (event === "SessionEnd") { script = "session.mjs"; args = ["--release"]; }
else if (event === "PreToolUse") script = input.tool_name === "Bash" ? "bash-guard.mjs" : "guard.mjs";
else if (event === "PostToolUse" || event === "PostToolUseFailure") { script = "guard.mjs"; args = ["--post"]; }
else if (event === "SessionHeartbeat") { script = "guard.mjs"; args = ["--post"]; }
else process.exit(0);
const child = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", fileURLToPath(new URL(script, import.meta.url)), ...args], {
  input: JSON.stringify(input), encoding: "utf8", windowsHide: true,
  env: { ...process.env, AGENT_COORD_HOOK_TOOL: "kimi-code" },
});
if (child.stderr) process.stderr.write(child.stderr);
if (child.stdout) {
  let output = child.stdout;
  try { output = JSON.parse(output).hookSpecificOutput?.additionalContext || output; } catch {}
  process.stdout.write(output);
}
process.exit(child.status === 2 ? 2 : 0);
