# Identity, native delivery and bounded contention validation

This record covers the continuation after the original September 5 handoff.
The v1.9.0 tag and draft archives still name `829aed4`; they do not contain
these fixes. Publication remains the operator's decision and was not performed.

## Identity investigation, i-6daec436

The live name directory contained 64 names and all 64 were inside the old
24-hour retention window. The old resolver returned an already-owned animal
when that pool filled. In this continuation even the agreeing hook/shell name
belonged to a different stored session hash. An isolated 160-session test
reproduced only 64 distinct identities before the fix. Confidence: high.

Two independent boundaries explain the observed symptoms:

- Without native per-request context or an environment session id, MCP uses
  a standalone transport identity. A shared connection cannot infer which
  thread called it. The original `whale`/`moose` observation had this missing
  context signature; its exact historical transport wiring remains unknown.
- Exhaustion and stale-name recycling could merge unrelated mailboxes,
  presence, claims and provenance even when the hook and shell agreed.
  Directed messages intentionally cross workspaces, making name reuse visible
  as unrelated mail. This was reproduced independently of message routing.

The shared resolver now preserves existing owners, checks ownership before
claiming a vacant slot, and uses a pinned 16-hex session suffix on overflow.
It no longer recycles aliases into old records. Both tiers use the same code.
The suffix uses the existing 64-bit session-hash key, so it is collision
resistant, not a mathematical uniqueness or authentication guarantee.
Existing explicit Claude resume bindings remain supported.

Fresh MCP processes use the fix. Already-running servers retain their loaded
resolver until restarted, verified directly in this continuation. No blanket
release or identity-store rewrite was used. Only exact source-file claims made
by this continuation were released during its name transition. Historical
records that already collided were not reassigned or retrospectively trusted.
Standalone MCP now warns when host identity is absent; unused startup names
are never grounds for releasing another identity's claims.

## PowerShell and native host delivery

Concurrent commit `8876633` was already on main. Its quoted-executable invocation
fix is preserved. The author's separate audit records installation and review
in an existing named profile; this continuation independently verified that
profile through the installed dispatcher. No reliable readiness reply was
obtained from the previously named author connection.

The first full native contention experiment exposed a second shell boundary:
`pwsh -Command` mapped the Node hook's exit 2 to shell exit 1. Codex treated that
as a failed hook and applied the conflicting patch. The isolated store recorded
the conflict while the file bytes changed. A separate Node/PowerShell probe
confirmed the exit conversion. Confidence: high.

The adapter now uses the documented `permissionDecision: deny` response and
exit 0. It does not grant shell/edit permissions. This changes adapter code,
not the installed hook definitions or their trust hashes. Both the generated
shell-command regression and the actual native dispatcher now refuse the write.
The [official hook contract](https://learn.chatgpt.com/docs/hooks) documents
structured denial and profile-effective review; runtime evidence remains the
acceptance test.

`scripts/native-codex-smoke.py` uses two fresh installed Codex CLI 0.153.3
processes, an already-approved named profile, a disposable git repository,
and a deterministic localhost backend. The installed host dispatches every
shell/MCP/patch call and every hook. The driver never submits fabricated hook
payloads or model-authored `_coord`. Both hook and MCP stores are explicitly
isolated, and the actual global git guard remains enabled. No remote model
is called, no trust is copied or edited, and no trust bypass is used.

The final quiet run passed 21 checks, including:

1. Distinct session ids and matching hook, shell and MCP identities;
   both MCP results report `native-hooks` and `identityBasis: hook`.
2. A claimed file blocks the other session's patch and names the correct holder;
   the original bytes remain unchanged.
3. A directed message appears in the recipient's next local-tool developer
   context. The holder also receives its deduplicated wait notice.
4. Explicit release permits reclaim, reread and a successful patch.
5. A real commit changing a document held by that same session succeeds.
6. Both normal session exits mark their identities dead and release their own
   remaining claims. Hook definitions and trust remain unchanged.
7. The store records one wait episode, one blocked reservation attempt, and
   release after 2,110 ms. This is an artificial smoke measurement, not evidence
   of faster project throughput.

Native MCP reconnect is not exercised by the driver. The isolated real-stdio
MCP tests separately verify reconnect preservation. This is not presented as
native-host reconnect validation.

One earlier native run, concurrent with the full test suite, passed the write
and message checks but hit `ERR_SQLITE_ERROR disk I/O error` during one session's
shutdown. Its test lease remained until fallback expiry; the quiet rerun passed.
Local issue `i-8578246d` retains that evidence. Root cause is unknown. Normal
shutdown was exercised successfully, but shutdown cleanup is not guaranteed
under storage failure. No lock timeout was shortened to conceal this limit.

The profile tested here is approved. Other profiles and old MCP processes are
not thereby approved or upgraded. Restart old sessions and review `/hooks` in
the effective profile wherever the definitions are still marked modified.

## Contention scope

Implemented: per-file episode/retry counts, waiter duration, observed holder
state, seven-day completed-history retention, cancellation/abandonment/expiry,
and budgeted holder notices deduplicated across concurrent deliveries. Schema
changes are additive and retain schema version 2 and existing leases.

The count of in-flight write commands is distinct from idle reservations and
unknown legacy state. It is not a timer for actual editing or CPU use. Missing
post-tool events can leave the observation stale. Metrics do not change lease
warmth, TTL, heartbeat thresholds, exclusivity, or atomic claim behavior.
Telemetry runs behind savepoints: an injected telemetry-table failure still
denies conflicting single-file and atomic multi-file claims, preserves existing
claims, and permits an unrelated free-file claim. Missing metrics are reported
as degraded observation rather than changing the known lease decision.

No named atomic handoff, FIFO reservation, line locking, simultaneous full-file
writes, or base-hash patch submission was added. Availability still requires
reclaiming and rereading. Read-only reporting and unrelated completion events
do not add database writes.

## Automated evidence and release boundary

Windows Node 22.22.0: the final full suite passed 48/48 files, including
concurrent-notice and warm-schema-upgrade coverage. Exact-SHA CI results are
recorded in the handoff continuation after completion. Doctor reported 10/10; this checks
configuration, independently of the native dispatcher evidence above.

The native driver is opt-in because normal CI cannot inherit operator hook
trust. Shell and isolated regression tests remain part of `npm test`.
Local raw evidence and logs stay outside public version control. The immutable
tag, its draft assets, and unrelated `.social-post/` work are preserved.
The old tag's native blocking defect is not repaired by publishing its existing
archives. A future release needs a newly tested revision and version.
