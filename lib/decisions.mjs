import { randomUUID } from "node:crypto";
import { writeTxn, nowIso } from "./store.mjs";
import { insertMessage } from "./messages.mjs";

// Decision log — the coherence primitive for the one root-cause failure nothing
// else catches: two agents making CONTRADICTORY architectural choices in
// different files (locks see same-file edits, overlap sees same-task text;
// neither sees "JWT here, sessions there"). A decision is workspace-scoped,
// keyed by a short topic, append-only (history kept; latest per topic wins).
//
// Recording one also broadcasts it to the room, so live peers hear it mid-turn
// (📬) and new agents see the current set in their session-start room brief.

export function recordDecision(db, { workspaceId, agentId, topic, decision }) {
  const t = String(topic || "").trim();
  const d = String(decision || "").trim();
  if (!t || !d) return { ok: false, error: "topic and decision are both required" };
  return writeTxn(db, () => {
    const id = "d-" + randomUUID().replace(/-/g, "").slice(0, 6);
    db.prepare("INSERT INTO decisions(decision_id,workspace_id,agent_id,topic,decision,ts) VALUES(?,?,?,?,?,?)").run(
      id,
      workspaceId,
      agentId,
      t,
      d,
      nowIso(),
    );
    insertMessage(db, { fromAgent: agentId, workspaceId, body: `📌 decision [${t}]: ${d}` });
    return { ok: true, decisionId: id, topic: t };
  });
}

// Latest decision per topic, newest first. `limit` caps topics, not rows.
export function listDecisions(db, { workspaceId, limit = 20 }) {
  const rows = db.prepare("SELECT * FROM decisions WHERE workspace_id=? ORDER BY rowid DESC").all(workspaceId); // rowid = insert order; ts alone ties within 1ms
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const key = r.topic.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ decision_id: r.decision_id, topic: r.topic, decision: r.decision, by: r.agent_id, ts: r.ts });
    if (out.length >= limit) break;
  }
  return out;
}
