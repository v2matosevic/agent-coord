import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { INSTRUCTIONS, TOOL_DEFS } from "../mcp/tool-defs.mjs";

// Updated for the additive reliable directed-message tool. This guards
// compatibility with clients, native hook rewriting and saved ADE profiles.
const contract = JSON.stringify(TOOL_DEFS.map(({ name, inputSchema }) => ({ name, inputSchema })));
assert.equal(createHash("sha256").update(contract).digest("hex"), "00eb3912901fe78803ea5b441140f53e3353a32f373e9ad6cdf52c6900720c3d");
const first = INSTRUCTIONS.slice(0, 512);
for (const rule of ["announce_intent", "trusted native hooks", "claim_files", "read_messages", "never force-release", "pending_push_review"]) assert.ok(first.includes(rule), rule);
assert.ok(Buffer.byteLength(INSTRUCTIONS) <= 600);
assert.ok(Buffer.byteLength(JSON.stringify({ instructions: INSTRUCTIONS, tools: TOOL_DEFS })) <= 17_500);
console.log("All 30 names and schemas match the reliable-message contract; critical guidance and catalog stay within budget");
