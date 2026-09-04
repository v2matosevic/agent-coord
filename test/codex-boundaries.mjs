// Boundaries a happy-path hook fixture misses: no partial shell claims, cwd
// outside the session repo, and files not yet created through a directory alias.
import assert from "node:assert/strict";
const assertDenied = (result, label = "") => {
  assert.equal(result.status, 0, label + result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny", label);
};
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const temp = mkdtempSync(join(tmpdir(), "coord-boundary-"));
process.env.AGENT_COORD_HOME = join(temp, "store");
const { getDb } = await import("../lib/store.mjs");
const { ensureAgent } = await import("../lib/agents.mjs");
const { claimResource, claimFile } = await import("../lib/leases.mjs");
const { agentIdFromSession } = await import("../lib/identity.mjs");
const { workspaceId, canonicalFilePath } = await import("../lib/path-canon.mjs");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const db = getDb();
const env = { ...process.env, CODEX_THREAD_ID: "", CLAUDE_CODE_SESSION_ID: "", CLAUDECODE: "", CLAUDE_PID: "", AGENT_COORD_NOTIFY: "0" };
const one = join(temp, "one"), two = join(temp, "two");
for (const dir of [one, two]) {
  mkdirSync(dir);
  execFileSync("git", ["init", "-q", dir], { env });
  mkdirSync(join(dir, "src"));
}
const id = agentIdFromSession("boundary-agent");
const hook = (fields) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(root, "hooks", "codex.mjs")], {
  cwd: one, env, encoding: "utf8", timeout: 15000,
  input: JSON.stringify({ session_id: "boundary-agent", cwd: one, hook_event_name: "PreToolUse", ...fields }),
});
const checks = [];
const check = (label, fn) => { try { fn(); checks.push(true); console.log("PASS " + label); } catch (e) { checks.push(false); console.error("FAIL " + label + ": " + e.message); } };
try {
  ensureAgent(db, { agentId: "peer", repoPath: two });
  claimResource(db, { agentId: "peer", resourceId: "port:41234" });
  check("denied shell operation leaves no file claims", () => {
    const result = hook({ tool_name: "Bash", tool_input: { command: "npm run dev -- --port 41234 > src/server.log" } });
    assertDenied(result, result.stderr);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM file_leases WHERE agent_id=?").get(id).n, 0);
  });
  claimFile(db, { agentId: "peer", workspaceId: workspaceId(two), repoPath: two, path: "src/held.ts" });
  check("workdir in another repo honors that repo's peer claims", () => {
    const result = hook({ tool_name: "Bash", tool_input: { command: "echo changed > src/held.ts", workdir: two } });
    assertDenied(result, result.stderr);
  });
  check("fleet follows a changed working directory without waiting for heartbeat expiry", () => {
    assert.equal(hook({ tool_name: "Bash", tool_input: { command: "git status", workdir: two } }).status, 0);
    assert.equal(workspaceId(db.prepare("SELECT repo_path FROM agents WHERE agent_id=?").get(id).repo_path), workspaceId(two));
    assert.equal(hook({ tool_name: "Bash", tool_input: { command: "git status" } }).status, 0);
    assert.equal(workspaceId(db.prepare("SELECT repo_path FROM agents WHERE agent_id=?").get(id).repo_path), workspaceId(one));
  });
  const alias = join(temp, "alias");
  check("leaving git clears the previous branch during the heartbeat interval", () => {
    assert.equal(hook({ tool_name: "Bash", tool_input: { command: "echo outside", workdir: temp } }).status, 0);
    assert.equal(db.prepare("SELECT branch FROM agents WHERE agent_id=?").get(id).branch, null);
  });
  symlinkSync(one, alias, process.platform === "win32" ? "junction" : "dir");
  check("new files reached through a directory alias share one lease key", () => {
    assert.equal(canonicalFilePath(join(alias, "src", "new.ts"), one), "src/new.ts");
    const result = hook({ cwd: alias, tool_name: "apply_patch", tool_input: { command: "*** Begin Patch\n*** Add File: src/new.ts\n+test\n*** End Patch" } });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(db.prepare("SELECT 1 FROM file_leases WHERE workspace_id=? AND path='src/new.ts' AND agent_id=?").get(workspaceId(one), id));
  });
} finally {
  db.close();
  rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
process.exitCode = checks.every(Boolean) ? 0 : 1;
