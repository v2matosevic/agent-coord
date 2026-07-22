// The universal net: a commit staging a file another live agent holds is
// blocked; the same commit by the holder itself (committer marker) is allowed.
// The self-check must also survive a MISSED marker (30s TTL — a `npm test &&
// git commit` chain outlives it) via the session-link under the process
// anchor, and recognize the holder's whole session FAMILY (a subagent's
// `base/sub-x` lease must not block its own parent's commit) — i-3eeb7ef8.
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
import { writeSessionLink } from "../lib/session-link.mjs";

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

// Marker points at someone else (stale/foreign) and no link -> still blocked.
writeCommitterMarker(repo, "stranger-Z");
const strangerBlocked = runCheck();

// Same foreign marker, but the session-link under the spawned check's anchor
// (its ppid == this test process) names the holder — the link must rescue the
// self-commit the marker missed. The isolated AGENT_COORD_HOME guarantees no
// real session's link can shadow this candidate.
writeSessionLink(process.pid, "holder-X");
const linkAllowed = runCheck();

// Family: the lease is a SUBAGENT's (`holder-X/explore-ab12`) — the parent
// session's commit must pass on base match, not exact-id match.
writeTxn(db, () => db.prepare("UPDATE file_leases SET agent_id=? WHERE workspace_id=?").run("holder-X/explore-ab12", ws));
ensureAgent(db, { agentId: "holder-X/explore-ab12", repoPath: repo, branch: "main" });
const familyAllowed = runCheck();

writeTxn(db, () => db.prepare("DELETE FROM file_leases WHERE workspace_id=?").run(ws));
rmSync(repo, { recursive: true, force: true });

console.log(
  `other-agent-holds -> exit ${blocked} (want 1); self-commit -> exit ${allowed} (want 0); ` +
    `foreign-marker -> exit ${strangerBlocked} (want 1); link-rescue -> exit ${linkAllowed} (want 0); ` +
    `subagent-family -> exit ${familyAllowed} (want 0)`,
);
const pass = blocked === 1 && allowed === 0 && strangerBlocked === 1 && linkAllowed === 0 && familyAllowed === 0;
console.log(pass ? "PASS ✅ blocks cross-agent commit; self, link-resolved, and family commits pass" : "FAIL ❌");
process.exit(pass ? 0 : 1);
