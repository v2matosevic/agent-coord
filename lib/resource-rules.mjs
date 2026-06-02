// Map a shell command to the machine-wide singleton(s) it would contend for.
// Deliberately conservative — only the genuinely collision-prone, mostly
// unrecoverable operations (a second concurrent migration or deploy, two dev
// servers on one port). Add rules here as new collisions surface.

function parsePort(cmd) {
  const m = cmd.match(/(?:-p|--port[ =])\s*(\d{2,5})/);
  return m ? Number(m[1]) : null;
}

const RULES = [
  {
    test: /drizzle-kit\s+(push|migrate)|prisma\s+migrate|knex\s+migrate|sequelize[^\n]*db:migrate|(npm|pnpm|yarn)\s+run\s+db:(push|migrate)/i,
    id: () => "db:dev",
    label: "dev database migration",
  },
  {
    test: /\b(npm|pnpm|yarn)\s+run\s+deploy\b|(^|[\s&|])\.?\/?deploy(\.sh|\.ps1)?\b|\bhostinger\b|docker\s+compose\s+up\b[^\n]*\s-d\b/i,
    id: () => "deploy:primary",
    label: "deploy",
  },
  {
    test: /\b(next\s+(dev|start)|vite|astro\s+dev|(npm|pnpm|yarn)\s+(run\s+)?dev)\b/i,
    id: (cmd) => "port:" + (parsePort(cmd) ?? 3000),
    label: "dev server port",
  },
];

export function detectResources(command) {
  // Match on command STRUCTURE, not quoted argument text — so a commit/echo whose
  // message contains "deploy"/"migrate" doesn't trip a resource lease.
  const cmd = String(command).replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
  const out = [];
  const seen = new Set();
  for (const r of RULES) {
    if (!r.test.test(cmd)) continue;
    const id = r.id(cmd);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ resourceId: id, label: r.label });
  }
  return out;
}
