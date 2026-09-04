import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { getDb, DB_PATH, DEGRADED_FLAG, writeTxn } from "../lib/store.mjs";
import { COORD_HOME } from "../lib/identity.mjs";
import { codexHooks, CODEX_EVENTS } from "../lib/codex-install.mjs";

// Health check for the whole install. Each probe is isolated so one failure
// doesn't hide the rest.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const checks = [];
const add = (ok, label, detail = "") => checks.push({ ok, label, detail });

try {
  await import("node:sqlite");
  add(true, "node:sqlite runtime");
} catch (e) {
  add(false, "node:sqlite runtime", e.message);
}

try {
  const db = getDb();
  writeTxn(db, () => db.prepare("SELECT 1").get());
  add(true, "store writable", DB_PATH);
} catch (e) {
  add(false, "store writable", e.message);
}

add(!existsSync(DEGRADED_FLAG), "not degraded", existsSync(DEGRADED_FLAG) ? readFileSync(DEGRADED_FLAG, "utf8").trim() : "");

try {
  const s = JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8"));
  const blob = JSON.stringify(s.hooks || {}) + JSON.stringify(s.statusLine || {});
  const need = ["session.mjs", "guard.mjs", "bash-guard.mjs", "statusline.mjs"];
  const missing = need.filter((n) => !blob.includes(n));
  add(missing.length === 0, "Claude hooks + statusline", missing.length ? "missing: " + missing.join(", ") : "");
} catch (e) {
  add(false, "Claude hooks + statusline", e.message);
}

try {
  const hp = execFileSync("git", ["config", "--global", "--get", "core.hooksPath"], { encoding: "utf8" }).trim();
  const expected = join(COORD_HOME, "githooks");
  const norm = (p) => process.platform === "win32" ? p.replace(/\\/g, "/").toLowerCase() : p;
  add(norm(hp) === norm(expected) && existsSync(join(expected, "pre-commit")), "global pre-commit (all repos)", hp || "unset");
} catch {
  add(false, "global pre-commit (all repos)", "core.hooksPath unset");
}

try {
  const c = readFileSync(join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml"), "utf8");
  const section = c.split(/(?=^\[)/m).find((s) => /^\[mcp_servers\.(?:"agent-coord"|'agent-coord'|agent-coord)\]/.test(s));
  add(!!section && !/^\s*enabled\s*=\s*false/m.test(section) && /server\.mjs/.test(section), "Codex MCP server configured");
} catch {
  add(false, "Codex MCP server", "no ~/.codex/config.toml");
}

try {
  add(readFileSync(join(homedir(), ".claude.json"), "utf8").includes("agent-coord"), "Claude MCP server");
} catch (e) {
  add(false, "Claude MCP server", e.message);
}

add(existsSync(join(ROOT, "mcp", "server.mjs")), "MCP server file");
try {
  await import("@modelcontextprotocol/sdk/server/index.js");
  await import("@modelcontextprotocol/sdk/server/stdio.js");
  add(true, "MCP SDK loads");
} catch (e) {
  add(false, "MCP SDK loads", e.message);
}

try {
  const file = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "hooks.json");
  const installed = JSON.parse(readFileSync(file, "utf8"));
  const wanted = codexHooks(ROOT);
  const missing = CODEX_EVENTS.filter((event) => !(installed.hooks?.[event] || []).some((g) =>
    (!g.matcher || g.matcher === "*" || g.matcher === ".*") && (g.hooks || []).some((h) =>
      h.type === "command" && h.command === wanted[event][0].hooks[0].command && h.enabled !== false)));
  add(!missing.length, "Codex hooks configured (trust/runtime not verified)", missing.length ? "missing: " + missing.join(", ") : file);
} catch (e) {
  add(false, "Codex hooks configured", e.message);
}

for (const c of checks) console.log(`${c.ok ? "✅" : "❌"} ${c.label}${c.detail ? "  — " + c.detail : ""}`);
const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
