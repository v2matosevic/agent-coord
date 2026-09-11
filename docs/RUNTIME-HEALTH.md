# Runtime coordination health

Agent-coord 1.10.0 records small operational events for ADE's Fleet health panel.
It makes recent hook timing, errors, refusals, missing completions, loaded
versions and pending-mail counts visible. This evidence is advisory; it never
grants a file/resource lease or acknowledges a message.

## Collection contract

Hooks append a start record after reading their input and a completion record
from the process exit handler. A killed process leaves a start without a recorded
completion. That is missing evidence, not proof of a particular failure cause.
Failures before the collector starts, host shell startup and OS/filesystem
stalls cannot be fully measured by a hook recording itself.

Records contain only a protocol version, timestamp, random event ID, hashed
session key, provider/event category, process ID, optional coordination name and
workspace hash, source version, duration, denial flag and bounded error category.
The persistence boundary whitelists these fields. Prompts, command text, working
directories, message bodies, credentials and raw error messages are not recorded.
MCP processes additionally report their loaded version and identity at most once
per minute per active caller. They do not add this data to tool responses.

Duration uses the Node process clock. It includes Node initialization/module
work observed by that clock, but not the host's complete shell/launch overhead.
Ordinary refusals are separate from errors. A refusal caused by a time-budget
failure records both facts. A failed optional log operation cannot change the
underlying allow/deny result.

Storage is local under `AGENT_COORD_HOME/health`, defaulting to
`~/.agent-coord/health`, separate from the lock database. Set
`AGENT_COORD_HEALTH=0` for a process to opt out; no global setting is changed by
the implementation or tests.

| Bound | Value |
|---|---:|
| Record | At most 768 UTF-8 bytes |
| Hourly bucket | 8 MiB, plus at most one record per concurrent appender |
| Retention target | Current hour and five previous hours |
| Cleanup | At most 32 directory entries examined when a bucket is created |
| MCP version observations | At most one per caller per minute; cache capped at 256 callers |

Each record is one append. Writers never rewrite another event. A full bucket
leaves an overflow marker, which makes the reader explicitly partial. Cleanup
only removes matching old files owned by this feature and is best effort; file
permission failures can retain old buckets. Collection I/O errors are contained
and do not write extra agent context.

## ADE reader and display

ADE reads the journal only while the Fleet health panel is mounted and the
window's attention policy permits polling. Its read work runs off the UI thread.
The Fleet panel now shares its ordinary fleet polling with other consumers,
instead of starting a duplicate fleet poll.

The Rust reader reads at most 2 MiB from each of the current and previous hourly
buckets, at most 20,000 records and 80 displayed agent rows. It prioritizes the
current bucket. A capped, malformed or newer-format input is marked partial,
never silently treated as a complete healthy sample. Its separate roster read
is bounded at 2 MiB/1,000 entries; the existing full fleet view is unchanged.

Pending-mail queries open SQLite read-only. Their predicate matches the existing
active inbox: direct messages across workspaces, current-session broadcasts and
older broadcasts from live senders/parents, excluding expired/self/read messages.
A byte-identical fixture is checked in both repositories. Queries have a 25 ms
busy timeout and a 150 ms aggregate VM-work deadline. Missing or interrupted
counts are unknown, not zero. They never update `message_reads`.

The UI reads on a 15-second attention-aware cadence, with no overlapping reads.
A three-second frontend deadline lets a hung request become unavailable and
recover later. The native reader admits only one read at a time, so retries
cannot accumulate blocked reader jobs. Closing the panel stops its polling.

Freshness comes from each hook's original completion timestamp. A fresh UI read
or fleet snapshot does not refresh an old hook observation. The panel separates
recent, slow, stale, missing and limited evidence, and exposes errors and missing
completions. A hook becomes stale after two minutes without observed completion;
a stale UI sample or mail count is not reused as current evidence.

## Verification

- The collector tests cover private-field filtering, independent parent/child
  keys, ordinary denials versus errors, malformed version metadata, failed
  storage, opt-out, bounded retention, concurrent append integrity and a killed
  writer that cannot manufacture completion.
- Node and Rust share the inbox fixture, including expired mail, inactive
  historical broadcasts, live parents, direct cross-workspace mail and a read
  watermark that stays unchanged.
- Native Rust tests exercise stale timestamps, missing completions, partial
  records, missing stores and an expensive SQLite view interrupted by the query
  deadline. A compiled native reader was also run against the real local data.
- Browser verification mounts the actual Fleet panel and health component. It
  verifies a stopped writer under fresh reads, missing completion, limited data,
  unknown mail counts, read failure, timeout recovery, shared fleet polling and
  complete polling teardown. Screenshots are in the ADE evidence directory.
- `scripts/benchmark-health.mjs` alternates collection off/on on the same code
  and fixture, checking model-facing output equality on every run. Timings are
  distributions, not brittle CI thresholds or task-completion promises.

Full-suite, native-dispatch and exact-commit CI evidence are recorded in the
completion handoff. Confidence is high for the tested behavior and privacy
boundaries, moderate for local overhead comparisons. No billed-token savings
or general end-to-end coding speedup is claimed from adding observability.

The final local core suite passed 64/64. The alternating collection benchmark
measured metadata-hook p50 70.175 ms off / 73.188 ms on, unrelated pre-hook
69.094 / 70.104 ms, and post-hook 101.820 / 104.329 ms. All model-facing outputs
were identical. [Measured overhead](evidence/runtime-health-2026-09-11/overhead.json).

One native dispatcher run reached 19 checks, then caught the already logged
shutdown I/O problem (`i-8578246d`): one SessionEnd failed with a disk I/O error.
The collector recorded its error completion at 70.553 ms instead of reporting a
successful hook. A subsequent quiet run passed all 21 checks. Keep both
[the captured failure](evidence/runtime-health-2026-09-11/native-io-failure.json)
and [the passing rerun](evidence/runtime-health-2026-09-11/native-passed.json).
This feature exposes that storage failure; it does not claim to repair it.

## Delivery and rollback

The existing hook commands load the collector from the installed checkout.
New MCP processes load version reporting on their normal restart. Hook
definitions and trust stores are unchanged. ADE's panel requires a build that
includes the new native command and UI; source verification is not an installed
application claim.

Disable collection for a process with `AGENT_COORD_HEALTH=0`, or revert the scoped
source commits. Do not delete/reset coordination state or change hook trust to
roll back metrics. Older ADE versions ignore the journal. Missing journal data
is shown as unavailable by the new reader.
