// Alternating off/on runs measure collection overhead on the same code/fixture.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
const root = fileURLToPath(new URL("../", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "coord-health-bench-"));
const env = { ...process.env, AGENT_COORD_HOME: home, CODEX_THREAD_ID: "", CLAUDE_CODE_SESSION_ID: "", CLAUDECODE: "", CLAUDE_PID: "", AGENT_COORD_NOTIFY: "0", AGENT_COORD_DIGEST: "0" };
const result = {};
try {
  for (const [name, event, tool] of [["metadata", "PreToolUse", "mcp__agent_coord__whoami"], ["noop", "PreToolUse", "mcp__fixture__read"], ["post", "PostToolUse", "exec_command"]]) {
    const values = { off: [], on: [] };
    let expected;
    for (let i = 0; i < 28; i++) for (const enabled of i % 2 ? [true, false] : [false, true]) {
      const start = performance.now();
      const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(root, "hooks/codex.mjs")], {
        cwd: root, env: { ...env, AGENT_COORD_HEALTH: enabled ? "1" : "0" }, windowsHide: true, encoding: "utf8", timeout: 10000,
        input: JSON.stringify({ session_id: "health-benchmark", cwd: root, hook_event_name: event, tool_name: tool, tool_input: {} }),
      });
      const ms = performance.now() - start;
      if (run.status !== 0 || run.stderr) throw new Error(run.error || run.stderr || `exit ${run.status}`);
      expected ??= run.stdout;
      if (run.stdout !== expected) throw new Error("health recording changed model-facing output");
      if (i >= 3) values[enabled ? "on" : "off"].push(ms);
    }
    const stats = list => { list.sort((a, b) => a - b); return { p50Ms: list[12], p95Ms: list[23] }; };
    result[name] = { off: stats(values.off), on: stats(values.on), modelOutputUnchanged: true };
  }
  const report = { measuredAt: new Date().toISOString(), node: process.version, platform: process.platform, samples: 25, warmups: 3, result,
    limits: "Collection off/on on the same build; includes Node process overhead. This is not full task latency. Output equality checked on every run." };
  const out = process.argv.indexOf("--out");
  if (out >= 0) writeFileSync(process.argv[out + 1], JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally { try { rmSync(home, { recursive: true, force: true, maxRetries: 3 }); } catch {} }
