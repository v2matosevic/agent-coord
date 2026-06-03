// Commit provenance + push verdicts: an agent reviewing unpushed commits should
// mark its own as push-mine, a finished peer's as push-peer-done, and WIP as hold.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, writeTxn, isoAgoMs } from "../lib/store.mjs";
import { ensureAgent } from "../lib/agents.mjs";
import { logActivity } from "../lib/activity.mjs";
import { workspaceId } from "../lib/path-canon.mjs";
import { analyzePendingPush } from "../lib/pending-push.mjs";
import { writeSessionLink } from "../lib/session-link.mjs";

const g = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" }).trim();
const base = mkdtempSync(join(tmpdir(), "pp-"));
const remote = join(base, "remote.git");
const work = join(base, "work");
execFileSync("git", ["init", "--bare", "-q", remote]);
execFileSync("git", ["clone", "-q", remote, work]);
g(work, "config", "user.email", "t@t");
g(work, "config", "user.name", "t");
writeFileSync(join(work, "a.txt"), "1");
g(work, "add", ".");
g(work, "commit", "-qm", "base");
g(work, "push", "-u", "-q", "origin", "HEAD");

// three unpushed commits: mine, a peer's, a WIP
const commit = (f, msg) => { writeFileSync(join(work, f), "1"); g(work, "add", "."); g(work, "commit", "-qm", msg); return g(work, "rev-parse", "--short", "HEAD"); };
const hMine = commit("b.txt", "feature by me");
const hPeer = commit("c.txt", "feature by peer");
const hWip = commit("d.txt", "wip: half done");

const db = getDb();
const repo = g(work, "rev-parse", "--show-toplevel");
const ws = workspaceId(repo);
const ME = "pp-me-" + process.pid;
const PEER = "pp-peer-" + process.pid;
ensureAgent(db, { agentId: ME, repoPath: repo, branch: "main" });
ensureAgent(db, { agentId: PEER, repoPath: repo, branch: "main" });
writeTxn(db, () => db.prepare("UPDATE agents SET last_heartbeat=? WHERE agent_id=?").run(isoAgoMs(10 * 60 * 1000), PEER)); // PEER finished
logActivity(db, { agentId: ME, workspaceId: ws, event: "commit", detail: `${hMine}\tfeature by me` });
logActivity(db, { agentId: PEER, workspaceId: ws, event: "commit", detail: `${hPeer}\tfeature by peer` });
logActivity(db, { agentId: PEER, workspaceId: ws, event: "commit", detail: `${hWip}\twip: half done` });

const r = analyzePendingPush(db, repo, ME);
const v = Object.fromEntries(r.commits.map((c) => [c.subject, c.verdict]));

// Session-link recognition: the MCP server resolved a STANDALONE id (lost the
// SessionStart race / resumed), but the commit is by the HOOK id this session is
// bridged to via the session-link for our parent pid. It must read as push-mine,
// not a live peer's commit — otherwise the auto-push rule wrongly blocks on self.
const HOOK = "pp-hook-" + process.pid;
const STANDALONE = "pp-standalone-" + process.pid;
const hLink = commit("e.txt", "feature via session-link");
ensureAgent(db, { agentId: HOOK, repoPath: repo, branch: "main" }); // live, so without the bridge it'd be ask-peer
logActivity(db, { agentId: HOOK, workspaceId: ws, event: "commit", detail: `${hLink}\tfeature via session-link` });
writeSessionLink(process.ppid, HOOK);
const r2 = analyzePendingPush(db, repo, STANDALONE);
const linkVerdict = r2.commits.find((c) => c.subject === "feature via session-link")?.verdict;

const pass =
  v["feature by me"] === "push-mine" &&
  v["feature by peer"] === "push-peer-done" &&
  v["wip: half done"] === "hold-wip" &&
  r.allClear === false && // a WIP commit is present
  linkVerdict === "push-mine"; // recognized as ours via the session-link bridge
writeTxn(db, () => {
  db.prepare("DELETE FROM activity_log WHERE workspace_id=?").run(ws);
  db.prepare("DELETE FROM agents WHERE agent_id IN (?,?,?)").run(ME, PEER, HOOK);
});
try {
  rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
} catch {} // git holds Windows file locks briefly; temp dir is disposable

console.log("verdicts:", JSON.stringify(v));
console.log("recommendation:", r.recommendation);
console.log(pass ? "PASS ✅ provenance + push verdicts correct" : "FAIL ❌");
process.exit(pass ? 0 : 1);
