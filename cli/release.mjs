import { getDb, writeTxn } from "../lib/store.mjs";
import { gitContext } from "../lib/git-context.mjs";
import { workspaceId, canonicalFilePath } from "../lib/path-canon.mjs";

// Manual escape hatch for stuck leases.
// Usage: release --resource <id> | --agent <id> | --file <path> | --all
const args = process.argv.slice(2);
const val = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};

const db = getDb();

if (args.includes("--all")) {
  writeTxn(db, () => db.exec("DELETE FROM file_leases; DELETE FROM resource_leases; DELETE FROM lease_queue;"));
  console.log("released ALL leases + queue");
  process.exit(0);
}

const resource = val("--resource");
if (resource) {
  const n = writeTxn(db, () => db.prepare("DELETE FROM resource_leases WHERE resource_id=?").run(resource).changes);
  console.log(`released resource ${resource} (${n})`);
  process.exit(0);
}

const agent = val("--agent");
if (agent) {
  writeTxn(db, () => {
    db.prepare("DELETE FROM file_leases WHERE agent_id=?").run(agent);
    db.prepare("DELETE FROM resource_leases WHERE agent_id=?").run(agent);
    db.prepare("DELETE FROM lease_queue WHERE agent_id=?").run(agent);
  });
  console.log(`released everything held by ${agent}`);
  process.exit(0);
}

const file = val("--file") || val("--force");
if (file) {
  const { repoRoot } = gitContext(process.cwd());
  const ws = workspaceId(repoRoot);
  const p = canonicalFilePath(file, repoRoot);
  const n = writeTxn(db, () => db.prepare("DELETE FROM file_leases WHERE workspace_id=? AND path=?").run(ws, p).changes);
  console.log(`released file ${p} (${n})`);
  process.exit(0);
}

console.log("usage: release --resource <id> | --agent <id> | --file <path> | --all");
