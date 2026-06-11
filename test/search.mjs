// Full-text search over coordination memory: backfill of pre-index rows,
// trigger sync on insert/update/delete, workspace + global scoping, kind
// filtering, snippet highlighting, and punctuation-proof natural queries.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate BEFORE importing modules that bind COORD_HOME.
process.env.AGENT_COORD_HOME ||= mkdtempSync(join(tmpdir(), "coord-search-"));
const { getDb, writeTxn } = await import("../lib/store.mjs");
const { postMessage } = await import("../lib/messages.mjs");
const { recordDecision } = await import("../lib/decisions.mjs");
const { createTask, updateTask } = await import("../lib/tasks.mjs");
const { searchRecords } = await import("../lib/search.mjs");

const db = getDb();
const ws = "search-ws-" + process.pid;
const other = "search-other-" + process.pid;
const checks = {};

// Seed BEFORE the first search — these rows exist with no index, so finding
// them later proves the one-time backfill.
postMessage(db, { fromAgent: "robin", workspaceId: ws, body: "heads up: refactoring the auth cookie flow, leave lib/auth alone" });
recordDecision(db, { workspaceId: ws, agentId: "falcon", topic: "auth", decision: "httpOnly JWT cookies, no localStorage" });
const t1 = createTask(db, { workspaceId: ws, title: "wire the checkout payment webhook", createdBy: "puma" });
postMessage(db, { fromAgent: "robin", workspaceId: other, body: "auth work in a DIFFERENT repo must not leak" });
postMessage(db, { fromAgent: "owl", workspaceId: null, scope: "global", body: "global broadcast: registry migration tonight" });

// 1) Backfill: pre-index rows are searchable on first query.
const auth = searchRecords(db, { workspaceId: ws, query: "auth" });
checks["backfill indexes pre-existing rows"] = auth.some((r) => r.kind === "message") && auth.some((r) => r.kind === "decision");
checks["workspace scoping holds"] = !auth.some((r) => String(r.snippet).includes("DIFFERENT repo"));
checks["snippets highlight the match"] = auth.every((r) => String(r.snippet).includes("«"));

// 2) Global broadcasts (workspace_id NULL) are searchable from any room.
checks["global broadcasts searchable"] = searchRecords(db, { workspaceId: ws, query: "registry migration" }).length === 1;

// 3) Trigger sync: a message posted AFTER the index exists is found.
postMessage(db, { fromAgent: "gecko", workspaceId: ws, body: "the carousel flickers on safari only" });
checks["insert trigger syncs new messages"] = searchRecords(db, { workspaceId: ws, query: "carousel safari" }).length === 1;

// 4) Task updates reindex: a done-summary becomes searchable text.
updateTask(db, { taskId: t1.taskId, agentId: "puma", status: "done", summary: "stripe webhook verified via signing secret; retries are idempotent" });
const sig = searchRecords(db, { workspaceId: ws, query: "signing secret idempotent" });
checks["update trigger reindexes tasks"] = sig.length === 1 && sig[0].kind === "task";

// 5) Kind filtering.
checks["kinds filter excludes others"] = searchRecords(db, { workspaceId: ws, query: "auth", kinds: ["decision"] }).every((r) => r.kind === "decision");

// 6) Natural punctuation must not hit FTS MATCH syntax errors.
checks["punctuation-proof queries"] = Array.isArray(searchRecords(db, { workspaceId: ws, query: 'auth-cookie: "flow"? (lib/auth)' }));

// 7) Delete trigger: removing the source row removes the hit.
writeTxn(db, () => db.prepare("DELETE FROM messages WHERE body LIKE '%carousel%'").run());
checks["delete trigger removes hits"] = searchRecords(db, { workspaceId: ws, query: "carousel safari" }).length === 0;

// 8) AND semantics: all terms must appear.
checks["multi-term queries are AND"] = searchRecords(db, { workspaceId: ws, query: "auth carousel" }).length === 0;

let ok = true;
for (const [k, v] of Object.entries(checks)) {
  if (!v) ok = false;
  console.log(`${v ? "✅" : "❌"} ${k}`);
}
console.log(ok ? "PASS ✅ FTS search over messages/decisions/tasks" : "FAIL ❌");
process.exit(ok ? 0 : 1);
