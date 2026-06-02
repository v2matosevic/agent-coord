// Tunables for the coordination layer. One place so the installer / docs can
// reference them and the test harness can reason about timing.

export const SCHEMA_VERSION = 2;

// A lease's wall-clock cap. The real gate is agent liveness (heartbeat); this
// is a backstop so a lease can't outlive a wedged-but-"alive" process forever.
export const FILE_TTL_SEC = 60 * 60; // 1h
export const RESOURCE_TTL_SEC = 30 * 60; // 30m

// No heartbeat for this long => the agent is considered dead and its leases
// stop blocking others. Active work refreshes the heartbeat on every tool call.
export const DEAD_MS = 3 * 60 * 1000; // 3 min

// A file lease only BLOCKS while it's "warm" — the holder edited THAT file within
// this window (acquired_at refreshes on every edit). Past this, the lease goes
// "cold": the holder moved on, so a waiting agent may take the file automatically,
// no force-release and no human. This is what stops a one-time edit from locking a
// file for the whole (still-alive) session. The TTL above remains the hard GC cap.
// Tuned short to favor freeing abandoned files over protecting long idle gaps:
// well above a normal same-file edit cadence, so active work isn't disrupted, and
// a rare mid-sweep takeover self-heals on the holder's next edit.
export const FILE_ACTIVE_MS = 5 * 60 * 1000; // 5 min

// Overlap / duplicate-work detection (lib/overlap.mjs). Two agents launched on
// the same vague prompt share near-identical task text; we flag that as likely
// duplication so the later-starter can differentiate or stand down.
export const OVERLAP_THRESHOLD = 0.5; // Jaccard over significant task tokens
export const OVERLAP_MIN_TOKENS = 2; // too little task text => no signal, don't flag
export const OVERLAP_NOTICE_COOLDOWN_MS = 90 * 1000; // rate-limit the soft advisory
export const OVERLAP_ESCALATE_AFTER = 3; // soft advisories before the later-starter's edits hard-block
