import { writeTxn } from "./store.mjs";

// Full-text search over the coordination memory — messages, decisions, and
// tasks. The store accumulates exactly the context an arriving agent needs
// ("have we decided how auth works?", "did anyone mention the checkout bug?"),
// but until now the only access was chronological dumps. One FTS5 virtual
// table indexes all three record kinds; SQLite triggers keep it in sync with
// zero changes to the write paths, and a one-time backfill indexes whatever
// the store already holds. activity_log is deliberately NOT indexed — it's
// high-volume/low-text, and query_history already serves it.
//
// FTS5 ships in Node's bundled SQLite, but if a build lacks it (or the
// migration fails mid-flight on an old store) everything degrades to a LIKE
// scan: same results shape, no ranking — fail open, never block.

let _ftsState = null; // null = unprobed; true/false after ensureSearchIndex

// The trigger set mirrors every write path of the three indexed tables.
// Contentless-delete is avoided on purpose: storing the text in the FTS table
// keeps snippet()/highlight() working and the queries trivial.
const FTS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  text, kind UNINDEXED, ref UNINDEXED, workspace_id UNINDEXED, agent UNINDEXED, ts UNINDEXED
);
CREATE TRIGGER IF NOT EXISTS fts_msg_ai AFTER INSERT ON messages BEGIN
  INSERT INTO search_index(text, kind, ref, workspace_id, agent, ts)
  VALUES (new.body, 'message', new.seq, new.workspace_id, new.from_agent, new.ts);
END;
CREATE TRIGGER IF NOT EXISTS fts_msg_ad AFTER DELETE ON messages BEGIN
  DELETE FROM search_index WHERE kind='message' AND ref=old.seq;
END;
CREATE TRIGGER IF NOT EXISTS fts_dec_ai AFTER INSERT ON decisions BEGIN
  INSERT INTO search_index(text, kind, ref, workspace_id, agent, ts)
  VALUES (new.topic || ': ' || new.decision, 'decision', new.decision_id, new.workspace_id, new.agent_id, new.ts);
END;
CREATE TRIGGER IF NOT EXISTS fts_dec_ad AFTER DELETE ON decisions BEGIN
  DELETE FROM search_index WHERE kind='decision' AND ref=old.decision_id;
END;
CREATE TRIGGER IF NOT EXISTS fts_task_ai AFTER INSERT ON tasks BEGIN
  INSERT INTO search_index(text, kind, ref, workspace_id, agent, ts)
  VALUES (new.title || COALESCE(' — ' || new.detail, '') || COALESCE(' — ' || new.summary, ''),
          'task', new.task_id, new.workspace_id, COALESCE(new.owner_agent, new.created_by), new.created_at);
END;
CREATE TRIGGER IF NOT EXISTS fts_task_au AFTER UPDATE ON tasks BEGIN
  DELETE FROM search_index WHERE kind='task' AND ref=old.task_id;
  INSERT INTO search_index(text, kind, ref, workspace_id, agent, ts)
  VALUES (new.title || COALESCE(' — ' || new.detail, '') || COALESCE(' — ' || new.summary, ''),
          'task', new.task_id, new.workspace_id, COALESCE(new.owner_agent, new.created_by), new.created_at);
END;
CREATE TRIGGER IF NOT EXISTS fts_task_ad AFTER DELETE ON tasks BEGIN
  DELETE FROM search_index WHERE kind='task' AND ref=old.task_id;
END;
`;

const BACKFILL = `
INSERT INTO search_index(text, kind, ref, workspace_id, agent, ts)
  SELECT body, 'message', seq, workspace_id, from_agent, ts FROM messages;
INSERT INTO search_index(text, kind, ref, workspace_id, agent, ts)
  SELECT topic || ': ' || decision, 'decision', decision_id, workspace_id, agent_id, ts FROM decisions;
INSERT INTO search_index(text, kind, ref, workspace_id, agent, ts)
  SELECT title || COALESCE(' — ' || detail, '') || COALESCE(' — ' || summary, ''),
         'task', task_id, workspace_id, COALESCE(owner_agent, created_by), created_at FROM tasks;
