// Private operational metadata only. Never reads the coordination database or
// writes model context. A failed observation cannot affect the guarded action.
import { appendFileSync, mkdirSync, opendirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { VERSION } from "./version.mjs";

export const HEALTH_BUCKET_MS = 3_600_000;
export const HEALTH_MAX_BYTES = 8 * 1024 * 1024;
export const HEALTH_RETAIN_BUCKETS = 6;
export const HEALTH_MAX_RECORD_BYTES = 768;
const EVENTS = new Set(["SessionStart", "SessionEnd", "SubagentStart", "SubagentStop", "PreToolUse", "PostToolUse", "PostToolUseFailure", "UserPromptSubmit"]);
const providerName = value => ["codex", "claude-code", "mcp-agent"].includes(value) ? value : "other";
const agentName = value => typeof value === "string" && /^[a-zA-Z0-9/_-]{1,100}$/.test(value) ? value : undefined;
const workspaceName = value => typeof value === "string" && /^[a-f0-9]{16}$/.test(value) ? value : undefined;
const version = VERSION.length <= 40 && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(VERSION) ? VERSION : "0.0.0";
export const healthSessionKey = input => typeof input?.session_id === "string" && input.session_id
  ? createHash("sha256").update(input.session_id).update("\0").update(String(input.agent_id || "")).digest("hex").slice(0, 16) : undefined;

export function createHealthJournal({ home = process.env.AGENT_COORD_HOME || join(homedir(), ".agent-coord"),
  enabled = process.env.AGENT_COORD_HEALTH !== "0", now = Date.now, maxBytes = HEALTH_MAX_BYTES } = {}) {
  const dir = join(home, "health");
  const write = data => {
    if (!enabled) return false;
    try {
      const at = now();
      const bucket = Math.floor(at / HEALTH_BUCKET_MS);
      const path = join(dir, `h-${bucket}.jsonl`);
      // Whitelist at the persistence boundary too: an accidental spread of a
      // hook payload must never put prompts, commands or message bodies on disk.
      if (!["start", "end", "mcp"].includes(data?.phase)) return false;
      const line = JSON.stringify({ v: 1, at, phase: data.phase,
        id: typeof data.id === "string" && data.id.length <= 80 && agentName(data.id) ? data.id : undefined,
        session: typeof data.session === "string" && /^[a-f0-9]{16}$/.test(data.session) ? data.session : undefined,
        agent: agentName(data.agent), workspace: workspaceName(data.workspace), provider: providerName(data.provider),
        event: data.event === undefined ? undefined : EVENTS.has(data.event) ? data.event : "Other",
        version: typeof data.version === "string" && data.version.length <= 40 && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(data.version) ? data.version : "0.0.0",
        pid: Number.isSafeInteger(data.pid) && data.pid > 0 ? data.pid : undefined,
        ms: Number.isFinite(data.ms) && data.ms >= 0 ? data.ms : undefined,
        outcome: ["ok", "denied", "error"].includes(data.outcome) ? data.outcome : undefined,
        error: ["deadline", "schema", "busy", "io", "error", "exit"].includes(data.error) ? data.error : undefined,
        denied: data.denied === true ? true : undefined,
      }) + "\n";
      if (Buffer.byteLength(line) > HEALTH_MAX_RECORD_BYTES) return false;
      mkdirSync(dir, { recursive: true });
      let size = 0, fresh = false;
      try { size = statSync(path).size; } catch { fresh = true; }
      if (size + Buffer.byteLength(line) > maxBytes) {
        try { writeFileSync(path + ".overflow", "limited\n", { flag: "wx" }); } catch {}
        return false;
      }
      // One bounded append; concurrent writers never rewrite another event.
      // The byte ceiling may overshoot by one record per concurrent appender.
      appendFileSync(path, line);
      if (fresh) {
        try {
        const scan = opendirSync(dir);
        try {
          for (let i = 0; i < 32; i++) {
            const entry = scan.readSync();
            if (!entry) break;
            const match = /^h-(\d+)\.jsonl(?:\.overflow)?$/.exec(entry.name);
            if (match && Number(match[1]) < bucket - HEALTH_RETAIN_BUCKETS + 1) {
              try { unlinkSync(join(dir, entry.name)); } catch {}
            }
          }
        } finally { scan.closeSync(); }
        } catch {}
      }
      return true;
    } catch { return false; }
  };
  return { write, dir };
}

const journal = createHealthJournal();
let active = null;

export function bindHealthContext({ agentId, ws } = {}) {
  if (!active) return;
  active.agent = agentName(agentId);
  active.workspace = workspaceName(ws);
}

export function markHealthDenied() { if (active) active.denied = true; }

export function markHealthFailure(error) {
  if (!active) return;
  const sqliteCode = Number.isInteger(error?.errcode) ? error.errcode & 255 : null;
  active.error = error?.code === "COORD_DEADLINE" ? "deadline"
    : error?.code === "SCHEMA_AHEAD" ? "schema"
      : [5, 6].includes(sqliteCode) ? "busy"
        : ["EACCES", "EPERM", "ENOSPC", "EIO"].includes(error?.code) || sqliteCode === 10 ? "io" : "error";
}

export function beginHookHealth(provider, input, { event = input?.hook_event_name, sink = journal, elapsed = () => performance.now() } = {}) {
  try {
  const state = { id: `${process.pid}-${randomBytes(8).toString("hex")}`, session: healthSessionKey(input),
    provider: providerName(provider), event: EVENTS.has(event) ? event : "Other", version, pid: process.pid };
  const previous = active;
  const started = sink.write({ phase: "start", ...state });
  if (started) active = state;
  let done = false;
  const finish = (exitCode = 0) => {
    if (done) return;
    done = true;
    process.removeListener("exit", finish);
    if (active === state) active = previous;
    if (!started) return;
    try {
      const error = state.error || (exitCode !== 0 && !state.denied ? "exit" : undefined);
      const ms = elapsed();
      sink.write({ phase: "end", ...state, error,
        ms: Number.isFinite(ms) && ms >= 0 ? Math.round(ms * 1000) / 1000 : undefined,
        outcome: error ? "error" : state.denied ? "denied" : "ok" });
    } catch {}
  };
  process.once("exit", finish);
  return { finish };
  } catch { return { finish() {} }; }
}

const mcpObserved = new Map();
export function observeMcpHealth({ agentId, ws, tool, sessionId } = {}, hookInput) {
  try {
  const agent = agentName(agentId);
  if (!agent) return;
  const now = Date.now();
  if (now - (mcpObserved.get(agent) || 0) < 60_000) return;
  if (journal.write({ phase: "mcp", agent, workspace: workspaceName(ws), session: healthSessionKey(hookInput || { session_id: sessionId }), provider: providerName(tool), version })) {
    if (mcpObserved.size >= 256) mcpObserved.delete(mcpObserved.keys().next().value);
    mcpObserved.set(agent, now);
  }
  } catch {}
}
