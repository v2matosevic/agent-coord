// §7.1 — N processes race to claim the SAME file exclusively. Exactly one must
// win, none may crash. Proves the BEGIN IMMEDIATE check-and-insert is atomic
// across processes (the core guarantee).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getDb, writeTxn } from "../lib/store.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const N = 30;
const ws = "test-ws-" + process.pid;
const path = "src/race.ts";

const db = getDb();
writeTxn(db, () => db.prepare("DELETE FROM file_leases WHERE workspace_id=?").run(ws));

const worker = (i) =>
  new Promise((res) => {
    const p = spawn(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", join(__dir, "claim-worker.mjs"), `racer-${i}`, ws, path],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => res(out.trim()));
  });

const results = await Promise.all(Array.from({ length: N }, (_, i) => worker(i)));
const granted = results.filter((r) => r === "GRANTED").length;
const conflict = results.filter((r) => r === "CONFLICT").length;
const errors = results.filter((r) => r.startsWith("ERROR"));

console.log(`workers=${N}  granted=${granted}  conflict=${conflict}  errors=${errors.length}`);
if (errors.length) console.log("  sample errors:", errors.slice(0, 3).join(" | "));

const pass = granted === 1 && conflict === N - 1 && errors.length === 0;
console.log(pass ? "PASS ✅ exactly one winner, no errors, no lost claims" : "FAIL ❌");

writeTxn(db, () => db.prepare("DELETE FROM file_leases WHERE workspace_id=?").run(ws));
process.exit(pass ? 0 : 1);
