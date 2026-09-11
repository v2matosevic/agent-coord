import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readCodeVersion } from "../lib/version.mjs";
assert.ok(process.env.AGENT_COORD_HOME, "run through the isolated runner");
const path = join(process.env.AGENT_COORD_HOME, "fixture-package.json");
for (const body of ['{}', '{"version":null}', '{"version":123}', '{broken']) {
  writeFileSync(path, body);
  assert.equal(readCodeVersion(path), "0.0.0", "bad metadata cannot break a hook import");
}
writeFileSync(path, '{"version":"1.10.0"}');
assert.equal(readCodeVersion(path), "1.10.0");
assert.equal(readCodeVersion(path + ".missing"), "0.0.0");
console.log("Unavailable or invalid version metadata degrades to a string without breaking hooks");
