# Session handoff, 2026-09-05

This is the continuation record for the Codex coordination improvements and
open source release preparation performed on September 4 and 5. It records
verified results separately from unverified behavior and proposed work.

## Start here

Read the applicable AGENTS.md, global working rules and shared/project memory.
Check the current checkout, fleet, messages and issue log before editing. This
record is a historical checkpoint; current code and new evidence take priority.

The first next-session priority is the identity mismatch discovered during
wrap-up, followed by actual trusted Codex host validation. Do not treat green
fixtures as proof that the current host connection uses the intended identity.
After those checks, improve contention measurement and explicit file handoffs.

## Delivered and pushed

Repository: https://github.com/v2matosevic/agent-coord, public, MIT licensed.

- `6325f88`: native Codex coordination and reliable session tracking.
- `ea5de72`: coordination boundary fixes, dependency updates and release preparation.
- `829aed4`: verify SQLite full-text search before setup and correct Node requirements.

The annotated `v1.9.0` tag points to
`829aed4fc326767f1930a27903582a634541395e`. This handoff may be committed later on
main. Do not move the version tag or silently replace its source assets.

The [v1.9.0 GitHub release](https://github.com/v2matosevic/agent-coord/releases/tag/untagged-b767c44b5b8354b88215)
is a **draft**, not published. It contains source ZIP, tar.gz, SHA256SUMS, release
notes and exact validation references. Both archives contain the same 154 files
from the tagged commit. Downloaded assets were compared with the originals.

```text
881a8ace532555a707cf62ec6edcbfefdc41a3b8bd9fdb990d1c6c2b8a85ce37  agent-coord-1.9.0.zip
c3025961bccbd9c2a54eab983085d4f9d68b4241dd1ea384b64d9bd61612b6c9  agent-coord-1.9.0.tar.gz
```

### Implemented behavior

- Native Codex lifecycle hooks provide check-in, recognized pre-write guards
  and between-tool message delivery after the operator trusts the definitions.
  Installation preserves other hook handlers and writes backups.
- Request-local `_coord` metadata carries session/workspace context into MCP.
  `CODEX_THREAD_ID` is recognized when supplied. Merely opening an unused MCP
  connection does not create a fleet agent. Native claims survive MCP reconnects.
- MCP-only keepalive does not renew file edit warmth. Workspace, branch and tool
  changes refresh presence even during the heartbeat throttle window. Leaving
  a git checkout clears its previous branch.
- Patch add/update/delete/rename paths are claimed atomically. Shell file and
  resource claims roll back together when any part of an operation is blocked.
  Explicit shell work directories and new files through directory aliases use
  the correct workspace and path keys.
- Git guards prefer the current session over a foreign repository marker and
  inspect NUL-delimited staged paths including both rename endpoints. Push
  review uses the latest recorded attribution in explicit sequence order.
- Repeated global-hook installation preserves the saved rollback destination.
  Codex MCP setup updates an existing entry directly instead of removing it first.
- Setup probes SQLite FTS5 before changing configuration. Doctor checks FTS5 and
  actually imports the SDK, so an empty dependency directory is not healthy.
- Compatible transitive dependency updates cleared the release-time audit.
- File availability notices require reclaiming and re-reading current contents;
  they no longer imply that the notification reserves a file.
- CI covers the minimum supported runtime and installs/smoke-tests source archives.

### Documentation delivered

- [Codex activation, behavior and smoke check](CODEX.md).
- [Agent protocol](AGENT-PROTOCOL.md).
- [Concurrent editing and proposed improvements](CONCURRENT-EDITING.md).
- [Versioned release notes](releases/v1.9.0.md).
- [Release procedure and rollback](RELEASING.md).
- Updated README, AGENTS.md, CONTRIBUTING.md, SECURITY.md, CHANGELOG.md,
  SYSTEM.md and bug-report environment guidance.

## Verification checkpoint

- Windows: all 43 test suites passed on Node 22.22.0 and on exact minimum 22.16.0.
- [CI on the tagged commit](https://github.com/v2matosevic/agent-coord/actions/runs/33924160646):
  six successful jobs, Windows/macOS/Linux on Node 22.16.0 and 24.
- Final ZIP extracted into a temporary directory, installed with `npm ci`, and
  passed both Codex-hook and real stdio MCP smoke suites. CI also exercised an
  extracted source archive without checkout metadata.
- Final setup completed and doctor reported 10/10. Claude hooks/statusline,
  global git hooks, Codex hooks and both client MCP registrations were configured.
- `npm audit` reported zero vulnerabilities at verification time, not a promise
  about advisories discovered later.
- A checksum-verified Node 22.13 executable was rejected by setup without changing
  the checked global configuration files.

Node 22.13 imports SQLite but lacks FTS5. The first minimum-runtime CI run exposed
this. Supported versions are Node 22.16+ on the 22.x line, or Node 24+. Do not
weaken the full-text search tests to restore the old minimum.

Confidence is high in the recorded automated results. The tests use native event
fixtures and real MCP/git processes, but they do not prove actual trusted-host
dispatch or correct identity for every installed connection.

## First priority: investigate live identity before publishing

During wrap-up, the connection reported:

```text
MCP whoami: whale / mcp-agent / standalone / coordinationMode=mcp
MCP workspace: this agent-coord checkout
Local Codex shell agentIdFromEnv(): moose
CODEX_THREAD_ID present; CLAUDE_CODE_SESSION_ID absent
```

The mailbox returned directed messages to `whale` about tasks in other workspaces
that this session was not doing. Those instructions were not acted on. Directed
messages intentionally cross workspace boundaries, so this observation alone
does not establish a routing bug. It does require investigation of launch
environment/configuration, missing native request context, shared transports,
alias reuse and mailbox lifecycle. Root cause is unknown.

The mismatch also reproduced at commit time: this connection claimed only the
handoff document through MCP, then its Codex shell commit was blocked because
the document was held by `whale`. The holder's displayed task had meanwhile
changed to an unrelated live task. This strengthens the need to investigate
identity sharing, rather than dismissing the mailbox result as old messages.
Only this connection's specific handoff-document claim was released before
retrying; no peer-wide release or guard bypass was used.

Durable local issue: `i-6daec436`. Read its evidence with
`node cli/issues.mjs i-6daec436`. The report records message sequence references,
not copied transcripts. Keep unrelated project conversations out of public docs.

Do not bypass a self-conflict merely because display names match. Verify opaque
session identity, reproduce with isolated stores and preserve claims belonging
to live peers. Avoid blanket claim release under a suspect identity; release
only the specific files this session actually claimed in its verified workspace.

## Second priority: actual native Codex smoke check

Follow [the complete procedure](CODEX.md#native-session-smoke-check) using two
fresh Codex sessions in a disposable git repository. The operator reviews/trusts
the installed definitions through `/hooks`. Never edit the trust store or bypass
review. CLI 0.153.3 reporting stable/enabled hooks is not evidence of delivery.

Acceptance criteria:

1. Each session has a distinct identity; hook, shell and MCP mappings agree.
2. MCP reports `coordinationMode: native-hooks` under the actual host dispatcher.
3. A peer-held file blocks a patch before bytes change and names the correct holder.
4. A directed message reaches the intended session on a subsequent local tool call.
5. Releasing the claim lets the waiting agent reclaim, re-read and patch the file.
6. Reconnect and session-end behavior preserve or release only the appropriate
   session's claims. Record what was actually exercised and what remains untested.

If the host does not expose the required UI or sessions to the agent, give the
operator the minimal concrete trust/test step and continue independent work.
Do not replace this check with another JSON fixture and label it live validation.

## Third priority: faster coordination, with measured evidence

The present file warmth window is five minutes; missing heartbeat stops blocking
after three minutes. Explicit release can free a finished file earlier. Waiting
notifications are advisory and are delivered at later context events, not by a
continuous push channel or FIFO reservation.

Recommended implementation order, each as a bounded change with regression tests:

1. Add per-file contention counts and wait duration. Distinguish retry attempts
   from unique wait episodes and active editing from idle reservations. Include
   release, expiry, abandoned waiters and bounded retention. Measure before claiming
   faster throughput. Keep schema changes additive and writes off unnecessary hot paths.
2. Add deduplicated notices to the current holder that another live agent is
   waiting. Name a safe handoff point. Test repeated retries, stale waiters and
   no notification spam. Never auto-unlock a file during an active command.
3. Add atomic handoff to a named live waiter, with bounded acceptance and recovery
   for crashes, expiration, competing claims and multi-file operations. A simple
   release followed by a claim is not an atomic handoff.
4. Consider base-content-hash patch submission later. Validate the base under the
   write claim, reject/rebase stale patches, and test the combined result. Merely
   storing a hash provides no stale-write protection.

For substantial independent same-file changes today, use separate worktrees and
one integration owner. Shared dependencies, environment files, databases and
ports still need coordination. Do not shorten timeouts blindly, treat shared
claims as permission for concurrent writes, or introduce line locks as a shortcut.

The metrics, holder notices, atomic handoff and patch-submission mechanism above
are proposals, not features shipped in v1.9.0.

## Other field reports to triage

The local cross-project survey surfaced these open reports. Their presence does
not prove that every report is a current agent-coord defect. Reproduce and scope
them before editing another repository or marking anything resolved.

- `i-5cacb8b6`: hook/MCP identity disagreement causing apparent self-blocking.
  Review alongside the new wrap-up identity observation.
- `i-89040117`: broad directory checkout discarded a peer's uncommitted work.
  Check recognized shell-write guard coverage and safe worktree-based workflows.
- `i-ab5d727a`: external integration hooks accumulated git staging processes and
  index locks under machine pressure. Do not kill unknown peers or remove their locks.
- `i-cf3e4c71`: unrelated application's flaky tests were included by the broad
  coordination-term survey. Confirm relevance rather than importing that scope.

Use `node cli/issues.mjs <id>` for local details. `--here` alone misses reports
filed from other repositories. Keep unrelated project bodies out of this public repo.

## Working tree, machine state and release boundaries

- The pre-handoff tracked working tree was clean. `.social-post/` is existing
  untracked work, left untouched and excluded from commits and release assets.
- `.release/` and `*.log` are ignored local artifacts. They hold archives,
  checksums, test/audit/setup logs and paths to temporary validation directories.
  Do not stage them. Some disposable dependency/runtime/archive folders remain
  under the system temporary directory; inspect paths before any cleanup.
- Package extraction was unusually slow in the workspace. A clean dependency
  install in a temporary local directory succeeded quickly and its dependencies
  were copied back. The cause of the wider machine slowdown was not established.
  Do not attribute unrelated process stalls to a proven coordination bug.
- A Windows Codex configuration write briefly failed during remove-then-add.
  Registration was restored, the remove step was eliminated, and setup then
  completed successfully. Do not repeat removal as the routine update strategy.
- The old global hooks-path backup already pointed to agent-coord itself. The
  original pre-install value is unknown; preserve that uncertainty.
- No hook-trust metadata was changed. Existing sessions may still hold old MCP
  processes. Restarting the client session is separate from updating source files.
- Keep v1.9.0 a draft while the identity observation and native-host check are
  unresolved. Publishing was not performed or newly authorized by the wrap-up.
  If later fixes change released behavior, make a new tested revision and version
  as appropriate; do not move an existing public tag.

## Next-session completion evidence

Record the identity investigation result, host validation evidence, the bounded
contention improvement implemented, relevant regression checks and any remaining
limits. For code changes run the appropriate isolated tests, full suite when
warranted, doctor after configuration changes, and CI on the exact pushed commit.
Use `pending_push_review` before pushing others' commits. Preserve unrelated work,
update this handoff and project memory, and release only owned claims at the end.

Project memory pointer on the development machine:
`~/.claude/projects/B--Coding-agent-coord/memory/project_codex-native-2026-09.md`.
Global memory remains `~/.claude/memory`; do not replace it with a separate vault.
