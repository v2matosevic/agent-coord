// Test helper: plant an exclusive lease held by "ghost-agent" on <repo>/feature.ts
// in the LIVE store, so the installed global pre-commit hook has something to
// block against. Usage: node test/_plant-lease.mjs <repoPath>
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { getDb, writeTxn, nowIso, isoInSec } from "../lib/store.mjs";
import { ensureAgent } from "../lib/agents.mjs";
import { workspaceId, canonicalFilePath } from "../lib/path-canon.mjs";

const repo = execFileSync("git", ["-C", process.argv[2], "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const db = getDb();
const ws = workspaceId(repo);
const p = canonicalFilePath(repo + "/feature.ts", repo);
ensureAgent(db, { agentId: "ghost-agent", repoPath: repo, branch: "main" });
writeTxn(db, () =>
  db
    .prepare("INSERT INTO file_leases(lease_id,workspace_id,path,agent_id,mode,reason,acquired_at,expires_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(randomUUID(), ws, p, "ghost-agent", "exclusive", "held", nowIso(), isoInSec(600)),
);
console.log("planted exclusive lease:", p, "ws", ws);
