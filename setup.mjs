// Cross-platform installer (Windows / macOS / Linux). One command:
//   node setup.mjs
// Idempotent and fail-soft: each step is independent, missing CLIs are skipped,
// and re-running is safe. Wires Claude Code hooks + statusline, the global git
// pre-commit net, and the MCP server into Claude and Codex, then health-checks.
// (Windows users can use setup.ps1 instead — it also builds the VS Code panel.)
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const FLAG = "--disable-warning=ExperimentalWarning";
const q = (s) => (/\s/.test(String(s)) ? `"${s}"` : String(s));
const sh = (parts) => spawnSync(parts.map(q).join(" "), { cwd: ROOT, shell: true, stdio: "inherit" }).status === 0;
const has = (cmd) => spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" }).status === 0;
const server = join(ROOT, "mcp", "server.mjs");

console.log("== agent-coord setup ==");
console.log("root:", ROOT, "\nnode:", NODE, "\n");

console.log("[1/6] npm install (MCP SDK)");
sh(["npm", "install", "--no-audit", "--no-fund"]);

console.log("\n[2/6] Claude Code hooks + statusline");
sh([NODE, FLAG, join(ROOT, "cli", "install-claude-hooks.mjs")]);

console.log("\n[3/6] global git pre-commit net (all repos)");
sh([NODE, FLAG, join(ROOT, "cli", "install-global.mjs")]);

console.log("\n[4/6] Claude MCP server");
if (has("claude")) {
  spawnSync("claude mcp remove agent-coord --scope user", { shell: true, stdio: "ignore" });
  sh(["claude", "mcp", "add", "agent-coord", "--scope", "user", "--", NODE, FLAG, server, "--tool", "claude-code"]);
} else console.log("  claude CLI not on PATH — skipped (hooks still cover Claude Code)");

console.log("\n[5/6] Codex MCP server");
if (has("codex")) {
  spawnSync("codex mcp remove agent-coord", { shell: true, stdio: "ignore" });
  sh(["codex", "mcp", "add", "agent-coord", "--", NODE, FLAG, server, "--tool", "codex"]);
} else console.log("  codex CLI not on PATH — skipped");

console.log("\n[6/6] health check");
sh([NODE, FLAG, join(ROOT, "cli", "doctor.mjs")]);

console.log("\nDone. Open NEW agent sessions/terminals to pick it up.");
console.log("Verify any time:  node", q(join(ROOT, "cli", "doctor.mjs")));
