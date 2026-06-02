# Changelog

Notable changes to `agent-coord`. Dates are when the work landed; this is a
single-user tool with trunk-based history, so entries map to themes, not semver.

## Recent — coordination quality + portability

**Self-healing file locks (warm/cold).** A lease used to block for its full TTL as
long as the holder's *session* was alive — so a file edited once stayed locked for
the session and the only escape (force-release) bubbled up to the human. Now a
lease blocks only while **warm** (the holder edited that exact file within
`FILE_ACTIVE_MS`, default 5 min); past that it goes **cold** and a waiting agent
takes the file automatically, sweeping the stale lease. Same gate in conflict
checks and the pre-commit net. The block message states when it auto-frees and
steers to "edit elsewhere / message the peer," never "force-release / ask the
human." `+ test/cold-lease.mjs`.

**One identity per session (hook + MCP unified).** The stdio MCP server minted a
random identity, so every Claude session showed up as *two* agents — a hook-self
that held the locks and a random MCP-self that sent the messages. That doubled the
fleet, broke own-commit recognition in `pending_push_review`, and echoed an agent's
own broadcasts back to it. Bridged on the `claude.exe` both processes share
(`proc-ancestry.mjs` walks the tree, `session-link.mjs` publishes `pid → agentId`,
the MCP server adopts it). Fails safe to standalone, so Codex is unaffected.
`+ test/session-link.mjs`.

**Mid-turn message delivery.** Peer messages were injected only at
`UserPromptSubmit`, so an agent building a feature in one long turn never heard
them. Now also delivered between tool calls via `PostToolUse` `additionalContext`
(non-blocking; not a forced `allow`, so it can never bypass a permission prompt).

**Duplicate-work de-confliction.** Two agents on one vague prompt would build the
same thing. A cheap task-similarity heuristic (`overlap.mjs`, Jaccard over tokens
— not ML) flags overlap; `announce_intent` warns the later starter; the
deterministic tiebreaker is the earlier `registered_at`; the later starter is
advised mid-turn, then hard-blocked by its own guard if it keeps duplicating
(escape hatch: announce a distinct lane). New `request_yield` MCP tool asks a peer
to stand down instead of fighting locks. `+ test/overlap.mjs, test/overlap-flow.mjs`.

**Statusline self-identity.** The statusline showed only peers; it now leads with
*this* terminal's own id and its live subagents (`◆ <id> ⤷ sub-a, sub-b`), so a
glance maps each terminal to its agent.

**Portability.** Every script derives the repo root from its own location — install
from any clone path. Added cross-platform `node setup.mjs` (Windows/macOS/Linux)
alongside `setup.ps1`. `AGENTS.md` runbook lets a coding agent install it
autonomously.

## Earlier milestones

- **Auto-push when clear** — `pending_push_review` returns `allClear` when every
  unpushed commit is push-safe; agents push without asking. Deploy-keyword
  false-positive in the Bash guard fixed.
- **Commit provenance + autonomous pre-push decision** — a post-commit hook logs
  who authored each commit; agents map unpushed commits to author + live status +
  a verdict. Live ask/reply between concurrent agents.
- **Workspace-scoped agent-to-agent messaging** — a mailbox on top of presence
  (broadcast + directed, read-once, project-isolated).
- **`cli/insights.mjs`** — retro: files edited by 2+ distinct agents + conflicts.
- **VS Code "Agent Fleet" extension** — Activity Bar panel reading the live store.
- **Tier 2** — live browser dashboard; git-worktree isolation; subagent identity.
- **Tier 0–1 (global)** — SQLite WAL store, file/resource leases, Claude
  `PreToolUse` hard-block, **global** git pre-commit net across all repos, MCP
  server in Claude + Codex, reaper, `doctor`/`status`/`watch`, `setup.ps1`.

See `docs/SYSTEM.md` §9 for the design decisions behind these, and `DESIGN.md`
for the original architecture.
