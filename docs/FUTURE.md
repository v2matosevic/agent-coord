# FUTURE — where agent-coord can go next

Status: Tier 0–2, the macOS expansion (menu bar, notifications, shell-write guard,
self-learning digest/hotspots/`query_history`), the cooperation tier (freed-file
notify, task handoff, decisions, room brief), v1.2 (claimed single-word speakable
names) and v1.3 (FTS5 `search` over coordination memory, failure-path delivery)
are shipped and proven on Windows and macOS. This is the roadmap beyond that,
grounded in the **honest limits** in [`DESIGN.md` §9](../DESIGN.md) /
[`SYSTEM.md` §9](./SYSTEM.md) and what already exists — not a wishlist of
duplicates.

Each item is tagged with rough **effort** (S/M/L) and **value** for the original
setup it was built in (solo operator, many concurrent Claude/Codex sessions,
web-dev studio, macOS + Windows).

## Recommended next 3 (after v1.8.0)

1. **Hephaestus/ADE passes `--tool claude-code` and reads `whoami.identityBasis`**
   (S, other repo: `app_tracker/apps/ade/src/lib/ade/toolProfile.ts:158`). The env
   anchor already makes the flag unnecessary, but a profile that says what it is
   documents the contract, and a tile that shows `identityBasis: standalone` for a
   Claude session is the split made visible on the surface where it matters.
2. **One id per real resource** (M). The shell guard auto-claims `deploy:<workspace-id>`
   while agents hand-name `deploy:melora-prod`; the two never contend, so two holders
   can both be "right" (i-e1e00240's second half). Make `claim_resource` on a `deploy:*`
   id also take the workspace-keyed lease (or the guard check any live `deploy:*` lease
   whose reason names this repo), and have the guard's block message print BOTH ids.
3. **Attribution the reader can audit** (S). `pending_push_review` now says which repo
   it looked at and recognises own commits from the env session id; the next gap is
   the `manual` bucket — 1760 of ~1960 commits logged in the last 7 days on Olympus
   were `manual`, almost all `baseline` commits from other projects' test fixtures
   hitting the global hooksPath. Tag fixture/temp-dir repos as `fixture` (path under
   `$TMP`) so they never count as "a human typed this", and report `unknown-author`
   separately from `manual` (ADR-076: an empty answer carries its reason).

_Also shipped 2026-08-29 (v1.8.0): the env-anchored identity — one session is one
agent across hooks, MCP server, git hooks and CLI regardless of how the server was
spawned; name retention across `/clear`; nested-repo-safe push review; honest
`release_resource`; harness-preamble-proof overlap; snapshot refresh from every
session's heartbeat path. The previous next-3 moves down:_

4. **Live two-agent shakedown on macOS** (S–M) — the standing open item. A
   reproducible scripted scenario (two `claude -p` agents colliding on one file +
   one duplicating a task) to tune `DEAD_MS`/TTLs from real behaviour, now that the
   Mac is the primary box.
5. **Linux/Windows notifications** (S) — generalize `lib/notify.mjs` beyond macOS
   (`notify-send` on Linux, PowerShell toast on Windows). The seam is already there
   and the operator works daily on Windows.
6. **`npx agent-coord` installer + Homebrew formula** (S–M) — one-command install
   for anyone, not just "clone + `node setup.mjs`."

_Shipped from this list (v1.7.0): SessionStart-throttled digest auto-run; the
dashboard insights panel + "what it saved you" ROI counters (`coordinationROI`)._

## Coordination depth

- **Symbol-level leases** (L) — lock a function/class byte-range instead of the
  whole file (the `wit` project proves the idea with Tree-sitter). Surveyed
  2026-06: a real win for two agents in one big file, but Tree-sitter breaks the
  zero-dependency rule — only viable as an **optional plugin**, never core.
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
  deploy targets — so the resource guard covers the operator's real collision points, not
  just the built-in `port:`/`db:`/`deploy:` rules.

## Robustness / ops

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
