// Hold a file lease as a live agent (simulates "another agent is editing it now").
// Usage: node test/_hold.mjs <repoPath> <relpath> [agentId]
import { getDb } from "../lib/store.mjs";
import { gitContext } from "../lib/git-context.mjs";
import { workspaceId } from "../lib/path-canon.mjs";
import { ensureAgent } from "../lib/agents.mjs";
import { claimFile } from "../lib/leases.mjs";

const repo = gitContext(process.argv[2]).repoRoot;
const path = process.argv[3];
const id = process.argv[4] || "holder-live";
const db = getDb();
ensureAgent(db, { agentId: id, repoPath: repo, branch: "master" });
const r = claimFile(db, { agentId: id, workspaceId: workspaceId(repo), repoPath: repo, branch: "master", path, mode: "exclusive", reason: "editing" });
console.log(`holder ${id} claim ${path} -> ${r.granted ? "GRANTED" : "FAILED"}`);
