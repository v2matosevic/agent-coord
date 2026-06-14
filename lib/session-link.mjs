import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { COORD_HOME } from "./identity.mjs";
import { findClaudePid } from "./proc-ancestry.mjs";

// Bridges a Claude session's two processes onto ONE coordination identity. The
// hooks know the stable session_id (their identity); the stdio MCP server does
// not (Claude exposes no session id to it). Their only shared anchor is the
// claude.exe that parents both. So the SessionStart hook resolves that pid and
// writes pid -> agentId here; the MCP server reads it by its own ppid and adopts
// the same id — instead of minting a random one and showing up as a ghost twin.
//
// Fail-safe: if the hook never wrote a link (Codex, or ancestry resolution
// failed), the MCP server falls back to a standalone id — no regression.

const DIR = join(COORD_HOME, "session-links");
const LINK_TTL_MS = 12 * 60 * 60 * 1000; // 12h — generous; reused/reaped well before
const linkFile = (claudePid) => join(DIR, "pid-" + Number(claudePid) + ".json");
const cacheFile = (sessionId) => join(DIR, "ses-" + createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 16) + ".json");

export function writeSessionLink(claudePid, agentId, sessionId = null) {
  if (!claudePid || !agentId) return;
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(linkFile(claudePid), JSON.stringify({ agentId, claudePid: Number(claudePid), ts: Date.now() }));
    if (sessionId) writeFileSync(cacheFile(sessionId), JSON.stringify({ claudePid: Number(claudePid), ts: Date.now() }));
  } catch {}
}

// The claude.exe pid we resolved for this session last time (so repeat
// SessionStarts — resume/clear/compact — skip the cost of re-walking the tree).
export function cachedClaudePid(sessionId) {
  if (!sessionId) return null;
  try {
    const c = JSON.parse(readFileSync(cacheFile(sessionId), "utf8"));
    if (Date.now() - c.ts < LINK_TTL_MS) return c.claudePid;
  } catch {}
  return null;
}

export function readSessionLink(claudePid) {
  if (!claudePid) return null;
  try {
    const l = JSON.parse(readFileSync(linkFile(claudePid), "utf8"));
    if (Date.now() - l.ts < LINK_TTL_MS) return l.agentId;
  } catch {}
  return null;
}

// MCP server adoption: the link may not exist yet if the server wins the race
// against the SessionStart hook, so poll briefly before giving up.
export async function pollSessionLink(claudePid, timeoutMs = 4000, stepMs = 150) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const id = readSessionLink(claudePid);
    if (id) return id;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

// The parent session's claimed identity, resolved the same way the MCP server
// avoids its ghost twin: walk up to the claude.exe that parents this hook and
// read the link the SessionStart hook published for it. A subagent hook calls
// this to inherit its parent's base name instead of hashing its own (possibly
// different) session_id into a separate codename. Returns null if no link is
// resolvable, so callers fall back to the session_id hash (no regression).
export function parentBaseFromProc(ppid = process.ppid) {
  try {
    const claudePid = findClaudePid(ppid);
    if (claudePid) return readSessionLink(claudePid);
  } catch {}
  return null;
}

// Reaper hook: drop link/cache files past their TTL.
export function reapSessionLinks() {
  try {
    const now = Date.now();
    for (const f of readdirSync(DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        const { ts } = JSON.parse(readFileSync(join(DIR, f), "utf8"));
        if (!ts || now - ts > LINK_TTL_MS) rmSync(join(DIR, f), { force: true });
      } catch {
        rmSync(join(DIR, f), { force: true });
      }
    }
  } catch {}
}
