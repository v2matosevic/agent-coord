// AI attribution stripping (global commit-msg): the pure function, and a real
// `git commit` in a scratch repo through the hook so the trailer never lands.
import { mkdtempSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stripAiAttribution } from "../lib/attribution.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "cli", "commit-msg.mjs");
const checks = {};

const msg = "Fix the thing\n\nBody line.\n\nVerified: tests (3 passed)\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n";
const s = stripAiAttribution(msg);
checks["claude trailer removed"] = s.removed === 1 && !s.text.includes("Co-Authored-By");
checks["verified trailer kept"] = s.text.includes("Verified: tests (3 passed)");
checks["pr footer removed"] = stripAiAttribution("Body\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n").removed === 1;
checks["human co-author kept"] = stripAiAttribution("x\n\nCo-Authored-By: Ana <ana@example.com>\n").removed === 0;
checks["codex co-author removed"] = stripAiAttribution("x\n\nCo-authored-by: Codex <codex@openai.com>\n").removed === 1;
checks["comment line untouched"] = stripAiAttribution("x\n# Co-Authored-By: Claude\n").removed === 0;
checks["clean message unchanged"] = stripAiAttribution("Fix\n\nBody\n").text === "Fix\n\nBody\n";

// end to end: a real commit through the hook
const repo = mkdtempSync(join(tmpdir(), "ac-attr-"));
const home = mkdtempSync(join(tmpdir(), "ac-attr-home-"));
const env = { ...process.env, AGENT_COORD_HOME: home, AGENT_COORD_MACHINE: "testbox", AGENT_COORD_VERIFY_MODE: "off" };
const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8", env });
git("init", "-q");
git("config", "user.email", "t@example.invalid");
git("config", "user.name", "t");
const hooks = join(repo, ".hooks");
execFileSync(process.execPath, ["-e", `require('fs').mkdirSync(${JSON.stringify(hooks)})`]);
writeFileSync(join(hooks, "commit-msg"), `#!/bin/sh\nnode "${HOOK.replace(/\\/g, "/")}" "$1"\n`, { mode: 0o755 });
git("config", "core.hooksPath", hooks.replace(/\\/g, "/"));
writeFileSync(join(repo, "a.txt"), "a\n");
git("add", "a.txt");
git("commit", "-q", "-m", "Add a\n\nVerified: none (test)\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>");
const body = git("log", "-1", "--format=%B");
checks["committed message has no AI trailer"] = !/Co-Authored-By/i.test(body);
checks["committed message keeps the stamp"] = body.includes("Verified: none (test)");

let ok = true;
for (const [k, v] of Object.entries(checks)) {
  if (!v) ok = false;
  console.log(`${v ? "✅" : "❌"} ${k}`);
}
console.log(ok ? "PASS ✅ AI attribution stripped, human co-authors kept" : "FAIL ❌");
process.exit(ok ? 0 : 1);
