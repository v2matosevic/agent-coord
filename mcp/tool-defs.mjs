// MCP tool catalog. Plain JSON Schema (no zod in our code). The server process
// supplies a default identity. Codex hooks attach request-local session metadata
// so threads sharing a transport never rename one another.

// Keep the first 512 characters useful when a host truncates server guidance.
export const INSTRUCTIONS = "Machine-wide coordination for agents sharing files and resources. Start with announce_intent: one call returns identity, peers, board, decisions and mail counts. Without trusted native hooks, claim_files before each edit and poll read_messages. Locks self-heal; never force-release a live peer or ask the human to unlock. Use post_directed_message for reliable handoff; post_message/reply for lightweight chat. Claim shared services and run pending_push_review before peer commits. Search prior work; record_decision pins choices; report_issue logs friction.";

const strArr = { type: "array", items: { type: "string" } };

export const TOOL_DEFS = [
  {
    name: "whoami",
    description: "Return this agent's coordination identity (id, tool, repo, branch).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "announce_intent",
    description: "Start here: identity, peers, board, decisions, mail counts and task overlaps. If a live peer started first, narrow your lane or hand off.",
    inputSchema: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
  },
  {
    name: "list_active_agents",
    description: "List live agents and each one's latest held file. Default: all repos. Use scope:'workspace' for this repo.",
    inputSchema: { type: "object", properties: { scope: { type: "string", enum: ["global", "workspace"] } } },
  },
  {
    name: "post_message",
    description: "Legacy message: workspace broadcast by default; to reaches one agent. Use post_directed_message when receipts matter.",
    inputSchema: { type: "object", properties: { body: { type: "string" }, to: { type: "string" }, scope: { type: "string", enum: ["workspace", "global"] } }, required: ["body"] },
  },
  {
    name: "post_directed_message",
    description: "Reliably queue one directed message. Caller must create and reuse the same UUID message_id after an uncertain response.",
    inputSchema: { type: "object", properties: { message_id: { type: "string" }, to: { type: "string" }, body: { type: "string" } }, required: ["message_id", "to", "body"] },
  },
  {
    name: "directed_message",
    description: "Receive, acknowledge, or inspect reliable mail. current is a read-only queue head; ack needs message_id, attempt_id and payload_sha256.",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["receive", "ack", "status", "current"] }, message_id: { type: "string" }, attempt_id: { type: "string" }, payload_sha256: { type: "string" }, limit: { type: "number" } }, required: ["action"] },
  },
  {
    name: "read_messages",
    description: "Read the legacy inbox; remaining is exact. from_live:false means the sender exited. Reliable directed mail uses directed_message.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_global_state",
    description: "Fleet snapshot: agents, leases, queue, tasks and recent activity. Capped lists say when clipped.",
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
    description: "Claim a shared singleton before use: machine-wide e.g. port:3000, or a shared workspace/deploy key.",
    inputSchema: { type: "object", properties: { resource_id: { type: "string" }, reason: { type: "string" } }, required: ["resource_id"] },
  },
  {
    name: "release_resource",
    description: "Release your resource lease. A peer's lease returns released:false + heldBy; never treat that as released.",
    inputSchema: { type: "object", properties: { resource_id: { type: "string" } }, required: ["resource_id"] },
  },
  {
    name: "log_activity",
    description: "Append a note to the shared activity feed other agents can see.",
    inputSchema: { type: "object", properties: { event: { type: "string" }, detail: { type: "string" } }, required: ["event"] },
  },
  {
    name: "pending_push_review",
    description: "Review unpushed peer commits, liveness and blockers. Pass repo for a nested checkout; inspect verdict before push.",
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
    description: "Ask a duplicate worker to stand down. If they agree, they release files and stop; never force-release peer locks.",
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
    description: "Claim task_id or create+claim a deduplicated title. Refuses a live owner; supports depends_on and priority.",
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
    description: "Atomically claim the highest-priority ready task, including completed dependency summaries. Empty board returns granted:false.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "update_task",
    description: "Update task_id. open releases it; done should include a downstream summary. detail replaces its description.",
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
    description: "Pin a project choice for peers and briefs. Check first; reusing topic supersedes its prior decision.",
    inputSchema: { type: "object", properties: { topic: { type: "string" }, decision: { type: "string" } }, required: ["topic", "decision"] },
  },
  {
    name: "list_decisions",
    description: "Latest standing decisions per topic in this repo. Consult before choosing architecture or conventions.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "search",
    description: "Ranked full-text search across this repo's messages, decisions, tasks and issues. Filter with kinds and limit.",
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
    description: "Log a durable cross-project bug or coordination problem for later review; include repro and attempted fixes.",
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
