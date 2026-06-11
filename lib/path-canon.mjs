import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
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

// Repo-relative, forward-slash, lowercased-on-Windows path. Computed against the
// git-reported root form so it works for files that don't exist yet (a Write
// about to create one) — realpath would throw on those. Falls back to a
// realpath-based key only for paths that don't sit under the given root.
export function canonicalFilePath(filePath, repoRoot) {
  if (!filePath) return null;
  const rootForm = (repoRoot || process.cwd()).replace(/\\/g, "/");
  const abs = isAbsolute(filePath)
    ? filePath.replace(/\\/g, "/")
    : resolve(rootForm, filePath).replace(/\\/g, "/");

  const a = isWin ? abs.toLowerCase() : abs;
  const r = isWin ? rootForm.toLowerCase() : rootForm;
  if (a === r || a.startsWith(r + "/")) {
    return a.slice(r.length).replace(/^\/+/, "");
  }

  // Different alias or outside the root — resolve via realpath and retry.
  try {
    const real = norm(realpathSync.native(filePath));
    const realRoot = canonicalRepoRoot(repoRoot);
    if (realRoot && (real === realRoot || real.startsWith(realRoot + "/"))) {
      return real.slice(realRoot.length).replace(/^\/+/, "");
    }
    return real;
  } catch {
    return a;
  }
}
