// Reproducible local measurements. No live store, network, models or global setup.
// node scripts/benchmark.mjs [--samples 25] [--out <report.json>]
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const option = (name) => process.argv[process.argv.indexOf(name) + 1];
const samples = process.argv.includes("--samples") ? Number(option("--samples")) : 25;
const nativeHooks = process.argv.includes("--native-hooks");
if (!Number.isInteger(samples) || samples < 5 || samples > 500) throw new Error("--samples must be 5..500");
const home = mkdtempSync(join(tmpdir(), "coord-benchmark-"));
const env = { ...process.env, AGENT_COORD_HOME: home, AGENT_COORD_BENCHMARK: "1", AGENT_COORD_NOTIFY: "0", AGENT_COORD_DIGEST: "0",
  CODEX_THREAD_ID: "", CLAUDE_CODE_SESSION_ID: "", CLAUDECODE: "", CLAUDE_PID: "" };
Object.assign(process.env, env);
const { getDb, writeTxn, nowIso } = await import("../lib/store.mjs");
const { ensureAgent } = await import("../lib/agents.mjs");
const { resolveAgentId } = await import("../lib/identity.mjs");
const { workspaceId } = await import("../lib/path-canon.mjs");
const { getFleet } = await import("../lib/activity.mjs");
const { writeSnapshot } = await import("../lib/snapshot.mjs");
const db = getDb();
const ws = workspaceId(root);
const ts = nowIso();
const until = new Date(Date.now() + 3600_000).toISOString();
writeTxn(db, () => {
  const agent = db.prepare("INSERT INTO agents(agent_id,tool,repo_path,branch,current_task,status,registered_at,last_heartbeat) VALUES(?,'codex',?,'main',?,'active',?,?)");
  const lease = db.prepare("INSERT INTO file_leases(lease_id,workspace_id,path,agent_id,mode,acquired_at,expires_at) VALUES(?,?,?,?,'exclusive',?,?)");
  for (let i = 0; i < 40; i++) {
    const id = `benchmark-peer-${i}`;
    agent.run(id, root, `Implement independent component ${i}`, ts, ts);
    for (let j = 0; j < 8; j++) lease.run(`fixture-${i}-${j}`, ws, `src/component-${i}/file-${j}.ts`, id, ts, until);
  }
});
const hookInput = { session_id: "benchmark-hook-session", cwd: root, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {} };
ensureAgent(db, { agentId: resolveAgentId(hookInput), repoPath: root, branch: "main" });
writeSnapshot(db);
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => Number(sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)].toFixed(3));
  return { samples: sorted.length, p50Ms: at(0.5), p95Ms: at(0.95), minMs: at(0), maxMs: at(1) };
};
const size = (value) => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value));
const child = (path, args = [], input) => {
  const start = performance.now();
  const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(root, path), ...args],
    { cwd: root, env, input, encoding: "utf8", timeout: 30_000, windowsHide: true });
  if (result.status !== 0) throw new Error(`${path}: ${result.error || result.stderr || result.status}`);
  return { ms: performance.now() - start, stdout: result.stdout };
};
let client;
try {
  const processMs = [], openMs = [], hookMs = [], fleetMs = [], nativeMetadataMs = [], nativeNoopMs = [];
  for (let i = 0; i < samples + 3; i++) {
    const opened = child("scripts/benchmark-worker.mjs");
    const hooked = child("hooks/guard.mjs", ["--post"], JSON.stringify(hookInput));
    if (hooked.stdout.trim()) throw new Error("empty hook emitted context in quiet fixture");
    const start = performance.now();
    getFleet(db);
    if (i >= 3) {
      processMs.push(opened.ms); openMs.push(JSON.parse(opened.stdout).storeOpenMs);
      hookMs.push(hooked.ms); fleetMs.push(performance.now() - start);
    }
    if (nativeHooks) {
      const metadata = child("hooks/codex.mjs", [], JSON.stringify({ ...hookInput, hook_event_name: "PreToolUse", tool_name: "mcp__agent_coord__whoami" }));
      if (JSON.parse(metadata.stdout).hookSpecificOutput.updatedInput._coord.session_id !== hookInput.session_id) throw new Error("native identity forwarding failed");
      const noop = child("hooks/codex.mjs", [], JSON.stringify({ ...hookInput, hook_event_name: "PreToolUse", tool_name: "mcp__browser__snapshot" }));
      if (noop.stdout.trim()) throw new Error("unrelated pre-hook emitted context");
      if (i >= 3) { nativeMetadataMs.push(metadata.ms); nativeNoopMs.push(noop.ms); }
    }
  }
  client = new Client({ name: "coord-benchmark", version: "1.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ["--disable-warning=ExperimentalWarning", join(root, "mcp/server.mjs"), "--tool", "codex"], cwd: root, env });
  const start = performance.now();
  await client.connect(transport);
  const connectMs = performance.now() - start;
  const catalog = (await client.listTools()).tools;
  const instructions = client.getInstructions() || "";
  if (process.argv.includes("--catalog-out")) {
    const path = option("--catalog-out");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ instructions, tools: catalog }) + "\n");
  }
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(JSON.stringify(result));
    return result;
  };
  await call("announce_intent", { task: "Measure coordination overhead" });
  const roundtrip = {};
  const resultBytes = {};
  for (const name of ["read_messages", "list_active_agents", "get_global_state"]) {
    const values = [];
    for (let i = 0; i < samples + 3; i++) {
      const t = performance.now();
      const result = await call(name);
      if (i >= 3) values.push(performance.now() - t);
      resultBytes[name] = size(result);
    }
    roundtrip[name] = stats(values);
  }
  const runtime = createHash("sha256");
  for (const dir of ["lib", "hooks", "mcp", "tier0/lib"]) {
    for (const file of readdirSync(join(root, dir)).filter(f => f.endsWith(".mjs")).sort()) {
      runtime.update(`${dir}/${file}\n`).update(readFileSync(join(root, dir, file)));
    }
  }
  const report = {
    measuredAt: nowIso(), node: process.version, platform: process.platform,
    revision: spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).stdout.trim(),
    runtimeSha256: runtime.digest("hex"),
    fixture: { peers: 40, leasesPerPeer: 8, samples, warmups: 3, nativeHooks, storage: "OS temporary directory", emptyHookOutputBytes: 0 },
    catalog: { tools: catalog.length, instructionsBytes: size(instructions), toolDefinitionsBytes: size(catalog),
      wireBytes: size({ instructions, tools: catalog }),
      // Some hosts prefix the instructions on every tool, as observed in Codex's
      // exposed tool metadata. This is a projection, not provider-billed tokens.
      repeatedInstructionsBytes: size(catalog.map(t => ({ ...t, description: `${instructions}\n\n${t.description}` }))) },
    latency: { storeOpen: stats(openMs), storeProcess: stats(processMs), quietHookProcess: stats(hookMs), fleetRead: stats(fleetMs),
      ...(nativeHooks ? { nativeMetadataProcess: stats(nativeMetadataMs), nativeNoopProcess: stats(nativeNoopMs) } : {}),
      mcpConnectMs: Number(connectMs.toFixed(3)), mcpRoundtrip: roundtrip }, resultBytes,
    limits: "Local synthetic timings, not task completion time or billed model tokens. Whole process timings include Node startup. Run on unchanged fixture and hardware; timings are advisory, never flaky test gates.",
  };
  if (process.argv.includes("--out")) {
    const path = option("--out");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  try { await client?.close(); } catch {}
  db.close();
  // Only the directory created by this process, under the OS temp directory.
  try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
}
