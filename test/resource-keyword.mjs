// Resource detection must match the command STRUCTURE, not quoted text or a bare
// word — so a commit message mentioning "deploy"/"migrate" doesn't claim a
// resource, AND a read-only run observer that merely references a deploy workflow
// isn't misread as a deploy (BUG 3B). Per-project resources (deploy) are keyed to
// the workspace so unrelated repos don't serialize each other (BUG 3A).
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// --- i-231005d4: resolve the REAL dev port, never a guessed port:3000 -------
// `pnpm dev` in an Astro repo (port 4321) used to claim port:3000 and
// false-contend with an unrelated repo's Next server.
const mkRepo = (files) => {
  const dir = mkdtempSync(join(tmpdir(), "coord-rr-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
};

const astroRepo = mkRepo({ "package.json": JSON.stringify({ scripts: { dev: "astro dev" } }) });
check(ids("pnpm dev", { workspaceId: "wsA", repoRoot: astroRepo })[0] === "port:4321", "pnpm dev + astro script → port:4321 (framework default via package.json)");

const scriptPortRepo = mkRepo({ "package.json": JSON.stringify({ scripts: { dev: "next dev --port 4001" } }) });
check(ids("npm run dev", { workspaceId: "wsA", repoRoot: scriptPortRepo })[0] === "port:4001", "explicit port in the dev script wins");

const envPortRepo = mkRepo({ "package.json": JSON.stringify({ scripts: { dev: "next dev" } }), ".env": "DB_URL=x\nPORT=4002\n" });
check(ids("pnpm dev", { workspaceId: "wsA", repoRoot: envPortRepo })[0] === "port:4002", ".env PORT beats the framework default (Next honors PORT)");

check(ids("pnpm dev --port 5000", { workspaceId: "wsA", repoRoot: astroRepo })[0] === "port:5000", "explicit port on the command beats everything");

const opaqueRepo = mkRepo({ "package.json": JSON.stringify({ scripts: { dev: "node server.mjs" } }) });
const opaque = detectResources("pnpm dev", { workspaceId: "wsA", repoRoot: opaqueRepo })[0];
check(opaque.resourceId === "dev-server:wsA" && opaque.scope === "workspace", "unresolvable port → workspace-scoped dev-server key, not a guessed port:3000");

check(ids("PORT=4003 npm run dev", { workspaceId: "wsA", repoRoot: opaqueRepo })[0] === "port:4003", "PORT= env prefix on the command resolves");

for (const d of [astroRepo, scriptPortRepo, envPortRepo, opaqueRepo]) rmSync(d, { recursive: true, force: true });

console.log(ok ? "PASS ✅ structure-aware, observer-safe, per-repo deploy scoping, real-port resolution" : "FAIL ❌");
process.exit(ok ? 0 : 1);
