import { beginHookHealth, bindHealthContext } from "../lib/runtime-health.mjs";
beginHookHealth("codex", { session_id: "health-fixture-session", hook_event_name: "PreToolUse" });
bindHealthContext({ agentId: "fixture-agent", ws: "aaaaaaaaaaaaaaaa" });
if (process.argv.includes("--hang")) {
  process.stdout.write("ready\n");
  setInterval(() => {}, 1000);
}
