// The universal net: a commit staging a file another live agent holds is
// blocked; the same commit by the holder itself (committer marker) is allowed.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { getDb, writeTxn, nowIso, isoInSec } from "../lib/store.mjs";
import { ensureAgent } from "../lib/agents.mjs";
import { workspaceId, canonicalFilePath } from "../lib/path-canon.mjs";
import { writeCommitterMarker } from "../lib/committer.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const check = join(__dir, "..", "cli", "precommit-check.mjs");
const repo = mkdtempSync(join(tmpdir(), "coord-pc-"));
const g = (args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });

g(["init", "-q"]);
g(["config", "user.email", "t@t"]);
g(["config", "user.name", "t"]);
writeFileSync(join(repo, "a.txt"), "hello");
g(["add", "a.txt"]);

const db = getDb();
const ws = workspaceId(repo);
const p = canonicalFilePath(join(repo, "a.txt"), repo);
ensureAgent(db, { agentId: "holder-X", repoPath: repo, branch: "main" });
writeTxn(db, () =>
  db
    .prepare("INSERT INTO file_leases(lease_id,workspace_id,path,agent_id,mode,reason,acquired_at,expires_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(randomUUID(), ws, p, "holder-X", "exclusive", "x", nowIso(), isoInSec(600)),
);

const runCheck = () => {
  try {
    execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", check], { cwd: repo, stdio: ["ignore", "ignore", "ignore"] });
    return 0;
  } catch (e) {
    return e.status ?? 1;
  }
};

const blocked = runCheck(); // other agent holds it, no committer marker -> 1
writeCommitterMarker(repo, "holder-X"); // now "I" am the committer -> 0
const allowed = runCheck();

writeTxn(db, () => db.prepare("DELETE FROM file_leases WHERE workspace_id=?").run(ws));
rmSync(repo, { recursive: true, force: true });

console.log(`other-agent-holds -> exit ${blocked} (want 1); self-commit -> exit ${allowed} (want 0)`);
const pass = blocked === 1 && allowed === 0;
console.log(pass ? "PASS ✅ blocks cross-agent commit, allows self-commit" : "FAIL ❌");
process.exit(pass ? 0 : 1);
