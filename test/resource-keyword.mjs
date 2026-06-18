// Resource detection must match the command STRUCTURE, not quoted text or a bare
// word — so a commit message mentioning "deploy"/"migrate" doesn't claim a
// resource, AND a read-only run observer that merely references a deploy workflow
// isn't misread as a deploy (BUG 3B). Per-project resources (deploy) are keyed to
// the workspace so unrelated repos don't serialize each other (BUG 3A).
import { detectResources } from "../lib/resource-rules.mjs";

const ids = (cmd, opts) => detectResources(cmd, opts).map((r) => r.resourceId);
let ok = true;
const check = (cond, msg) => {
  if (!cond) ok = false;
  console.log(`  ${cond ? "✓" : "✗"} ${msg}`);
};

// --- quoted text never trips a resource (unchanged) ------------------------
check(ids('git commit -m "fix the deploy and migrate flow"').length === 0, "quoted commit message → no resource");
check(ids("echo 'start the dev server'").length === 0, "quoted echo → no resource");

// --- real actions are still caught -----------------------------------------
check(ids("npm run deploy").includes("deploy:primary"), "npm run deploy → deploy");
check(ids("npm run deploy:prod").includes("deploy:primary"), "npm run deploy:prod → deploy");
check(ids("./deploy.sh").includes("deploy:primary"), "./deploy.sh → deploy");
check(ids("bash deploy.sh prod").includes("deploy:primary"), "bash deploy.sh → deploy");
check(ids("sudo /opt/deploy.sh").includes("deploy:primary"), "sudo /opt/deploy.sh → deploy");
check(ids("make deploy").includes("deploy:primary"), "make deploy → deploy");
check(ids("vercel deploy --prod").includes("deploy:primary"), "vercel deploy → deploy");
check(ids("vercel --prod").includes("deploy:primary"), "vercel --prod → deploy");
check(ids("wrangler pages deploy ./dist").includes("deploy:primary"), "wrangler pages deploy → deploy");
check(ids("cd app && ./deploy.sh").includes("deploy:primary"), "chained ./deploy.sh after && → deploy");
check(ids("npx drizzle-kit push").includes("db:dev"), "drizzle-kit push → db:dev");
check(ids("next dev -p 3005").includes("port:3005"), "next dev -p 3005 → port:3005");

// --- BUG 3B: read-only observers that REFERENCE a deploy are NOT deploys ----
check(ids("gh run watch 1234 --exit-status").length === 0, "gh run watch <id> → not a deploy");
check(ids("gh run list --workflow deploy.yml").length === 0, "gh run list --workflow deploy.yml → not a deploy");
check(ids("gh workflow view deploy").length === 0, "gh workflow view deploy → not a deploy");
check(ids("git log --oneline deploy").length === 0, "git log <deploy-branch> → not a deploy");
check(ids("cat deploy-notes.md").length === 0, "cat deploy-notes.md → not a deploy");
check(ids("fly logs deploy-app").length === 0, "fly logs <app-named-deploy-app> → not a deploy");
check(ids("kubectl get deploy").length === 0, "kubectl get deploy (read-only shorthand) → not a deploy");
check(ids("echo vercel --prod").length === 0, "echo vercel --prod (not command position) → not a deploy");

// --- BUG 3A: deploy is keyed to the WORKSPACE; the port is not -------------
const depA = ids("npm run deploy", { workspaceId: "wsAAAA" });
const depB = ids("npm run deploy", { workspaceId: "wsBBBB" });
check(depA[0] === "deploy:wsAAAA" && depB[0] === "deploy:wsBBBB", "deploy id folds in the workspace");
check(depA[0] !== depB[0], "different repos → different deploy keys → no cross-project block");
check(ids("next dev", { workspaceId: "wsAAAA" })[0] === "port:3000", "a port stays machine-wide (not workspace-keyed)");

console.log(ok ? "PASS ✅ structure-aware, observer-safe, per-repo deploy scoping" : "FAIL ❌");
process.exit(ok ? 0 : 1);
