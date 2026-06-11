import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

// Idempotently merge the agent-coord hooks + statusline into Claude's user
// settings.json. Safe to re-run: existing (incl. non-coord) hooks are preserved,
// and our entries are added only if absent. Backs up first.

// Repo root = this script's parent's parent (cli/ -> <repo>), so the installer
// works from wherever the project was cloned — no hardcoded path.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url))).replace(/\\/g, "/");
const FILE = join(homedir(), ".claude", "settings.json");
const C = (rest) => `node --disable-warning=ExperimentalWarning "${ROOT}/${rest}"`;

// PowerShell is matched alongside Bash everywhere: on Windows Claude Code runs
// shell work through the PowerShell tool, and its input has the same
// tool_input.command shape — without it, resource guards and the committer
// marker silently don't fire for PowerShell commands (found live: an agent's
// own PowerShell `git commit` was blocked as a "cross-agent" conflict).
// PostToolUse also covers shell calls so mid-turn delivery reaches an agent
// deep in a test/build loop, not just one that's editing files.
const WANT = [
  { event: "SessionStart", matcher: null, command: C("hooks/session.mjs") + " --register" },
  { event: "UserPromptSubmit", matcher: null, command: C("hooks/session.mjs") + " --prompt" },
  { event: "PreToolUse", matcher: "Write|Edit|MultiEdit|NotebookEdit", command: C("hooks/guard.mjs") },
  { event: "PreToolUse", matcher: "Bash|PowerShell", command: C("hooks/bash-guard.mjs") },
  { event: "PostToolUse", matcher: "Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell", command: C("hooks/guard.mjs") + " --post" },
  // Failures heartbeat + deliver too: an agent stuck retrying a broken build is
  // exactly the one that must stay visible to the fleet and hear a peer's
  // "stop, I broke that" mid-turn. guard.mjs --post is failure-agnostic.
  { event: "PostToolUseFailure", matcher: "Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell", command: C("hooks/guard.mjs") + " --post" },
  { event: "SessionEnd", matcher: null, command: C("hooks/session.mjs") + " --release" },
  { event: "SubagentStart", matcher: null, command: C("hooks/session.mjs") + " --subagent-start" },
  { event: "SubagentStop", matcher: null, command: C("hooks/session.mjs") + " --subagent-stop" },
];

const settings = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {};
settings.hooks = settings.hooks || {};

const has = (event, command) => (settings.hooks[event] || []).some((g) => (g.hooks || []).some((h) => h.command === command));

// Migration: a prior install registered our commands under narrower matchers
// (e.g. "Bash" without PowerShell). Upgrade those groups' matchers in place —
// only groups that contain OUR commands; user hooks are untouched.
let migrated = 0;
for (const { event, matcher, command } of WANT) {
  if (!matcher) continue;
  for (const g of settings.hooks[event] || []) {
    if ((g.matcher || null) !== matcher && (g.hooks || []).some((h) => h.command === command)) {
      g.matcher = matcher;
      migrated++;
    }
  }
}

let added = 0;
for (const { event, matcher, command } of WANT) {
  if (has(event, command)) continue;
  settings.hooks[event] = settings.hooks[event] || [];
  let group = settings.hooks[event].find((g) => (g.matcher || null) === matcher);
  if (!group) {
    group = matcher ? { matcher, hooks: [] } : { hooks: [] };
    settings.hooks[event].push(group);
  }
  group.hooks = group.hooks || [];
  group.hooks.push({ type: "command", command });
  added++;
}

const statusCmd = C("cli/statusline.mjs");
let statusNote = "kept existing";
if (!settings.statusLine) {
  settings.statusLine = { type: "command", command: statusCmd };
  statusNote = "set";
} else if (!String(settings.statusLine.command || "").includes("agent-coord")) {
  statusNote = "SKIPPED — you have a custom statusLine; add agent-coord manually if wanted";
}

if (added || migrated || statusNote === "set") {
  if (existsSync(FILE)) copyFileSync(FILE, FILE + ".bak." + Date.now());
  else mkdirSync(dirname(FILE), { recursive: true }); // fresh machine: ~/.claude may not exist yet
  writeFileSync(FILE, JSON.stringify(settings, null, 2) + "\n");
}
console.log(`Claude hooks: ${added} added, ${migrated} matcher(s) upgraded (${WANT.length - added} already present). statusLine: ${statusNote}.`);
