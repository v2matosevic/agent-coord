// Integration: the live Bash hook (hooks/bash-guard.mjs) blocks a shell command
// that writes a file a warm peer holds, and allows free / read-only commands.
// Runs the real hook as a child process with JSON on stdin, like Claude does.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../lib/store.mjs";
import { ensureAgent, heartbeat } from "../lib/agents.mjs";
import { claimFile } from "../lib/leases.mjs";
import { workspaceId } from "../lib/path-canon.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GUARD = join(ROOT, "hooks", "bash-guard.mjs");

const repo = mkdtempSync(join(tmpdir(), "ac-bashguard-"));
execFileSync("git", ["init", "-q"], { cwd: repo });
execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
execFileSync("git", ["config", "user.name", "t"], { cwd: repo });

const db = getDb();
const ws = workspaceId(repo);
ensureAgent(db, { agentId: "ghost-1", tool: "claude-code", repoPath: repo, branch: "main" });
heartbeat(db, "ghost-1");
claimFile(db, { agentId: "ghost-1", workspaceId: ws, repoPath: repo, branch: "main", path: "notes.txt", mode: "exclusive" });

const runGuard = (command) =>
  spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", GUARD], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: repo, session_id: "tester-xyz" }),
    encoding: "utf8",
  });

let ok = true;
const check = (cond, msg) => {
  if (!cond) ok = false;
  console.log(`  ${cond ? "✓" : "✗"} ${msg}`);
};

check(runGuard("echo hi > notes.txt").status === 2, "shell write to a peer-held file is blocked (exit 2)");
check(runGuard("sed -i 's/a/b/' notes.txt").status === 2, "sed -i on a peer-held file is blocked");
check(runGuard("echo hi > other.txt").status === 0, "writing a free file is allowed");
check(runGuard("cat notes.txt | grep x").status === 0, "read-only command on the held file is allowed");
check(runGuard('git commit -m "touch notes.txt > x"').status === 0, "commit whose message mentions the file is not blocked");

console.log(ok ? "PASS ✅" : "FAIL ❌");
process.exit(ok ? 0 : 1);
