import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

// Which machine a commit was made on, so a repo shared between machines shows
// per commit whether it came from "macbook-air" or "olympus". The name is the
// one Hermes (Athena Workspaces) enrolled this device under, so git history,
// `ahermes status` and the wip/<machine> branches share one vocabulary. The
// hostname is the fallback on a machine Hermes never enrolled.

// Mirrors hermes/src/config.mjs configDir(): same override, same per-OS dirs.
export function hermesConfigDir({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  if (env.HERMES_CONFIG_DIR) return env.HERMES_CONFIG_DIR;
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "hermes");
  if (platform === "darwin") return join(home, "Library", "Application Support", "hermes");
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "hermes");
}

export function machineName(opts = {}) {
  const env = opts.env || process.env;
  const explicit = String(env.AGENT_COORD_MACHINE || "").trim();
  if (explicit) return explicit;
  try {
    const cfg = JSON.parse(readFileSync(join(hermesConfigDir({ ...opts, env }), "config.json"), "utf8"));
    const name = typeof cfg.machine === "string" ? cfg.machine.trim() : "";
    if (name) return name;
  } catch {}
  return (opts.host || hostname()).toLowerCase().split(".")[0];
}

// True when a commit message is empty once git's comment lines (and anything
// under a `commit -v` scissors line) are dropped. Stamping one would turn git's
// "Aborting commit due to empty commit message" into a trailer-only commit.
export function isEmptyMessage(text, commentChar = "#") {
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith(commentChar) && line.includes(" >8 ")) return true;
    if (line.trim() !== "" && !line.startsWith(commentChar)) return false;
  }
  return true;
}
