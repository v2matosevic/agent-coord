// getGlobalState: the default is COMPLETE lists (human-facing consumers —
// menubar contention badge, dashboard, snapshot/fleet view — derive counts and
// conflict detection from list lengths, so clipping them hides real state).
// The cap is opt-in for the MCP tool only, covers EVERY list (incl.
// resourceLeases), and always announces what it clipped in `note`.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_COORD_HOME ||= mkdtempSync(join(tmpdir(), "coord-gstate-"));
const { getDb } = await import("../lib/store.mjs");
const { ensureAgent } = await import("../lib/agents.mjs");
const { claimFile, claimResource } = await import("../lib/leases.mjs");
const { createTask } = await import("../lib/tasks.mjs");
const { getGlobalState } = await import("../lib/activity.mjs");

const db = getDb();
const ws = "gstate-ws-" + process.pid;
const [A, B] = ["gstate-a-" + process.pid, "gstate-b-" + process.pid];
for (const id of [A, B]) ensureAgent(db, { agentId: id, repoPath: "/t/gstate", branch: "m" });

const N = 8;
// f0 claimed shared so B's shared claim below can coexist (a warm exclusive
// lease would block it) — the point is TWO live rows on one path.
for (let i = 0; i < N; i++) claimFile(db, { agentId: A, workspaceId: ws, path: `src/f${i}.ts`, mode: i === 0 ? "shared" : "exclusive" });
for (let i = 0; i < N; i++) claimResource(db, { agentId: A, resourceId: `res-${process.pid}-${i}` });
for (let i = 0; i < N; i++) createTask(db, { workspaceId: ws, title: `task ${i}`, createdBy: A });
// The contention case the cap must not hide from DEFAULT consumers: B also
// holds a lease on A's OLDEST-claimed path (claim as shared so both rows live).
claimFile(db, { agentId: B, workspaceId: ws, path: "src/f0.ts", mode: "shared" });

const checks = {};

const full = getGlobalState(db);
checks["default: complete leases (no cap)"] = full.fileLeases.filter((l) => l.workspace_id === ws).length === N + 1;
checks["default: complete tasks"] = full.tasks.filter((t) => t.workspace_id === ws).length === N;
checks["default: no truncation note"] = !("note" in full);
checks["default: conflict pair visible"] = full.fileLeases.filter((l) => l.workspace_id === ws && l.path === "src/f0.ts").length === 2;

const CAP = 5;
const capped = getGlobalState(db, { cap: CAP });
checks["capped: leases clipped to cap"] = capped.fileLeases.length === CAP;
checks["capped: resourceLeases clipped too"] = capped.resourceLeases.length === CAP;
checks["capped: tasks clipped"] = capped.tasks.length === CAP;
checks["capped: newest rows kept"] = capped.fileLeases.some((l) => l.path === "src/f0.ts" && l.agent_id === B); // B's claim is the newest
checks["capped: note names every clipped list"] =
  typeof capped.note === "string" && ["fileLeases", "resourceLeases", "queue", "tasks"].filter((k) => capped[k].length === CAP).every((k) => capped.note.includes(k));

let ok = true;
for (const [k, v] of Object.entries(checks)) {
  if (!v) ok = false;
  console.log(`${v ? "✅" : "❌"} ${k}`);
}
console.log(ok ? "PASS ✅ global state: complete by default, cap opt-in + loud" : "FAIL ❌");
process.exit(ok ? 0 : 1);
