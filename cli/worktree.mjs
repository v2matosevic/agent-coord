import { execFileSync } from "node:child_process";
import { existsSync, symlinkSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { agentIdFromSession } from "../lib/identity.mjs";
import { gitContext } from "../lib/git-context.mjs";
import { getDb, nowIso } from "../lib/store.mjs";

// Optional PHYSICAL isolation: give an agent its own worktree + branch so it
// literally cannot collide on disk. Conflicts defer to one explicit merge.
// Usage: worktree new [--base <branch>] | worktree list | worktree rm <path|name>
const args = process.argv.slice(2);
const cmd = args[0];
const flag = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : null;
};
const git = (a, cwd) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const disp = (p) => p.replace(/\\/g, "/");

function mainRepo() {
  const { repoRoot } = gitContext(process.cwd());
  if (!repoRoot) {
    console.error("not inside a git repo");
    process.exit(1);
  }
  return repoRoot;
}

function freePort(db) {
  const used = new Set(
    db.prepare("SELECT resource_id FROM resource_leases WHERE resource_id LIKE 'port:%' AND expires_at > ?").all(nowIso()).map((r) => Number(r.resource_id.split(":")[1])),
  );
  for (let p = 3001; p <= 3099; p++) if (!used.has(p)) return p;
  return 3001;
}

const name = () => agentIdFromSession(randomUUID());

if (cmd === "new") {
  const repo = mainRepo();
  const slug = name();
  const branch = "coord/" + slug;
  const base = flag("--base") || git(["rev-parse", "--abbrev-ref", "HEAD"], repo);
  const wtPath = join(dirname(repo), basename(repo) + "-wt", slug);

  git(["worktree", "add", "-b", branch, wtPath, base], repo);

  let nm = "skipped (main has no node_modules)";
  if (existsSync(join(repo, "node_modules"))) {
    try {
      execFileSync("cmd", ["/c", "mklink", "/J", join(wtPath, "node_modules"), join(repo, "node_modules")], { stdio: "ignore" });
      nm = "junctioned from main (no reinstall)";
    } catch {
      nm = "FAILED — run `npm ci` in the worktree";
    }
  }

  const envNotes = [];
  for (const f of [".env", ".env.local"]) {
    if (!existsSync(join(repo, f))) continue;
    try {
      symlinkSync(join(repo, f), join(wtPath, f), "file");
      envNotes.push(`${f}: symlinked from main`);
    } catch {
      envNotes.push(`${f}: NOT linked (needs Dev Mode/admin) — copy manually if needed`);
    }
  }

  const port = freePort(getDb());
  console.log("✅ worktree ready");
  console.log(`  path:    ${disp(wtPath)}`);
  console.log(`  branch:  ${branch}  (from ${base})`);
  console.log(`  port:    ${port}  (suggested; claimed when your dev server starts)`);
  console.log(`  node_modules: ${nm}`);
  envNotes.forEach((n) => console.log(`  ${n}`));
  console.log("\n  next:");
  console.log(`    cd "${disp(wtPath)}"`);
  console.log(`    $env:PORT=${port}   # PowerShell`);
  console.log("    claude   # (or codex) — it registers + coordinates automatically");
} else if (cmd === "list") {
  const repo = mainRepo();
  console.log(git(["worktree", "list"], repo));
  const ports = getDb().prepare("SELECT resource_id,agent_id FROM resource_leases WHERE resource_id LIKE 'port:%' AND expires_at > ?").all(nowIso());
  if (ports.length) {
    console.log("\nactive port leases:");
    ports.forEach((p) => console.log(`  ${p.resource_id} — ${p.agent_id}`));
  }
} else if (cmd === "rm") {
  const repo = mainRepo();
  const target = args[1];
  if (!target) {
    console.error("usage: worktree rm <path|name>");
    process.exit(1);
  }
  const path = existsSync(target) ? target : join(dirname(repo), basename(repo) + "-wt", target);
  git(["worktree", "remove", path, "--force"], repo);
  console.log("removed worktree", disp(path));
} else {
  console.log("usage: worktree new [--base <branch>] | worktree list | worktree rm <path|name>");
}
