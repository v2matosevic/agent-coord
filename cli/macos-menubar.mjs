import { existsSync } from "node:fs";
import { getDb, DEGRADED_FLAG } from "../lib/store.mjs";
import { getGlobalState } from "../lib/activity.mjs";
import { workspaceId } from "../lib/path-canon.mjs";

// SwiftBar / xbar plugin renderer for agent-coord — the Mac-native counterpart to
// the Windows VS Code "Fleet" panel. Prints the live fleet in menu-bar format:
// the first line is the menu-bar title, then `---`, then the dropdown. Invoked by
// the generated plugin stub (see cli/install-macos-menubar.mjs) on SwiftBar's
// refresh interval. READ-ONLY by design — a passive viewer must never write to
// (or reap) the store, so it can't perturb the very fleet it's watching. Fails
// soft: any error prints a single muted title so the menu bar never shows a stack
// trace. SF Symbols (`sfimage=`) render in SwiftBar and are ignored by xbar.

const RED = "#cc2323"; // brand red
const GRAY = "#8a8a8a";
const DASH_URL = "http://localhost:7777"; // cli/dashboard.mjs default

const short = (id) => String(id).replace(/-\d+$/, "");
const repoName = (p) => (p ? p.replace(/\/+$/, "").split("/").pop() : "—");
const trunc = (s, n) => ((s = String(s ?? "")), s.length > n ? s.slice(0, n - 1) + "…" : s);

const out = [];
const p = (s) => out.push(s);
const flush = () => process.stdout.write(out.join("\n") + "\n");

try {
  const db = getDb();
  const state = getGlobalState(db);
  const degraded = existsSync(DEGRADED_FLAG);
  const agents = state.agents || [];
  const n = agents.length;

  // Same path held by 2+ live agents = real serial contention worth flagging red.
  const byPath = new Map();
  for (const l of state.fileLeases || []) {
    const k = l.workspace_id + "||" + l.path;
    if (!byPath.has(k)) byPath.set(k, new Set());
    byPath.get(k).add(l.agent_id);
  }
  // Keep the full workspace||path key so the same filename in two repos isn't
  // cross-flagged; derive bare paths only for the display section.
  const conflictKeys = new Set([...byPath.entries()].filter(([, s]) => s.size > 1).map(([k]) => k));
  const conflicts = [...conflictKeys].map((k) => k.split("||")[1]);
  const waiting = (state.queue || []).filter((q) => q.kind === "file").length;
  const contended = conflictKeys.size > 0 || waiting > 0;

  // --- menu-bar title ---
  if (degraded) p(`⚠️ coord | color=orange`);
  else if (!n) p(`⚪︎ 0 | color=${GRAY}`);
  else if (contended) p(`🔴 ${n} | color=${RED}`);
  else p(`🟢 ${n}`);

  // --- dropdown ---
  p("---");
  p(`agent-coord — ${n} live agent${n === 1 ? "" : "s"} | size=12 color=${GRAY}`);
  if (degraded) p(`⚠ store degraded — running without lock enforcement | color=orange sfimage=exclamationmark.triangle.fill`);

  if (n) {
    // Group agents by repo so a glance maps work to project.
    const byRepo = new Map();
    for (const a of agents) {
      const k = a.repo_path ? repoName(a.repo_path) : "—";
      if (!byRepo.has(k)) byRepo.set(k, []);
      byRepo.get(k).push(a);
    }
    for (const [repo, list] of [...byRepo].sort((a, b) => b[1].length - a[1].length)) {
      p("---");
      p(`${repo} · ${list.length} | size=11 color=${GRAY} sfimage=folder`);
      for (const a of list) {
        const sym = a.tool === "codex" ? "diamond.fill" : "circle.fill";
        const det = a.editing ? `  ⚙ ${trunc(a.editing, 34)}` : a.current_task ? `  “${trunc(a.current_task, 32)}”` : "";
        const onConflict = a.editing && a.repo_path && conflictKeys.has(workspaceId(a.repo_path) + "||" + a.editing);
        p(`${short(a.agent_id)}${det} | size=13 sfimage=${sym}${onConflict ? ` color=${RED}` : ""}`);
      }
    }
  }

  if (conflicts.length) {
    p("---");
    p(`⚠ contended files | size=11 color=${RED}`);
    for (const f of conflicts.slice(0, 8)) p(`${trunc(f, 40)} | color=${RED} size=12 sfimage=person.2.fill`);
  }

  const res = state.resourceLeases || [];
  if (res.length) {
    p("---");
    p(`resources | size=11 color=${GRAY}`);
    for (const r of res.slice(0, 8)) p(`${r.resource_id} — ${short(r.agent_id)} | size=12 sfimage=lock.fill`);
  }

  const openTasks = (state.tasks || []).length;
  if (openTasks) {
    p("---");
    p(`${openTasks} open task${openTasks === 1 ? "" : "s"} on the board | size=11 color=${GRAY} sfimage=checklist`);
  }

  // --- actions ---
  p("---");
  p(`Open dashboard | href=${DASH_URL} sfimage=chart.bar.doc.horizontal`);
  p(`Refresh | refresh=true sfimage=arrow.clockwise`);
  flush();
} catch (e) {
  process.stdout.write(`coord ? | color=${GRAY}\n---\nmenu-bar read failed: ${String(e.message || e)}\n`);
}
