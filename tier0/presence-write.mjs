import { readFileSync } from "node:fs";
import { relative, basename } from "node:path";
import { agentIdFromSession } from "./lib/identity.mjs";
import { gitContext } from "./lib/git-context.mjs";
import { writePresence, readExisting } from "./lib/presence-store.mjs";

// Hook entry point. Invoked as: node presence-write.mjs <Event>
// where <Event> is SessionStart | UserPromptSubmit | PreEdit. Reads the hook
// JSON from stdin, refreshes this agent's presence file. Never blocks (exit 0).

const EVENT = process.argv[2] || "Unknown";
const MAX_TASK = 100;

function readInput() {
  try {
    return JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

function toDisplayPath(p, root) {
  if (!p) return null;
  if (root) {
    const rel = relative(root, p).replace(/\\/g, "/");
    if (rel && !rel.startsWith("..")) return rel;
  }
  return basename(p);
}

const input = readInput();
const sessionId = input.session_id || "unknown";
const cwd = input.cwd || process.cwd();
const agentId = agentIdFromSession(sessionId);
const prev = readExisting(agentId);

// Spawning git on every edit would tax the hot path, so only re-resolve the
// repo when cwd changed or at the (infrequent) start/prompt events.
const cwdUnchanged = prev && prev.cwd === cwd && prev.repoRoot !== undefined;
const refreshGit =
  !cwdUnchanged || EVENT === "SessionStart" || EVENT === "UserPromptSubmit";
const ctx = refreshGit
  ? gitContext(cwd)
  : { repoRoot: prev.repoRoot, repoName: prev.repoName, branch: prev.branch };

const editPath = input.tool_input?.file_path || input.tool_input?.notebook_path || null;
let editing = prev?.editing ?? null;
if (EVENT === "UserPromptSubmit") editing = null; // new turn clears current file
if (editPath) editing = toDisplayPath(editPath, ctx.repoRoot);

let task = prev?.task ?? null;
if (EVENT === "UserPromptSubmit" && typeof input.prompt === "string") {
  task = input.prompt.replace(/\s+/g, " ").trim().slice(0, MAX_TASK) || null;
}

const now = new Date().toISOString();
const record = {
  agentId,
  tool: "claude-code",
  sessionId,
  pid: process.ppid,
  cwd,
  repoRoot: ctx.repoRoot,
  repoName: ctx.repoName,
  branch: ctx.branch,
  task,
  editing,
  lastTool: input.tool_name ?? prev?.lastTool ?? null,
  lastEvent: EVENT,
  startedAt: prev?.startedAt ?? now,
  updatedAt: now,
};

try {
  writePresence(record);
} catch {}
process.exit(0);
