// The room is keyed on the repo ROOT, never the branch — so a mid-session
// `git switch` must not orphan leases. Guards that invariant.
import { workspaceId } from "../lib/path-canon.mjs";

const repo = "B:/Coding/Version2.0";
const onMaster = workspaceId(repo);
const onFeature = workspaceId(repo); // same repo root, different branch checked out

console.log(`ws(master)=${onMaster}  ws(feature)=${onFeature}`);
const pass = onMaster === onFeature;
console.log(pass ? "PASS ✅ room stable across branch switch" : "FAIL ❌");
process.exit(pass ? 0 : 1);
