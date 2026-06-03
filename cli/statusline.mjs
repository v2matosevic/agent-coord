import { readFileSync, existsSync } from "node:fs";
import { resolveAgentId } from "../lib/identity.mjs";
import { gitContext } from "../lib/git-context.mjs";
import { getDb, DEGRADED_FLAG } from "../lib/store.mjs";
import { ensureAgent } from "../lib/agents.mjs";
import { getFleet, queueDepth } from "../lib/activity.mjs";
import { unreadCount } from "../lib/messages.mjs";
import { workspaceId } from "../lib/path-canon.mjs";
import { reapThrottled } from "../lib/reaper.mjs";
import { writeSnapshot } from "../lib/snapshot.mjs";

const COLOR = !process.env.NO_COLOR;
const MAX_SHOWN = 6;
const wrap = (c, s) => (COLOR ? `\x1b[${c}m${s}\x1b[0m` : s);
const accent = (s) => wrap("38;2;204;35;35", s); // brand red (#cc2323)
const dim = (s) => wrap("2", s);

function readInput() {
  try {
    return JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}
const shorten = (s, n = 22) => ((s = String(s)), s.length > n ? s.slice(0, n - 1) + "…" : s);
const short = (id) => id.replace(/-\d+$/, "");
const repoName = (p) => (p ? p.replace(/\/+$/, "").split("/").pop() : null);

try {
  const input = readInput();
  const myId = resolveAgentId(input);
  const cwd = input.cwd || input.workspace?.current_dir || process.cwd();
  const db = getDb();
  const { repoRoot, branch } = gitContext(cwd);
  ensureAgent(db, { agentId: myId, tool: "claude-code", repoPath: repoRoot, branch }); // self-heartbeat
  reapThrottled(db);
  writeSnapshot(db); // keep ~/.agent-coord/snapshot.json fresh for the VS Code fleet view

  const myRoom = workspaceId(repoRoot);
  const fleet = getFleet(db).filter((a) => a.agent_id !== myId);
  // This terminal's own subagents (id is "<myId>/<type>-<tag>") vs. real peers.
  const mySubs = fleet.filter((a) => a.agent_id.startsWith(myId + "/"));
  const peers = fleet.filter((a) => !a.agent_id.startsWith(myId + "/"));
  const sameRoom = (a) => a.repo_path && workspaceId(a.repo_path) === myRoom;
  const here = peers.filter(sameRoom);
  const elsewhere = peers.filter((a) => !sameRoom(a));

  const detail = (a) =>
    a.editing ? ` ⚙ ${shorten(a.editing)}` : a.current_task ? ` “${shorten(a.current_task, 24)}”` : "";
  const fmt = (a, withRepo) =>
    (withRepo && a.repo_path ? dim(repoName(a.repo_path) + ":") : "") + short(a.agent_id) + dim(detail(a));
  const group = (arr, wr) =>
    arr.slice(0, MAX_SHOWN).map((a) => fmt(a, wr)).join(dim(" · ")) +
    (arr.length > MAX_SHOWN ? dim(` +${arr.length - MAX_SHOWN}`) : "");

  // Lead with THIS terminal's identity so a glance maps terminal -> agent, then
  // its own subagents, then the surrounding fleet.
  const subTag = (s) => s.agent_id.split("/").slice(1).join("/") || s.agent_id;
  let self = accent("◆ ") + accent(myId);
  if (mySubs.length) self += dim(" ⤷ ") + mySubs.slice(0, 3).map((s) => subTag(s)).join(dim(", ")) + (mySubs.length > 3 ? dim(` +${mySubs.length - 3}`) : "");

  const parts = [self];
  if (here.length) parts.push(dim(`${here.length} here: `) + group(here, false));
  if (elsewhere.length) parts.push(group(elsewhere, true));
  if (!peers.length && !mySubs.length) parts.push(dim("solo"));

  let line = parts.join(dim(" │ "));
  const unread = unreadCount(db, { agentId: myId, workspaceId: myRoom });
  if (unread > 0) line = accent(`✉ ${unread} `) + line;
  if (queueDepth(db, myRoom) > 0) line = accent("⚠ CONTENDED ") + line;
  if (existsSync(DEGRADED_FLAG)) line = accent("⚠ COORD DEGRADED ") + line;
  process.stdout.write(line);
} catch {
  process.stdout.write("");
}
