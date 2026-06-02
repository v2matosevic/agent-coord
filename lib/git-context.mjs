import { execFileSync } from "node:child_process";

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 4000,
  }).trim();
}

// Repo root + branch for a working dir. repoRoot comes back forward-slashed
// from git. Non-git dirs return nulls (the agent still registers, just without
// a room).
export function gitContext(cwd) {
  try {
    const repoRoot = git(["rev-parse", "--show-toplevel"], cwd);
    let branch = "";
    try {
      branch = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    } catch {}
    if (!branch || branch === "HEAD") {
      try {
        branch = "detached@" + git(["rev-parse", "--short", "HEAD"], cwd);
      } catch {}
    }
    return { repoRoot, branch: branch || "?" };
  } catch {
    return { repoRoot: null, branch: null };
  }
}
