import { execFileSync } from "node:child_process";
import { basename } from "node:path";

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 4000,
  }).trim();
}

// Resolve the repo "room" for a working directory. Non-git dirs return nulls
// (the agent still shows up, just without a repo tag). repoRoot comes back
// forward-slashed from git, which is exactly the canonical form we want.
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
    return { repoRoot, repoName: basename(repoRoot), branch: branch || "?" };
  } catch {
    return { repoRoot: null, repoName: null, branch: null };
  }
}
