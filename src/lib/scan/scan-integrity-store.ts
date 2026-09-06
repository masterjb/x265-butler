// 48-01 (D2=A): process-local snapshot of the LAST scan's directory-integrity
// counters, read by the /api/diagnostics aggregator.
//
// Why a dedicated store and not the log ring-buffer: the 1000-line ring is
// SHARED by every diagnostic event (cpu_attribution, slow_query, slow_request,
// recentErrors …) and is documented in CLAUDE.md (CPU_ATTRIBUTION_INTERVAL_MS)
// as evicting older evidence. Parking the scan-integrity evidence there would
// reproduce exactly the silent-loss class this plan ends.
//
// Why process-local and NOT persisted: the snapshot answers "was the LAST scan
// complete?", not "what did last month look like". A DB table + migration would
// be a larger surface for a question nobody asked.
//
// audit-added S1 — CONCURRENCY. `runScan` is NOT globally serialized:
// `acquireScanLock` (scan-progress-flag.ts) covers only /api/scan and
// /api/scan/estimate, while the reconcile path (watch/reconcile.ts) calls
// runScan WITHOUT the lock. A boot-reconcile scan and a manual scan can
// therefore overlap, and the one that FINISHES last wins this slot — even if it
// started first. Accepted, known class (identical to the
// last-writer-by-completion-time behaviour recorded for the encoder detection
// under 39-01 in CLAUDE.md). `startedAtIso` + `finishedAtIso` exist so the case
// stays reconstructable from a copy-report; a real lock would change scan
// semantics, not just diagnostics, and is deliberately NOT in scope for 48-01.

export type ScanIntegrityShareRow = {
  shareId: number | null;
  name: string;
  rootPath: string;
  // audit-added M1: distinguishes "share threw" from "share is empty" — a
  // zeroed row is otherwise indistinguishable from a clean scan of nothing.
  failed: boolean;
  dirsVisited: number;
  dirsSkippedCycle: number;
  dirsSkippedUnreadable: number;
  dirsSkippedMaxDepth: number;
  // 48-02: DELIBERATE system-prefix prunes (/proc, /sys, /dev, /run). Rendered
  // as its own column in the copy-report — a per-share counter that never
  // renders is not evidence (AC-9).
  dirsSkippedSystemPrefix: number;
};

export type ScanIntegritySnapshot = {
  // audit-added M1 / AC-16: two timestamps instead of a single `atIso` — they
  // make overlapping scans (see the concurrency note above) reconstructable.
  // On outcome:'failed' finishedAtIso is the moment the scan aborted.
  startedAtIso: string;
  finishedAtIso: string;
  // audit-added M1: 'failed' = runScan threw (single-share/fallback path).
  outcome: 'complete' | 'failed';
  // audit-added M4: null in the multi-share case — `opts.rootPath` is
  // meaningless there (reconcile.ts passes shares[0].path pro forma only, and
  // the multi-share branch ignores it). The real roots live per row in byShare.
  rootPath: string | null;
  dirsVisited: number;
  dirsSkippedCycle: number;
  dirsSkippedUnreadable: number;
  dirsSkippedMaxDepth: number;
  dirsSkippedSystemPrefix: number; // 48-02
  cycleSamples: string[];
  unreadableSamples: string[]; // audit-added M2
  systemPrefixSamples: string[]; // 48-02
  sharesFailed: number; // audit-added M1
  byShare: ScanIntegrityShareRow[];
};

let lastScan: ScanIntegritySnapshot | null = null;

// audit-added S2 — WRITE RIGHTS: this is called EXCLUSIVELY by runScan. Neither
// estimate-engine.ts nor the estimate route nor the watcher may write here: an
// estimate walk aborts early by design (ESTIMATE_MAX_FILES / client abort), so
// its partial — and deceptively clean — numbers would overwrite the evidence of
// a complete scan.
export function recordScanIntegrity(snapshot: ScanIntegritySnapshot): void {
  lastScan = snapshot;
}

export function getScanIntegrity(): ScanIntegritySnapshot | null {
  return lastScan;
}

// Test-only helper (mirrors __resetScanLockForTests in scan-progress-flag.ts).
// Production code never calls this.
export function __resetScanIntegrityForTests(): void {
  lastScan = null;
}
