// Seed a store with a realistic demo fleet (for screenshots / dashboard demos).
// Run against an isolated store via AGENT_COORD_HOME so the live store is untouched.
// Fictional repos/tasks — just illustrative shapes.
import { getDb } from "../lib/store.mjs";
import { ensureAgent } from "../lib/agents.mjs";
import { claimFile, claimResource } from "../lib/leases.mjs";
import { logActivity } from "../lib/activity.mjs";
import { workspaceId } from "../lib/path-canon.mjs";

const db = getDb();
const ws = (r) => workspaceId(r);
const A = (id, tool, repo, branch, task) => ensureAgent(db, { agentId: id, tool, repoPath: repo, branch, task });
const claim = (id, repo, branch, path) => claimFile(db, { agentId: id, workspaceId: ws(repo), repoPath: repo, branch, path, mode: "exclusive", reason: "Edit" });

const SHOP = "/work/acme-shop";
A("amber-fox-1234", "claude-code", SHOP, "master", "checkout polish");
A("jade-wolf-5678", "claude-code", SHOP, "master", "blog category resolver fix");
claim("amber-fox-1234", SHOP, "master", "src/app/checkout/page.tsx");
claim("jade-wolf-5678", SHOP, "master", "src/lib/blog/categories.ts");

const FIN = "/work/finance-app";
A("ruby-hawk-9012", "codex", FIN, "main", "wire stripe webhook + retries");
claimResource(db, { agentId: "ruby-hawk-9012", resourceId: "deploy:primary", reason: "deploy" });
claim("ruby-hawk-9012", FIN, "main", "app/api/webhooks/stripe/route.ts");

A("slate-lynx-3456", "claude-code", "/work/landing-site", "dev", "hero parallax tuning");

logActivity(db, { agentId: "amber-fox-1234", workspaceId: ws(SHOP), event: "claim", detail: "src/app/checkout/page.tsx" });
logActivity(db, { agentId: "ruby-hawk-9012", event: "resource-claim", detail: "deploy:primary" });
logActivity(db, { agentId: "jade-wolf-5678", workspaceId: ws(SHOP), event: "intent", detail: "blog category resolver fix" });
console.log("seeded demo fleet:", db.prepare("SELECT COUNT(*) c FROM agents").get().c, "agents");
