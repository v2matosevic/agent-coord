// Machine trailer (global commit-msg): which name it picks, when it stays out
// of the message, and the hook end to end against a scratch repo. No network:
// the child gets its own AGENT_COORD_HOME with a seeded visibility cache, and
// the machine is pinned by env.
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { machineName, isEmptyMessage } from "../lib/machine.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "cli", "commit-msg.mjs");
const checks = {};

// which name
const cfgDir = mkdtempSync(join(tmpdir(), "ac-hermes-"));
writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ machine: "olympus" }));
checks["env override wins"] = machineName({ env: { AGENT_COORD_MACHINE: "box", HERMES_CONFIG_DIR: cfgDir } }) === "box";
checks["hermes enrolment name"] = machineName({ env: { HERMES_CONFIG_DIR: cfgDir } }) === "olympus";
checks["hostname fallback"] =
  machineName({ env: { HERMES_CONFIG_DIR: join(cfgDir, "missing") }, host: "MacBook-Air.local" }) === "macbook-air";

// empty messages stay empty
checks["blank is empty"] = isEmptyMessage("\n\n");
checks["comments only is empty"] = isEmptyMessage("\n# Please enter the commit message\n#\n");
checks["scissors diff is empty"] = isEmptyMessage("\n# ------------------------ >8 ------------------------\ndiff --git a/x b/x\n");
checks["subject is not empty"] = !isEmptyMessage("Fix the thing\n\n# comment\n");

// the hook, end to end
const repo = mkdtempSync(join(tmpdir(), "ac-repo-"));
const home = mkdtempSync(join(tmpdir(), "ac-home-"));
writeFileSync(
  join(home, "remote-visibility.json"),
  JSON.stringify({ "x/pub": { public: true, ts: Date.now() }, "x/priv": { public: false, ts: Date.now() } }),
);
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
git("init", "-q");
const env = { ...process.env, AGENT_COORD_MACHINE: "testbox", AGENT_COORD_HOME: home };
const run = (text) => {
  const f = join(repo, "MSG");
  writeFileSync(f, text);
  execFileSync(process.execPath, [HOOK, f], { cwd: repo, env, stdio: "ignore" });
  return readFileSync(f, "utf8");
};

checks["no remote: stamped"] = run("Fix the thing\n") === "Fix the thing\n\nMachine: testbox\n";
checks["not stamped twice"] = run(run("Fix the thing\n")).split("Machine:").length === 2;
checks["keeps another machine's stamp"] = !run("Fix\n\nMachine: olympus\n").includes("testbox");
checks["empty message untouched"] = run("\n# comment\n") === "\n# comment\n";

git("remote", "add", "origin", "https://github.com/x/pub.git");
checks["public repo untouched"] = run("Fix the thing\n") === "Fix the thing\n";
git("remote", "set-url", "origin", "git@github.com:x/priv.git");
checks["private repo stamped"] = run("Fix the thing\n").includes("\nMachine: testbox\n");
git("remote", "set-url", "origin", "https://gitlab.com/x/y.git");
checks["non-GitHub remote stamped"] = run("Fix the thing\n").includes("\nMachine: testbox\n");

let ok = true;
for (const [k, v] of Object.entries(checks)) {
  if (!v) ok = false;
  console.log(`${v ? "✅" : "❌"} ${k}`);
}
console.log(ok ? "PASS ✅ machine trailer: name/empty/hook/public" : "FAIL ❌");
process.exit(ok ? 0 : 1);
