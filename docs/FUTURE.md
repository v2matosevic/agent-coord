# FUTURE — where agent-coord can go next

Status: Tier 0–2 + the macOS expansion (menu bar, notifications, shell-write guard,
self-learning digest/hotspots/`query_history`) are shipped and proven on Windows and
macOS. This is the roadmap beyond that, grounded in the **honest limits** in
[`DESIGN.md` §9](../DESIGN.md) / [`SYSTEM.md` §9](./SYSTEM.md) and what already exists
— not a wishlist of duplicates.

Each item is tagged with rough **effort** (S/M/L) and **value** for Marko's actual
setup (solo operator, many concurrent Claude/Codex sessions, web-dev studio, macOS).

## Recommended next 3

1. **SessionStart-throttled digest auto-run** (S) — the one remaining §12 item. Run
   `cli/digest.mjs` automatically (throttled, e.g. once/day) so the per-project
   hotspot record stays fresh with zero ceremony. Pure win, builds on shipped code.
2. **Dashboard "Insights" tab** (M) — surface `lib/insights.mjs` (hotspots + a
   conflict timeline + the digests) in the existing browser dashboard, and a
   "what it saved you" counter (conflicts prevented, dup-work blocked, cold
   takeovers). Turns the data we already log into a visible payoff.
3. **Live two-agent shakedown on macOS** (S–M) — the standing open item. A
   reproducible scripted scenario (two `claude -p` agents colliding on one file +
   one duplicating a task) to tune `DEAD_MS`/TTLs from real behaviour, now that the
   Mac is the primary box.

## Coordination depth

- **Per-line / hunk granularity** (L) — whole-file locks needlessly serialize two
  agents editing *different* functions in one big file. Map edits to symbol ranges
  (tree-sitter) and only block on overlapping ranges. The biggest correctness
  upgrade, also the hardest; revisit only if false-serialization actually bites.
- **Shared-lease serial queue** (M) — for files that tolerate serialized edits,
  queue-and-notify instead of block. `shared` mode + `lease_queue` already exist;
  this wires them into a "you're next" flow.
- **Pre-write enforcement for non-Claude agents** (L) — today only Claude gets a
  hard pre-write block; Codex/Cursor/Aider get awareness + the commit net. Explore
  an LSP/file-watcher guard or thin editor plugins so a warm conflict blocks them
  *before* the write, not just at commit.

## Reach & surfaces

- **Linux/Windows notifications** (S) — generalize `lib/notify.mjs` beyond macOS
  (`notify-send` on Linux, PowerShell toast on Windows). The seam is already there.
- **Menu-bar clickable actions** (M) — release a lease, message a peer, open the
  repo, or start the dashboard detached, straight from the SwiftBar dropdown; an
  agent-history submenu.
- **Remote/phone ping** (S) — when you're blocked >N min or a `request_yield`
  arrives while you're away, push to ntfy.sh/Pushover so you don't need the Mac
  in front of you. Extends the notify layer.

## Intelligence / self-learning

- **Conflict *prediction* at `announce_intent`** (M) — combine `overlap.mjs` task
  similarity with file-hotspot history to warn "your task will likely touch
  `src/auth/*`, which a live peer holds" *before* the first edit.
- **Provenance-aware `query_history`** (S) — fold the post-commit provenance log in,
  so history shows who *committed* changes to a file, not just who touched it live.
- **ROI metrics in the digest** (S) — count conflicts prevented, dup-work blocked,
  cold takeovers per week; a one-line "what coordination saved you" in each digest.

## Resource model

- **Auto-detect more singletons for the stack** (M) — OrbStack/Docker containers,
  DB URLs from `.env`, dev ports from `package.json` scripts, Hostinger/Hetzner
  deploy targets — so the resource guard covers Marko's real collision points, not
  just the built-in `port:`/`db:`/`deploy:` rules.

## Robustness / ops

- **MCP identity reconciliation on resume** (M) — the MCP server resolves its
  identity ONCE at startup (`pollSessionLink`, 4s) and never reconciles. If it loses
  the SessionStart race or the session resumes, it falls back to a standalone id and
  shows up as a "ghost twin" of the same session — the split the session-link was
  built to prevent, recurring at resume. `pending_push_review` now bridges past it
  (treats the session-linked hook id for our parent pid as ours, so it doesn't flag
  a self-commit as a live peer's), but the twin still appears as a second agent in
  the fleet and splits any leases/messages it makes. Fix: re-poll + late-adopt the
  link on the first tool calls, before the standalone id has created state.
- **PID-reuse liveness guard** (M, deferred) — revisit using `proc_start_time` so a
  reused PID can't free a live lease (see §9).
- **`doctor --deep`** (S) — check hook latency, store/WAL size, throttle-file health;
  catch a degrading install before it bites.

## Distribution

- **Publish the VS Code extension** + a Zed/JetBrains equivalent (M).
- **`npx agent-coord` installer + Homebrew formula** (S–M) — one-command install for
  anyone, not just "clone + `node setup.mjs`."

---

_Anything here is opt-in; the core stays zero-dependency and fail-open. Add a rule /
surface only when a real collision or blind spot justifies it — the project's whole
ethos is "advisory by default, two hard chokepoints, never freeze real work."_
