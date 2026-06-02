import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { getDb, DB_PATH, DEGRADED_FLAG, writeTxn } from "../lib/store.mjs";
import { COORD_HOME } from "../lib/identity.mjs";

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
  add(!!hp && existsSync(join(COORD_HOME, "githooks", "pre-commit")), "global pre-commit (all repos)", hp || "unset");
} catch {
  add(false, "global pre-commit (all repos)", "core.hooksPath unset");
}

try {
  const c = readFileSync(join(homedir(), ".codex", "config.toml"), "utf8");
  add(/mcp_servers\."?agent-coord"?/.test(c), "Codex MCP server");
} catch {
  add(false, "Codex MCP server", "no ~/.codex/config.toml");
}

try {
  add(readFileSync(join(homedir(), ".claude.json"), "utf8").includes("agent-coord"), "Claude MCP server");
} catch (e) {
  add(false, "Claude MCP server", e.message);
}

add(existsSync(join(ROOT, "mcp", "server.mjs")), "MCP server file");
add(existsSync(join(ROOT, "node_modules", "@modelcontextprotocol", "sdk")), "MCP SDK installed");

for (const c of checks) console.log(`${c.ok ? "✅" : "❌"} ${c.label}${c.detail ? "  — " + c.detail : ""}`);
const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
