// Verification stamp gate (global commit-msg): parsing the trailer, the
// verdict per mode, the exemptions, the two-block escape, and the hook end to
// end against a scratch repo in observe and enforce mode.
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parseVerified,
  decide,
  exemptReason,
  verifyMode,
  recentBlockCount,
  readLog,
} from "../lib/verification.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "cli", "commit-msg.mjs");
const checks = {};

// parsing
const p1 = parseVerified("Fix invoice rounding\n\nVerified: tests (InvoiceTest, 14 passed)\nMachine: olympus\n");
checks["parses a method"] = p1.present && !p1.none && p1.value.startsWith("tests");
const p2 = parseVerified("Docs\n\nVerified: none (docs only)\n");
checks["none with reason"] = p2.none && p2.reason === "docs only";
const p3 = parseVerified("Docs\n\nVerified: none\n");
checks["none without reason"] = p3.none && p3.reason === null;
checks["case-insensitive key"] = parseVerified("x\n\nverified: e2e-browser\n").present;
checks["comment lines ignored"] = !parseVerified("x\n# Verified: tests\n").present;
checks["scissors ends message"] = !parseVerified("x\n# ------------------------ >8 ------------------------\nVerified: tests\n").present;
checks["missing"] = !parseVerified("Fix the thing\n").present;
checks["empty value is missing"] = !parseVerified("x\n\nVerified:\n").present;
checks["last trailer wins"] = parseVerified("x\n\nVerified: none\nVerified: tests\n").value === "tests";

// verdicts
const miss = parseVerified("x\n");
checks["observe never blocks"] = decide({ mode: "observe", isAgent: true, parsed: miss }).action === "allow";
checks["observe records would-block"] = decide({ mode: "observe", isAgent: true, parsed: miss }).wouldBlock === true;
checks["enforce blocks agent with no stamp"] = decide({ mode: "enforce", isAgent: true, parsed: miss }).action === "block";
checks["enforce never blocks a human"] = decide({ mode: "enforce", isAgent: false, parsed: miss }).action === "allow";
checks["enforce blocks none without reason"] = decide({ mode: "enforce", isAgent: true, parsed: p3 }).action === "block";
checks["enforce passes none with reason"] = decide({ mode: "enforce", isAgent: true, parsed: p2 }).action === "allow";
checks["enforce passes exempt"] = decide({ mode: "enforce", isAgent: true, parsed: miss, exempt: "merge" }).action === "allow";
checks["third attempt escapes"] = decide({ mode: "enforce", isAgent: true, parsed: miss, recentBlocks: 2 }).action === "escaped";

// exemptions
checks["wip branch exempt"] = exemptReason({ branch: "wip/olympus" }) === "wip-branch";
checks["merge subject exempt"] = exemptReason({ subject: "Merge branch 'main'" }) === "merge";
checks["fixup exempt"] = exemptReason({ subject: "fixup! Fix x" }) === "fixup";
checks["normal commit not exempt"] = exemptReason({ branch: "master", subject: "Fix x" }) === null;

// mode resolution
const mh = mkdtempSync(join(tmpdir(), "ac-vmode-"));
checks["default mode is observe"] = verifyMode({ env: {}, home: mh }) === "observe";
writeFileSync(join(mh, "verify-mode"), "enforce\n");
checks["file sets mode"] = verifyMode({ env: {}, home: mh }) === "enforce";
checks["env beats file"] = verifyMode({ env: { AGENT_COORD_VERIFY_MODE: "off" }, home: mh }) === "off";
checks["junk mode falls back"] = verifyMode({ env: { AGENT_COORD_VERIFY_MODE: "loud" }, home: mkdtempSync(join(tmpdir(), "ac-v-")) }) === "observe";

// escape window counts only recent blocks in the same repo
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const log = [
  { action: "block", repo: "/r", ts: iso(now - 60_000) },
  { action: "block", repo: "/r", ts: iso(now - 3_600_000) },
  { action: "block", repo: "/other", ts: iso(now - 60_000) },
  { action: "allow", repo: "/r", ts: iso(now - 60_000) },
];
checks["block window"] = recentBlockCount(log, "/r", now) === 1;

// the hook end to end
const repo = mkdtempSync(join(tmpdir(), "ac-vrepo-"));
const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
git("init", "-q");
const run = (text, extraEnv) => {
  const home = extraEnv.AGENT_COORD_HOME;
  mkdirSync(home, { recursive: true });
  const f = join(repo, "MSG");
  writeFileSync(f, text);
  const r = spawnSync(process.execPath, [HOOK, f], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, AGENT_COORD_MACHINE: "testbox", CLAUDE_CODE_SESSION_ID: "", CLAUDECODE: "", CODEX_THREAD_ID: "", ...extraEnv },
  });
  return { status: r.status, stderr: r.stderr, log: readLog(home) };
};

const hObs = mkdtempSync(join(tmpdir(), "ac-vh-"));
const obs = run("Fix the thing\n", { AGENT_COORD_HOME: hObs, AGENT_COORD_VERIFY_MODE: "observe", CLAUDECODE: "1" });
checks["hook observe: allowed"] = obs.status === 0;
checks["hook observe: logged would-block"] = obs.log.length === 1 && obs.log[0].wouldBlock === true && obs.log[0].agent === "claude";

const hEnf = mkdtempSync(join(tmpdir(), "ac-vh-"));
const enfEnv = { AGENT_COORD_HOME: hEnf, AGENT_COORD_VERIFY_MODE: "enforce", CLAUDECODE: "1" };
const b1 = run("Fix the thing\n", enfEnv);
checks["hook enforce: refused"] = b1.status === 1 && /Verified:/.test(b1.stderr);
const ok = run("Fix the thing\n\nVerified: tests (unit, 3 passed)\n", enfEnv);
checks["hook enforce: stamped passes"] = ok.status === 0 && ok.log.at(-1).outcome === "verified";
run("Fix the thing\n", enfEnv);
const b3 = run("Fix the thing\n", enfEnv);
checks["hook enforce: third attempt escapes"] = b3.status === 0 && b3.log.at(-1).action === "escaped";

const hHum = mkdtempSync(join(tmpdir(), "ac-vh-"));
const hum = run("Fix the thing\n", { AGENT_COORD_HOME: hHum, AGENT_COORD_VERIFY_MODE: "enforce" });
checks["hook enforce: human allowed"] = hum.status === 0 && hum.log[0].agent === "human";

const hOff = mkdtempSync(join(tmpdir(), "ac-vh-"));
const off = run("Fix the thing\n", { AGENT_COORD_HOME: hOff, AGENT_COORD_VERIFY_MODE: "off", CLAUDECODE: "1" });
checks["hook off: nothing logged"] = off.status === 0 && off.log.length === 0;

checks["machine stamp still applied"] = readFileSync(join(repo, "MSG"), "utf8").includes("Machine: testbox");

let all = true;
for (const [k, v] of Object.entries(checks)) {
  if (!v) all = false;
  console.log(`${v ? "✅" : "❌"} ${k}`);
}
console.log(all ? "PASS ✅ verification stamp: parse/verdict/exempt/escape/hook" : "FAIL ❌");
process.exit(all ? 0 : 1);
