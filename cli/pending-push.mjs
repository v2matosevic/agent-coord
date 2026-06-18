import { execFileSync } from "node:child_process";
import { getDb } from "../lib/store.mjs";
import { analyzePendingPush } from "../lib/pending-push.mjs";
import { sessionAnchorPids } from "../lib/session-link.mjs";

// `coord pending-push` — review unpushed commits before pushing: whose they are,
// whether those agents are still live, and what's safe vs. needs a peer/you.
// Pass the session anchor pids so own commits are recognized via the claude.exe
// session-link (this CLI's raw ppid is the shell that launched it, not claude.exe)
// — same identity invariant as the MCP server (BUG 1, OBSERVED-BUGS-2026-06-18).
const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", cwd: process.cwd() }).trim();
const r = analyzePendingPush(getDb(), repo, null, { ppids: sessionAnchorPids() });

console.log("pending-push review —", repo.split("/").pop());
console.log(r.recommendation || "(nothing)");
if (r.commits.length) console.log(r.allClear ? "✅ ALL CLEAR — safe to push without asking" : "⛔ has blockers — resolve before pushing");
console.log("");
for (const c of r.commits) {
  const who = c.mine ? "yours" : `by ${c.agent}${c.live ? " — LIVE" : c.agent !== "unknown" && c.agent !== "manual" ? " — finished" : ""}`;
  console.log(`  ${c.hash}  ${c.wip ? "⚠WIP " : ""}${c.subject}`);
  console.log(`        ${who}  →  ${c.verdict}`);
}
