import { randomUUID } from "node:crypto";
import { writeTxn, nowIso } from "./store.mjs";

// Cross-project issue log — the "come back later and fix it" record. Every other
// table here (messages/decisions/tasks) is workspace-scoped and short-lived,
// built for agents coordinating in real time. This one is the opposite: an agent
// that HITS a problem anywhere on the machine — a bug, a recurring friction, a
// broken build, a coordination failure, a confusing API — files it here, tagged
// with where it happened, and it sits durably until a human (or agent) reviews
// and resolves it. The operator surveys the whole machine's issues from one place
// (cli/issues.mjs), reads the full context of each, and fixes them on their own
// time, instead of every "fix this" starting from zero context.
//
// Rows record their origin (workspace_id / repo_path / project) so you can filter
// by project, but listIssues defaults to GLOBAL: the point is the bird's-eye view.

const SEV = { critical: 3, high: 2, medium: 1, low: 0 };
const STATUSES = new Set(["open", "resolved", "wontfix"]);
const shortId = () => "i-" + randomUUID().replace(/-/g, "").slice(0, 8);

export function normSeverity(s) {
  const v = String(s || "").trim().toLowerCase();
  // Object.hasOwn, not `v in SEV`: `in` walks the prototype chain, so "toString"/
  // "constructor" would pass through, get stored verbatim, and later poison the
  // severity-rank sort (SEV["toString"] is a function, not a number).
  return Object.hasOwn(SEV, v) ? v : "medium";
}

// Short, filterable project label from a repo root (basename), e.g.
// "B:\Coding\agent-coord" -> "agent-coord". Falls back to "(no repo)".
export function projectLabel(repoPath) {
  return (
    String(repoPath || "")
      .replace(/\\/g, "/")
      .replace(/\/+$/, "")
      .split("/")
      .pop() || "(no repo)"
  );
}

// File an issue. Only `title` is required — everything else is context that makes
// the later fix cheaper. Returns the new id. No broadcast: issues aren't live
// coordination, they're a backlog; the caller (server/CLI) logs an activity row.
export function reportIssue(
  db,
  { workspaceId = null, repoPath = null, project = null, agentId = null, branch = null, title, body = null, severity = null, kind = null, area = null, tags = null },
) {
  const t = String(title || "").trim();
  if (!t) return { ok: false, error: "title is required (one line: what went wrong)" };
  return writeTxn(db, () => {
    const id = shortId();
    const now = nowIso();
    db.prepare(
      `INSERT INTO issues(issue_id,ts,updated_at,workspace_id,repo_path,project,agent_id,branch,severity,kind,title,body,area,tags,status)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open')`,
    ).run(
      id,
      now,
      now,
      workspaceId,
      repoPath,
      project || projectLabel(repoPath),
      agentId,
      branch,
      normSeverity(severity),
      (String(kind || "bug").trim().toLowerCase() || "bug").slice(0, 24),
      t.slice(0, 200),
      body ? String(body) : null,
      area ? String(area).slice(0, 300) : null,
      tags ? String(tags).slice(0, 200) : null,
    );
    return { ok: true, issueId: id };
  });
}

const shape = (r) => ({
  issue_id: r.issue_id,
  ts: r.ts,
  updated_at: r.updated_at,
  project: r.project,
  repo_path: r.repo_path,
  workspace_id: r.workspace_id,
  by: r.agent_id,
  branch: r.branch,
  severity: r.severity,
  kind: r.kind,
  title: r.title,
  body: r.body,
  area: r.area,
  tags: r.tags,
  status: r.status,
  resolution: r.resolution,
  resolved_by: r.resolved_by,
  resolved_at: r.resolved_at,
});

// List issues, severity-first then newest. `workspaceId` null = GLOBAL (every
// project) — the default for surveying the machine; pass one to scope to a repo.
// `status` defaults to 'open' (the actionable backlog); pass null/'all' for the
// full history. `project`/`severity`/`kind` narrow further.
export function listIssues(db, { workspaceId = null, status = "open", severity = null, project = null, kind = null, limit = 50 } = {}) {
  const where = [];
  const vals = [];
  if (workspaceId) {
    where.push("workspace_id=?");
    vals.push(workspaceId);
  }
  if (status && status !== "all") {
    where.push("status=?");
    vals.push(status);
  }
  if (severity) {
    where.push("severity=?");
    vals.push(normSeverity(severity));
  }
  if (project) {
    where.push("project=?");
    vals.push(project);
  }
  if (kind) {
    where.push("kind=?");
    vals.push(String(kind).toLowerCase());
  }
  const sql = `SELECT * FROM issues${where.length ? " WHERE " + where.join(" AND ") : ""}`;
  const rows = db.prepare(sql).all(...vals);
  rows.sort((a, b) => (SEV[b.severity] ?? 1) - (SEV[a.severity] ?? 1) || String(b.ts).localeCompare(String(a.ts)));
  return rows.slice(0, Math.max(1, Math.min(500, Number(limit) || 50))).map(shape);
}

