import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { COORD_HOME } from "../lib/identity.mjs";

// Repo root from this script's location (cli/ -> <repo>) — portable, no hardcode.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url))).replace(/\\/g, "/");

// Make the commit net GLOBAL: one git hooks dir applied to every repo on the
// machine via `git config --global core.hooksPath`. The hook fails OPEN (only a
// real cross-agent conflict, rc=1, blocks; node-missing/crash/store-error all
// allow the commit) and chains to a repo-local hook if one exists — so it never
// silently breaks commits or other tooling.

const dir = join(COORD_HOME, "githooks");
mkdirSync(dir, { recursive: true });

const HOOK = `#!/bin/sh
# agent-coord global pre-commit (universal cross-agent commit guard)
# Fail OPEN: only a real conflict (rc=1) blocks; node missing / crash / store
# error must never wedge a commit anywhere on the machine.
node --disable-warning=ExperimentalWarning "${ROOT}/cli/precommit-check.mjs"
rc=$?
[ "$rc" = "1" ] && exit 1
# global hooksPath bypasses .git/hooks, so chain to a repo-local hook if present
# (skip our own per-repo copies to avoid double-running).
GITDIR=$(git rev-parse --git-dir 2>/dev/null)
LOCAL="$GITDIR/hooks/pre-commit"
if [ -n "$GITDIR" ] && [ -x "$LOCAL" ] && ! grep -q "agent-coord" "$LOCAL" 2>/dev/null; then
  "$LOCAL" "$@"
  exit $?
fi
exit 0
`;

const target = join(dir, "pre-commit");
writeFileSync(target, HOOK);
try {
  chmodSync(target, 0o755);
} catch {}

// post-commit: record commit provenance (who made which commit). Never blocks.
const POST = `#!/bin/sh
# agent-coord post-commit (record commit provenance) — never blocks
node --disable-warning=ExperimentalWarning "${ROOT}/cli/log-commit.mjs" >/dev/null 2>&1 &
exit 0
`;
const postTarget = join(dir, "post-commit");
writeFileSync(postTarget, POST);
try {
  chmodSync(postTarget, 0o755);
} catch {}

let prior = "";
try {
  prior = execFileSync("git", ["config", "--global", "--get", "core.hooksPath"], { encoding: "utf8" }).trim();
} catch {}
writeFileSync(join(COORD_HOME, "git-hookspath.prior"), prior || "(unset)");

const posixDir = dir.replace(/\\/g, "/");
execFileSync("git", ["config", "--global", "core.hooksPath", posixDir]);

console.log("✅ global pre-commit + post-commit installed for ALL repos");
console.log("   core.hooksPath ->", posixDir);
console.log("   prior value:", prior || "(unset)", "(saved to git-hookspath.prior)");
console.log("   revert: git config --global --unset core.hooksPath" + (prior ? `  # was ${prior}` : ""));
