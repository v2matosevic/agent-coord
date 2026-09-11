# Coordination reliability follow-up

The next improvement after reducing prompt and hook overhead is to make failure
behavior consistent across clients, then measure operations against realistic
history. This follow-up implements three concrete findings. It does not add an
always-running service, alter hook trust, or shrink the coordination catalog.

## Implemented

### Keep a known refusal authoritative

Claude's edit/shell hooks and Codex's store-backed hook wrote activity or queue
records before emitting their final denial. If that bookkeeping failed, the
outer error handler could let the operation proceed even though the hook had
already identified the conflicting owner.

SQL trigger fault injection reproduced all eight cases: activity logging for
Claude edits, Claude shell files/resources and Codex files/resources, plus queue
logging for the three file paths. They now retain the refusal and identify the
holder. Ordinary errors before a decision retain the documented behavior;
this correction prevents an optional diagnostic from reversing a known result.

Optional denial bookkeeping uses at most 50 ms of the existing transaction wait
budget. It cannot extend a shorter outer budget. The previous timeout and
deadline are restored after the scope, so an unsuccessful observation does not
poison a later operation. A held-writer test verifies prompt return and recovery.
Diagnostics remain best effort; a missing activity row is not proof that no
collision happened.

### Reserve a shell operation atomically

Claude's shell hook previously acquired resources and files one at a time. A
command rejected on its last file retained earlier reservations even though the
command never started. The reproduction left two file rows and a resource row
where only one earlier file claim should have remained; it also changed that
earlier claim's acquisition/expiry data.

The hook now uses the same atomic operation primitive as native Codex. All
recognized file/resource reservations commit together, or every new reservation
and renewal rolls back. Existing claims remain byte-for-byte unchanged after a
refusal. Commit-marker handling and the existing shell target parser are
preserved. MCP `claim_files` retains its documented per-file grant results.

### Remove the history scan on every file reservation

MCP `claim_files` computes a hotspot advisory before attempting a reservation.
Its edit-history query scanned the full activity table even for an empty result.
On the local store, 20 samples after three warmups measured 32.408 ms p50 and
40.724 ms p95 for this repository, returning zero hotspots.

An additive partial index on `(workspace_id, ts)` includes only edit rows with
a path. The same read-only measurement after ordinary schema initialization
returned the same zero hotspots in 0.142 ms p50 and 0.465 ms p95. SQLite's query
plan changed from a table scan to an indexed workspace/time range. This is an
empty-result local case, not an end-to-end agent speed claim.

The repeatable populated fixture has 140,000 history rows, 700 relevant edits
and seven hotspots. Fifty measured samples after three warmups took 11.003 ms
p50 / 12.037 ms p95 before the index, and 1.793 / 2.246 ms afterward. Results
were identical, including normalized paths and participating agents. Index
construction took 21.534 ms in that in-memory fixture. Only qualifying edit
inserts maintain the partial index, rather than every claim/status event.

Run `node scripts/benchmark-hotspots.mjs --out <report.json>` to reproduce the
synthetic comparison. Store compatibility version remains 2; no tables,
leases, messages or acknowledgement cursors are removed.

## Operational guidance and remaining priorities

Source version is now 1.9.2. A fresh `whoami.version` distinguishes the updated
MCP process from a pre-update process without adding another tool or repeatedly
hashing the code. This is an unreleased source version, not a claim that a new
tagged package has been published. Hook-loaded files update through the existing
installed checkout; already-running MCP imports need a normal restart.

The recommended next sequence is:

1. Add bounded runtime health evidence to the existing ADE status surface:
   recent hook duration, failures, loaded version and pending-mail count. Keep
   prompts, message bodies, credentials and command text out of telemetry. First
   measure its collection overhead and prove a stopped writer cannot look
   healthy. This would replace repeated log diagnosis; it is not implemented here.
2. Exercise oversized MCP message batches before changing delivery. The current
   live inventory had 5,453 messages, an 8,668-byte maximum and a 599-byte mean;
   none exceeded 20 KB individually. A count limit still does not bound a batch.
   A future byte limit must preserve complete-message acknowledgement and provide
   a bounded continuation for a single oversized message. Silent truncation,
   advancing past withheld content, or endless polling on a large first message
   are unacceptable. The existing hook budget/history protections remain intact.
3. Measure complete representative tasks: successful handoff, simultaneous
   editing, terminal exit/resume and busy-store recovery. Compare total calls,
   returned context, retries, completion time and task correctness. Keep the
   existing native two-session smoke and cross-platform CI as release gates.

Do not infer productive time saved from a smaller prompt or a microbenchmark.
Do not cache mutable ownership decisions, force-release a live peer, or introduce
a daemon solely to improve a synthetic startup number. These are priorities for
further evidence, not new required work hidden inside this completed fix.

## Verification and delivery

All 61 isolated suites and 21 checks through the installed Codex dispatcher
passed; both native sessions reported version 1.9.2. Doctor passed 10/10.
The populated [benchmark results](evidence/reliability-2026-09-11/hotspots.json)
and [native summary](evidence/reliability-2026-09-11/native-smoke.json) are retained.
Remote CI results are recorded in the completion handoff with their exact revision.
The catalog schema and existing ADE snapshot/Room contracts are unchanged.
These core corrections do not require an ADE binary rebuild.

Confidence is high for the reproduced and tested failure fixes and indexed query
selection, moderate for the local timing comparisons. OS/filesystem/host stalls
remain outside a synchronous hook's wait budget. Native GUI acceptance on every
machine and billed-model-token savings are not established by these tests.

This follows [the earlier research and optimization](OPTIMIZATION-2026-09-11.md).
Issue `i-2b98c891` records the guard failures and their resolution.
