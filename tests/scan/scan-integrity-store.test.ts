/*
 * 48-01: process-local last-scan integrity snapshot.
 *
 * The store itself is deliberately dumb (last writer wins, no merge) — the
 * concurrency reasoning lives in the module header and is asserted end-to-end
 * from runScan in tests/scan/orchestrator.test.ts.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordScanIntegrity,
  getScanIntegrity,
  __resetScanIntegrityForTests,
  type ScanIntegritySnapshot,
} from '@/src/lib/scan/scan-integrity-store';

function snap(over: Partial<ScanIntegritySnapshot> = {}): ScanIntegritySnapshot {
  return {
    startedAtIso: '2026-08-12T09:00:00.000Z',
    finishedAtIso: '2026-08-12T09:00:42.000Z',
    outcome: 'complete',
    rootPath: '/mnt/user/Movies',
    dirsVisited: 546,
    dirsSkippedCycle: 0,
    dirsSkippedUnreadable: 0,
    dirsSkippedMaxDepth: 0,
    dirsSkippedSystemPrefix: 0,
    cycleSamples: [],
    unreadableSamples: [],
    systemPrefixSamples: [],
    sharesFailed: 0,
    byShare: [],
    ...over,
  };
}

describe('scan-integrity-store', () => {
  beforeEach(() => {
    __resetScanIntegrityForTests();
  });

  it('test_getScanIntegrity_before_first_record_then_null', () => {
    // AC-11: "never scanned" must stay distinguishable from "scanned, 0 skips".
    expect(getScanIntegrity()).toBeNull();
  });

  it('test_getScanIntegrity_after_record_then_returns_snapshot', () => {
    const s = snap({ dirsSkippedCycle: 4, cycleSamples: ['/mnt/user/Movies/x'] });
    recordScanIntegrity(s);
    expect(getScanIntegrity()).toEqual(s);
  });

  it('test_recordScanIntegrity_second_call_then_fully_replaces_previous', () => {
    // AC-11: a second scan REPLACES the entry — including a failed one, so a
    // broken scan can never leave the previous run's numbers looking current.
    recordScanIntegrity(snap({ dirsVisited: 546 }));
    recordScanIntegrity(
      snap({
        outcome: 'failed',
        dirsVisited: 0,
        sharesFailed: 1,
        finishedAtIso: '2026-08-12T10:00:00.000Z',
      }),
    );

    const got = getScanIntegrity()!;
    expect(got.outcome).toBe('failed');
    expect(got.dirsVisited).toBe(0);
    expect(got.sharesFailed).toBe(1);
    expect(got.finishedAtIso).toBe('2026-08-12T10:00:00.000Z');
  });

  it('test_snapshot_carries_both_timestamps', () => {
    // AC-16 (audit-added S1): runScan is NOT globally serialized (the reconcile
    // path holds no scan lock), so overlapping scans are possible and the later
    // FINISHING one wins this slot. The pair of timestamps is what makes that
    // reconstructable from a copy-report afterwards.
    recordScanIntegrity(snap());
    const got = getScanIntegrity()!;
    expect(got.startedAtIso).toBe('2026-08-12T09:00:00.000Z');
    expect(got.finishedAtIso).toBe('2026-08-12T09:00:42.000Z');
    expect(Date.parse(got.finishedAtIso)).toBeGreaterThan(Date.parse(got.startedAtIso));
  });

  it('test_multi_share_snapshot_has_null_rootPath_and_per_share_rows', () => {
    // audit-added M4: top-level rootPath is null in multi-share mode; the real
    // roots live per row. audit-added M1: `failed` distinguishes a crashed share
    // from an empty one.
    recordScanIntegrity(
      snap({
        rootPath: null,
        sharesFailed: 1,
        byShare: [
          {
            shareId: 1,
            name: 'Movies',
            rootPath: '/mnt/user/Movies',
            failed: false,
            dirsVisited: 546,
            dirsSkippedCycle: 0,
            dirsSkippedUnreadable: 0,
            dirsSkippedMaxDepth: 0,
            dirsSkippedSystemPrefix: 0,
          },
          {
            shareId: 2,
            name: 'Series',
            rootPath: '/mnt/user/Series',
            failed: true,
            dirsVisited: 0,
            dirsSkippedCycle: 0,
            dirsSkippedUnreadable: 0,
            dirsSkippedMaxDepth: 0,
            dirsSkippedSystemPrefix: 0,
          },
        ],
      }),
    );

    const got = getScanIntegrity()!;
    expect(got.rootPath).toBeNull();
    expect(got.byShare).toHaveLength(2);
    expect(got.byShare[1]).toMatchObject({ name: 'Series', failed: true, dirsVisited: 0 });
  });

  it('test_reset_helper_clears_the_slot', () => {
    recordScanIntegrity(snap());
    expect(getScanIntegrity()).not.toBeNull();
    __resetScanIntegrityForTests();
    expect(getScanIntegrity()).toBeNull();
  });
});
