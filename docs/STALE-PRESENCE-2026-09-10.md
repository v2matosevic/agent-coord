# Closed terminal presence repair

Owner request: closed terminals and agents remain visible as active, causing
other agents to wait for workers that have exited. Issue: `i-ed8bdebd`.

## Changed behavior

- Record a resolved native client PID in the additive `agents.owner_pid` column.
  Never reinterpret the old `pid` column: hooks stored transient wrapper PIDs
  there. Claude's explicit PID and native Claude/Codex process ancestry supply
  ownership; an unknown owner retains the existing activity timeout.
- On store access, fleet/conflict reads and MCP requests, a definitively absent
  owner marks its agent dead. Updated MCP servers also check every five seconds.
  File/resource claims and task ownership then stop treating it as a live peer.
- Keep an explicitly cold heartbeat marker when a session ends. AD's existing
  heartbeat reader can use that marker even if its snapshot predates the exit.
  Previously deleting the marker made AD fall back to the older live heartbeat.
- Background keepalive updates only an active row. It cannot undo SessionEnd.
  A real resumed event can register again and replace or clear the old owner.
- Fleet snapshots omit file leases, resource leases and queue entries owned by
  inactive agents. This applies before optional result caps.
- Explicit Codex SessionEnd and standalone MCP cleanup refresh the snapshot
  immediately. No heartbeat timeout was shortened and no processes are killed
  by production cleanup.

## Verification

Windows, Node 22.22.0. Final `npm test`: **52/52 passed**. `git diff --check`
passed. A live-store fleet read returned nine agents in 1.23 ms; this is one
observation, not a performance benchmark or an end-to-end time-savings claim.

`test/process-liveness.mjs` kills only its own disposable child and checks that
a still-fresh lease stops blocking on the next conflict read. It also checks
resource handoff, live/unknown owners, capped/uncapped fleet output, frozen AD
snapshot plus cold marker, keepalive refusal, and resume with changed/unknown PID.

`test/mcp-lifecycle.mjs` leaves a real stdio transport connected across SessionEnd
and the background timer, then proves that only a subsequent actual request
revives the session. Closing one shared env transport does not end its session.

`test/mcp-owner-exit.mjs` runs a disposable native-named client through the real
ancestry resolver and stdio MCP server. It verifies the stored owner PID and
immediate absence after abrupt client termination without a lifecycle hook.

`node cli/doctor.mjs`: 10/10 configuration checks passed. This does not establish
Codex hook trust or prove that every currently open MCP server has reloaded.

## Delivery and limits

Local version: 1.9.1. Configured Claude and Codex hooks point directly into this
checkout, so subsequent hook executions read the changed code. MCP servers load
modules at startup: open fresh agent sessions to load the complete repair and
new process ownership. No global install, hook trust change, publication or
interruption of open agent terminals was performed.

AD source was inspected at
`Athena/app_tracker/apps/ade/src-tauri/crates/ade-core/src/coord.rs`:
`live_heartbeat_age` prefers marker mtime and `is_stale` applies its age gate.
The marker repair uses that existing contract; no AD binary was rebuilt and no
native UI close/reopen acceptance was claimed. Its display still follows its
normal polling cadence. If every coordination process is abruptly killed,
reconciliation occurs on the next coordination reader; without one the display
retains the original three-minute heartbeat fallback.

Process probes classify only `ESRCH` as death. Permission failures, unknown
owners and unrecognized launchers do not authorize a release. A live PID does
not exempt a session from activity expiry. PID reuse is not birth-time verified;
an immediately reused PID can delay detection, rather than release a live peer.
Native Windows execution was tested; macOS/Linux native acceptance was not run.
