// How much work ships with evidence. Reads ~/.agent-coord/verification.jsonl
// (written by the global commit-msg hook) and prints, per repo, how many
// commits were verified, stamped "none" with a reason, or carried no stamp,
// plus the latest commits an enforce-mode gate would have refused.
//
//   node cli/verify-report.mjs                 last 14 days, all repos
//   node cli/verify-report.mjs --days 30 --repo Athena
//   node cli/verify-report.mjs --json          raw summary for other tools
//   node cli/verify-report.mjs --mode observe|enforce|off   set the gate mode
import { writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { COORD_HOME } from "../lib/identity.mjs";
import { readLog, verifyMode, MODES } from "../lib/verification.mjs";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const setMode = opt("--mode", null);
if (setMode) {
  if (!MODES.includes(setMode)) {
    console.error(`mode must be one of: ${MODES.join(", ")}`);
    process.exit(2);
  }
  mkdirSync(COORD_HOME, { recursive: true });
  writeFileSync(join(COORD_HOME, "verify-mode"), setMode + "\n");
  console.log(`verification gate mode: ${setMode} (env AGENT_COORD_VERIFY_MODE still overrides)`);
  process.exit(0);
}

const days = Number(opt("--days", "14")) || 14;
const repoFilter = opt("--repo", "").toLowerCase();
const since = Date.now() - days * 86400_000;
const entries = readLog(COORD_HOME).filter(
  (e) => Date.parse(e.ts) >= since && (!repoFilter || String(e.repo).toLowerCase().includes(repoFilter)),
);

const byRepo = new Map();
for (const e of entries) {
  const k = e.repo || "(unknown)";
  if (!byRepo.has(k)) byRepo.set(k, { total: 0, verified: 0, none: 0, missing: 0, exempt: 0, agentMissing: 0, blocked: 0, escaped: 0, methods: {} });
  const r = byRepo.get(k);
  r.total++;
  if (e.outcome === "verified") {
    r.verified++;
    const m = String(e.verified || "").split(/[\s(,;]/)[0].toLowerCase();
    if (m) r.methods[m] = (r.methods[m] || 0) + 1;
  } else if (e.outcome === "none") r.none++;
  else if (e.outcome === "exempt") r.exempt++;
  else r.missing++;
  if (e.wouldBlock) r.agentMissing++;
  if (e.action === "block") r.blocked++;
  if (e.action === "escaped") r.escaped++;
}

const summary = {
  mode: verifyMode({ home: COORD_HOME }),
  days,
  commits: entries.length,
  repos: Object.fromEntries(byRepo),
};

if (args.includes("--json")) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

console.log(`Verification stamps, last ${days} days. Gate mode: ${summary.mode}.`);
if (!entries.length) {
  console.log("No commits logged yet. The log fills as commits are made on this machine.");
  process.exit(0);
}
const pct = (n, d) => (d ? Math.round((100 * n) / d) + "%" : "-");
const rows = [...byRepo.entries()].sort((a, b) => b[1].total - a[1].total);
console.log("");
console.log("repo".padEnd(28) + "commits  verified  none  no-stamp  agent-no-stamp  top methods");
for (const [repo, r] of rows) {
  const judged = r.total - r.exempt;
  const top = Object.entries(r.methods).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m, n]) => `${m}×${n}`).join(" ");
  console.log(
    basename(repo).slice(0, 27).padEnd(28) +
      String(r.total).padEnd(9) +
      pct(r.verified, judged).padEnd(10) +
      String(r.none).padEnd(6) +
      String(r.missing).padEnd(10) +
      String(r.agentMissing).padEnd(16) +
      top,
  );
}
const would = entries.filter((e) => e.wouldBlock).slice(-10);
if (would.length) {
  console.log("\nLatest agent commits an enforce-mode gate would have refused:");
  for (const e of would) console.log(`  ${e.ts.slice(0, 16)}  ${basename(e.repo)}  ${e.agent}  ${e.subject}`);
}
