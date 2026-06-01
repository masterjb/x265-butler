// Phase 13 Plan 13-04 Task 3a — shared single-flight gate.
//
// Both /api/scan and /api/scan/estimate must reject parallel requests with
// 409 + identical error-code so operator-triggered overlaps cannot corrupt
// walker counters or produce drifting eligible-counts. Pre-13-04 the flag
// lived as a module-local in app/api/scan/route.ts; promoting it here keeps
// the lock semantics in ONE place.
//
// JS event-loop atomicity guarantees that the check-then-set inside
// acquireScanLock is race-free as long as no async boundary sits between
// the read and the write — which it does not.

let inProgress = false;

export function isScanInProgress(): boolean {
  return inProgress;
}

export function acquireScanLock(): boolean {
  if (inProgress) return false;
  inProgress = true;
  return true;
}

export function releaseScanLock(): void {
  inProgress = false;
}

// Test-only helper. Production code never calls this; existing tests that
// share module-state across `describe` blocks need a deterministic reset.
export function __resetScanLockForTests(): void {
  inProgress = false;
}
