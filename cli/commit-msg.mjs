// Global commit-msg body. Three jobs (0 runs first):
//
// 0. Remove AI attribution lines (Co-Authored-By: Claude etc.), Marko's hard
//    rule; see lib/attribution.mjs. AGENT_COORD_KEEP_AI_ATTRIBUTION=1 skips it.
//
// 1. Stamp `Machine: <name>` on each commit so a repo shared between machines
//    shows which one made it (GitHub renders the trailer on the commit page;
//    `git log --grep "Machine: olympus"` filters by it). Never blocks. Leaves
//    alone: an empty message (git must still abort it), a message that already
//    names a machine (amend/cherry-pick keep the original), and public GitHub
//    repos, which keep a clean single-author history. A GitHub remote whose
//    visibility is unknown (offline, never cached) is also left alone: a
//    missing stamp costs nothing, a stray one in a public repo is permanent.
//
// 2. Read the `Verified: <how>` trailer and log the verdict to
//    ~/.agent-coord/verification.jsonl (lib/verification.mjs). Only in enforce
//    mode, and only for an agent's commit, a missing stamp exits 1 (refused).
//    Every other failure exits 0: the gate fails open.
import { readFileSync, writeFileSync } from "node:fs";
import { stripAiAttribution } from "../lib/attribution.mjs";
import { execFileSync } from "node:child_process";
import { machineName, isEmptyMessage } from "../lib/machine.mjs";
import { parseGitHubRepo, isPublicGitHubRemote } from "../lib/public-remote.mjs";
import { COORD_HOME, isClaudeChild } from "../lib/identity.mjs";
import {
  verifyMode,
  parseVerified,
  exemptReason,
  decide,
  appendLog,
  readLog,
  recentBlockCount,
  BLOCK_MESSAGE,
} from "../lib/verification.mjs";

const git = (args) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

async function shouldStamp() {
  let origin = "";
  try {
    origin = git(["remote", "get-url", "origin"]);
  } catch {}
  if (!parseGitHubRepo(origin)) return true;
  return (await isPublicGitHubRemote(origin)) === false;
}

function agentKind(env = process.env) {
  if (isClaudeChild(env)) return "claude";
  if (env.CODEX_THREAD_ID) return "codex";
  if (env.AGENT_COORD_TOOL) return String(env.AGENT_COORD_TOOL);
  return null;
}

const file = process.argv[2];
let text = "";
try {
  text = file ? readFileSync(file, "utf8") : "";
} catch {}

// 0. Remove AI attribution lines (lib/attribution.mjs). Never blocks.
try {
  if (file && process.env.AGENT_COORD_KEEP_AI_ATTRIBUTION !== "1") {
    const { text: cleaned, removed } = stripAiAttribution(text);
    if (removed) {
      writeFileSync(file, cleaned);
      text = cleaned;
    }
  }
} catch {}

try {
  if (file && !isEmptyMessage(text) && (await shouldStamp())) {
    execFileSync(
      "git",
      ["interpret-trailers", "--in-place", "--if-exists", "doNothing", "--trailer", `Machine: ${machineName()}`, file],
      { stdio: "ignore" },
    );
  }
} catch {}

let exitCode = 0;
try {
  const mode = verifyMode({ home: COORD_HOME });
  if (mode !== "off" && file && !isEmptyMessage(text)) {
    let repo = "";
    let branch = "";
    let gitDir = "";
    try {
      repo = git(["rev-parse", "--show-toplevel"]);
      gitDir = git(["rev-parse", "--absolute-git-dir"]);
      branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
    } catch {}
    const subject = (text.split(/\r?\n/).find((l) => l.trim() && !l.startsWith("#")) || "").trim();
    const parsed = parseVerified(text);
    const exempt = exemptReason({ branch, gitDir, subject });
    const agent = agentKind();
    const recentBlocks = mode === "enforce" ? recentBlockCount(readLog(COORD_HOME), repo) : 0;
    const verdict = decide({ mode, isAgent: !!agent, parsed, exempt, recentBlocks });
    appendLog(COORD_HOME, {
      ts: new Date().toISOString(),
      repo,
      branch,
      machine: machineName(),
      agent: agent || "human",
      subject: subject.slice(0, 120),
      verified: parsed.value,
      exempt,
      mode,
      ...verdict,
    });
    if (verdict.action === "block") {
      process.stderr.write(BLOCK_MESSAGE + "\n");
      exitCode = 1;
    }
  }
} catch {}
process.exit(exitCode);
