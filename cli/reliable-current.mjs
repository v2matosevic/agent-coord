import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { DB_PATH } from "../lib/store.mjs";
import { currentReliableMessage } from "../lib/messages.mjs";

const at = process.argv.indexOf("--recipient");
const recipient = at >= 0 ? process.argv[at + 1] : null;
if (!recipient) {
  process.stderr.write("usage: reliable-current.mjs --recipient <agent-id>\n");
  process.exit(2);
}

const result = { version: "agent-coord/reliable-current/v1", available: false, current: null };
if (existsSync(DB_PATH)) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    result.available = !!db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='reliable_messages'",
    ).get();
    if (result.available) result.current = currentReliableMessage(db, { recipientAgent: recipient });
  } finally {
    db.close();
  }
}
process.stdout.write(JSON.stringify(result));
