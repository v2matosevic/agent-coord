// Resource detection must match the command STRUCTURE, not quoted text — so a
// commit message mentioning "deploy"/"migrate" doesn't falsely claim a resource.
import { detectResources } from "../lib/resource-rules.mjs";

const ids = (cmd) => detectResources(cmd).map((r) => r.resourceId);

const commitMsg = ids('git commit -m "fix the deploy and migrate flow"'); // [] — quoted message
const echoQuoted = ids("echo 'start the dev server'"); // [] — quoted
const realDeploy = ids("npm run deploy"); // [deploy:primary]
const realMigrate = ids("npx drizzle-kit push"); // [db:dev]
const realDev = ids("next dev -p 3005"); // [port:3005]

console.log({ commitMsg, echoQuoted, realDeploy, realMigrate, realDev });
const pass =
  commitMsg.length === 0 &&
  echoQuoted.length === 0 &&
  realDeploy.includes("deploy:primary") &&
  realMigrate.includes("db:dev") &&
  realDev.includes("port:3005");
console.log(pass ? "PASS ✅ ignores quoted text, still catches real commands" : "FAIL ❌");
process.exit(pass ? 0 : 1);
