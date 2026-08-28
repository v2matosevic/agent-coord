// Commit provenance: the post-commit hook must attribute a commit to the Claude
// session that ran it, from the session id in the environment — exact and
// per-process — before falling back to the 30s per-repo committer marker, and
// only then to "manual". Seven sessions in three days saw their own commits
// come back "manual"/a peer's name because only the marker existed (i-4e28f13d).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const home = mkdtempSync(join(tmpdir(), "coord-attr-"));
process.env.AGENT_COORD_HOME = home;
const { getDb } = await import("../lib/store.mjs");
const { agentIdFromSession } = await import("../lib/identity.mjs");
const { writeCommitterMarker } = await import("../lib/committer.mjs");
const { workspaceId } = await import("../lib/path-canon.mjs");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOG = join(root, "cli", "log-commit.mjs");
const work = mkdtempSync(join(tmpdir(), "attr-repo-"));
const g = (...a) => execFileSync("git", ["-C", work, ...a], { encoding: "utf8" }).trim();
g("init", "-q");
g("config", "user.email", "t@t");
g("config", "user.name", "t");
g("config", "core.hooksPath", join(work, ".nohooks")); // keep the machine's global hooks out of this repo

let n = 0;
const commit = () => {
  writeFileSync(join(work, `f${++n}.txt`), String(n));
  g("add", ".");
  g("commit", "-qm", `c${n}`);
  return g("rev-parse", "--short", "HEAD");
};
// Run the post-commit target the way git would: cwd = repo, given env.
const scrub = { CLAUDE_CODE_SESSION_ID: "", CLAUDECODE: "", CLAUDE_PID: "" };
const logCommit = (env) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", LOG], { cwd: work, env: { ...process.env, ...scrub, ...env }, encoding: "utf8" });

const db = getDb();
const repo = g("rev-parse", "--show-toplevel");
const ws = workspaceId(repo);
const who = (hash) => db.prepare("SELECT agent_id FROM activity_log WHERE event='commit' AND workspace_id=? AND detail LIKE ? ORDER BY seq DESC").get(ws, hash + "\t%")?.agent_id;
const checks = {};

// 1) Env session id → the session's hook name, no marker needed.
const SID = "attr-session-" + process.pid;
const h1 = commit();
logCommit({ CLAUDE_CODE_SESSION_ID: SID });
checks["env session id attributes the commit to the session's name"] = who(h1) === agentIdFromSession(SID);

// 2) No env, no marker → manual (a human / non-Claude tool).
const h2 = commit();
logCommit({});
checks["no env + no marker → manual"] = who(h2) === "manual";

// 3) No env, marker present → the marker's agent (the shell-guard path still works).
const h3 = commit();
writeCommitterMarker(repo, "marker-agent");
logCommit({});
checks["marker still attributes when env is absent"] = who(h3) === "marker-agent";

// 4) Env beats a stale/foreign marker: the marker is per-repo with a 30s TTL, so
//    a peer's marker could still be warm when THIS session commits.
const h4 = commit();
writeCommitterMarker(repo, "some-peer");
logCommit({ CLAUDE_CODE_SESSION_ID: SID });
checks["env beats a warm marker left by a peer"] = who(h4) === agentIdFromSession(SID);

let ok = true;
for (const [k, v] of Object.entries(checks)) {
  if (!v) ok = false;
  console.log(`${v ? "✅" : "❌"} ${k}`);
}
for (const d of [work, home]) {
  try {
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
}
console.log(ok ? "PASS ✅ commit attribution: env → marker → manual" : "FAIL ❌");
process.exit(ok ? 0 : 1);
