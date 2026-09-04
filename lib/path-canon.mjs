import { realpathSync } from "node:fs";
import { dirname, basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";

const isWin = process.platform === "win32";

function norm(p) {
  let s = p.replace(/\\/g, "/");
  return isWin ? s.toLowerCase() : s;
}

// Canonical repo root for the room key: realpath collapses junctions / `subst`
// drives / symlinks so two agents reaching the same repo via different aliases
// land in the same room. The root always exists, so realpath is safe here.
export function canonicalRepoRoot(repoRoot) {
  if (!repoRoot) return null;
  let real = repoRoot;
  try {
    real = realpathSync.native(repoRoot);
  } catch {}
  return norm(real);
}

// The room. Keyed on the repo root ALONE (not the branch) — the bytes on disk
// are shared across branches in one tree, and putting a mutable HEAD in the key
// would orphan every live lease the instant someone runs `git switch`.
export function workspaceId(repoRoot) {
  const real = canonicalRepoRoot(repoRoot) ?? "no-repo";
  return createHash("sha256").update(real).digest("hex").slice(0, 16);
}

// A canonical path that stayed repo-relative means the file sits INSIDE the
// repo; canonicalFilePath returns an absolute form for everything else. Used to
// scope repo-level enforcement (e.g. the duplicate-work stand-down) so it can't
// block writes to unrelated locations like a memory dir under the user profile.
export function isRepoRelative(canonPath) {
  return !!canonPath && !canonPath.startsWith("/") && !/^[a-z]:\//i.test(canonPath);
}

// Resolve the nearest existing ancestor, then append the missing suffix. A new
// file under a junction or /tmp -> /private/tmp must get the same key as a file
// reached through the physical root, even before realpath(file) can succeed.
function physicalPath(path) {
  let parent = path;
  const suffix = [];
  for (;;) {
    try { return join(realpathSync.native(parent), ...suffix); } catch {}
    const next = dirname(parent);
    if (next === parent) return path;
    suffix.unshift(basename(parent));
    parent = next;
  }
}

// Repo-relative, forward-slash, lowercased-on-Windows path. Resolve aliases
// before comparing prefixes, including symlinked subdirectories within a repo.
export function canonicalFilePath(filePath, repoRoot) {
  if (!filePath) return null;
  const rootForm = repoRoot || process.cwd();
  const a = norm(physicalPath(resolve(rootForm, filePath)));
  const r = norm(physicalPath(resolve(rootForm)));
  if (a === r || a.startsWith(r + "/")) {
    return a.slice(r.length).replace(/^\/+/, "");
  }
  return a;
}
