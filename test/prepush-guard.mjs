// Public-remote WIP guard: URL parsing across remote forms, the pushed-refs
// decision matrix (wip create/update vs delete vs normal branches), and the
// disk-cached visibility oracle (no live network — fetch is injected).
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { COORD_HOME } from "../lib/identity.mjs";
import { parseGitHubRepo, isPublicGitHubRemote, wipRefsBeingPushed } from "../lib/public-remote.mjs";

const checks = {};
const SHA = "a".repeat(40);
const ZERO = "0".repeat(40);

// — remote URL parsing —
checks["https form"] = parseGitHubRepo("https://github.com/owner/repo.git") === "owner/repo";
checks["https no .git"] = parseGitHubRepo("https://github.com/owner/repo") === "owner/repo";
checks["ssh form"] = parseGitHubRepo("git@github.com:owner/repo.git") === "owner/repo";
checks["ssh url form"] = parseGitHubRepo("ssh://git@github.com/owner/repo") === "owner/repo";
checks["non-github -> null"] = parseGitHubRepo("https://gitlab.com/o/r.git") === null;
checks["garbage -> null"] = parseGitHubRepo("not a url") === null;

// — pushed-refs matrix —
checks["wip update detected"] = JSON.stringify(wipRefsBeingPushed(`refs/heads/wip/olympus ${SHA} refs/heads/wip/olympus ${ZERO}`)) === JSON.stringify(["wip/olympus"]);
checks["wip DELETE exempt"] = wipRefsBeingPushed(`(delete) ${ZERO} refs/heads/wip/olympus ${SHA}`).length === 0;
checks["normal branch ignored"] = wipRefsBeingPushed(`refs/heads/main ${SHA} refs/heads/main ${SHA}`).length === 0;
checks["tag ignored"] = wipRefsBeingPushed(`refs/tags/v1.0.0 ${SHA} refs/tags/v1.0.0 ${ZERO}`).length === 0;
checks["mixed push flags only wip"] =
  JSON.stringify(wipRefsBeingPushed(`refs/heads/main ${SHA} refs/heads/main ${SHA}\nrefs/heads/wip/mac ${SHA} refs/heads/wip/mac ${ZERO}`)) ===
  JSON.stringify(["wip/mac"]);
checks["empty stdin -> none"] = wipRefsBeingPushed("").length === 0;

// — visibility oracle (fetch injected; cache isolated via AGENT_COORD_HOME) —
const fake = (status) => async () => ({ status });
checks["200 -> public"] = (await isPublicGitHubRemote("https://github.com/x/pub.git", { fetchImpl: fake(200) })) === true;
checks["404 -> not public"] = (await isPublicGitHubRemote("https://github.com/x/priv.git", { fetchImpl: fake(404) })) === false;
checks["403 -> unknown"] = (await isPublicGitHubRemote("https://github.com/x/limited.git", { fetchImpl: fake(403) })) === null;
checks["network error -> unknown"] =
  (await isPublicGitHubRemote("https://github.com/x/down.git", {
    fetchImpl: async () => {
      throw new Error("offline");
    },
  })) === null;
checks["non-github -> unknown, no fetch"] =
  (await isPublicGitHubRemote("https://gitlab.com/x/y.git", {
    fetchImpl: async () => {
      throw new Error("should not be called");
    },
  })) === null;

// cache: second lookup must NOT hit the network
let calls = 0;
const counting = async () => (calls++, { status: 200 });
await isPublicGitHubRemote("https://github.com/x/cached.git", { fetchImpl: counting });
const second = await isPublicGitHubRemote("https://github.com/x/cached.git", {
  fetchImpl: async () => {
    throw new Error("must come from cache");
  },
});
checks["cached: confirmed public, one fetch"] = second === true && calls === 1;

// stale cache entry re-fetches
mkdirSync(COORD_HOME, { recursive: true });
writeFileSync(join(COORD_HOME, "remote-visibility.json"), JSON.stringify({ "x/stale": { public: false, ts: 1 } }));
checks["stale cache refreshed"] = (await isPublicGitHubRemote("git@github.com:x/stale.git", { fetchImpl: fake(200) })) === true;

let ok = true;
for (const [k, v] of Object.entries(checks)) {
  if (!v) ok = false;
  console.log(`${v ? "✅" : "❌"} ${k}`);
}
console.log(ok ? "PASS ✅ public-remote WIP guard: parse/matrix/oracle/cache" : "FAIL ❌");
process.exit(ok ? 0 : 1);
