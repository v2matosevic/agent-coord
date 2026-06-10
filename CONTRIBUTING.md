# Contributing

Thanks for looking at agent-coord. It's a small, sharp tool — contributions are
welcome as long as they keep it that way.

## Ground rules

- **Zero dependencies is a feature.** The hooks, CLI, and store use only Node
  built-ins (`node:sqlite`, `node:fs`, …). The MCP server carries the single
  allowed dependency (`@modelcontextprotocol/sdk`). PRs that add a dependency
  need a very good reason; PRs that add a *native* dependency will be declined.
- **Fail open, but loud.** A bug in coordination must never freeze someone's
  work. Guards and hooks catch their own errors, warn, and let the operation
  proceed. Keep that property in anything you touch.
- **Cross-platform.** Everything runs on Windows, macOS, and Linux. Platform
  branches use `process.platform`; paths go through `lib/path-canon.mjs`. CI
  runs the suite on all three.
- **Node ≥ 22** (for `node:sqlite`). No build step, no transpilation — plain
  ESM `.mjs` everywhere.

## Getting set up

```bash
git clone https://github.com/v2matosevic/Version2-Agent-Coordination.git
cd Version2-Agent-Coordination
npm ci          # only the MCP SDK
npm test        # full suite, isolated store — expect all green
```

You do **not** need to install agent-coord (hooks, MCP, git net) to hack on it.
Every test runs against a throwaway store via `AGENT_COORD_HOME`, so the suite
never touches a live installation. To try your changes live, run `node setup.mjs`
— it's idempotent, and `node cli/doctor.mjs` verifies the result.

## Tests

- `npm test` runs every `test/*.mjs` (underscore-prefixed files are child-process
  helpers, not standalone tests). Filter: `node test/run-all.mjs messages tasks`.
- New behavior needs a test. The existing tests are plain scripts that exit
  non-zero on failure — no framework, follow the pattern of a neighboring test.
- Tests must pass with an isolated `AGENT_COORD_HOME` and must not fire real
  notifications (`AGENT_COORD_NOTIFY=0` is set by the runner).

## Code style

Match what's there: plain modern ESM, small modules in `lib/`, CLIs in `cli/`
that stay readable as standalone scripts. Comments explain *why* (constraints,
invariants), not *what*. No TypeScript, no linter config to fight — just keep
diffs tight and consistent with the file you're editing.

## PRs

- One concern per PR. Small is reviewable; reviewable gets merged.
- Describe the failure mode you're fixing or the scenario the feature serves —
  this project is driven by real multi-agent collisions, and the best PRs cite
  one.
- Commit messages: what changed and why, imperative mood, no fluff
  (see `git log` for the house style).
- Architecture-level changes: open an issue first. `DESIGN.md` documents the
  invariants (single identity per session, warm/cold leases, advisory-by-default)
  — a PR that breaks one needs the discussion to happen before the code.

## Where to start

- [`docs/SYSTEM.md`](./docs/SYSTEM.md) — as-built reference, the fastest way to
  load the whole picture.
- [`docs/FUTURE.md`](./docs/FUTURE.md) — roadmap items, several are good first
  contributions.
- Issues tagged `good first issue`.
