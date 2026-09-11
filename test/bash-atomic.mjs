// A denied shell command must not keep reservations for work it never started.
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { getDb } from "../lib/store.mjs";
import { ensureAgent } from "../lib/agents.mjs";
import { claimFile, claimResource } from "../lib/leases.mjs";
import { agentIdFromSession } from "../lib/identity.mjs";
import { workspaceId } from "../lib/path-canon.mjs";

assert.ok(process.env.AGENT_COORD_HOME, "run through the isolated runner");
const repo = join(process.env.AGENT_COORD_HOME, "fixture-repo");
execFileSync("git", ["init", "-q", repo], { windowsHide: true });
const db = getDb(), ws = workspaceId(repo), session = "fixture-shell", id = agentIdFromSession(session);
for (const agentId of [id, "fixture-holder"]) ensureAgent(db, { agentId, repoPath: repo });
claimFile(db, { agentId: "fixture-holder", workspaceId: ws, repoPath: repo, path: "held.txt" });
claimFile(db, { agentId: id, workspaceId: ws, repoPath: repo, path: "existing.txt" });
claimResource(db, { agentId: "fixture-holder", resourceId: "port:54321" });
const before = db.prepare("SELECT * FROM file_leases WHERE agent_id=?").all(id);
const run = (command) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", fileURLToPath(new URL("../hooks/bash-guard.mjs", import.meta.url))], {
  cwd: repo, encoding: "utf8", env: process.env, windowsHide: true, timeout: 5000,
  input: JSON.stringify({ session_id: session, cwd: repo, tool_name: "Bash", tool_input: { command } }),
});
const denied = run("echo own > existing.txt; echo free > fresh.txt; npm run dev -- --port 54322; echo blocked > held.txt");
assert.equal(denied.status, 2, denied.stderr);
console.log("After denied command:", JSON.stringify({ files: db.prepare("SELECT COUNT(*) n FROM file_leases WHERE agent_id=?").get(id).n,
  resources: db.prepare("SELECT COUNT(*) n FROM resource_leases WHERE agent_id=?").get(id).n }));
assert.deepEqual(db.prepare("SELECT * FROM file_leases WHERE agent_id=?").all(id), before, "all new file claims and renewal timestamps roll back together");
assert.equal(db.prepare("SELECT COUNT(*) n FROM resource_leases WHERE agent_id=?").get(id).n, 0, "a denied command did not start a dev server");
const resourceDenied = run("echo free > fresh.txt; npm run dev -- --port 54321");
assert.equal(resourceDenied.status, 2, resourceDenied.stderr);
assert.deepEqual(db.prepare("SELECT * FROM file_leases WHERE agent_id=?").all(id), before);
const allowed = run("echo free > fresh.txt; npm run dev -- --port 54322");
assert.equal(allowed.status, 0, allowed.stderr);
assert.ok(db.prepare("SELECT 1 FROM file_leases WHERE agent_id=? AND path='fresh.txt'").get(id));
assert.ok(db.prepare("SELECT 1 FROM resource_leases WHERE agent_id=? AND resource_id='port:54322'").get(id));
console.log("Shell file/resource reservations commit as one operation and existing claims survive a refusal unchanged");