export function getIssue(db, { issueId }) {
  const r = db.prepare("SELECT * FROM issues WHERE issue_id=?").get(issueId);
  return r ? shape(r) : null;
}

// Update an issue. Resolving (status resolved|wontfix) stamps who/when; passing a
// `resolution` records HOW it was fixed — that's the payoff the next session reads
// ("oh, this exact thing happened before and here's what fixed it"). `reopen`
// (status='open') clears the resolution stamps.
export function updateIssue(db, { issueId, agentId = null, status = null, resolution = null, severity = null, kind = null, body = null, tags = null }) {
  return writeTxn(db, () => {
    const r = db.prepare("SELECT * FROM issues WHERE issue_id=?").get(issueId);
    if (!r) return { ok: false, error: "no such issue" };
    if (status && !STATUSES.has(status)) return { ok: false, error: `bad status (use ${[...STATUSES].join("|")})` };
    const sets = [];
    const vals = [];
    if (status) {
      sets.push("status=?");
      vals.push(status);
      if (status === "open") {
        sets.push("resolution=NULL", "resolved_by=NULL", "resolved_at=NULL");
      } else {
        sets.push("resolved_by=?", "resolved_at=?");
        vals.push(agentId, nowIso());
      }
    }
    // A reopen (status='open') already nulled the resolution above; ignore an
    // incoming resolution in that case so we don't write the column twice in one
    // UPDATE (last-write-wins would resurrect a resolution onto an open issue).
    if (resolution != null && status !== "open") {
      sets.push("resolution=?");
      vals.push(String(resolution));
    }
    if (severity != null) {
      sets.push("severity=?");
      vals.push(normSeverity(severity));
    }
    if (kind != null) {
      sets.push("kind=?");
      vals.push(String(kind).toLowerCase().slice(0, 24));
    }
    if (body != null) {
      sets.push("body=?");
      vals.push(String(body));
    }
    if (tags != null) {
      sets.push("tags=?");
      vals.push(String(tags).slice(0, 200));
    }
    sets.push("updated_at=?");
    vals.push(nowIso());
    vals.push(issueId);
    db.prepare(`UPDATE issues SET ${sets.join(",")} WHERE issue_id=?`).run(...vals);
    return { ok: true, issueId };
  });
}

// Group issues by their TRUE repo identity (workspace_id), not the basename
// `project` label — two distinct repos that happen to share a folder name ("web")
// must not merge in the grouped view or clobber each other on export. Returns
// groups in first-seen order, each flagged `labelAmbiguous` when another group
// shares its project label (so the caller can disambiguate with the repo path).
export function groupIssuesByRepo(issues) {
  const map = new Map();
  for (const it of issues) {
    const key = it.workspace_id || "no-ws";
    if (!map.has(key)) map.set(key, { workspaceId: it.workspace_id || null, project: it.project || "(no repo)", repoPath: it.repo_path || null, issues: [] });
    map.get(key).issues.push(it);
  }
  const labelCount = new Map();
  for (const g of map.values()) labelCount.set(g.project, (labelCount.get(g.project) || 0) + 1);
  return [...map.values()].map((g) => ({ ...g, labelAmbiguous: labelCount.get(g.project) > 1 }));
}

// Stable, collision-free export filename for a group: the friendly basename,
// suffixed with a short workspace hash ONLY when that label is shared by >1 repo
// (so the common, unambiguous case stays clean `project.md`).
export function issueFileName(group) {
  const safe = String(group.project || "no-repo").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "no-repo";
  return (group.labelAmbiguous && group.workspaceId ? `${safe}-${String(group.workspaceId).slice(0, 6)}` : safe) + ".md";
}

// Counts for the session brief / CLI summary. `workspaceId` null = whole machine.
export function issueStats(db, { workspaceId = null } = {}) {
  const where = workspaceId ? " WHERE workspace_id=?" : "";
  const args = workspaceId ? [workspaceId] : [];
  const open = db.prepare(`SELECT severity, COUNT(*) c FROM issues${where}${where ? " AND" : " WHERE"} status='open' GROUP BY severity`).all(...args);
  const bySev = { critical: 0, high: 0, medium: 0, low: 0 };
  let total = 0;
  for (const r of open) {
    bySev[r.severity] = r.c;
    total += r.c;
  }
  return { open: total, bySeverity: bySev };
}
