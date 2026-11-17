import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Verification stamp: every commit says how its change was verified, in a
// `Verified: <how>` trailer ("e2e-browser", "tests", "render-viewed", or
// "none (docs only)"). The global commit-msg hook reads it, logs one line per
// commit, and in enforce mode refuses an AGENT's commit that has no stamp.
//
// Modes (AGENT_COORD_VERIFY_MODE env > <COORD_HOME>/verify-mode file > default):
//   off      no logging, no blocking
//   observe  log what would have been blocked; never block   (DEFAULT)
//   enforce  block an agent commit with no stamp, or with `none` and no reason
//
// Escape hatches, so an agent never wedges: a commit carrying `Verified: none
// (<reason>)` always passes; after two blocks in the same repo within 30 min
// the third attempt is let through and logged as "escaped"; humans (no agent
// identity in env) are logged but never blocked; merges, rebases, cherry-picks,
// reverts and wip/* snapshot branches are exempt.
//
// Source: the Claude Code team's verification post (claude.dev, 2026-11-16):
// stamp commits with how they were verified, including "none", and start every
// new gate in observe mode.

export const MODES = ["off", "observe", "enforce"];
export const DEFAULT_MODE = "observe";
export const ESCAPE_AFTER_BLOCKS = 2;
export const ESCAPE_WINDOW_MS = 30 * 60 * 1000;

export function verifyMode({ env = process.env, home } = {}) {
  const fromEnv = String(env.AGENT_COORD_VERIFY_MODE || "").trim().toLowerCase();
  if (MODES.includes(fromEnv)) return fromEnv;
  if (home) {
    try {
      const fromFile = readFileSync(join(home, "verify-mode"), "utf8").trim().toLowerCase();
      if (MODES.includes(fromFile)) return fromFile;
    } catch {}
  }
  return DEFAULT_MODE;
}

// Last `Verified:` trailer wins (an amend that adds a second one is the newer
// statement). Comment lines and anything below a scissors line are ignored.
export function parseVerified(text, commentChar = "#") {
  let value = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith(commentChar) && line.includes(" >8 ")) break;
    if (line.startsWith(commentChar)) continue;
    const m = /^verified\s*:\s*(.*)$/i.exec(line.trim());
    if (m) value = m[1].trim();
  }
  if (value === null) return { present: false, value: null, none: false, reason: null };
  const none = /^(none|no|unverified)\b/i.test(value);
  let reason = null;
  if (none) {
    const rest = value.replace(/^(none|no|unverified)\b/i, "").trim();
    const inner = /^\((.*)\)$/.exec(rest);
    reason = (inner ? inner[1] : rest.replace(/^[-:,;]\s*/, "")).trim() || null;
  }
  return { present: value !== "", value: value || null, none, reason };
}

// Why this commit is not judged, or null. `state` holds what the hook read
// from the repo: { branch, gitDir, subject }.
export function exemptReason({ branch = "", gitDir = "", subject = "" } = {}) {
  if (/^wip\//.test(branch)) return "wip-branch";
  const has = (f) => {
    try {
      return gitDir && existsSync(join(gitDir, f));
    } catch {
      return false;
    }
  };
  if (has("MERGE_HEAD")) return "merge";
  if (has("rebase-merge") || has("rebase-apply")) return "rebase";
  if (has("CHERRY_PICK_HEAD")) return "cherry-pick";
  if (has("REVERT_HEAD")) return "revert";
  if (/^(Merge (branch|remote-tracking branch|pull request)|Revert ")/.test(subject)) return "merge";
  if (/^(fixup|squash|amend)! /.test(subject)) return "fixup";
  return null;
}

// The judgement. Pure: no I/O, so it is testable.
export function decide({ mode, isAgent, parsed, exempt, recentBlocks = 0 }) {
  let outcome;
  if (exempt) outcome = "exempt";
  else if (!parsed.present) outcome = "missing";
  else if (parsed.none && !parsed.reason) outcome = "none-no-reason";
  else if (parsed.none) outcome = "none";
  else outcome = "verified";
  const failing = outcome === "missing" || outcome === "none-no-reason";
  const wouldBlock = failing && isAgent;
  let action = "allow";
  if (mode === "enforce" && wouldBlock) action = recentBlocks >= ESCAPE_AFTER_BLOCKS ? "escaped" : "block";
  return { outcome, wouldBlock, action };
}

export function logPath(home) {
  return join(home, "verification.jsonl");
}

export function appendLog(home, entry) {
  try {
    mkdirSync(home, { recursive: true });
    appendFileSync(logPath(home), JSON.stringify(entry) + "\n");
  } catch {}
}

export function readLog(home) {
  let raw = "";
  try {
    raw = readFileSync(logPath(home), "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

export function recentBlockCount(entries, repo, now = Date.now()) {
  return entries.filter(
    (e) => e.action === "block" && e.repo === repo && now - Date.parse(e.ts) < ESCAPE_WINDOW_MS,
  ).length;
}

export const BLOCK_MESSAGE = `agent-coord: commit refused, no verification stamp.
Add a trailer saying how this change was verified, for example:
  Verified: e2e-browser (checkout flow clicked through, screenshot read)
  Verified: tests (php artisan test --filter=Invoice, 14 passed)
  Verified: render-viewed (frames 0/90/180 read)
  Verified: none (docs only)
A "none" stamp needs its reason in brackets. Run the verify skill first if the
change touches behaviour. Mode: AGENT_COORD_VERIFY_MODE or ~/.agent-coord/verify-mode.`;
