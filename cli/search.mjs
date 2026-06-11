import { getDb } from "../lib/store.mjs";
import { searchRecords } from "../lib/search.mjs";
import { gitContext } from "../lib/git-context.mjs";
import { workspaceId } from "../lib/path-canon.mjs";

// Terminal face of lib/search.mjs — full-text search over this repo's
// coordination memory (messages, decisions, tasks). Agents use the MCP
// `search` tool; this is for the human:
//   node cli/search.mjs "auth cookie decision"
//   node cli/search.mjs --kinds decision,task --limit 20 "migration"

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : null;
};
const kinds = flag("--kinds")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
const limit = Number(flag("--limit")) || 12;
const query = args.join(" ").trim();

if (!query) {
  console.log('usage: search.mjs [--kinds message,decision,task] [--limit N] "<query>"');
  process.exit(1);
}

const { repoRoot } = gitContext(process.cwd());
const ws = workspaceId(repoRoot);
const rows = searchRecords(getDb(), { workspaceId: ws, query, kinds, limit });

if (!rows.length) {
  console.log(`no matches for "${query}" in this repo's coordination memory`);
  process.exit(0);
}
const icon = { message: "✉", decision: "📌", task: "▦" };
for (const r of rows) {
  const when = String(r.ts || "").slice(0, 16).replace("T", " ");
  console.log(`${icon[r.kind] || "•"} [${r.kind}] ${when}  ${r.agent || "?"}\n   ${String(r.snippet).replace(/\s+/g, " ").slice(0, 200)}`);
}
