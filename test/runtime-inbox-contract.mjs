// Byte-identical fixture is consumed by ADE's Rust health reader.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getDb, writeTxn } from "../lib/store.mjs";
import { unreadCount, readMessages } from "../lib/messages.mjs";
assert.ok(process.env.AGENT_COORD_HOME, "run through the isolated runner");
const fixture = JSON.parse(readFileSync(new URL("fixtures/runtime-inbox.json", import.meta.url), "utf8"));
const db = getDb(), now = Date.now();
const iso = offset => new Date(now + offset).toISOString();
writeTxn(db, () => {
  for (const a of fixture.agents) db.prepare("INSERT INTO agents(agent_id,status,registered_at,last_heartbeat) VALUES(?,?,?,?)").run(a.id, a.status, iso(a.registered), iso(a.heartbeat));
  db.prepare("INSERT INTO message_reads VALUES(?,?)").run(fixture.recipient, fixture.readSeq);
  for (const m of fixture.messages) db.prepare("INSERT INTO messages(seq,ts,workspace_id,from_agent,to_agent,body,expires_at) VALUES(?,?,?,?,?,'fixture',?)")
    .run(m.seq, iso(m.at), m.ws, m.from, m.to, iso(m.expires));
});
const options = { agentId: fixture.recipient, workspaceId: fixture.workspace };
assert.equal(unreadCount(db, options), fixture.expectedSeqs.length);
assert.deepEqual(readMessages(db, { ...options, advance: false }).messages.map(m => m.seq), fixture.expectedSeqs);
assert.equal(db.prepare("SELECT last_seq FROM message_reads WHERE agent_id=?").get(fixture.recipient).last_seq, fixture.readSeq);
console.log("Runtime inbox fixture matches active delivery rules without advancing the cursor");
