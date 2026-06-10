// Run the whole suite: every test/*.mjs that doesn't start with "_" (those are
// child-process helpers, not standalone tests). Each test gets a fresh isolated
// store via AGENT_COORD_HOME so the live store is never touched. Sequential on
// purpose — several tests spawn their own worker processes and race internally.
import { spawnSync } from "node:child_process";
import { readdirSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const __dir = dirname(fileURLToPath(import.meta.url));
const only = process.argv.slice(2); // optional filter: node test/run-all.mjs messages tasks

const tests = readdirSync(__dir)
  .filter((f) => f.endsWith(".mjs") && !f.startsWith("_") && f !== "run-all.mjs")
  .filter((f) => only.length === 0 || only.some((o) => f.includes(o)))
  .sort();

let passed = 0;
const failed = [];
for (const f of tests) {
  const home = mkdtempSync(join(tmpdir(), "agent-coord-test-"));
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(__dir, f)], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, AGENT_COORD_HOME: home, AGENT_COORD_NOTIFY: "0" },
  });
  rmSync(home, { recursive: true, force: true });
  const ms = Date.now() - t0;
  if (r.status === 0) {
    passed++;
    console.log(`  ok    ${f} (${ms}ms)`);
  } else {
    failed.push(f);
    console.log(`  FAIL  ${f} (${ms}ms)${r.signal ? ` signal=${r.signal}` : ""}`);
    const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
    if (out) console.log(out.split("\n").map((l) => `        ${l}`).join("\n"));
  }
}

console.log(`\n${passed}/${tests.length} passed${failed.length ? ` — FAILED: ${failed.join(", ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
