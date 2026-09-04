import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { codexHooks, mergeCodexHooks } from "../lib/codex-install.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const homeArg = process.argv.indexOf("--codex-home");
if (homeArg >= 0 && !process.argv[homeArg + 1]) throw new Error("--codex-home requires a directory");
const codexHome = resolve(homeArg >= 0 ? process.argv[homeArg + 1] : process.env.CODEX_HOME || join(homedir(), ".codex"));
const file = join(codexHome, "hooks.json");
const old = existsSync(file) ? readFileSync(file, "utf8") : null;
const existing = old === null ? {} : JSON.parse(old);
const merged = mergeCodexHooks(existing, codexHooks(root));
const changed = JSON.stringify(existing) !== JSON.stringify(merged);
if (changed) {
  mkdirSync(codexHome, { recursive: true });
  if (old !== null) copyFileSync(file, file + ".bak." + Date.now());
  const staging = file + ".tmp." + process.pid;
  writeFileSync(staging, JSON.stringify(merged, null, 2) + "\n", { flag: "wx" });
  renameSync(staging, file);
}
console.log(`Codex coordination hooks: ${changed ? "installed" : "already current"} (${file}).`);
console.log("Open a new Codex session and review/trust these hooks in /hooks. Configured does not mean trusted or running.");
