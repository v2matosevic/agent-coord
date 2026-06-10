# Security

## Threat model — read this first

agent-coord is built for a **single-user development machine**. The SQLite store
at `~/.agent-coord/` has **no auth boundary**: every process running as your user
can read and write it. That is by design — the agents being coordinated already
have full shell access to your machine, so an in-store boundary would protect
nothing.

What that means in practice:

- **Don't** point `AGENT_COORD_HOME` at a shared/multi-user location.
- The store contains workspace paths, branch names, file paths, task titles, and
  agent messages — treat it like the rest of your dev environment, not like a
  secret store. Don't put credentials in task titles or messages.
- Coordination is advisory-by-default: the hard blocks (Claude `PreToolUse`,
  the git pre-commit/pre-push net) are guardrails against *accidents between
  cooperating agents*, not a sandbox against a malicious process.

## Hooks run code

`setup.mjs` wires hooks into Claude Code, your global git `core.hooksPath`, and
your MCP configs. Review what it does before running it — it's short, readable,
and prints every change it makes. Same standard applies to any PR touching
`setup.mjs`, `hooks/`, or `git/`.

## Reporting a vulnerability

If you find a way to break the guarantees above (e.g. a hook injection via
crafted file paths or messages, the pre-commit net being bypassable in a way the
docs don't already disclose, or anything that escalates beyond the single-user
model), please report it privately:

- **GitHub**: use [private vulnerability reporting](https://github.com/v2matosevic/Version2-Agent-Coordination/security/advisories/new)
  on this repository (preferred), or
- open a regular issue *only* if the report is not exploitable.

You'll get a response within a few days. There is no bounty — this is a solo
open-source project — but reports are credited in the changelog unless you ask
otherwise.
