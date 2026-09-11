// MCP tool catalog. Plain JSON Schema (no zod in our code). The server process
// supplies a default identity. Codex hooks attach request-local session metadata
// so threads sharing a transport never rename one another.

// Keep the first 512 characters useful when a host truncates server guidance.
export const INSTRUCTIONS = "Machine-wide coordination for agents sharing files and resources. Start with announce_intent: one call returns identity, peers, board, decisions and mail counts. Without trusted native hooks, claim_files before each edit and poll read_messages. Locks self-heal; never force-release a live peer or ask the human to unlock. Use post_message/reply for peers, claim_resource for shared services, pending_push_review before pushing peer commits. Search prior work; record_decision pins choices. Board tools hand off tasks; report_issue logs bugs and friction.";

const strArr = { type: "array", items: { type: "string" } };

export const TOOL_DEFS = [
  {
    name: "whoami",
    description: "Return this agent's coordination identity (id, tool, repo, branch).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "announce_intent",
    description:
      "Start here: one call returns identity, peers, board, decisions and unread-mail counts in brief, plus task overlaps. If a live peer started the same work first, narrow your lane or hand off.",
    inputSchema: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
  },
  {
    name: "list_active_agents",
    description: "List live agents and each one's latest held file. Default: all repos. Use scope:'workspace' for this repo.",
    inputSchema: { type: "object", properties: { scope: { type: "string", enum: ["global", "workspace"] } } },
  },
  {
    name: "post_message",
    description: "Message peers. Broadcasts default to this workspace; scope:'global' broadcasts fleet-wide. to:<agent_id> reaches that peer in any repo. Messages expire after 7 days.",
    inputSchema: { type: "object", properties: { body: { type: "string" }, to: { type: "string" }, scope: { type: "string", enum: ["workspace", "global"] } }, required: ["body"] },
  },
  {
    name: "read_messages",
    description: "Read and mark returned inbox messages read; remaining reports the backlog. Includes direct messages across repos, broadcasts during your session, and older broadcasts from live peers. Other history stays in search. from_live:false means the sender exited, not that the message is irrelevant. Trusted hooks deliver mail; poll when hooks are absent or pending mail is needed.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_global_state",
    description: "Fleet snapshot: agents, file/resource leases, queue, tasks and recent activity. Lists are capped with a note when clipped; check_conflicts/list_tasks give scoped detail.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "check_conflicts",
    description: "Without claiming, check whether any of these files are held by another live agent.",
    inputSchema: { type: "object", properties: { paths: strArr }, required: ["paths"] },
  },
  {
    name: "claim_files",
    description: "Reserve files before editing. Returns which were granted and who holds the rest. Call BEFORE you edit.",
    inputSchema: {
      type: "object",
      properties: { paths: strArr, mode: { type: "string", enum: ["exclusive", "shared"] }, reason: { type: "string" } },
      required: ["paths"],
    },
  },
  {
    name: "release_files",
    description: "Release file claims when done. Omit paths to release all of yours.",
    inputSchema: { type: "object", properties: { paths: strArr } },
  },
  {
    name: "claim_resource",
    description: "Claim a shared singleton before use. Give the same OS service one machine-wide id, e.g. 'port:3000'. Shell guards scope deployments/migrations per repo; use a shared id such as 'deploy:prod-host' when repos target the same service.",
    inputSchema: { type: "object", properties: { resource_id: { type: "string" }, reason: { type: "string" } }, required: ["resource_id"] },
  },
  {
    name: "release_resource",
    description: "Release a resource lease YOU hold. Returns released:false + heldBy when the lease is a peer's (it frees when they release or go silent) — never treat that as released.",
    inputSchema: { type: "object", properties: { resource_id: { type: "string" } }, required: ["resource_id"] },
  },
  {
    name: "log_activity",
    description: "Append a note to the shared activity feed other agents can see.",
    inputSchema: { type: "object", properties: { event: { type: "string" }, detail: { type: "string" } }, required: ["event"] },
  },
  {
    name: "pending_push_review",
    description: "Review unpushed commits before pushing peer work: authors, liveness and blockers. Returns the inspected repo/branch/upstream. For a nested checkout pass repo:<path inside it>; otherwise uses this server's cwd. Inspect the verdict before pushing.",
    inputSchema: { type: "object", properties: { repo: { type: "string", description: "path inside the git repo to review (default: this session's repo)" } } },
  },
  {
    name: "ask_agent",
    description: "Ask a live peer; returns ask_id for check_replies. Verify the recipient in list_active_agents: an exited peer cannot answer.",
    inputSchema: { type: "object", properties: { to: { type: "string" }, question: { type: "string" } }, required: ["to", "question"] },
  },
  {
    name: "check_replies",
    description: "Collect replies to ask_id without waiting. If none and the peer exited, decide from recorded state or tell the human; stop polling.",
    inputSchema: { type: "object", properties: { ask_id: { type: "string" } }, required: ["ask_id"] },
  },
  {
    name: "reply",
    description: "Answer a peer's ask using ask_id and to:<asker's from_agent>.",
    inputSchema: { type: "object", properties: { ask_id: { type: "string" }, to: { type: "string" }, answer: { type: "string" } }, required: ["ask_id", "to", "answer"] },
  },
  {
    name: "request_yield",
    description:
      "Ask a peer to stand down when you started duplicated work first or hold the verified result. If they agree they release files and stop. Never force-release their locks.",
    inputSchema: { type: "object", properties: { to: { type: "string" }, reason: { type: "string" } }, required: ["to"] },
  },
  {
    name: "query_history",
    description:
      "Find agents and edit/claim/conflict events for a file or directory prefix in this repo. Use before unfamiliar shared work. days defaults to 14.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, days: { type: "number" } }, required: ["path"] },
  },
  {
    name: "list_tasks",
    description:
      "This repo's complete board: owners, owner liveness, open/claimed/done/blocked status and dependency readiness. Check before picking work.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "claim_task",
    description:
      "Claim existing task_id or create+claim a deduplicated title. Refuses a live owner. depends_on sets prerequisites; higher priority goes first. Returns completed dependency summaries in handoff.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        task_id: { type: "string" },
        detail: { type: "string" },
        depends_on: { type: "array", items: { type: "string" } },
        priority: { type: "number" },
      },
    },
  },
  {
    name: "claim_next_task",
    description:
      "Atomically claim the highest-priority ready task in this repo, with completed dependency summaries in handoff. Ready means dependencies done and no live owner. Empty board returns granted:false.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "update_task",
    description:
      "Update task_id. status:'open' releases it; 'done' should include summary (what changed, where, gotchas) for downstream agents. detail replaces its description.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        status: { type: "string", enum: ["open", "claimed", "done", "blocked"] },
        detail: { type: "string" },
        summary: { type: "string" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "record_decision",
    description:
      "Pin a project choice for current and future peers; broadcast and show it in session briefs. Check list_decisions first. Reusing topic supersedes its previous decision.",
    inputSchema: { type: "object", properties: { topic: { type: "string" }, decision: { type: "string" } }, required: ["topic", "decision"] },
  },
  {
    name: "list_decisions",
    description: "Latest standing decisions per topic in this repo. Consult before choosing architecture or conventions.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "search",
    description:
      "Full-text search this repo's messages, decisions, tasks and issues, with ranked highlighted snippets. Check whether work was discussed or built before starting. Use kinds to filter and limit to bound results.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        kinds: { type: "array", items: { type: "string", enum: ["message", "decision", "task", "issue"] } },
        limit: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "report_issue",
    description:
      "Log a bug, friction, build failure or coordination problem for later review. title is required; body should carry repro, error and attempted fixes. Auto-tags repo/agent/branch/time. Durable across projects. Use post_message for live coordination and update_task for handoffs.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
        kind: { type: "string" },
        area: { type: "string" },
        tags: { type: "string" },
      },
      required: ["title"],
    },
  },
  {
    name: "list_issues",
    description:
      "Read this repo's issues, including bodies and resolutions. Defaults to open; filter status/severity and bound with limit. Cross-project survey: cli/issues.mjs.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", "resolved", "wontfix", "all"] },
        severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "resolve_issue",
    description:
      "Close issue_id after fixing it. Include resolution: how it was fixed and relevant caveats. status defaults to resolved; wontfix also supported. Reopen through the CLI.",
    inputSchema: {
      type: "object",
      properties: {
        issue_id: { type: "string" },
        resolution: { type: "string" },
        status: { type: "string", enum: ["resolved", "wontfix"] },
      },
      required: ["issue_id"],
    },
  },
];

// Adapter metadata, injected by Codex hooks rather than authored by the model.
for (const def of TOOL_DEFS) {
  def.inputSchema.properties._coord = {
    type: "object",
    description: "Reserved for the native Codex hook; omit in model-authored calls.",
    properties: {
      session_id: { type: "string" }, cwd: { type: "string" },
      agent_id: { type: "string" }, agent_type: { type: "string" },
    },
    required: ["session_id", "cwd"],
  };
}
