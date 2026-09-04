// Single-word name claiming: stable per session, unique across live sessions
// (the property pure hashing can't give from a 64-word pool), pool-exhaustion
// suffix fallback, and preservation of stale owners.
import { mkdtempSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate BEFORE importing the module that binds COORD_HOME.
process.env.AGENT_COORD_HOME ||= mkdtempSync(join(tmpdir(), "coord-names-"));
const { agentIdFromSession, COORD_HOME } = await import("../lib/identity.mjs");

const checks = {};
const POOL = 64;

// 1) Stable: same session id resolves to the same single-word name.
const a = agentIdFromSession("session-A");
checks["name is a single word"] = /^[a-z]+$/.test(a);
checks["same session -> same name"] = agentIdFromSession("session-A") === a;

// 2) Unique: many concurrent sessions never share a name. Pure hashing over a
//    64-word pool would collide almost surely across 50 sessions.
const names = new Set();
for (let i = 0; i < 50; i++) names.add(agentIdFromSession("burst-" + i));
checks["50 sessions -> 50 distinct names"] = names.size === 50 && names.has(a) === false;

// 3) Pool exhausted -> stable suffix instead of another session's mailbox key.
for (let i = 50; i < POOL + 5; i++) agentIdFromSession("burst-" + i); // fill the rest
const overflow = agentIdFromSession("the-65th-session");
checks["exhausted pool uses a session suffix"] = /^[a-z]+-[a-f0-9]{16}$/.test(overflow);

// 4) Old mail and provenance outlive liveness: stale names cannot be recycled.
const dir = join(COORD_HOME, "names");
const old = new Date(Date.now() - 25 * 3600 * 1000);
for (const f of readdirSync(dir)) utimesSync(join(dir, f), old, old);
const fresh = agentIdFromSession("after-the-flood");
checks["stale owners are preserved"] = /^[a-z]+-[a-f0-9]{16}$/.test(fresh) && agentIdFromSession("session-A") === a;

let ok = true;
for (const [k, v] of Object.entries(checks)) {
  if (!v) ok = false;
  console.log(`${v ? "✅" : "❌"} ${k}`);
}
console.log(ok ? "PASS ✅ claimed, speakable, collision-free names" : "FAIL ❌");
process.exit(ok ? 0 : 1);
