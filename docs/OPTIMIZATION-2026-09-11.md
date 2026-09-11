# Agent coordination optimization

Make routine coordination cheaper without weakening ownership, message delivery,
or the ADE fleet view. Keep the existing local SQLite and MCP architecture. The
first implementation targets repeated descriptions, unnecessary schema writes,
fleet query work, and redundant agent guidance. It does not change models,
permissions, lease lifetimes, or message acknowledgement rules.

## Evidence and recommendation

The baseline is agent-coord 1.9.1 at `dc56ead53e7f222edcd480d006976610e390036c`,
measured on Windows with Node 22.22.0. The repeatable fixture has 40 peers and
eight leases per peer, plus the benchmark's own hook and MCP identities. Each
timing has 25 samples after three warmups. The benchmark uses a disposable store
on the OS temporary disk, never the live coordination database.

| Measure | Baseline | Interpretation |
|---|---:|---|
| MCP tool count | 28 | Preserve every tool and existing argument |
| Server instructions | 1,407 bytes | Hosts can repeat this when exposing a tool |
| Tool definitions | 20,291 bytes | Descriptions and reserved hook metadata contribute |
| Catalog plus instructions | 21,726 bytes | Raw JSON size, not billed tokens |
| Catalog with instructions repeated per tool | 59,799 bytes | Projection matching this host's exposed metadata pattern |
| Fresh-process store open, p50 / p95 | 3.657 / 4.802 ms | Excludes Node startup and imports |
| Entire quiet post-tool hook, p50 / p95 | 87.692 / 91.877 ms | Mostly process startup and imports |
| Fleet query, p50 / p95 | 1.183 / 1.722 ms | Forty per-agent lease lookups after the agent query |
| MCP empty inbox, p50 / p95 | 1.201 / 2.072 ms | Already cheap and returns 56 bytes |
| MCP fleet listing, p50 / p95 | 2.042 / 3.100 ms | 13,345-byte result in this fixture |
| MCP global snapshot, p50 / p95 | 2.812 / 3.640 ms | 22,722-byte result in this fixture |

Raw evidence: [baseline.json](evidence/optimization-2026-09-11/baseline.json).
These are local synthetic measurements, not a claim that projects will finish
faster by the same percentage. Confidence is high for catalog sizes and the
observed work performed; moderate for timings on one machine; unknown for
end-to-end model cost and coding-task completion time.

The live store's read-only inventory contained 19 agent rows, 130 leases, 5,420
messages, nine tasks, and 132,585 activity rows. These include historical data,
not just active workers. Its size justifies checking indexed reads, but not a
database replacement. No message bodies or private work details are included in
the benchmark evidence.

## What is already working

The September 10 inbox correction excludes pre-session broadcasts from inactive
senders while retaining direct messages, current-session broadcasts, and history
in search. Its recorded comparison was 778 candidate messages reduced to nine.
Repeating that work would produce little value and risk a delivery regression.
See [the implementation and evidence](CONTEXT-EFFICIENCY-2026-09-10.md).

Heartbeat writes already have a 45-second throttle; snapshots have a 20-second
throttle. An empty hook emits no context. The one-call `announce_intent` brief
already replaces separate identity, presence, board, and decision requests.
The implementation should preserve these properties.

The September 10 closed-process repair checks known owner PIDs. Do not cache
lease ownership or skip process liveness to win a benchmark: that could make a
dead terminal block another agent again. See [the presence repair](STALE-PRESENCE-2026-09-10.md).

## Research findings

### Context reduction and elapsed time are different objectives

OpenAI's latency guidance prioritizes fewer output tokens and fewer requests as
well as parallel independent work. It explicitly cautions that cutting a prompt
in half often produces only a small latency improvement. Therefore measure
catalog size, tool result size, hook latency, and request count separately; do
not convert saved input tokens directly into minutes saved. [1]

Prompt caching reuses a shared prefix. Keep server instructions and tool order
stable; avoid inserting timestamps, per-session identities, or changing fleet
state in static definitions. Dynamic facts belong in the brief and results.
The host and model control the actual cache behavior, so agent-coord cannot
promise a cache hit or a particular discount. [2]

### Use host discovery before inventing another tool router

Anthropic reports better context efficiency from deferred tool discovery and
programmatic filtering of large results. Its examples concern larger catalogs
and particular evaluation setups; they are not expected savings for this tool.
The transferable principles are to expose only the needed detail and keep
intermediate bulk data outside model context. [3][4]

