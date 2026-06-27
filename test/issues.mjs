// Cross-project issue log: report from anywhere, survey globally or per-repo,
// severity-ordered, durable across resolve/reopen, and full-text searchable
// within its own room. Mirrors the real call paths (lib/issues.mjs + search).
import { getDb } from "../lib/store.mjs";
import { ensureAgent } from "../lib/agents.mjs";
import { workspaceId } from "../lib/path-canon.mjs";
import { reportIssue, listIssues, getIssue, updateIssue, issueStats, projectLabel, groupIssuesByRepo, issueFileName } from "../lib/issues.mjs";
import { searchRecords } from "../lib/search.mjs";

const db = getDb();

// Pre-create the FTS index so this whole test runs the WARM-store path — the
// realistic live-store state where messages/decisions/tasks built search_index
// long before issues existed. On that path the one-shot backfill is skipped, so
// this guards the regression where reported issues were silently never indexed
// (a fresh store hides it: the cold-start backfill happens to catch the rows).
db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(text, kind UNINDEXED, ref UNINDEXED, workspace_id UNINDEXED, agent UNINDEXED, ts UNINDEXED);");

const repoA = "/t/projA-" + process.pid;
const repoB = "/t/projB-" + process.pid;
const wsA = workspaceId(repoA);
const wsB = workspaceId(repoB);
ensureAgent(db, { agentId: "rep-a", repoPath: repoA, branch: "main" });
ensureAgent(db, { agentId: "rep-b", repoPath: repoB, branch: "main" });

const checks = {};
const eq = (k, got, want) => (checks[k] = JSON.stringify(got) === JSON.stringify(want));
const ok = (k, v) => (checks[k] = !!v);

// title is required.
ok("empty title rejected", reportIssue(db, { workspaceId: wsA, title: "  " }).ok === false);

// File three issues: two in A (one high, one critical), one in B (low).
const i1 = reportIssue(db, { workspaceId: wsA, repoPath: repoA, agentId: "rep-a", title: "build breaks on win", body: "vite EPERM on rename during HMR", severity: "high", kind: "build" });
const i2 = reportIssue(db, { workspaceId: wsA, repoPath: repoA, agentId: "rep-a", title: "auth redirect loop", body: "cookie SameSite drops session", severity: "critical", kind: "bug", area: "lib/auth.ts" });
const i3 = reportIssue(db, { workspaceId: wsB, repoPath: repoB, agentId: "rep-b", title: "typo in footer", severity: "low" });
ok("report returns ids", i1.ok && i2.ok && i3.ok && i1.issueId !== i2.issueId);

// Auto-derived project label from repo path.
eq("project label derived", getIssue(db, { issueId: i1.issueId }).project, projectLabel(repoA));

// Global open list: all three, severity-first (critical, high, low).
const global = listIssues(db, { workspaceId: null, status: "open" });
ok("global lists all projects", global.length === 3);
eq("severity ordered (critical→high→low)", global.map((x) => x.severity), ["critical", "high", "low"]);

// Scoped list: only this repo's.
const scoped = listIssues(db, { workspaceId: wsA, status: "open" });
ok("workspace scope filters to repo A", scoped.length === 2 && scoped.every((x) => x.workspace_id === wsA));

// Severity filter.
ok("severity filter", listIssues(db, { workspaceId: null, severity: "critical" }).length === 1);

// Resolve the critical one with a resolution note.
const up = updateIssue(db, { issueId: i2.issueId, agentId: "rep-a", status: "resolved", resolution: "set SameSite=Lax + secure on the session cookie" });
ok("resolve ok", up.ok);
const r2 = getIssue(db, { issueId: i2.issueId });
ok("resolution stamped", r2.status === "resolved" && r2.resolved_by === "rep-a" && /SameSite/.test(r2.resolution) && r2.resolved_at);

// Default open list now hides the resolved one; 'all' shows it again.
ok("resolved drops out of open", listIssues(db, { workspaceId: wsA, status: "open" }).length === 1);
ok("status=all includes resolved", listIssues(db, { workspaceId: wsA, status: "all" }).length === 2);

// Reopen clears the resolution stamps.
updateIssue(db, { issueId: i2.issueId, status: "open" });
const r3 = getIssue(db, { issueId: i2.issueId });
ok("reopen clears resolution", r3.status === "open" && r3.resolution === null && r3.resolved_by === null);

// Stats: global vs scoped.
ok("global stats count open", issueStats(db, { workspaceId: null }).open === 3);
ok("scoped stats + severity breakdown", (() => {
  const s = issueStats(db, { workspaceId: wsA });
  return s.open === 2 && s.bySeverity.critical === 1 && s.bySeverity.high === 1;
})());

// wontfix is a valid terminal status and also drops out of the open list.
const i4 = reportIssue(db, { workspaceId: wsB, repoPath: repoB, agentId: "rep-b", title: "wishlist: dark mode", severity: "low" });
updateIssue(db, { issueId: i4.issueId, agentId: "rep-b", status: "wontfix", resolution: "out of scope" });
ok("wontfix terminal status", getIssue(db, { issueId: i4.issueId }).status === "wontfix" && listIssues(db, { workspaceId: wsB, status: "open" }).every((x) => x.issue_id !== i4.issueId));

// Severity normalization rejects prototype-chain keys (Object.hasOwn, not `in`).
ok("severity 'toString' falls back to medium", reportIssue(db, { workspaceId: wsA, title: "x", severity: "toString" }).ok && getIssue(db, { issueId: listIssues(db, { workspaceId: wsA, status: "open" }).find((x) => x.title === "x").issue_id }).severity === "medium");

// Basename collision: two DISTINCT repos sharing a folder name must not merge in
// the grouped view or clobber each other's export file (grouping keys on
// workspace_id, not the basename `project` label).
const repoC = "/x/web";
const repoD = "/y/web";
reportIssue(db, { workspaceId: workspaceId(repoC), repoPath: repoC, agentId: "c", title: "issue in C" });
reportIssue(db, { workspaceId: workspaceId(repoD), repoPath: repoD, agentId: "d", title: "issue in D" });
const webGroups = groupIssuesByRepo(listIssues(db, { status: "all", limit: 500 })).filter((g) => g.project === "web");
ok("same-basename repos grouped separately", webGroups.length === 2);
ok("colliding label flagged ambiguous", webGroups.every((g) => g.labelAmbiguous));
ok("export filenames disambiguated + unique", new Set(webGroups.map(issueFileName)).size === 2 && webGroups.every((g) => /^web-[0-9a-f]{6}\.md$/.test(issueFileName(g))));
// A non-colliding project keeps the clean filename.
ok("unique label keeps clean filename", issueFileName({ project: "agent-coord", workspaceId: "abc123def", labelAmbiguous: false }) === "agent-coord.md");

// Full-text search finds an issue by body text on the WARM index path (the index
// pre-existed, so this exercises the catch-up backfill, not the cold one), scoped
// to its own room.
const found = searchRecords(db, { workspaceId: wsA, query: "EPERM rename", kinds: ["issue"] });
ok("warm-path search finds issue in its room", found.length >= 1 && found.some((f) => f.ref === i1.issueId));
ok("search is room-scoped (B can't see A's issue)", searchRecords(db, { workspaceId: wsB, query: "EPERM rename", kinds: ["issue"] }).length === 0);

let pass = true;
for (const [k, v] of Object.entries(checks)) {
  if (!v) pass = false;
  console.log(`${v ? "✅" : "❌"} ${k}`);
}
console.log(pass ? "PASS ✅ cross-project issue log" : "FAIL ❌");
process.exit(pass ? 0 : 1);
