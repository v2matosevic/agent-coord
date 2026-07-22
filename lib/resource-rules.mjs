import { readFileSync } from "node:fs";
import { join } from "node:path";

// Map a shell command to the machine-wide singleton(s) it would contend for.
// Deliberately conservative — only the genuinely collision-prone, mostly
// unrecoverable operations (a second concurrent migration or deploy, two dev
// servers on one port). Add rules here as new collisions surface.

function parsePort(text) {
  const m = String(text).match(/(?:-p|--port[ =])\s*(\d{2,5})\b/) || String(text).match(/(?:^|[;\s"'])(?:\$env:)?PORT\s*=\s*["']?(\d{2,5})\b/i);
  return m ? Number(m[1]) : null;
}

// --- dev-server port resolution ---------------------------------------------
// The rule used to claim a hardcoded `port:3000` whenever no explicit port was
// in the command — so `pnpm dev` in an Astro repo (real port 4321) contended
// machine-wide with an unrelated repo's Next server (field report i-231005d4).
// Resolve the ACTUAL port instead: explicit flag/env in the command, then the
// package script the command runs, then the repo's .env PORT, then the
// framework's default. Only when nothing resolves does it fall back — and then
// to a WORKSPACE-scoped `dev-server:<ws>` key (two dev servers in one repo
// still serialize; unrelated repos never false-block on a guessed number).
const FRAMEWORK_PORTS = [
  [/\bastro\b/i, 4321],
  [/\bvite\b/i, 5173],
  [/\bnext\b/i, 3000],
  [/\bnuxt\b/i, 3000],
  [/\bremix\b/i, 3000],
];

function frameworkPort(text) {
  for (const [re, port] of FRAMEWORK_PORTS) if (re.test(String(text))) return port;
  return null;
}

// The package script a `npm|pnpm|yarn|bun (run) dev[...]` command executes —
// its text usually names the framework and/or an explicit port.
function devScript(repoRoot, cmd) {
  const m = String(cmd).match(/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(dev[\w:.-]*)\b/i);
  if (!m) return null;
  try {
    return JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).scripts?.[m[1]] || null;
  } catch {
    return null;
  }
}

function envFilePort(repoRoot) {
  for (const f of [".env.local", ".env"]) {
    try {
      const m = readFileSync(join(repoRoot, f), "utf8").match(/^\s*PORT\s*=\s*["']?(\d{2,5})\b/m);
      if (m) return Number(m[1]);
    } catch {}
  }
  return null;
}

// .env PORT deliberately beats the framework default (Next/Nuxt/Remix honor the
// PORT env; a repo that sets it runs there, not on the default).
function resolveDevServer(cmd, workspaceId, repoRoot) {
  const script = repoRoot ? devScript(repoRoot, cmd) : null;
  const port =
    parsePort(cmd) ??
    (script != null ? parsePort(script) : null) ??
    (repoRoot ? envFilePort(repoRoot) : null) ??
    frameworkPort(script || "") ??
    frameworkPort(cmd);
  return port != null
    ? { resourceId: "port:" + port, scope: "machine", label: "dev server port" }
    : { resourceId: "dev-server:" + (workspaceId || "here"), scope: "workspace", label: "dev server" };
}

// --- deploy detection -------------------------------------------------------
// Match deploy as an ACTION that ships to a shared target, NOT the word "deploy"
// appearing as an argument or a name. The old rule matched a bare "deploy" token
// anywhere, so a read-only run observer that merely REFERENCED a deploy workflow
// (`gh run watch <id>` on a "deploy" workflow, `gh run list --workflow deploy.yml`,
// `git log deploy`) was misclassified as a deploy mutation and blocked (BUG 3B,
// OBSERVED-BUGS-2026-06-18).
//
// The discriminator is COMMAND POSITION: a deploy tool/script must sit at the start
// of a command or just after a separator (optionally behind a path), never buried as
// an argument to some other verb. `deploy` as a CLI subcommand must also be a whole
// word, so `fly logs deploy-app` (reading logs of an app NAMED deploy-app) is not a
// deploy. `CMD` is that command-position prefix.
const CMD = String.raw`(?:^|[;&|(]|&&|\|\|)\s*(?:\S*\/)?`;
const DEPLOY = [
  // a package script: npm|pnpm|yarn|bun (run) deploy[:env] — running a script is
  // itself the action, so this one needn't be command-position gated.
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?deploy(?:[:@][\w./-]+)?\b/i,
  // a deploy CLI invoked in command position with `deploy` as a whole-word subcommand
  new RegExp(CMD + String.raw`(?:vercel|netlify|wrangler|flyctl|fly|serverless|sls|sst|firebase|surge|eb|pulumi|kamal)\s+(?:[\w:@./-]+\s+)*deploy(?=\s|$|[;&|])`, "i"),
  // `vercel … --prod` (deploy-to-prod form has no "deploy" verb), tool in command position
  new RegExp(CMD + String.raw`vercel\b[^\n;&|]*\s--prod\b`, "i"),
  // a deploy script EXECUTED in command position, optionally via an interpreter and/or
  // a path (`./deploy.sh`, `bash deploy.sh`, `sudo /opt/deploy.sh`, `make deploy`)
  new RegExp(CMD + String.raw`(?:(?:sudo|bash|sh|zsh|pwsh|powershell|node|make)\s+(?:-\S+\s+)*)?(?:\S*\/)?deploy(?:\.\w+)?(?=$|[\s;&|)])`, "i"),
  // the Hostinger CLI (mutates prod) in command position
  new RegExp(CMD + String.raw`hostinger\b`, "i"),
  // a detached compose bring-up
  /docker\s+compose\s+up\b[^\n]*\s-d\b/i,
];

// scope:
//   "machine"   — a real OS-level singleton (a TCP port): two repos collide
//                 regardless of project, so the lock key must be global.
//   "workspace" — contends on a PER-PROJECT target (a deploy destination, a repo's
//                 own dev DB): keying it globally serialized unrelated repos (BUG
//                 3A). Scoped to the workspace so repo A's deploy can't block repo
//                 B's. A genuinely shared host/DB can still be claimed explicitly
//                 with a machine-wide id via the claim_resource tool.
const RULES = [
  {
    test: /drizzle-kit\s+(push|migrate)|prisma\s+migrate|knex\s+migrate|sequelize[^\n]*db:migrate|(npm|pnpm|yarn)\s+run\s+db:(push|migrate)/i,
    scope: "machine", // a local dev DB is commonly shared across checkouts on one box — keep global (no field report of a false cross-project block here)
    id: () => "db:dev",
    label: "dev database migration",
  },
  {
    test: (cmd) => DEPLOY.some((re) => re.test(cmd)),
    scope: "workspace",
    id: (cmd, ws) => "deploy:" + (ws || "primary"),
    label: "deploy",
  },
  {
    test: /\b(next\s+(dev|start)|vite|astro\s+dev|(npm|pnpm|yarn|bun)\s+(run\s+)?dev)\b/i,
    resolve: resolveDevServer,
  },
];

export function detectResources(command, { workspaceId = null, repoRoot = null } = {}) {
  // Match on command STRUCTURE, not quoted argument text — so a commit/echo whose
  // message contains "deploy"/"migrate" doesn't trip a resource lease.
  const cmd = String(command).replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
  const out = [];
  const seen = new Set();
  for (const r of RULES) {
    const hit = typeof r.test === "function" ? r.test(cmd) : r.test.test(cmd);
    if (!hit) continue;
    const res = r.resolve
      ? r.resolve(cmd, workspaceId, repoRoot)
      : { resourceId: r.id(cmd, r.scope === "workspace" ? workspaceId : null), label: r.label, scope: r.scope };
    if (seen.has(res.resourceId)) continue;
    seen.add(res.resourceId);
    out.push(res);
  }
  return out;
}
