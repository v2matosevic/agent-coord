// A store written by a NEWER schema version must flip the degraded flag on open
// (fail loud), not silently write incompatible data.
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, writeTxn, DEGRADED_FLAG } from "../lib/store.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const db = getDb();
writeTxn(db, () => db.prepare("UPDATE schema_version SET version=999").run());
rmSync(DEGRADED_FLAG, { force: true });

// fresh process opens the (now schema-ahead) store -> guard should set degraded
execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(__dir, "_open-store.mjs")], { stdio: "ignore" });
const degraded = existsSync(DEGRADED_FLAG);

writeTxn(db, () => db.prepare("UPDATE schema_version SET version=1").run());
rmSync(DEGRADED_FLAG, { force: true });

console.log("degraded flag set on schema-ahead store:", degraded);
console.log(degraded ? "PASS ✅" : "FAIL ❌");
process.exit(degraded ? 0 : 1);
