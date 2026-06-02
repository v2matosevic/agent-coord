import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

// Find the nearest ancestor process whose name matches /claude/i, walking up from
// `startPid`. This is the bridge for identity unification: a Claude hook's own
// parent is a transient spawn wrapper (it dies immediately), but the persistent
// claude.exe a few levels up ALSO parents the stdio MCP server — so claude.exe's
// pid is the one stable key both the hook and the MCP server can agree on.
// Best-effort and fail-safe: any error returns null and callers fall back to a
// standalone identity (so Codex / non-Claude setups are unaffected).

const RE = /claude/i;

function winSnapshot() {
  // One CIM enumeration (cheaper than one query per level), parsed into
  // pid -> { ppid, name }. powershell.exe (5.1) is present on every Windows.
  const out = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress",
    ],
    { encoding: "utf8", timeout: 8000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );
  const arr = JSON.parse(out);
  const list = Array.isArray(arr) ? arr : [arr];
  const m = new Map();
  for (const p of list) m.set(Number(p.ProcessId), { ppid: Number(p.ParentProcessId), name: String(p.Name || "") });
  return m;
}

function posixParentName(pid) {
  try {
    if (existsSync(`/proc/${pid}/stat`)) {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // comm sits in parens and may itself contain spaces/parens; ppid is the
      // second whitespace field AFTER the final ')'.
      const rp = stat.lastIndexOf(")");
      const rest = stat.slice(rp + 2).trim().split(/\s+/);
      const ppid = Number(rest[1]); // [0]=state, [1]=ppid
      let name = "";
      try {
        name = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
      } catch {}
      return { ppid, name };
    }
  } catch {}
  try {
    const out = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8", timeout: 4000 }).trim();
    const sp = out.search(/\s/);
    return { ppid: Number(out.slice(0, sp)), name: out.slice(sp + 1).trim() };
  } catch {}
  return null;
}

export function findClaudePid(startPid = process.ppid, maxHops = 8) {
  try {
    if (!startPid || startPid <= 0) return null;
    if (process.platform === "win32") {
      const snap = winSnapshot();
      let pid = Number(startPid);
      for (let i = 0; i < maxHops && pid > 0; i++) {
        const e = snap.get(pid);
        if (!e) return null;
        if (RE.test(e.name)) return pid;
        pid = e.ppid;
      }
    } else {
      let pid = Number(startPid);
      for (let i = 0; i < maxHops && pid > 0; i++) {
        const e = posixParentName(pid);
        if (!e) return null;
        if (RE.test(e.name)) return pid;
        pid = e.ppid;
      }
    }
  } catch {}
  return null;
}
