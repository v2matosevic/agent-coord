import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const temp = mkdtempSync(join(tmpdir(), "coord-install-"));
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const store = join(temp, "store");
const prior = join(temp, "existing-hooks").replace(/\\/g, "/");
const env = { ...process.env, AGENT_COORD_HOME: store, GIT_CONFIG_GLOBAL: join(temp, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
try {
  mkdirSync(prior);
  execFileSync("git", ["config", "--global", "core.hooksPath", prior], { env });
  const run = () => {
    const r = spawnSync(process.execPath, [join(root, "cli", "install-global.mjs")], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };
  run();
  assert.equal(readFileSync(join(store, "git-hookspath.prior"), "utf8"), prior);
  run();
  assert.equal(readFileSync(join(store, "git-hookspath.prior"), "utf8"), prior, "rerunning setup must preserve the original rollback destination");
  console.log("PASS global installer preserves rollback on repeated installs");
} finally {
  rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
