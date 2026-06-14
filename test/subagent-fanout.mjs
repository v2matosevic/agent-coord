// Fan-out identity unification + family overlap exclusion.
//
// Regression for the 2026-06-14 "ghost twin on fan-out" bug: when Claude hands a
// subagent a session_id DIFFERENT from its parent, agentIdFromSession would mint
// a SEPARATE base codename for the whole fan-out (parent "horse", subagents
// "goat/..."), so one session looked like two and the duplicate-work guard stood
// subagents down against their own siblings. The fix: pin a subagent's base to
// the parent's via parentBase, and never flag same-base family as duplicate work.
import { getDb, writeTxn } from "../lib/store.mjs";
import { ensureAgent, heartbeat } from "../lib/agents.mjs";
import { workspaceId } from "../lib/path-canon.mjs";
import { resolveAgentId, baseAgentId } from "../lib/identity.mjs";
import { findOverlappingPeers, clearOverlapNotice } from "../lib/overlap.mjs";

const db = getDb();
const checks = {};

// 1. Identity: parent resolved first claims a base. A subagent carrying a
//    DIFFERENT session_id splits off its own base (the bug) unless parentBase
//    pins it back to the parent.
const parent = resolveAgentId({ session_id: "sess-parent" });
const childDivergent = resolveAgentId({ session_id: "sess-child-divergent", agent_id: "aaaaaa", agent_type: "general-purpose" });
const childPinned = resolveAgentId({ session_id: "sess-child-divergent", agent_id: "aaaaaa", agent_type: "general-purpose" }, { parentBase: parent });
checks["divergent session_id splits the base (the bug)"] = baseAgentId(childDivergent) !== parent;
checks["parentBase pins subagent to the parent base"] = baseAgentId(childPinned) === parent;
checks["pinned id is parent/type-tag"] = childPinned === `${parent}/general-purp-aaaaaa`;
checks["baseAgentId strips suffix / no-op on a base"] =
  baseAgentId("horse/general-purp-aaaaaa") === "horse" && baseAgentId("horse") === "horse";

// 2. Overlap: an agent never flags its own session family, still flags a real
//    cross-session peer running the same task.
const repo = "/t/fanout-" + process.pid;
const ws = workspaceId(repo);
const TASK = "light currency refresh of the wordpress elementor blog posts across croatian german english locales";
const P = parent; // parent session
const S = `${parent}/general-purp-bbbbbb`; // a subagent (same base as parent)
const X = "beaver"; // an unrelated, separate session
const ids = [P, S, X];
const clean = () => writeTxn(db, () => db.prepare(`DELETE FROM agents WHERE agent_id IN (${ids.map(() => "?").join(",")})`).run(...ids));
clean();
ids.forEach(clearOverlapNotice);
for (const id of ids) {
  ensureAgent(db, { agentId: id, repoPath: repo, branch: "main" });
  heartbeat(db, id, TASK);
}

const sOverlaps = findOverlappingPeers(db, { agentId: S, workspaceId: ws, task: TASK });
const pOverlaps = findOverlappingPeers(db, { agentId: P, workspaceId: ws, task: TASK });
checks["subagent does NOT flag its parent (same base)"] = !sOverlaps.some((p) => p.agentId === P);
checks["parent does NOT flag its own subagent (same base)"] = !pOverlaps.some((p) => p.agentId === S);
checks["subagent STILL flags a cross-session peer"] = sOverlaps.some((p) => p.agentId === X);
checks["parent STILL flags a cross-session peer"] = pOverlaps.some((p) => p.agentId === X);

clean();
ids.forEach(clearOverlapNotice);

let ok = true;
for (const [k, v] of Object.entries(checks)) {
  if (!v) ok = false;
  console.log(`${v ? "✅" : "❌"} ${k}`);
}
console.log(`parent=${parent} childDivergent=${childDivergent} childPinned=${childPinned}`);
console.log(ok ? "PASS ✅ fan-out identity unification + family overlap exclusion" : "FAIL ❌");
process.exit(ok ? 0 : 1);
