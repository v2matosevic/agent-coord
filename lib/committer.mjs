import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { COORD_HOME } from "./identity.mjs";
import { canonicalRepoRoot } from "./path-canon.mjs";

// Bridges the Bash guard and the git pre-commit hook. The pre-commit hook runs
// in a bare shell with no session id, so it can't tell whether the committer is
// the agent that holds a lease (legit self-commit) or a different agent. When a
// Claude agent runs `git commit`, the Bash guard drops a short-TTL marker here
// naming itself; the pre-commit reads it to exclude self. Manual/other-tool
// commits leave no marker, so they're checked against every live agent.

const DIR = join(COORD_HOME, "committers");
const TTL_MS = 30_000;

function fileFor(repoRoot) {
  const key = canonicalRepoRoot(repoRoot) || "no-repo";
  return join(DIR, createHash("sha256").update(key).digest("hex").slice(0, 16) + ".json");
}

export function writeCommitterMarker(repoRoot, agentId) {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(fileFor(repoRoot), JSON.stringify({ agentId, ts: Date.now() }));
  } catch {}
}

export function readCommitterMarker(repoRoot) {
  try {
    const m = JSON.parse(readFileSync(fileFor(repoRoot), "utf8"));
    if (Date.now() - m.ts < TTL_MS) return m.agentId;
  } catch {}
  return null;
}