`;

// Create the index + triggers (idempotent) and backfill exactly once. Called
// lazily from search() — most processes never search, so they never pay this.
export function ensureSearchIndex(db) {
  if (_ftsState !== null) return _ftsState;
  try {
    const existed = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='search_index'").get();
    writeTxn(db, () => {
      db.exec(FTS_DDL);
      if (!existed) db.exec(BACKFILL);
    });
    _ftsState = true;
  } catch {
    _ftsState = false; // no FTS5 in this build (or locked mid-migration) — LIKE fallback
  }
  return _ftsState;
}

// FTS5 treats ., -, :, etc. as syntax. Agents pass natural language, so quote
// each term instead of asking callers to know MATCH grammar. AND semantics.
function ftsQuery(q) {
  const terms = String(q || "").match(/[^\s"']+/g) || [];
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

const KINDS = new Set(["message", "decision", "task"]);

// Search the coordination memory. Returns [{kind, ref, agent, ts, snippet}]
// best-match first (FTS rank; recency on the fallback path). `workspaceId`
// scopes to the room; global broadcasts (workspace_id NULL) are always
// searchable since every room could have heard them.
export function searchRecords(db, { workspaceId, query, kinds = null, limit = 12 }) {
  const q = String(query || "").trim();
  if (!q) return [];
  const lim = Math.max(1, Math.min(50, Number(limit) || 12));
  const wanted = Array.isArray(kinds) && kinds.length ? kinds.filter((k) => KINDS.has(k)) : [...KINDS];
  if (!wanted.length) return [];
  const kindIn = wanted.map(() => "?").join(",");

  if (ensureSearchIndex(db)) {
    try {
      return db
        .prepare(
          `SELECT kind, ref, agent, ts, snippet(search_index, 0, '«', '»', ' … ', 16) AS snippet
           FROM search_index
           WHERE search_index MATCH ? AND kind IN (${kindIn}) AND (workspace_id IS NULL OR workspace_id = ?)
           ORDER BY rank LIMIT ?`,
        )
        .all(ftsQuery(q), ...wanted, workspaceId, lim);
    } catch {
      // fall through to LIKE — e.g. a query FTS still rejects
    }
  }

  // Fallback: LIKE scan over the source tables (every term must appear).
  const terms = (q.match(/[^\s"']+/g) || []).map((t) => `%${t}%`);
  const likes = (col) => terms.map(() => `${col} LIKE ?`).join(" AND ");
  const out = [];
  if (wanted.includes("message")) {
    out.push(
      ...db
        .prepare(`SELECT 'message' kind, seq ref, from_agent agent, ts, body snippet FROM messages WHERE ${likes("body")} AND (workspace_id IS NULL OR workspace_id=?) ORDER BY seq DESC LIMIT ?`)
        .all(...terms, workspaceId, lim),
    );
  }
  if (wanted.includes("decision")) {
    out.push(
      ...db
        .prepare(`SELECT 'decision' kind, decision_id ref, agent_id agent, ts, topic || ': ' || decision snippet FROM decisions WHERE ${likes("topic || ': ' || decision")} AND workspace_id=? ORDER BY rowid DESC LIMIT ?`)
        .all(...terms, workspaceId, lim),
    );
  }
  if (wanted.includes("task")) {
    out.push(
      ...db
        .prepare(`SELECT 'task' kind, task_id ref, COALESCE(owner_agent, created_by) agent, created_at ts, title || COALESCE(' — ' || summary, '') snippet FROM tasks WHERE ${likes("title || COALESCE(' — ' || detail, '') || COALESCE(' — ' || summary, '')")} AND workspace_id=? ORDER BY rowid DESC LIMIT ?`)
        .all(...terms, workspaceId, lim),
    );
  }
  return out.sort((a, b) => String(b.ts).localeCompare(String(a.ts))).slice(0, lim);
}
