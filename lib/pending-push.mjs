import { execFileSync } from "node:child_process";
import { isoAgoMs } from "./store.mjs";
import { DEAD_MS } from "./config.mjs";
import { workspaceId } from "./path-canon.mjs";
import { readSessionLink, readSessionLinkAny } from "./session-link.mjs";
import { baseAgentId, agentIdFromEnv } from "./identity.mjs";
import { gitContext } from "./git-context.mjs";

// Answers "I was told to push — but there are commits I didn't make; what do I do?"
// without bugging the human. Maps each unpushed commit to its author-agent (via
// the commit-provenance we log) + whether that agent is still live + WIP flag,
// then recommends. Honest about reachability: a finished agent can't be asked, so
// its committed (non-WIP) work is treated as a done unit; a LIVE peer's commit
// should be confirmed with that peer before pushing.

const git = (args, cwd) => execFileSync("git", args, { encoding: "utf8", cwd }).trim();

export function analyzePendingPush(db, repo, meAgentId = null, { ppids = null, includeAmbientIdentity = true } = {}) {
  // Resolve the NEAREST enclosing checkout of the path we were handed, and say
  // which one we answered about in every result — including the empty ones. An
  // unqualified "nothing to push" was indistinguishable from "I looked at the
  // outer repo" (i-789380cb / i-103b1445), and this tool's all-clear is the
  // standing push authorisation, so an unscoped answer manufactures consent.
  const ctx = gitContext(repo);
  if (!ctx.repoRoot) return { repo: String(repo), branch: null, upstream: false, commits: [], recommendation: `Not a git repo: ${repo}` };
  repo = ctx.repoRoot;
  const scope = { repo, branch: ctx.branch };
  const ws = workspaceId(repo);
  let ahead;
  try {
    scope.upstreamRef = git(["rev-parse", "--abbrev-ref", "@{u}"], repo);
    ahead = git(["log", "@{u}..HEAD", "--format=%h%x09%s"], repo);
  } catch {
    return { ...scope, upstream: false, commits: [], recommendation: `No upstream tracking branch on ${ctx.branch} in ${repo} — can't tell what's unpushed.` };
  }
  scope.range = `${scope.upstreamRef}..HEAD`;
  const lines = ahead.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { ...scope, upstream: true, commits: [], recommendation: `Up to date with ${scope.upstreamRef} — nothing to push from ${repo} (${ctx.branch}).` };

  const provenance = new Map(
    db.prepare("SELECT agent_id, detail FROM activity_log WHERE event='commit' AND workspace_id=?").all(ws).map((r) => [String(r.detail).split("\t")[0], r.agent_id]),
  );
  const live = new Set(db.prepare("SELECT agent_id FROM agents WHERE status='active' AND last_heartbeat>?").all(isoAgoMs(DEAD_MS)).map((r) => r.agent_id));

  // Commits are attributed to the HOOK identity (the git committer marker). The
  // caller (the MCP server) may run under a related id: even after the BUG-1 fix it
  // could (rarely) still be a standalone twin if no hook link was ever published.
  // Bridge that by ALSO treating the session-linked id as ours — resolved via the
  // anchor pids the caller passes (the claude.exe pid first, then the raw ppid), so
  // it reads the hook link behind a wrapper the same way startup adoption does;
  // falls back to the raw ppid when no anchors are passed (direct/library callers).
  // And treat the whole session FAMILY as ours: a subagent commits under
  // `base/type-tag`, so match on the shared base too. Read-only and additive — it
  // can only ever recognize OUR OWN session, never clear a genuine peer's commit.
  const linked = includeAmbientIdentity ? (ppids && ppids.length ? readSessionLinkAny(ppids) : readSessionLink(process.ppid)) : null;
  // And the session id Claude exported into our environment — the exact hook
  // identity the post-commit hook now stamps on commits (cli/log-commit.mjs).
  let fromEnv = null;
  try {
    if (includeAmbientIdentity) fromEnv = agentIdFromEnv();
  } catch {}
  const myIds = new Set([meAgentId, linked, fromEnv].filter(Boolean));
  const myBases = new Set([...myIds].map(baseAgentId).filter(Boolean));

  const commits = lines.map((l) => {
    const [hash, ...s] = l.split("\t");
    const subject = s.join("\t");
    const agent = provenance.get(hash) || "unknown";
    const wip = /^\s*(wip\b|\[wip\])/i.test(subject);
    const mine = myIds.has(agent) || myBases.has(baseAgentId(agent));
    const isLive = live.has(agent);
    let verdict;
    if (wip) verdict = "hold-wip";
    else if (mine) verdict = "push-mine";
    else if (agent === "unknown" || agent === "manual") verdict = "ask-human";
    else if (isLive) verdict = "ask-peer";
    else verdict = "push-peer-done";
    return { hash, subject, agent, wip, mine, live: isLive, verdict };
  });

  const n = (v) => commits.filter((c) => c.verdict === v);
  const parts = [];
  if (n("push-mine").length || n("push-peer-done").length) parts.push(`${n("push-mine").length + n("push-peer-done").length} safe to push (yours or by finished agents, not WIP)`);
  if (n("ask-peer").length) parts.push(`${n("ask-peer").length} by LIVE peers — ask them first: ${[...new Set(n("ask-peer").map((c) => c.agent))].join(", ")}`);
  if (n("hold-wip").length) parts.push(`${n("hold-wip").length} WIP — do NOT push to prod`);
  if (n("ask-human").length) parts.push(`${n("ask-human").length} unknown/manual author — your call`);
  const blockers = commits.filter((c) => c.verdict === "hold-wip" || c.verdict === "ask-peer" || c.verdict === "ask-human");
  const allClear = commits.length > 0 && blockers.length === 0;
  return { ...scope, upstream: true, commits, recommendation: parts.join("; "), allClear, blockers: blockers.map((c) => ({ hash: c.hash, agent: c.agent, verdict: c.verdict })) };
}
