// A known denial must survive failures in optional queue/activity bookkeeping.
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { getDb } from "../lib/store.mjs";
import { ensureAgent } from "../lib/agents.mjs";
import { claimFile, claimResource } from "../lib/leases.mjs";
import { workspaceId } from "../lib/path-canon.mjs";

assert.ok(process.env.AGENT_COORD_HOME, "run through the isolated runner");
const repo = join(process.env.AGENT_COORD_HOME, "fixture-repo");
execFileSync("git", ["init", "-q", repo], { windowsHide: true });
const db = getDb(), ws = workspaceId(repo);
ensureAgent(db, { agentId: "fixture-holder", repoPath: repo });
claimFile(db, { agentId: "fixture-holder", workspaceId: ws, repoPath: repo, path: "held.txt" });
claimResource(db, { agentId: "fixture-holder", resourceId: "port:54321" });
const cases = [
  ["edit", "guard.mjs", "Edit", { file_path: join(repo, "held.txt") }, "file"],
  ["shell-file", "bash-guard.mjs", "Bash", { command: "echo change > held.txt" }, "file"],
  ["shell-resource", "bash-guard.mjs", "Bash", { command: "npm run dev -- --port 54321" }, "resource"],
  ["codex-file", "codex.mjs", "apply_patch", { command: "*** Begin Patch\n*** Update File: held.txt\n@@\n-old\n+new\n*** End Patch" }, "file"],
  ["codex-resource", "codex.mjs", "exec_command", { cmd: "npm run dev -- --port 54321" }, "resource"],
];
let failed = 0;
for (const fault of ["activity", "queue"]) {
  db.exec(fault === "activity"
    ? "CREATE TRIGGER diagnostic_fault BEFORE INSERT ON activity_log WHEN new.event IN ('conflict','resource-conflict','overlap-block') BEGIN SELECT RAISE(ABORT,'fixture activity failure'); END"
    : "CREATE TRIGGER diagnostic_fault BEFORE INSERT ON lease_queue BEGIN SELECT RAISE(ABORT,'fixture queue failure'); END");
  for (const [label, file, tool_name, tool_input, kind] of cases) {
    if (fault === "queue" && kind === "resource") continue;
    const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", fileURLToPath(new URL(`../hooks/${file}`, import.meta.url))], {
      cwd: repo, encoding: "utf8", env: process.env, windowsHide: true, timeout: 5000,
      input: JSON.stringify({ session_id: `fixture-${fault}-${label}`, cwd: repo, hook_event_name: "PreToolUse", tool_name, tool_input }),
    });
    const denied = file === "codex.mjs"
      ? r.status === 0 && r.stdout.includes('"permissionDecision":"deny"')
      : r.status === 2;
    const named = r.stderr.includes("fixture-holder");
    if (!denied || !named) failed++;
    console.log(`${denied && named ? "PASS" : "FAIL"} ${label} preserves denial through ${fault} failure (exit ${r.status})`);
  }
  db.exec("DROP TRIGGER diagnostic_fault");
}
assert.equal(failed, 0, "bookkeeping failures must never override a known refusal");
