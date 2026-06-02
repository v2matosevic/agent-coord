import { execFileSync } from "node:child_process";
import { getDb } from "../lib/store.mjs";
import { analyzePendingPush } from "../lib/pending-push.mjs";

// `coord pending-push` — review unpushed commits before pushing: whose they are,
// whether those agents are still live, and what's safe vs. needs a peer/you.
const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", cwd: process.cwd() }).trim();
const r = analyzePendingPush(getDb(), repo);

console.log("pending-push review —", repo.split("/").pop());
console.log(r.recommendation || "(nothing)");
if (r.commits.length) console.log(r.allClear ? "✅ ALL CLEAR — safe to push without asking" : "⛔ has blockers — resolve before pushing");
console.log("");
for (const c of r.commits) {
  const who = c.mine ? "yours" : `by ${c.agent}${c.live ? " — LIVE" : c.agent !== "unknown" && c.agent !== "manual" ? " — finished" : ""}`;
  console.log(`  ${c.hash}  ${c.wip ? "⚠WIP " : ""}${c.subject}`);
  console.log(`        ${who}  →  ${c.verdict}`);
}
