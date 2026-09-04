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
import { agentIdFromSession } from "../lib/identity.mjs";

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
// A hook may have recorded a fallback before the final attribution was known.
// Query-plan order must never let that older record overwrite the newer one.
logActivity(db, { agentId: "manual", workspaceId: ws, event: "commit", detail: `${hPeer}\tfeature by peer` });
logActivity(db, { agentId: PEER, workspaceId: ws, event: "commit", detail: `${hPeer}\tfeature by peer` });
logActivity(db, { agentId: PEER, workspaceId: ws, event: "commit", detail: `${hWip}\twip: half done` });

const r = analyzePendingPush(db, repo, ME);
const v = Object.fromEntries(r.commits.map((c) => [c.subject, c.verdict]));
db.exec("PRAGMA reverse_unordered_selects=ON");
const reversed = analyzePendingPush(db, repo, ME);
db.exec("PRAGMA reverse_unordered_selects=OFF");
const stableAttribution = reversed.commits.find((c) => c.hash === hPeer)?.verdict === "push-peer-done";

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

// Own-commit recognition via the env session id: the post-commit hook stamps
// commits with agentIdFromSession(CLAUDE_CODE_SESSION_ID); a caller in that same
// session (any id it happens to run under) must see them as push-mine.
const SID = "pp-env-" + process.pid;
const ENV_ME = agentIdFromSession(SID);
const hEnv = commit("f.txt", "feature via env session");
ensureAgent(db, { agentId: ENV_ME, repoPath: repo, branch: "main" }); // live → would be ask-peer without the bridge
logActivity(db, { agentId: ENV_ME, workspaceId: ws, event: "commit", detail: `${hEnv}\tfeature via env session` });
process.env.CLAUDE_CODE_SESSION_ID = SID;
const r3 = analyzePendingPush(db, repo, "pp-someone-else-" + process.pid);
delete process.env.CLAUDE_CODE_SESSION_ID;
const envVerdict = r3.commits.find((c) => c.subject === "feature via env session")?.verdict;

// Scope is named in EVERY result (i-789380cb / i-103b1445): the repo, branch and
// upstream inspected — and a NESTED checkout resolves to itself, never the outer.
const inner = join(work, "inner");
const innerRemote = join(base, "inner-remote.git");
execFileSync("git", ["init", "--bare", "-q", innerRemote]);
execFileSync("git", ["clone", "-q", innerRemote, inner]);
g(inner, "config", "user.email", "t@t");
g(inner, "config", "user.name", "t");
writeFileSync(join(inner, "i.txt"), "1");
g(inner, "add", ".");
g(inner, "commit", "-qm", "inner base");
g(inner, "push", "-u", "-q", "origin", "HEAD");
const rInnerClean = analyzePendingPush(db, join(inner, "deeper-nonexistent-cwd-parent") /* resolves up to inner */, ME);
writeFileSync(join(inner, "j.txt"), "1");
g(inner, "add", ".");
g(inner, "commit", "-qm", "inner unpushed");
const innerRoot = g(inner, "rev-parse", "--show-toplevel");
const rInner = analyzePendingPush(db, inner, ME);
const rOuter = analyzePendingPush(db, work, ME);
const outerRoot = g(work, "rev-parse", "--show-toplevel");
const scopeOk =
  rInner.repo === innerRoot && rInner.commits.length === 1 && rInner.commits[0].subject === "inner unpushed" && typeof rInner.upstreamRef === "string" && rInner.range === `${rInner.upstreamRef}..HEAD` &&
  rOuter.repo === outerRoot && rOuter.commits.length >= 4 &&
  rInnerClean.repo === innerRoot && rInnerClean.commits.length === 0 && rInnerClean.upstream === true && rInnerClean.recommendation.includes(innerRoot);
const notRepo = analyzePendingPush(db, join(base, "nowhere-" + process.pid), ME);
const notRepoOk = notRepo.upstream === false && notRepo.commits.length === 0 && /not a git repo/i.test(notRepo.recommendation);

const pass =
  stableAttribution &&
  envVerdict === "push-mine" &&
  scopeOk &&
  notRepoOk &&
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
console.log("env-session verdict:", envVerdict, "| nested scope ok:", scopeOk, "| non-repo ok:", notRepoOk);
console.log("inner:", rInner.repo, rInner.range, "| outer:", rOuter.repo, rOuter.range);
console.log("recommendation:", r.recommendation);
console.log(pass ? "PASS ✅ provenance + push verdicts correct" : "FAIL ❌");
process.exit(pass ? 0 : 1);
