import { performance } from "node:perf_hooks";

export function deadlineAfter(ms) { return performance.now() + ms; }

export function deadlineError() {
  return Object.assign(new Error("coordination time budget exhausted"), { code: "COORD_DEADLINE" });
}

// One monotonic deadline across all waits, not a fresh timeout for each retry.
export function remainingMs(deadline = Infinity, maximum = 10_000) {
  const remaining = Math.min(maximum, deadline - performance.now());
  if (remaining <= 0) throw deadlineError();
  return Math.max(1, Math.floor(remaining));
}