Claude Code already supports tool search, with configurable deferral and an
`alwaysLoad` override. Codex supports server-wide MCP instructions and advises
making their first 512 characters self-contained. A concise first paragraph
should carry the check-in, file claim, polling, and lock-safety rules; specific
tools retain their own scope and caveats. Do not force a new global tool-search
setting or always-load the entire coordination catalog. [5][6]

MCP tools/list pagination is a transport mechanism. A client may still enumerate
all pages before presenting tools, so adding pagination alone would not prove a
token reduction. A new multiplexing tool would also introduce a second argument
schema and could defeat native Codex hook matching. Preserve the existing 28
names and the `_coord` identity metadata. [7]

MCP permits structured results but recommends a serialized text representation
for compatibility. Returning both copies can increase context in some hosts.
Do not add `structuredContent` as an assumed performance fix without measuring
the actual consumers. [7]

### Remove unnecessary database writes before adding a daemon

SQLite WAL permits concurrent readers while retaining a single writer. Our
store initializer currently enters a schema write transaction on every fresh
hook process, even on a fully migrated store. That undermines the already
implemented heartbeat and empty-mailbox read paths. Avoid the transaction when
the exact schema is known to be ready; preserve `BEGIN IMMEDIATE` for actual
migrations and claims. Do not relax durability or busy timeouts. [8]

SQLite's read-only `PRAGMA schema_version` reports a schema-change counter. It
can invalidate a readiness marker after DDL by another connection. This is
distinct from agent-coord's own `schema_version` table, whose compatibility
value remains 2. Never assign to SQLite's counter. [9]

The fleet reader currently queries each agent's latest lease separately. A
single correlated query with an index on owner and acquisition time can retain
the exact public shape while removing JavaScript-to-SQL calls and repeated
sorts. This is a measured query optimization, not permission to truncate the
fleet or change the definition of an active agent.

## ADE integration contract

ADE is already integrated through three different paths:

| Consumer | Current contract | Required preservation |
|---|---|---|
| Terminal and tile tool profiles | Launch `mcp/server.mjs` from this checkout | All tools and identity inference remain available |
| Fleet view in `ade-core/src/coord.rs` | Read snapshot.json plus heartbeat markers | Complete lists, generatedAt, root and current liveness |
| Room in `ade-core/src/coord_room.rs` | Open state.db read-only; mirror messages to room.db | No schema removals; never advance message_reads from a UI reader |
| Agent brief in `src/lib/ade/agentBrief.ts` | Explain check-in, peers and delivery | Distinguish trusted hooks from manual fallback |

The current ADE brief unconditionally says locks are automatic and repeats an
old routing incident. Replace that with concise operational guidance: one
check-in, trusted-hook automation, explicit claiming/polling otherwise, direct
peer routing, and existing push review. Keep `scope:'global'` with named-peer
messages for compatibility with older connected servers.

Changes in the hook-loaded checkout affect later hook processes. Already-running
MCP processes retain their imports until normal restart. A changed ADE brief
requires the next ADE build/session materialization; do not label a source edit
as an installed binary update. The database and snapshot improvements require
no ADE binary change because they preserve its existing readers.

## Execution plan

1. Establish an isolated benchmark and retain its baseline. Done. Keep the
   fixture, warmup policy and result-size accounting in the repository so future
   changes can be compared without live model calls.
2. Shorten server-wide instructions and tool descriptions. Preserve tool names,
   schema, routing, destructive-operation cautions, and hook identity fields.
   Target about a 20% reduction in the raw catalog and a 30% reduction in the
   repeated-instruction projection. Validate contract and size budgets.
3. Add a schema-readiness fast path. Record a fingerprint of the complete
   additive schema and its SQLite schema counter only after migration commits.
   Recheck the compatibility version on every fresh connection. Missing,
   mismatched, altered, and old stores take the migration path; ordinary warm
   opens must not require a writer lock. Test cold concurrent startup, warm
   upgrade, schema-ahead warning and cache invalidation.
4. Optimize fleet reads with a supporting additive index and one query, keeping
   the same fields and all rows. Verify expired/newest/no-lease cases and both
   capped MCP versus complete ADE snapshot consumers. Re-measure before retaining
   the optimization.
5. Correct and shorten ADE's coordination brief. Preserve the manual fallback
   and compatible directed routing. Verify the actual tool profiles and existing
   ADE reader contracts; run the affected ADE tests and project checks.
6. Run focused coordination checks, then the entire isolated suite, doctor and
   diff checks. Record after measurements, exact delivery state and rollback.
   Commit the scoped sources and evidence, preserving unrelated shared work.

The definition of finish is a smaller catalog, less unnecessary database work,
passing ownership/delivery/compatibility checks, and an ADE integration record
that distinguishes running source from a rebuilt application. Timing results
are recorded as distributions, not hard CI thresholds. No lease safety or
message delivery loss is an acceptable trade for a smaller number.

