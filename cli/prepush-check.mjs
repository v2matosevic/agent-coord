import { readFileSync } from "node:fs";
import { isPublicGitHubRemote, wipRefsBeingPushed } from "../lib/public-remote.mjs";

// Global pre-push guard: block wip/<machine> snapshot branches (UNCOMMITTED
// work, force-pushed by machine-sync tooling) from landing on a PUBLIC GitHub
// remote — the universal-chokepoint answer, like the pre-commit net: it holds
// no matter which tool pushes. Everything else passes untouched:
//   - normal branches (any remote)            → allow
//   - wip/* to private / non-GitHub / unknown → allow (fail open, loud on unknown)
//   - DELETING a wip/* ref anywhere           → allow (cleanup must always work)
// Exit 1 = block (the hook treats only rc=1 as a block; crashes fail open).
// Escape hatch: AGENT_COORD_ALLOW_PUBLIC_WIP=1 for a deliberate one-off.

const remoteUrl = process.argv[3] || ""; // hook passes: $1 remote name, $2 url
let stdin = "";
try {
  stdin = readFileSync(0, "utf8");
} catch {}

const wipRefs = wipRefsBeingPushed(stdin);
if (!wipRefs.length) process.exit(0); // hot path: no network, no cache, no cost

if (process.env.AGENT_COORD_ALLOW_PUBLIC_WIP === "1") {
  process.stderr.write(`⚠ agent-coord: AGENT_COORD_ALLOW_PUBLIC_WIP=1 — allowing ${wipRefs.join(", ")} despite the public-remote guard.\n`);
  process.exit(0);
}

const visibility = await isPublicGitHubRemote(remoteUrl).catch(() => null);
if (visibility === true) {
  process.stderr.write(
    `⛔ agent-coord: refusing to push ${wipRefs.join(", ")} — ${remoteUrl} is a PUBLIC GitHub repo.\n` +
      `   These branches carry snapshots of UNCOMMITTED work; on a public remote that publishes your WIP to the world.\n` +
      `   Options: commit the work and push a real branch · point your sync tool's WIP carrier at a private remote ·\n` +
      `   or, if you truly mean it: AGENT_COORD_ALLOW_PUBLIC_WIP=1 git push …\n`,
  );
  process.exit(1);
}
if (visibility === null) {
  process.stderr.write(`⚠ agent-coord: couldn't determine visibility of ${remoteUrl} — allowing wip push (fail-open). If this remote is public, fix that.\n`);
}
process.exit(0);
