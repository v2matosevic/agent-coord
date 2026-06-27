import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "../lib/store.mjs";
import { COORD_HOME } from "../lib/identity.mjs";
import { gitContext } from "../lib/git-context.mjs";
import { workspaceId } from "../lib/path-canon.mjs";
import { reapThrottled } from "../lib/reaper.mjs";
import { listIssues, getIssue, reportIssue, updateIssue, projectLabel, issueStats, groupIssuesByRepo, issueFileName } from "../lib/issues.mjs";

// The operator's window into the cross-project issue log — run from anywhere to
// see what agents have flagged across every repo, read the full context of one,
// and close it out. This is the "come back here and check the logs" surface.
//
//   node cli/issues.mjs                       # open issues, ALL projects (default)
//   node cli/issues.mjs --all                 # include resolved / wontfix
//   node cli/issues.mjs --here                # only the current repo
//   node cli/issues.mjs --project <name>      # filter by project label
//   node cli/issues.mjs --severity high       # filter by severity
//   node cli/issues.mjs i-1a2b3c4d            # full detail of one issue
//   node cli/issues.mjs --add "title" [--body "..."] [--severity high] [--kind bug]
//   node cli/issues.mjs --resolve <id> [how it was fixed...]
//   node cli/issues.mjs --reopen <id>
//   node cli/issues.mjs --export              # mirror to ~/.agent-coord/issues/*.md

const db = getDb();
reapThrottled(db);
const { repoRoot, branch } = gitContext(process.cwd());
const ws = workspaceId(repoRoot);

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : null;
};

const COLOR = !process.env.NO_COLOR;
const wrap = (code, s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => wrap("2", s);
const bold = (s) => wrap("1", s);
const sevColor = (sev, s) => (sev === "critical" ? wrap("1;31", s) : sev === "high" ? wrap("31", s) : sev === "low" ? dim(s) : wrap("33", s));
const sevTag = (sev) => sevColor(sev, sev.toUpperCase().padEnd(8));
const ago = (ts) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 60000));
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

// ── mutating subcommands ────────────────────────────────────────────────────
if (has("--add")) {
  const title = val("--add");
  if (!title || title.startsWith("--")) (console.error('usage: issues.mjs --add "<title>" [--body "..."] [--severity high] [--kind bug]'), process.exit(1));
  const r = reportIssue(db, {
    workspaceId: ws,
    repoPath: repoRoot,
    project: projectLabel(repoRoot),
    agentId: "operator",
    branch,
    title,
    body: val("--body"),
    severity: val("--severity"),
    kind: val("--kind"),
    area: val("--area"),
  });
  console.log(r.ok ? `logged ${r.issueId}: ${title}` : `error: ${r.error}`);
  process.exit(r.ok ? 0 : 1);
}
if (has("--resolve")) {
  const i = args.indexOf("--resolve");
  const id = args[i + 1]; // the id directly follows the flag
  const resolution = args.slice(i + 2).filter((x) => !x.startsWith("--")).join(" ").trim() || null; // the rest is the how-fixed note
  const r = updateIssue(db, { issueId: id, agentId: "operator", status: "resolved", resolution });
  console.log(r.ok ? `resolved ${id}` : `error: ${r.error}`);
  process.exit(r.ok ? 0 : 1);
}
if (has("--reopen")) {
  const id = val("--reopen");
  const r = updateIssue(db, { issueId: id, status: "open" });
  console.log(r.ok ? `reopened ${id}` : `error: ${r.error}`);
  process.exit(r.ok ? 0 : 1);
}
if (has("--export")) {
  exportMarkdown();
  process.exit(0);
}

// ── single-issue detail (a bare i-xxxx positional) ──────────────────────────
const idArg = args.find((a) => /^i-[0-9a-f]+$/i.test(a));
if (idArg) {
  const it = getIssue(db, { issueId: idArg });
  if (!it) (console.log(`no such issue: ${idArg}`), process.exit(1));
  console.log(`${sevTag(it.severity)} ${bold(it.title)}  ${dim(it.issue_id)}`);
  console.log(dim(`  ${it.status} · ${it.kind} · ${it.project}${it.branch ? ` @${it.branch}` : ""} · by ${it.by || "?"} · ${ago(it.ts)}`));
  if (it.area) console.log(dim(`  area: ${it.area}`));
  if (it.repo_path) console.log(dim(`  repo: ${it.repo_path}`));
  if (it.tags) console.log(dim(`  tags: ${it.tags}`));
  if (it.body) console.log("\n" + it.body.split("\n").map((l) => "  " + l).join("\n"));
  if (it.resolution) console.log("\n" + wrap("32", `  ✔ resolution (${it.resolved_by || "?"}, ${ago(it.resolved_at)}): `) + it.resolution);
  process.exit(0);
}

