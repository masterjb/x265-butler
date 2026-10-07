// Upper bound for automatic enqueues in one run (one reconcile tick, one
// scan). Bounds the event-loop work and the queue burst from a large backlog;
// the remainder is picked up by the next run. Env RECONCILE_ORPHAN_CAP,
// documented in docs/dev/kill-switches.md. Malformed values (NaN/0/negative/
// empty) fall back to 1000 without a warning. Read per call: runs are rare.
export function automaticEnqueueCap(): number {
  const n = Number(process.env.RECONCILE_ORPHAN_CAP);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1000;
}
