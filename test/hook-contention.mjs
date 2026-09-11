import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getDb } from "../lib/store.mjs";
import { resolveAgentId } from "../lib/identity.mjs";
import { ensureAgent } from "../lib/agents.mjs";
import { claimFile } from "../lib/leases.mjs";
import { postMessage } from "../lib/messages.mjs";
import { gitContext } from "../lib/git-context.mjs";

assert.ok(process.env.AGENT_COORD_HOME, "run through the isolated runner");
const root = fileURLToPath(new URL("../", import.meta.url));
const session = { session_id: "hook-contention-session", cwd: root };
const id = resolveAgentId(session);
const db = getDb();
const context = gitContext(root);
ensureAgent(db, { agentId: id, tool: "codex", repoPath: context.repoRoot, branch: context.branch });
claimFile(db, { agentId: id, workspaceId: "fixture", path: "held.ts" });
postMessage(db, { fromAgent: "fixture-peer", workspaceId: "fixture", toAgent: id, body: "keep this unread during contention" });
const run = (hook_event_name, fields = {}) => {
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", fileURLToPath(new URL("../hooks/codex.mjs", import.meta.url))], {
    env: process.env, cwd: root, input: JSON.stringify({ ...session, hook_event_name, ...fields }),
    encoding: "utf8", windowsHide: true, timeout: hook_event_name === "SessionEnd" ? 3000 : 4000,
  });
  assert.equal(r.status, 0, `${hook_event_name} must return before the host timeout with a writer held: ${r.error || r.stderr}`);
  return r;
};
db.exec("BEGIN IMMEDIATE");
try {
  const forwarded = run("PreToolUse", { tool_name: "mcp__agent_coord__claim_files", tool_input: { paths: ["x.ts"] } });
  const updated = JSON.parse(forwarded.stdout).hookSpecificOutput.updatedInput;
  assert.deepEqual(updated, { paths: ["x.ts"], _coord: session });
  assert.equal(forwarded.stderr, "", "metadata forwarding must not touch SQLite");
  const irrelevant = run("PreToolUse", { tool_name: "mcp__browser__snapshot", tool_input: {} });
  assert.equal(irrelevant.stdout + irrelevant.stderr, "", "unrelated pre-tool hook is a silent no-op");
  const read = run("PreToolUse", { tool_name: "exec_command", tool_input: { cmd: "git status --short" } });
  assert.equal(read.stdout + read.stderr, "", "unchanged read-only shell context needs no database write");
  const write = run("PreToolUse", { tool_name: "apply_patch", tool_input: { command: "*** Begin Patch\n*** Add File: blocked.ts\n+test\n*** End Patch" } });
  assert.equal(JSON.parse(write.stdout).hookSpecificOutput.permissionDecision, "deny", "ownership uncertainty must not allow a write");
  assert.match(write.stderr, /budget|deadline/i);
  const end = run("SessionEnd");
  assert.match(end.stderr, /budget|deadline/i);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM file_leases WHERE agent_id=?").get(id).n, 1, "failed cleanup must not partly release claims");
  assert.equal(db.prepare("SELECT last_seq FROM message_reads WHERE agent_id=?").get(id), undefined, "unreturned messages stay unread");
} finally { db.exec("ROLLBACK"); }
const recovered = run("PreToolUse", { tool_name: "apply_patch", tool_input: { command: "*** Begin Patch\n*** Add File: recovered.ts\n+test\n*** End Patch" } });
assert.equal(recovered.stderr, "", "next event recovers when the writer releases");
assert.equal(recovered.stdout, "");
console.log("Busy store: metadata forwards, irrelevant pre-hooks skip, unchecked edits deny, teardown returns, unread mail survives, next event recovers");
