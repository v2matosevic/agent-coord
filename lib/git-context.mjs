import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 4000,
  }).trim();
}

// Pure-fs resolution first, subprocess as fallback. This runs in BOTH hooks on
// EVERY tool call, and each `git rev-parse` spawn costs ~10-15ms — measured, the
// subprocess pair was the single largest hot-path cost after node boot itself.
// Walking up to `.git` and parsing HEAD by hand covers normal repos, worktrees,
// and submodules (`.git` file with a `gitdir:` pointer); anything unparseable
// falls through to real git, so correctness never rides on the parser.

// Walk up from cwd to the first `.git` (dir for a normal repo, file for a
// worktree/submodule). The containing dir IS the working-tree root — the same
// answer as `git rev-parse --show-toplevel` for on-disk layouts.
function findWorkTreeRoot(cwd) {
  let dir = resolve(cwd);
  for (;;) {
    let st = null;
    try {
      st = statSync(join(dir, ".git"));
    } catch {}
    if (st) return { root: dir, gitPath: join(dir, ".git"), isFile: st.isFile() };
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// The dir that holds HEAD: `.git` itself, or the `gitdir:` target from a
// worktree/submodule pointer file (relative targets resolve against the root).
function headDir({ root, gitPath, isFile }) {
  if (!isFile) return gitPath;
  const m = readFileSync(gitPath, "utf8").match(/^gitdir:\s*(.+)\s*$/m);
  if (!m) return null;
  const target = m[1].trim();
  return isAbsolute(target) ? target : resolve(root, target);
}

// "ref: refs/heads/feat/x" -> "feat/x" (same as --abbrev-ref, incl. slashes);
// a bare sha (detached) -> "detached@<7>" like the subprocess path produced.
function branchFromHead(dir) {
  const head = readFileSync(join(dir, "HEAD"), "utf8").trim();
  const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
  if (ref) return ref[1];
  if (/^[0-9a-f]{40,}$/i.test(head)) return "detached@" + head.slice(0, 7);
  return null;
}

// Repo root + branch for a working dir. repoRoot comes back forward-slashed.
// Non-git dirs return nulls (the agent still registers, just without a room).
export function gitContext(cwd) {
  // GIT_DIR/GIT_WORK_TREE override on-disk discovery — let git answer.
  if (!process.env.GIT_DIR && !process.env.GIT_WORK_TREE) {
    try {
      const found = findWorkTreeRoot(cwd);
      if (!found) return { repoRoot: null, branch: null };
      const dir = headDir(found);
      const branch = dir ? branchFromHead(dir) : null;
      // realpath the root: `git rev-parse --show-toplevel` resolves symlinks
      // (macOS /tmp -> /private/tmp), and canonicalFilePath's fast prefix match
      // expects the root in that resolved form. The root exists, so this is safe.
      if (branch) return { repoRoot: realpathSync.native(found.root).replace(/\\/g, "/"), branch };
      // fall through: found a .git but couldn't parse HEAD — ask real git
    } catch {}
  }
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
