import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COORD_HOME } from "./identity.mjs";
import { NOTIFY_ENABLED, NOTIFY_THROTTLE_MS } from "./config.mjs";

// Native desktop notifications so a HEADS-DOWN HUMAN hears what the coordination
// layer already surfaces to heads-down agents: you got blocked on a file, a peer
// messaged you, a peer asked you to yield. macOS-first (terminal-notifier if
// present, else the always-available osascript); a silent no-op elsewhere.
//
// Fail-SAFE and NON-BLOCKING by contract: the child is spawned detached + unref'd
// with errors swallowed, so a missing binary or a slow Notification Center can
// NEVER delay or break the hook/tool call that triggered it. Same-key alerts are
// deduped within NOTIFY_THROTTLE_MS via a tiny file in the store dir, so a retried
// edit on a held file doesn't fire a banner every attempt.

const THROTTLE_FILE = join(COORD_HOME, "notify-throttle.json");
const TERMINAL_NOTIFIER = ["/opt/homebrew/bin/terminal-notifier", "/usr/local/bin/terminal-notifier"].find((p) => {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
});

// File-backed throttle (hooks are short-lived processes, so in-memory won't do).
// Returns true if this key fired within the window. Best-effort: any IO error just
// means "not throttled" — we'd rather double-notify than drop a real alert.
function throttled(key) {
  if (!key) return false;
  const now = Date.now();
  let map = {};
  try {
    map = JSON.parse(readFileSync(THROTTLE_FILE, "utf8"));
  } catch {}
  if (map[key] && now - map[key] < NOTIFY_THROTTLE_MS) return true;
  map[key] = now;
  for (const k of Object.keys(map)) if (now - map[k] > 3_600_000) delete map[k]; // prune >1h so it can't grow unbounded
  try {
    writeFileSync(THROTTLE_FILE, JSON.stringify(map));
  } catch {}
  return false;
}

// AppleScript string escaping — only used on the osascript fallback path.
const esc = (s) =>
  String(s ?? "")
    .replace(/[\\"]/g, "\\$&")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 220);

// Build the command without running it — the dry-run seam tests exercise. Returns
// null when notifications are disabled, throttled, or there's nothing to say.
function planNotification({ title = "agent-coord", subtitle = "", message = "", key = "", sound = false }) {
  if (!NOTIFY_ENABLED || !message) return null;
  if (throttled(key)) return null;
  if (TERMINAL_NOTIFIER) {
    const args = ["-title", title, "-message", message, "-group", "agent-coord" + (key ? ":" + key : "")];
    if (subtitle) args.push("-subtitle", subtitle);
    if (sound) args.push("-sound", "default");
    return { cmd: TERMINAL_NOTIFIER, args };
  }
  const script =
    `display notification "${esc(message)}" with title "${esc(title)}"` +
    (subtitle ? ` subtitle "${esc(subtitle)}"` : "") +
    (sound ? ` sound name "default"` : "");
  return { cmd: "osascript", args: ["-e", script] };
}

export function notify(opts = {}) {
  let plan = null;
  try {
    plan = planNotification(opts);
    if (!plan) return null;
    if (process.env.AGENT_COORD_NOTIFY_DRYRUN === "1") return plan; // tests: no OS side-effect
    const child = spawn(plan.cmd, plan.args, { detached: true, stdio: "ignore" });
    child.on("error", () => {}); // binary missing etc. — never throw from a hook
    child.unref();
  } catch {}
  return plan;
}
