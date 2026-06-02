import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync } from "node:fs";
import { join, isAbsolute, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// Install the universal pre-commit net into ONE repo, chain-safely: if a
// pre-commit hook already exists (husky etc.), it's preserved and still runs
// after ours. Per-repo on purpose — globally hijacking core.hooksPath would
// silently disable existing project hooks.
// Usage: node cli/install-git-hook.mjs [repoPath]

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))).replace(/\\/g, "/"); // cli/ -> <repo>
const MARK = "# agent-coord";
const CHECK = `node --disable-warning=ExperimentalWarning "${ROOT}/cli/precommit-check.mjs" || exit 1`;

const repo = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
const hooksRel = execFileSync("git", ["-C", repo, "rev-parse", "--git-path", "hooks"], { encoding: "utf8" }).trim();
const hooksDir = isAbsolute(hooksRel) ? hooksRel : join(repo, hooksRel);
mkdirSync(hooksDir, { recursive: true });

const target = join(hooksDir, "pre-commit");
let chain = "";
if (existsSync(target)) {
  if (readFileSync(target, "utf8").includes(MARK)) {
    console.log("already installed:", target);
    process.exit(0);
  }
  renameSync(target, join(hooksDir, "pre-commit.coord-backup"));
  chain = '\nif [ -f "$(dirname "$0")/pre-commit.coord-backup" ]; then\n  "$(dirname "$0")/pre-commit.coord-backup" "$@" || exit $?\nfi';
}

writeFileSync(target, `#!/bin/sh\n${MARK} (universal cross-agent commit guard)\n${CHECK}${chain}\nexit 0\n`);
try {
  chmodSync(target, 0o755);
} catch {}
console.log("installed pre-commit ->", target, chain ? "(chained existing hook)" : "");