## Alternatives not selected for this implementation

A persistent hook service might remove much of the roughly 88 ms process cost,
but adds endpoint authentication, per-request identity, failure recovery,
updater compatibility, startup orchestration and shutdown ownership. It needs a
separate fault-tested design only if measured hook totals remain a material
burden after these changes. Keep the hook fallback even in that design.

A remote coordination database would complicate a deliberately machine-local
lock authority. SQLite WAL itself requires shared local memory and is not a
cross-machine protocol. Cross-machine source handoff remains Git/Hermes; it is
not safe to synchronize a live WAL store. [8]

Aggressive polling suppression could delay direct messages and change liveness.
Caching static definitions and schema readiness is safer than caching mutable
ownership decisions. Likewise, hiding tools by default would trade lower context
for discoverability risk in clients without tool search. A profile can be
evaluated later against recorded actual usage, not adopted from a vendor's
headline percentage.

This work does not change the Room archive's delivery labels, overhaul all task
backlogs, reduce reasoning effort, or add a second coordination system. Broader
IDE features and unrelated open issues are outside the optimization scope.

## Executed changes and measurements

The six steps are implemented. The owner then explicitly added native Codex
hook timeouts to the acceptance criteria. That investigation found a concrete
mismatch: installed host limits are 10 seconds, or 3 seconds for SessionEnd,
while SQLite's busy wait was 10 seconds with up to eight retries. Optional
Windows process discovery allowed another eight seconds, and Git fallback
could run three four-second subprocesses. A contention test reproduced a
blocked PreToolUse identity-forwarding call before the fix.

The Codex entry point now forwards identity metadata and skips unrelated
PreToolUse events before importing the SQLite/runtime modules. Events that need
the store share a monotonic deadline across migration, mutation retries, Git
fallback and optional process discovery: 1,500 ms, or 1,000 ms for SessionEnd.
Discovery is optional and retains unknown-owner heartbeat fallback when it cannot
finish. Shell calls still refresh workspace/branch context. This preserves the
boundary checks that caught and corrected an initial overly broad skip.

If a deadline expires before ownership is checked, a guarded write receives the
existing structured-denial format with a retry reason. It is not silently
allowed. Advisory events report degraded operation and return. A held-writer
test verifies metadata forwarding, unrelated pre-hook silence, read-only shell
context, guarded refusal, session-end return, unchanged claims/unread mail and
recovery after the writer releases. This intentionally narrows the former
fail-open rule for ownership uncertainty caused by deadline exhaustion.

### Token and payload measurements

| Catalog representation | Before | After | Reduction |
|---|---:|---:|---:|
| Raw JSON bytes | 21,726 | 17,396 | 19.9% |
| Reference tokens, raw catalog | 4,964 | 3,955 | 20.3% |
| Bytes with guidance repeated per tool | 59,799 | 32,438 | 45.8% |
| Reference tokens with guidance repeated per tool | 12,711 | 6,923 | 45.5% |
| Server instruction bytes | 1,407 | 554 | 60.6% |

Reference counts use `tiktoken` 0.14.0, `o200k_base`, over exact compact JSON
captured from real MCP initialization/tools-list responses. They do not claim
to be the private Astra/Claude tokenizer or provider-billed usage. The tokenizer
was installed into a disposable measurement directory, not globally or as a
runtime dependency. [Token results](evidence/optimization-2026-09-11/tokens.json).
All 28 names and schemas, including hook-only metadata, match the original
schema fingerprint. Critical guidance fits the first 512 characters.

### Runtime measurements

A later sequential comparison added actual Codex PreToolUse processes. The
before run used the original revision in a disposable C: worktree; the after
run used this checkout. Both used the same benchmark script, Node and 40-peer
fixture, with three warmups and 25 measured samples. Temporary database storage
was on the same OS disk. Different checkout paths and machine load remain
confounders, so these are observed distributions, not service-level guarantees.

| Operation | Before p50 / p95, ms | After p50 / p95, ms |
|---|---:|---:|
| Codex MCP identity forwarding, whole process | 112.544 / 134.048 | 67.508 / 75.178 |
| Codex unrelated pre-tool event, whole process | 111.171 / 128.701 | 64.243 / 74.183 |
| Fleet query | 1.332 / 1.595 | 0.378 / 0.517 |
| Fresh-process store open, excluding startup | 4.937 / 9.604 | 3.341 / 4.460 |
| Quiet Claude post-tool hook, whole process | 104.512 / 118.548 | 95.751 / 103.456 |
| MCP fleet listing | 2.981 / 3.880 | 1.665 / 2.303 |

