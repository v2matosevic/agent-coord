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
    description: "Read messages other agents left for you in this workspace (plus global broadcasts). Marks them read. Each message carries `from_live` — false means that sender has since EXITED, so don't treat its message as live presence or plan a hand-off to it. Call when you start a task and periodically during long work.",
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
    description: "Reserve a shared singleton before using it. Use a machine-wide id for a real OS singleton (e.g. 'port:3000') so every repo contends; the shell guard auto-claims deploys/migrations per-repo, but pass a stable shared id here (e.g. 'deploy:prod-host') when several projects genuinely deploy to ONE host and must serialize.",
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
    name: "query_history",
    description:
      "Who recently touched a file (exact path) or directory (prefix) in THIS repo — the distinct agents plus edit/claim/conflict events. Use before diving into an unfamiliar or shared area to spot a peer who owns it or recent churn the lock wouldn't show. Optional `days` window (default 14).",
    inputSchema: { type: "object", properties: { path: { type: "string" }, days: { type: "number" } }, required: ["path"] },
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
      "Claim a unit of work so peers know it's yours — the structural way to avoid two agents building the same thing. Pass `title` to create+claim a new task (deduped against existing titles), or `task_id` to claim an existing one from list_tasks. Fails if a LIVE peer already owns it. Optional `depends_on` (task ids) records ordering; `priority` (higher = sooner) orders claim_next_task. Returns `handoff`: summaries from completed dependencies, so you start informed.",
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
      "Pull the next unit of work from this repo's board: atomically claims the highest-priority READY task (all deps done, not owned by a live peer). Call when you finish something and have capacity, or when told to 'pick up work'. Returns the task plus `handoff` — what upstream tasks built — so you can start immediately. Empty board → granted:false; do something else.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "update_task",
    description:
      "Update a task you're working: status one of open|claimed|done|blocked ('open' also releases it). When marking 'done', PASS `summary` — 1-3 sentences on what you built/changed, where, and any gotchas. It's delivered to whoever depends on or later claims downstream work; without it they start blind. `detail` updates the task description.",
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
      "Record a project-level decision (architecture, convention, library choice — e.g. topic 'auth', decision 'httpOnly JWT cookies, no localStorage') so parallel and future agents stay CONSISTENT. It's broadcast to live peers and shown in every new agent's session brief. Check list_decisions before deciding something that might already be decided; re-recording a topic supersedes it.",
    inputSchema: { type: "object", properties: { topic: { type: "string" }, decision: { type: "string" } }, required: ["topic", "decision"] },
  },
  {
    name: "list_decisions",
    description: "The standing decisions for this repo (latest per topic). Consult before making architectural or convention choices so you don't contradict a peer's recorded decision.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "search",
    description:
      "Full-text search this repo's coordination memory: peer messages, recorded decisions, and board tasks. Ask in plain words ('auth cookie decision', 'checkout bug', 'who handled the migration') — best matches first with «highlighted» snippets. Use it to answer 'has this been discussed/decided/built already?' before starting; chronological dumps (list_decisions, list_tasks) only show the latest.",
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
      "Log a problem you hit — anywhere, any repo — to the durable CROSS-PROJECT issue log, so the operator can review and fix it later with full context (instead of you fixing it now or it being lost). Use for real bugs, recurring friction, broken builds, confusing/broken APIs, or coordination failures you notice. NOT for live coordination (use post_message) and not for normal task handoff (use update_task). Only `title` is required; add `body` with what happened + repro + error text + what you tried, `severity` (low|medium|high|critical), `kind` (bug|friction|build|coordination|perf|docs|other), and `area` (the file/dir/component). It's auto-tagged with this project, agent, branch, and time.",
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
      "Read THIS repo's issue log — known problems logged against this project, so you can check before debugging something that may already be on file (maybe with a fix from last time). Filter by `status` (open|resolved|wontfix|all, default open) and `severity`. Each issue carries its full body, reporter, and (if resolved) how it was fixed. Scoped to this workspace by design; the cross-project survey is the operator's `cli/issues.mjs`, not an in-session tool.",
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
      "Close out an issue from the log once it's fixed (or won't be). Pass the `issue_id`, a `resolution` (1-3 sentences on HOW it was fixed — this is what the next session reads when the same thing recurs), and optional `status` (resolved|wontfix, default resolved). Reopen with status not supported here — use the CLI.",
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
