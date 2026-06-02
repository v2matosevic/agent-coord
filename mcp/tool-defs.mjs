// MCP tool catalog. Plain JSON Schema (no zod in our code). The server process
// is itself one agent, so tools don't take an agent_id — it knows who it is.

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
      "Broadcast what you're about to work on so peers can see it. Call before starting a task. Returns `overlaps` + a `warning` if a live peer in this repo is already doing similar work — if you're the later starter, narrow your lane or hand off instead of duplicating.",
    inputSchema: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
  },
  {
    name: "list_active_agents",
    description: "List live agents with the file each holds. Default: the whole fleet (all repos/windows). Pass scope:'workspace' for just this repo's agents.",
    inputSchema: { type: "object", properties: { scope: { type: "string", enum: ["global", "workspace"] } } },
  },
  {
    name: "post_message",
    description: "Leave a message for other agents to coordinate (e.g. 'refactoring auth, leave lib/auth alone'; 'API ready, wire the UI'). Default scope is THIS workspace (same repo). Pass scope:'global' for the whole fleet, or to:<agent_id> to direct it.",
    inputSchema: { type: "object", properties: { body: { type: "string" }, to: { type: "string" }, scope: { type: "string", enum: ["workspace", "global"] } }, required: ["body"] },
  },
  {
    name: "read_messages",
    description: "Read messages other agents left for you in this workspace (plus global broadcasts). Marks them read. Call when you start a task and periodically during long work.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_global_state",
    description: "Full snapshot: agents, file leases, resource leases, queue, recent activity.",
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
    description: "Reserve a machine-wide singleton before using it (e.g. 'port:3000', 'db:dev', 'deploy:primary').",
    inputSchema: { type: "object", properties: { resource_id: { type: "string" }, reason: { type: "string" } }, required: ["resource_id"] },
  },
  {
    name: "release_resource",
    description: "Release a machine-wide resource lease.",
    inputSchema: { type: "object", properties: { resource_id: { type: "string" } }, required: ["resource_id"] },
  },
  {
    name: "log_activity",
    description: "Append a note to the shared activity feed other agents can see.",
    inputSchema: { type: "object", properties: { event: { type: "string" }, detail: { type: "string" } }, required: ["event"] },
  },
  {
    name: "pending_push_review",
    description: "BEFORE pushing, review unpushed commits you may not have made: who authored each, whether that agent is still live, and what's safe vs. needs a peer or the human. Use this INSTEAD of asking the human 'should I push these other commits?'.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ask_agent",
    description: "Ask a specific live agent a question; returns an ask_id to collect the reply with check_replies. Only works if that agent is currently in list_active_agents (a finished agent can't answer). e.g. ask a commit's author if it's prod-ready.",
    inputSchema: { type: "object", properties: { to: { type: "string" }, question: { type: "string" } }, required: ["to", "question"] },
  },
  {
    name: "check_replies",
    description: "Non-blocking: collect replies to an ask_id. If empty and the peer isn't live, stop waiting and fall back (decide from recorded state or tell the human).",
    inputSchema: { type: "object", properties: { ask_id: { type: "string" } }, required: ["ask_id"] },
  },
  {
    name: "reply",
    description: "Answer another agent's ask. Pass the ask_id and the asker's agent_id (the from_agent on the question you received).",
    inputSchema: { type: "object", properties: { ask_id: { type: "string" }, to: { type: "string" }, answer: { type: "string" } }, required: ["ask_id", "to", "answer"] },
  },
  {
    name: "request_yield",
    description:
      "Ask a specific peer to STAND DOWN because you're already doing that work (the clean alternative to force-releasing their locks or having the human kill them). They hear it mid-turn; if they agree they release their files and stop. Use when you and a peer are provably duplicating and you started first / have the verified version.",
    inputSchema: { type: "object", properties: { to: { type: "string" }, reason: { type: "string" } }, required: ["to"] },
  },
  {
    name: "list_tasks",
    description:
      "Show the shared task board for THIS repo: every task, who owns it (and if they're still live), status (open/claimed/done/blocked), and dependency readiness. Check this before picking work so you don't duplicate a peer.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "claim_task",
    description:
      "Claim a unit of work so peers know it's yours — the structural way to avoid two agents building the same thing. Pass `title` to create+claim a new task (deduped against existing titles), or `task_id` to claim an existing one from list_tasks. Fails if a LIVE peer already owns it. Optional `depends_on` (task ids) records ordering.",
    inputSchema: { type: "object", properties: { title: { type: "string" }, task_id: { type: "string" }, detail: { type: "string" }, depends_on: { type: "array", items: { type: "string" } } } },
  },
  {
    name: "update_task",
    description: "Update a task you're working: status one of open|claimed|done|blocked ('open' also releases it), and/or set detail. Mark it 'done' so dependent tasks unblock.",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, status: { type: "string", enum: ["open", "claimed", "done", "blocked"] }, detail: { type: "string" } }, required: ["task_id"] },
  },
];