The narrow Codex pre-hook paths were 40.0% and 42.2% faster at p50 in this run.
Fleet reads were 71.6% faster. Confidence is moderate for those comparisons and
high for the tested structural reductions: no SQLite/runtime import on the
forwarding path, no warm schema writer transaction, and an indexed fleet lookup.

An earlier intermediate run was slower under the observed machine conditions;
it is retained as [after-core.json](evidence/optimization-2026-09-11/after-core.json).
Do not discard it or use only the best sample. The first baseline's quiet-hook
p50 was 87.692 ms, faster than the final 95.751 ms, so this work does not establish
a general quiet-Claude-hook speedup. The repeatable sources and distributions,
rather than a blanket speed claim, are the result.

Final measurements: [before-native.json](evidence/optimization-2026-09-11/before-native.json)
and [after.json](evidence/optimization-2026-09-11/after.json). Their runtime SHA-256
values identify the measured `.mjs` source even before a commit is created.
Reproduce with `node scripts/benchmark.mjs --native-hooks --out <report.json>`.
`--catalog-out <path>` optionally records the exact catalog for a tokenizer.
Timings are advisory; schema/output budgets and correctness are tested gates.

## Verification and delivery

- Full coordination suite: 57/57 passed. Coverage includes concurrent claims,
  warm migration, schema-ahead warning, schema-cookie invalidation, metadata
  contract, process liveness, bounded contention, messaging, hook budgets,
  workspace changes, and complete versus capped snapshots.
- Real installed Codex dispatcher: 21/21 checks passed using two ephemeral
  sessions and a localhost deterministic backend. This exercised hooks, MCP and
  shell identity agreement, collision denial, unchanged blocked bytes, direct
  mail, handoff/reclaim, a patch after release and both session-end cleanups.
  Hook definitions and trust were unchanged. [Native summary](evidence/optimization-2026-09-11/native-smoke.json).
- Doctor: 10/10 configuration checks. Native evidence comes from the dispatcher
  test, not from treating doctor as proof of hook execution.
- ADE: 108 focused profile/identity/brief tests passed, then full type checking
  (zero errors/warnings), repository lint and 2,318 tests passed, with three
  existing skips. The new brief preserves compatible peer routing and makes
  automatic enforcement conditional on trusted hooks.

The hook-loaded source is in the installed checkout on Olympus and was exercised
by the real CLI. Newly started MCP processes load the smaller definitions;
existing ones retain their old imports until a normal restart. No agent was
stopped, no global hook configuration or trust store was edited, and no model
setting or runtime dependency was changed.

ADE's existing fleet and Room readers consume the unchanged snapshot/SQLite
contracts, so the core improvements require no ADE binary update. The concise
ADE prompt is a separate source change in `app_tracker`, verified but not
packaged or installed by this task. A normal subsequent ADE build and new
session materialization will carry that prompt. No remote release or other
machine rollout is claimed.

The tested timeout path is fixed; an absolute promise that hooks can never time
out is not supportable. OS scheduling, blocked filesystem I/O, host shell startup,
and host failures can still exceed a timeout outside our controlled waits. A
heavy synchronous query is also not preempted by this wait budget. Do not widen
host timeouts to hide those cases. The guard returns promptly for the reproduced
contention case while preserving ownership and undelivered mail. End-to-end
coding quality, billed tokens and project completion time remain unmeasured.

Rollback is a scoped revert of the implementation commits. Keep the additive
schema_readiness table and index; older code ignores them. Do not reset/delete
the live store, change hook trust, or revert a peer's uncommitted changes. MCP
processes load either version at their next normal restart.

## Sources

All web sources were inspected in a real browser on September 11, 2026. Vendor
benchmarks explain candidate mechanisms; the local measurements determine what
is retained here.

1. OpenAI, [Latency optimization](https://developers.openai.com/api/docs/guides/latency-optimization), living documentation.
2. OpenAI, [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), living documentation.
3. Anthropic, [Introducing advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use), engineering article.
4. Anthropic, [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp), November 4, 2025.
5. Anthropic, [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp), current tool-search configuration.
6. OpenAI, [Model Context Protocol](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), current Codex host support and server instructions.
7. Model Context Protocol, [Tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), November 25, 2025 revision.
8. SQLite, [Write-Ahead Logging](https://sqlite.org/wal.html), concurrency, checkpoint and durability behavior.
9. SQLite, [PRAGMA schema_version](https://sqlite.org/pragma.html#pragma_schema_version), schema counter and read/write distinction.
