import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { COORD_HOME } from "./identity.mjs";

// Public-remote awareness for the WIP push guard. The failure this prevents:
// machine-sync tooling (Hermes etc.) force-pushes `wip/<machine>` snapshots of
// UNCOMMITTED work to a repo's origin — fine for private remotes, a public
// disclosure when origin is a public GitHub repo (observed live 2026-06-09:
// two dirty-tree snapshots landed on the public agent-coord repo).
//
// Visibility oracle: an UNAUTHENTICATED GitHub API request. 200 = public by
// definition (the world can see it); 404 = private-or-missing (not public);
// network/rate-limit errors = unknown. Cached on disk (TTL) so the pre-push
// hot path almost never touches the network.

const CACHE_FILE = () => join(COORD_HOME, "remote-visibility.json");
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d — visibility changes are rare and deliberate

// "owner/repo" from the github remote URL forms in the wild; null for
// non-GitHub remotes (we can't judge those — treat as unknown/allow).
export function parseGitHubRepo(url) {
  const m = String(url || "").match(/(?:^|@|\/\/)(?:[^@/]+@)?github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

function readCache() {
  try {
    return JSON.parse(readFileSync(CACHE_FILE(), "utf8"));
  } catch {
    return {};
  }
}
function writeCache(map) {
  try {
    mkdirSync(COORD_HOME, { recursive: true });
    writeFileSync(CACHE_FILE(), JSON.stringify(map, null, 1));
  } catch {}
}

// true = confirmed public, false = confirmed not-public, null = unknown
// (network failure / rate limit) — callers FAIL OPEN on null, loudly.
export async function isPublicGitHubRemote(url, { fetchImpl = fetch, ttlMs = CACHE_TTL_MS } = {}) {
  const repo = parseGitHubRepo(url);
  if (!repo) return null;
  const cache = readCache();
  const hit = cache[repo];
  if (hit && Date.now() - hit.ts < ttlMs) return hit.public;
  let result = null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3000); // a hook must never hang a push
    const res = await fetchImpl(`https://api.github.com/repos/${repo}`, {
      signal: ctl.signal,
      headers: { "user-agent": "agent-coord-prepush-guard" },
    });
    clearTimeout(t);
    if (res.status === 200) result = true;
    else if (res.status === 404) result = false; // private or gone — either way not public
    // 403 (rate limit) and everything else stay null/unknown
  } catch {}
  if (result !== null) {
    cache[repo] = { public: result, ts: Date.now() };
    writeCache(cache);
  }
  return result;
}

// Parse pre-push stdin ("<local-ref> <local-sha> <remote-ref> <remote-sha>" per
// line) and return the remote WIP branch names being CREATED/UPDATED. Deletions
// (local-sha all zeros) are exempt — removing a leaked snapshot must always work.
export function wipRefsBeingPushed(stdinText) {
  const ZERO = /^0+$/;
  const out = [];
  for (const line of String(stdinText || "").split("\n")) {
    const [, localSha, remoteRef] = line.trim().split(/\s+/);
    if (!remoteRef || ZERO.test(localSha || "")) continue;
    const m = remoteRef.match(/^refs\/heads\/(wip\/.+)$/);
    if (m) out.push(m[1]);
  }
  return out;
}
