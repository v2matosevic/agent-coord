import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { INSTRUCTIONS, TOOL_DEFS } from "../mcp/tool-defs.mjs";

// Captured from v1.9.1 before the description-only optimization. This guards
// compatibility with clients, native hook rewriting and saved ADE profiles.
const contract = JSON.stringify(TOOL_DEFS.map(({ name, inputSchema }) => ({ name, inputSchema })));
assert.equal(createHash("sha256").update(contract).digest("hex"), "f0989e025fd9ea64dbf41c7c46bb0e73425c523ec972c94f1c2328c7086bef61");
const first = INSTRUCTIONS.slice(0, 512);
for (const rule of ["announce_intent", "trusted native hooks", "claim_files", "read_messages", "never force-release", "pending_push_review"]) assert.ok(first.includes(rule), rule);
assert.ok(Buffer.byteLength(INSTRUCTIONS) <= 600);
assert.ok(Buffer.byteLength(JSON.stringify({ instructions: INSTRUCTIONS, tools: TOOL_DEFS })) <= 17_500);
console.log("All 28 names and schemas unchanged; critical guidance fits first 512 characters; catalog stays within budget");