// ── list (default view) ─────────────────────────────────────────────────────
const status = has("--all") ? "all" : val("--status") || "open";
const scopedWs = has("--here") ? ws : null;
const issues = listIssues(db, { workspaceId: scopedWs, status, severity: val("--severity"), project: val("--project"), kind: val("--kind"), limit: 500 });

const scopeLabel = has("--here") ? `this repo (${projectLabel(repoRoot)})` : "all projects";
if (!issues.length) {
  console.log(`issue log — ${scopeLabel}: no ${status === "all" ? "" : status + " "}issues. Agents file them via the report_issue MCP tool, or: issues.mjs --add "<title>".`);
  process.exit(0);
}

// Group by workspace_id (the true repo identity) so two repos sharing a folder
// name don't visually merge; show the path to disambiguate when a label collides.
const groups = groupIssuesByRepo(issues);

console.log(bold(`issue log — ${scopeLabel}`) + dim(`  (${issues.length} ${status === "all" ? "total" : status})`) + "\n");
const statusMark = (s) => (s === "open" ? "○" : s === "wontfix" ? "✗" : "✓");
for (const g of groups) {
  if (!has("--here")) {
    const amb = g.labelAmbiguous && g.repoPath ? dim(` (${g.repoPath})`) : "";
    console.log(bold(`  ${g.project}`) + amb + dim(` — ${g.issues.length}`));
  }
  for (const it of g.issues) {
    const head = `${statusMark(it.status)} ${sevTag(it.severity)} ${it.title}`;
    console.log(`    ${head}  ${dim(it.issue_id)} ${dim(it.kind + " · " + ago(it.ts) + (it.by ? " · " + it.by : ""))}`);
    if (it.status !== "open" && it.resolution) console.log(dim(`        ↳ ${it.resolution.slice(0, 120)}`));
  }
}

const s = issueStats(db, { workspaceId: scopedWs });
console.log(dim(`\n  ${s.open} open` + (s.bySeverity.critical ? ` · ${s.bySeverity.critical} critical` : "") + (s.bySeverity.high ? ` · ${s.bySeverity.high} high` : "")));
console.log(dim(`  detail: issues.mjs <id>   ·   resolve: issues.mjs --resolve <id> "how"   ·   export: issues.mjs --export`));

// ── markdown export ─────────────────────────────────────────────────────────
// Mirror the log to ~/.agent-coord/issues/ (OUTSIDE any repo, so client context
// never lands in a public push) — durable, human-browsable, mirrors digests/.
function exportMarkdown() {
  const outDir = join(COORD_HOME, "issues");
  mkdirSync(outDir, { recursive: true });
  const all = listIssues(db, { status: "all", limit: 500 });
  // Group by true repo identity so two repos sharing a basename get distinct files
  // (issueFileName disambiguates the collision) instead of clobbering each other.
  const groups = groupIssuesByRepo(all);
  const indexLines = [`# Issue log\n`, `_${all.length} issues across ${groups.length} repo(s). Generated by cli/issues.mjs --export._\n`];
  for (const g of groups) {
    const file = issueFileName(g);
    const open = g.issues.filter((i) => i.status === "open").length;
    indexLines.push(`- [${g.project}](./${file})${g.labelAmbiguous && g.repoPath ? ` \`${g.repoPath}\`` : ""} — ${open} open / ${g.issues.length} total`);
    const lines = [`# ${g.project} — issues\n`];
    if (g.repoPath) lines.push(`_${g.repoPath}_\n`);
    for (const it of g.issues) {
      lines.push(`## ${it.status === "open" ? "○" : "✓"} ${it.title}`);
      lines.push(`\n- **id:** ${it.issue_id} · **severity:** ${it.severity} · **kind:** ${it.kind} · **status:** ${it.status}`);
      lines.push(`- **reported:** ${it.ts}${it.by ? ` by ${it.by}` : ""}${it.branch ? ` (branch ${it.branch})` : ""}`);
      if (it.area) lines.push(`- **area:** \`${it.area}\``);
      if (it.tags) lines.push(`- **tags:** ${it.tags}`);
      if (it.body) lines.push(`\n${it.body}`);
      if (it.resolution) lines.push(`\n> **Resolved** (${it.resolved_by || "?"}, ${it.resolved_at}): ${it.resolution}`);
      lines.push("\n---\n");
    }
    writeFileSync(join(outDir, file), lines.join("\n"));
  }
  writeFileSync(join(outDir, "INDEX.md"), indexLines.join("\n") + "\n");
  console.log(`exported ${all.length} issues → ${outDir}`);
}
