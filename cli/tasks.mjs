import { getDb } from "../lib/store.mjs";
import { gitContext } from "../lib/git-context.mjs";
import { workspaceId } from "../lib/path-canon.mjs";
import { listTasks, createTask, updateTask } from "../lib/tasks.mjs";
import { reapThrottled } from "../lib/reaper.mjs";

// View / lightly manage the shared task board for the current repo.
//   node cli/tasks.mjs                 # show the board
//   node cli/tasks.mjs --add "title"   # create a task
//   node cli/tasks.mjs --done <id>     # mark done

const { repoRoot } = gitContext(process.cwd());
const ws = workspaceId(repoRoot);
const db = getDb();
reapThrottled(db);

const args = process.argv.slice(2);
const flag = (f) => args.indexOf(f);

if (flag("--add") >= 0) {
  const title = args.slice(flag("--add") + 1).join(" ").trim();
  if (!title) (console.error("usage: tasks.mjs --add <title>"), process.exit(1));
  const r = createTask(db, { workspaceId: ws, title, createdBy: "cli" });
  console.log(`${r.created ? "created" : "exists"} ${r.taskId}: ${title}`);
  process.exit(0);
}
if (flag("--done") >= 0) {
  const id = args[flag("--done") + 1];
  console.log(updateTask(db, { taskId: id, status: "done" }).ok ? `done ${id}` : `no such task ${id}`);
  process.exit(0);
}

const tasks = listTasks(db, { workspaceId: ws });
const COLOR = !process.env.NO_COLOR;
const wrap = (code, s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => wrap("2", s);
if (!tasks.length) {
  console.log("task board: empty for this repo. Agents claim work via the claim_task MCP tool, or: tasks.mjs --add \"<title>\".");
  process.exit(0);
}
const icon = (t) => (t.status === "done" ? "✓" : t.status === "blocked" ? "⛔" : t.status === "claimed" ? (t.ownerLive ? "▶" : "◻") : "○");
console.log(`task board — ${repoRoot || "(no repo)"}\n`);
for (const t of tasks) {
  const owner = t.owner ? dim(` @${t.owner}${t.ownerLive ? "" : " (offline)"}`) : "";
  const dep = t.blockedBy.length ? dim(` ⛓ waits: ${t.blockedBy.join(", ")}`) : "";
  const prio = t.priority ? ` p${t.priority}` : "";
  console.log(`  ${icon(t)} ${dim(t.task_id)}${prio}  ${t.title}${owner}${dep}`);
  if (t.status === "done" && t.summary) console.log(dim(`      ↳ ${t.summary}`));
}
const n = (s) => tasks.filter((t) => t.status === s).length;
console.log(dim(`\n  ${n("open")} open · ${n("claimed")} claimed · ${n("blocked")} blocked · ${n("done")} done`));
