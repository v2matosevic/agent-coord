// Native hook fixtures + real stdio MCP + real git staging in isolated stores.
import assert from "node:assert/strict";
const assertDenied = (result, label = "") => {
  assert.equal(result.status, 0, label + result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny", label);
};
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const temp = mkdtempSync(join(tmpdir(), "coord-codex-"));
process.env.AGENT_COORD_HOME = join(temp, "store");
const { getDb } = await import("../lib/store.mjs");
const { agentIdFromSession, agentIdFromEnv, sessionIdFromEnv } = await import("../lib/identity.mjs");
const { writeCommitterMarker } = await import("../lib/committer.mjs");
const { workspaceId } = await import("../lib/path-canon.mjs");
const { codexHooks, mergeCodexHooks } = await import("../lib/codex-install.mjs");
const { patchTargets } = await import("../lib/codex-context.mjs");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const db = getDb();
const cleanEnv = { ...process.env, CLAUDE_CODE_SESSION_ID: "", CLAUDECODE: "", CLAUDE_PID: "", CODEX_THREAD_ID: "", AGENT_COORD_NOTIFY: "0" };
const work = join(temp, "repo with spaces");
const other = join(temp, "other");
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: cleanEnv }).trim();
for (const dir of [work, other]) {
  mkdirSync(dir);
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "test");
  git(dir, "config", "user.email", "test@example.invalid");
  git(dir, "config", "core.hooksPath", join(temp, "no-hooks"));
}
mkdirSync(join(work, "src"));
const ws = workspaceId(work);
const hookFile = join(root, "hooks", "codex.mjs");
const a = { session_id: "codex-a", cwd: work };
const b = { session_id: "codex-b", cwd: work };
const hook = (session, event, fields = {}) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", hookFile], {
  env: cleanEnv, cwd: work, encoding: "utf8", input: JSON.stringify({ ...session, hook_event_name: event, ...fields }), timeout: 15000,
});
const good = (r) => { assert.equal(r.status, 0, r.stderr); assert.doesNotMatch(r.stderr, /DEGRADED/); return r.stdout ? JSON.parse(r.stdout) : null; };
const prePatch = (session, patch) => hook(session, "PreToolUse", { tool_name: "apply_patch", tool_input: { command: patch } });
const update = (path) => `*** Begin Patch\n*** Update File: ${path}\n@@\n-old\n+new\n*** End Patch`;
let client;
try {
  assert.equal(agentIdFromEnv({ CODEX_THREAD_ID: "codex-a" }), agentIdFromSession("codex-a"));
  assert.equal(sessionIdFromEnv({ CODEX_THREAD_ID: "child", CLAUDE_CODE_SESSION_ID: "parent" }, "claude-code"), "parent");
  assert.equal(sessionIdFromEnv({ CODEX_THREAD_ID: "child", CLAUDE_CODE_SESSION_ID: "parent" }), "child");
  const startA = hook(a, "SessionStart");
  assert.equal(startA.status, 0, startA.stderr);
  assert.match(startA.stdout, /you are/);
  assert.equal(hook(b, "SessionStart").status, 0);
  const idA = agentIdFromSession(a.session_id), idB = agentIdFromSession(b.session_id);
  assert.notEqual(idA, idB);
  good(prePatch(a, update("src/held.ts")));
  const denied = prePatch(b, update("src/held.ts"));
  assertDenied(denied);
  assert.ok(denied.stderr.includes(idA));
  good(prePatch(a, update("src/held.ts"))); // own hook lease never conflicts
  const batch = `*** Begin Patch\n*** Add File: src/free.ts\n+new\n*** Update File: src/held.ts\n@@\n-old\n+new\n*** End Patch`;
  assertDenied(prePatch(b, batch));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM file_leases WHERE agent_id=?").get(idB).n, 0, "denied patch leaves no partial claims");
  good(prePatch(b, update("src/own.ts")));
  const ownBefore = db.prepare("SELECT * FROM file_leases WHERE agent_id=?").get(idB);
  assertDenied(prePatch(b, batch.replace("src/free.ts", "src/own.ts")));
  assert.deepEqual(db.prepare("SELECT * FROM file_leases WHERE agent_id=?").get(idB), ownBefore, "rollback preserves an existing lease exactly");
  const rename = "*** Begin Patch\n*** Update File: src/old.ts\n*** Move to: src/held.ts\n@@\n-old\n+new\n*** End Patch";
  assert.deepEqual(patchTargets({ command: rename }), ["src/old.ts", "src/held.ts"]);
  assertDenied(prePatch(b, rename), "rename destination protected");
  assertDenied(prePatch(b, "*** Begin Patch\n*** Delete File: src/held.ts\n*** End Patch"));
  good(prePatch({ ...a, cwd: join(work, "src") }, update("relative.ts")));
  assert.ok(db.prepare("SELECT 1 FROM file_leases WHERE agent_id=? AND path='src/relative.ts'").get(idA));
  const shellBlock = hook(b, "PreToolUse", { tool_name: "Bash", tool_input: { command: 'echo changed > "src/held.ts"' } });
  assertDenied(shellBlock, shellBlock.stderr);
  const readOnly = good(hook(a, "PreToolUse", { tool_name: "Bash", tool_input: { command: "git status" } }));
  assert.equal(readOnly, null, "shell hook never forces permissionDecision allow");
  good(hook(a, "PreToolUse", { tool_name: "Bash", tool_input: { command: "npm run dev -- --port 43219" } }));
  assertDenied(hook(b, "PreToolUse", { tool_name: "Bash", tool_input: { command: "npm run dev -- --port 43219" } }), "native shell resource conflict");
  const child = { ...a, agent_id: "child-abcdef", agent_type: "worker" };
  assert.equal(hook(child, "SubagentStart").status, 0);
  good(prePatch(child, update("src/child.ts")));
  assertDenied(prePatch(a, update("src/child.ts")), "child and parent edits remain distinct");
  good(hook(a, "SubagentStop")); // missing child id cannot end the parent
  assert.equal(db.prepare("SELECT status FROM agents WHERE agent_id=?").get(idA).status, "active");
  good(hook(child, "SubagentStop"));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM file_leases WHERE path='src/child.ts'").get().n, 0);

  // The native hook rewrites only coordination MCP calls, with the real session.
  const rewritten = good(hook(a, "PreToolUse", { tool_name: "mcp__agent_coord__whoami", tool_input: {} })).hookSpecificOutput.updatedInput;
  assert.deepEqual(rewritten, { _coord: a });
  client = new Client({ name: "codex-test", version: "1" }, { capabilities: {} });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--disable-warning=ExperimentalWarning", join(root, "mcp", "server.mjs"), "--tool", "codex"], cwd: work, env: cleanEnv }));
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(!r.isError, r.content[0].text);
    return JSON.parse(r.content[0].text);
  };
  assert.equal((await call("whoami", rewritten)).agentId, idA);
  assert.equal((await call("whoami", rewritten)).coordinationMode, "native-hooks");
  const own = await call("claim_files", { paths: ["src/held.ts"], _coord: a });
  assert.equal(own.results[0].granted, true, "MCP and hook share the same identity");
  const [parent, peer] = await Promise.all([call("whoami", { _coord: a }), call("whoami", { _coord: b })]);
  assert.equal(parent.agentId, idA);
  assert.equal(peer.agentId, idB);
  assert.equal((await call("whoami", { _coord: a })).agentId, idA);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agents WHERE status='active'").get().n, 2, "no unused MCP ghost");
  const away = { session_id: "codex-away", cwd: other };
  const otherMe = await call("whoami", { _coord: away });
  assert.equal(otherMe.workspace, workspaceId(other));
  assert.equal((await call("whoami", { _coord: a })).workspace, ws, "workspace does not leak between requests");
  // Test messages stay in this disposable store, never reach real agents.
  await call("post_message", { _coord: b, to: idA, body: "peer integration ready" });
  const delivered = good(hook(a, "PostToolUse", { tool_name: "Bash", tool_input: { command: "git status" } }));
  assert.match(delivered.hookSpecificOutput.additionalContext, /peer integration ready/);
  assert.equal(good(hook(a, "PostToolUse", { tool_name: "Bash" })), null, "message delivered once");
  assert.equal((await call("read_messages", { _coord: away })).messages.length, 0);
  // No ambient MCP-server identity may authorize a different hook thread's push.
  const malformed = await client.callTool({ name: "whoami", arguments: { _coord: { cwd: work } } });
  assert.equal(malformed.isError, true);
  await client.close(); client = null;
  assert.equal(db.prepare("SELECT status FROM agents WHERE agent_id=?").get(idA).status, "active", "MCP disconnect preserves native session");

  // Git hooks recognize Codex's exact identity, even with a peer's warm marker.
  writeFileSync(join(work, "src", "held.ts"), "new\n");
  writeFileSync(join(work, "src", "own.ts"), "new\n");
  git(work, "add", "src/held.ts");
  const check = (id) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(root, "cli", "precommit-check.mjs")], { env: { ...cleanEnv, CODEX_THREAD_ID: id }, cwd: work, encoding: "utf8" });
  writeCommitterMarker(work, idB);
  assert.equal(check(a.session_id).status, 0, "Codex can commit its own claimed file");
  git(work, "add", "src/own.ts");
  assert.equal(check(a.session_id).status, 1, "foreign marker cannot exempt a peer's file");
  git(work, "commit", "-qm", "test provenance");
  const logged = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(root, "cli", "log-commit.mjs")], { cwd: work, env: { ...cleanEnv, CODEX_THREAD_ID: a.session_id }, encoding: "utf8" });
  assert.equal(logged.status, 0);
  assert.equal(db.prepare("SELECT agent_id FROM activity_log WHERE event='commit' ORDER BY seq DESC LIMIT 1").get().agent_id, idA);

  // Installer preserves other hooks and can be re-run without duplicate entries.
  const existing = { description: "user config", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "user-guard" }] }], Stop: [{ hooks: [{ type: "command", command: "user-stop" }] }] } };
  const wanted = codexHooks(root);
  const merged = mergeCodexHooks(existing, wanted);
  assert.deepEqual(mergeCodexHooks(merged, wanted), merged);
  assert.throws(() => mergeCodexHooks([], wanted));
  assert.throws(() => mergeCodexHooks({ hooks: [] }, wanted));
  assert.deepEqual(merged.hooks.Stop, existing.hooks.Stop);
  assert.deepEqual(merged.hooks.PreToolUse[0], existing.hooks.PreToolUse[0]);
  const configHome = join(temp, "codex-home");
  mkdirSync(configHome);
  const configFile = join(configHome, "hooks.json");
  writeFileSync(configFile, JSON.stringify(existing));
  const install = () => spawnSync(process.execPath, [join(root, "cli", "install-codex-hooks.mjs"), "--codex-home", configHome], { encoding: "utf8", env: cleanEnv });
  assert.equal(install().status, 0);
  const first = readFileSync(configFile, "utf8");
  assert.match(install().stdout, /already current/);
  assert.equal(readFileSync(configFile, "utf8"), first);
  writeFileSync(configFile, "{invalid");
  assert.notEqual(install().status, 0);
  assert.equal(readFileSync(configFile, "utf8"), "{invalid", "invalid config is never overwritten");
  good(hook(a, "SessionEnd"));
  assert.equal(db.prepare("SELECT status FROM agents WHERE agent_id=?").get(idA).status, "dead");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM file_leases WHERE agent_id=?").get(idA).n, 0);
  console.log("PASS Codex: atomic patch guard, shell guard, session/MCP identity, scoped mail, commit safety, lifecycle and installer");
} finally {
  if (client) await client.close();
  db.close();
  rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
