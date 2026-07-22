import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "../lib/store.mjs";
import { collisionHotspots, coordinationROI } from "../lib/insights.mjs";
import { COORD_HOME } from "../lib/identity.mjs";

// The "self-learning" step (SYSTEM.md §12, gated on insights proving signal): turn
// the read-only retro into a DURABLE per-project record. Deliberately conservative
// per that design note:
//   • high threshold — only multi-agent hotspots (>= --min-agents, default 2),
//   • update-not-duplicate — ONE regenerated markdown file per project, never a
//     pile of timestamped notes,
//   • does NOT touch the hand-curated Obsidian vault OR your client repos — writes
//     to agent-coord's own space (~/.agent-coord/digests/), safe to delete.
// The live, just-in-time surfacing is elsewhere (the claim_files hotspot warning
// and the query_history MCP tool); this file is the human-readable retro.

const args = process.argv.slice(2);
const flag = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : d;
};
const since = flag("--since", "7d");
const minAgents = Number(flag("--min-agents", "2"));
const m = String(since).match(/^(\d+)([dh])$/);
const windowMs = m ? Number(m[1]) * (m[2] === "d" ? 86400000 : 3600000) : 7 * 86400000;

const db = getDb();
const hotspots = collisionHotspots(db, { windowMs }).filter((h) => h.agents.length >= minAgents);

const byRepo = new Map();
for (const h of hotspots) {
  if (!byRepo.has(h.ws)) byRepo.set(h.ws, { repo: h.repo, ws: h.ws, items: [] });
  byRepo.get(h.ws).items.push(h);
}

const dir = join(COORD_HOME, "digests");
mkdirSync(dir, { recursive: true });
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "repo";
const now = new Date().toISOString();

let written = 0;
for (const { repo, ws, items } of byRepo.values()) {
  const file = join(dir, `${slug(repo)}-${ws.slice(0, 8)}.md`);
  const lines = [
    `# agent-coord insights — ${repo}`,
    "",
    `_Generated ${now} · window ${since} · machine-local retro (${file}), safe to delete._`,
    "",
    `## Multi-agent hotspots (same file, ${minAgents}+ agents)`,
    "",
    "Files edited by multiple agents recently — the lock can't catch serial",
    "same-file work, so review these for **duplicated or contradictory** changes,",
    "and claim/split them deliberately next time.",
    "",
  ];
  for (const h of items) {
    lines.push(`- \`${h.path}\` — ${h.agents.length} agents, ${h.edits} edits, last ${h.last.slice(0, 16).replace("T", " ")}  _[${h.agents.join(", ")}]_`);
  }
  // What coordination saved this repo over the window — the visible payoff that
  // justifies the per-call hook overhead.
  const roi = coordinationROI(db, { windowMs, workspaceId: ws });
  if (roi.fileBlocks || roi.resourceBlocks || roi.dupWorkBlocks) {
    lines.push("", `## What coordination did (last ${since})`, "");
    if (roi.fileBlocks) lines.push(`- ${roi.fileBlocks} concurrent-edit collision${roi.fileBlocks === 1 ? "" : "s"} blocked (${roi.selfHealedBlocks} self-healed without a human)`);
    if (roi.resourceBlocks) lines.push(`- ${roi.resourceBlocks} resource collision${roi.resourceBlocks === 1 ? "" : "s"} blocked (dev server / migration / deploy)`);
    if (roi.dupWorkBlocks) lines.push(`- ${roi.dupWorkBlocks} duplicate-work stand-down${roi.dupWorkBlocks === 1 ? "" : "s"}${roi.yieldRequests ? ` · ${roi.yieldRequests} yield request${roi.yieldRequests === 1 ? "" : "s"}` : ""}`);
  }
  lines.push("");
  writeFileSync(file, lines.join("\n"));
  written++;
  console.log(`✅ ${repo}: ${items.length} hotspot${items.length === 1 ? "" : "s"} → ${file}`);
}

if (!written) console.log(`No multi-agent hotspots (>= ${minAgents} agents) in the last ${since}. Nothing to distil — that's a good sign.`);
else console.log(`\nWrote ${written} project digest${written === 1 ? "" : "s"} to ${dir}`);
