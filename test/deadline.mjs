import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { deadlineAfter, remainingMs } from "../lib/deadline.mjs";
import { getDb, writeTxn } from "../lib/store.mjs";
import { gitContext } from "../lib/git-context.mjs";

assert.ok(process.env.AGENT_COORD_HOME, "run through the isolated runner");
assert.equal(remainingMs(Infinity, 123), 123);
assert.throws(() => remainingMs(deadlineAfter(-1)), { code: "COORD_DEADLINE" });
const db = getDb();
getDb({ deadline: deadlineAfter(-1) });
let called = false;
assert.throws(() => writeTxn(db, () => { called = true; }), { code: "COORD_DEADLINE" });
assert.equal(called, false, "an expired operation must never enter a mutation");

const original = childProcess.execFileSync;
const previousGitDir = process.env.GIT_DIR;
let options;
try {
  childProcess.execFileSync = (_command, _args, opts) => {
    options = opts;
    throw Object.assign(new Error("fixture timeout"), { code: "ETIMEDOUT" });
  };
  syncBuiltinESMExports();
  process.env.GIT_DIR = "fixture-force-subprocess";
  assert.throws(() => gitContext(process.cwd(), { deadline: deadlineAfter(1000) }), { code: "COORD_DEADLINE" });
  assert.ok(options.timeout > 0 && options.timeout <= 1000);
  assert.deepEqual(gitContext(process.cwd()), { repoRoot: null, branch: null }, "ordinary callers keep the prior fallback");
} finally {
  childProcess.execFileSync = original;
  syncBuiltinESMExports();
  if (previousGitDir === undefined) delete process.env.GIT_DIR;
  else process.env.GIT_DIR = previousGitDir;
}
console.log("Expired budgets prevent mutations; Git fallback shares the remaining deadline without inventing a repository");
