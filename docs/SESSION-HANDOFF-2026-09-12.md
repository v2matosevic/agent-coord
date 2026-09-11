# Coordination and ADE session handoff

Work completed September 11–12, 2026. This is the consolidated entry point for
the research, implementation, verification and delivery records. The final
wrap-up changes documentation only; it does not rerun tests, publish another
application, install software, re-pair devices or start another agent task.

## Final delivery state

Agent-coord source **1.10.0** is pushed at `a969512`, including the earlier
efficiency and reliability repairs. The Windows hook integration loads the
installed checkout; already-running MCP processes load updates on normal restart.
Source publication is distinct from a new standalone tagged installer release.

**ADE 0.0.96 is published for Windows x64 and Apple Silicon Mac** from the same
immutable source `60fdf30856072dc694339b8a23c2c319f9d5b942`. It includes the Fleet
health reader, smaller coordination briefs, terminal receipts and Athena fixes.
All four updater entries and full authenticated downloads were verified. The
old prepared 0.0.94/0.0.95 packages are superseded and retained.

No installed ADE was replaced. The final recorded installations were Windows
0.0.92 and Mac 0.0.91. The owner can update through Settings > About > Check for
updates. This handoff grants no new installation, token or provider-trust authority.

[Published ADE release](https://github.com/v2matosevic/athena-tracker/releases/tag/ade-v0.0.96).
[Exact ADE release record](https://github.com/v2matosevic/athena-tracker/blob/a7cb934/apps/ade/docs/RELEASE-0.0.96.md).

## Completed work and measured results

| Area                  | Final behavior and evidence                                                                                                                                                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Research and baseline | Nine primary sources, local code audit and repeatable isolated benchmarks support retaining SQLite/MCP and optimizing repeated context and unnecessary work. [Research and plan](OPTIMIZATION-2026-09-11.md).                                                                                                             |
| Coordination context  | Preserve all 28 tools and schemas. Reference catalog tokens decreased from 4,964 to 3,955; repeated-guidance projection from 12,711 to 6,923. These are tokenizer measurements, not billed-token totals.                                                                                                                  |
| Codex waits           | Metadata and irrelevant pre-tool events skip runtime/SQLite imports. Other events share a 1,500 ms wait budget, or 1,000 ms at SessionEnd, across retries and optional discovery. An expired ownership check refuses the write; advisory events report degradation. OS/filesystem/host stalls remain outside this budget. |
| Database work         | Warm schema readiness avoids unnecessary writers; fleet reads use one indexed query. Ownership decisions are not cached.                                                                                                                                                                                                  |
| Refusal integrity     | Eight fault-injection cases prove optional logging cannot reverse an already-known denial. Optional bookkeeping shares a maximum 50 ms wait allowance.                                                                                                                                                                    |
| Shell claims          | Claude resource/file reservations are atomic. Failure leaves no newly acquired partial reservations and preserves earlier legitimate holdings.                                                                                                                                                                            |
| History lookup        | The populated 140,000-row fixture returned identical seven hotspots; median lookup decreased from 11.003 ms to 1.793 ms with an additive partial index. [Reliability record](SYSTEM-RELIABILITY-2026-09-11.md).                                                                                                           |
| Runtime health        | Small private bounded journal records duration, completion/error category and observed version. Prompts, command text, credentials and message bodies are excluded. The reader distinguishes stale, missing, interrupted and limited evidence. [Contract and limits](RUNTIME-HEALTH.md).                                  |
| Collector overhead    | Alternating off/on measurements added about 1–3 ms at the median for the tested hook paths; model-facing output stayed byte-identical. This establishes fixture overhead, not general coding-task speed.                                                                                                                  |
| ADE efficiency        | Fleet reuses the existing poll; health reads run while its panel is mounted, have bounded work/deadlines and cannot accumulate concurrent native readers. Pending-mail reads never acknowledge messages.                                                                                                                  |
| Athena orchestration  | Fresh installed Windows tests proved Athena opening two Codex terminals and relaying an observed result; Codex then opened Claude, awaited its exact receipt and prompted the other Codex. No replacement prompt was sent after uncertain delivery.                                                                       |
| Workspace memory      | Separate native sessions, directories and bounded histories retain workspace identity through focus changes and recovery. Telegram/web MAIN remains the general conversation; forwarded work targets one captured local workspace.                                                                                        |
| Athena repairs        | Detect missing dispatch permission, wake registration after re-pairing including late old-token failures, and recognize Codex's observed animated placeholder while retaining setup/draft guards.                                                                                                                         |

Confidence is high for the recorded correctness and delivery checks, moderate
for local timing comparisons. No universal hook-timeout guarantee, billed-token
savings or end-to-end coding-task speedup was established.

## Verification provenance

These are retained passing results from implementation and release, not tests
repeated during the documentation wrap.

- Core `48880f6`: 57 isolated suites, 21 native dispatcher checks and doctor 10/10.
- Core `0564150`: 61 suites, 21 native checks and doctor 10/10.
- Core `a969512`: 64 suites, doctor 10/10, all six cross-platform CI jobs passed.
  [Final core CI](https://github.com/v2matosevic/agent-coord/actions/runs/34629752596).
- Athena integration `0e62063`: 2,338 frontend tests, 36 Hermes tests,
  21 PHP tests/128 assertions and 35 browser groups. The wire fixture uses real
  local Svelte/Laravel/MySQL; physical devices/native effects remain simulated.
- Exact ADE release `60fdf30`: both platforms passed 2,338 frontend tests with
  three existing skips; Windows passed 576 native tests/22 ignored and Mac
  566/19. Both passed required types, formatting, builds and strict native lint.
- Both packages survived ten-second launch checks. The extracted Windows
  executable passed all 11 terminal-channel contracts. Mac app, extracted
  archive and mounted DMG passed deep/strict Apple signature checks.
- Windows and Mac updater signatures, trusted comments and tamper rejection
  were verified. Independent authenticated streams matched the built/downloaded
  bytes. Final combined verification: September 11 at 23:15:01 UTC, September 12
  locally. All four manifest keys remained, including unchanged Windows entries.

The Mac verification helper's Python 3.9 extraction incompatibility was repaired
after its original runner exited. Safe native extraction replaced that private
helper step; successful source gates and packages were reused. No source recut
or verification bypass occurred. Athena's normal five-minute cache briefly
retained the Windows-only manifest, then refreshed without a service/cache change.

## What remains, with existing tracking

| Item                                                                  | Current boundary and next scoped action                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mac agent-coord companion, Athena-6uai                                | Mac reported standalone 1.7.0. Inspect its actual checkout/configuration before an authorized upgrade to 1.10. The ADE reader does not install the collector; missing observations remain visible. Preserve required hook trust.                                                                                                                            |
| Remote execution, Athena-0h5v / Athena-0tk7                           | Server and daemon are deployed, but the recorded ADE app tokens lack dispatch permission and no executors were registered. Complete legitimate device re-pairing, then verify a harmless Telegram/web request using the original receipt. Pairing rotates host and terminal credentials. Never patch token permissions directly or replay earlier commands. |
| Installed/native provider acceptance, Athena-osyi and related records | Published package delivery is complete. Broader native Mac GUI/provider workflows and the original three-Claude scenario remain distinct from the tested Windows chain.                                                                                                                                                                                     |
| Shutdown storage defect, i-8578246d                                   | One SessionEnd disk-I/O failure was captured; a later quiet native run passed. The health collector exposes the failure, it does not repair the root cause. Keep both failing and passing evidence.                                                                                                                                                         |
| Further measurements                                                  | Oversized MCP message batches and representative full-task cost/latency remain research priorities, not unfinished work silently added to this completed release. Preserve complete-message acknowledgment if implementing a future byte limit.                                                                                                             |

Athena-le9c (combined release), Athena-i1ny (runtime health) and Athena-73tv
(integration verification/source repairs) are closed. Do not reopen them merely
to re-audit passing work. No build, release publication or remote publisher remains
pending for 0.0.96. Old prepared installers and successful test results are history,
not instructions to rerun or install them.

## Resume map and preserved state

The private Athena repository retains the full release receipt, package hashes,
native task/repair/completion records and normalized logs at
`docs/ade/evidence/2026-09-12-ade-0.0.96.md` and `docs/ade/evidence/ade-0.0.96/`.
Published documentation commits are ADE `a7cb934` and Athena `315e5daf`/`a36ec3d7`.
The manifest preserves original and retained log hashes.

Project memory indexes in both agent-coord and ADE point to this final state.
The workspace's native Athena acknowledged the earlier scoped integration
handoff, and a final cockpit report records the published release. No unrelated
workspace chat history was copied into this handoff.

Existing peer Desktop edits, social-work files and untracked historical failure
images were preserved. Owned local browser/API/database test processes were
stopped; temporary data and release worktrees remain for reproducibility. Three
harmless terminal probes were left idle for inspection, not closed by this task.
No credentials, provider trust store or installed executable was changed by the
documentation wrap. The running Mac app wrote profile files during smoke, so
unchanged-profile-byte claims remain unsupported.
