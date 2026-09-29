// 48-03 (R3): pure-function tests for the queue count triple helper.
//
// The bug this module fixes: listActive() selects queued+encoding, and eight
// emit sites reported that row count under a UI label reading "active"/"encoding".
// These tests pin the two invariants the fix rests on — one repo pass per call,
// and encodingJobs <= activeJobs because both come from the SAME row array.

import { describe, it, expect, vi } from 'vitest';
import { queueCountsFromRows, queueCountsSnapshot } from '@/src/lib/queue/counts';
import type { JobRow, JobStatus } from '@/src/lib/db/schema';

function row(id: number, status: JobStatus): JobRow {
  return {
    id,
    file_id: id * 10,
    status,
    started_at: null,
    finished_at: null,
    encoder: 'libx265',
    crf: null,
    bytes_in: null,
    bytes_out: null,
    duration_ms: null,
    exit_code: null,
    error_msg: null,
    log_tail: null,
    created_at: 1_700_000_000,
  } as JobRow;
}

describe('queueCountsSnapshot (48-03 AC-1)', () => {
  it('test_three_encoding_seven_queued_yields_10_3_7_with_one_call_each', () => {
    const rows = [
      ...[1, 2, 3].map((i) => row(i, 'encoding')),
      ...[4, 5, 6, 7, 8, 9, 10].map((i) => row(i, 'queued')),
    ];
    const listActive = vi.fn(() => rows);
    const countByStatus = vi.fn(() => 7);

    const result = queueCountsSnapshot({ listActive, countByStatus });

    expect(result).toEqual({ activeJobs: 10, encodingJobs: 3, pendingJobs: 7 });
    // AC-1: exactly one repo call each — the helper must not re-query.
    expect(listActive).toHaveBeenCalledTimes(1);
    expect(countByStatus).toHaveBeenCalledTimes(1);
    expect(countByStatus).toHaveBeenCalledWith('queued');
    expect(result.encodingJobs).toBeLessThanOrEqual(result.activeJobs);
  });

  it('test_empty_repo_yields_zeros', () => {
    // The shape existing test mocks use verbatim — must stay valid (AC-2).
    const result = queueCountsSnapshot({ listActive: () => [], countByStatus: () => 0 });
    expect(result).toEqual({ activeJobs: 0, encodingJobs: 0, pendingJobs: 0 });
    expect(result.encodingJobs).toBeLessThanOrEqual(result.activeJobs);
  });

  it('test_activeJobs_and_pendingJobs_stay_byte_identical_to_pre_48_03_math', () => {
    // AC-2: activeJobs === listActive().length, pendingJobs === countByStatus('queued').
    const rows = [row(1, 'encoding'), row(2, 'queued'), row(3, 'queued')];
    const result = queueCountsSnapshot({ listActive: () => rows, countByStatus: () => 2 });
    expect(result.activeJobs).toBe(rows.length);
    expect(result.pendingJobs).toBe(2);
  });

  it('test_encodingJobs_equals_countByStatus_encoding_over_mixed_fixture_AC21', () => {
    // AC-21: the provenance of encodingJobs changes from a COUNT(*) over the whole
    // job table to a filter over the listActive() rows. The equivalence holds only
    // because listActiveStmt is `WHERE status IN ('queued','encoding')` with NO
    // LIMIT — a later LIMIT or a third status in the IN list must break THIS test,
    // not silently miscount in production.
    const all: JobRow[] = [
      row(1, 'encoding'),
      row(2, 'encoding'),
      row(3, 'encoding'),
      row(4, 'encoding'),
      row(5, 'queued'),
      row(6, 'queued'),
      row(7, 'done'),
      row(8, 'failed'),
      row(9, 'cancelled'),
      row(10, 'interrupted'),
    ];
    const repo = {
      listActive: () => all.filter((r) => r.status === 'queued' || r.status === 'encoding'),
      countByStatus: (status: JobStatus) => all.filter((r) => r.status === status).length,
    };

    const result = queueCountsSnapshot(repo);

    expect(result.encodingJobs).toBe(repo.countByStatus('encoding'));
    expect(result.encodingJobs).toBe(4);
    expect(result.activeJobs).toBe(6);
    expect(result.pendingJobs).toBe(2);
    expect(result.encodingJobs).toBeLessThanOrEqual(result.activeJobs);
  });
});

describe('queueCountsFromRows (48-03 AC-3)', () => {
  it('test_only_queued_rows_yield_zero_encoding', () => {
    const rows = [row(1, 'queued'), row(2, 'queued'), row(3, 'queued')];
    const result = queueCountsFromRows(rows, 3);
    expect(result).toEqual({ activeJobs: 3, encodingJobs: 0, pendingJobs: 3 });
    expect(result.encodingJobs).toBeLessThanOrEqual(result.activeJobs);
  });

  it('test_only_encoding_rows_yield_encoding_equals_active', () => {
    const rows = [row(1, 'encoding'), row(2, 'encoding')];
    const result = queueCountsFromRows(rows, 0);
    expect(result).toEqual({ activeJobs: 2, encodingJobs: 2, pendingJobs: 0 });
    expect(result.encodingJobs).toBeLessThanOrEqual(result.activeJobs);
  });

  it('test_empty_rows_yield_zeros_and_pass_pending_through', () => {
    const result = queueCountsFromRows([], 0);
    expect(result).toEqual({ activeJobs: 0, encodingJobs: 0, pendingJobs: 0 });
  });

  it('test_pendingJobs_is_passed_through_not_derived_from_rows', () => {
    // Invariant 1: pendingJobs is NOT recomputed from the rows. The queued rows
    // here say 1, the passed value says 995 — the helper must report 995 so the
    // number stays byte-identical to countByStatus('queued') at the call site.
    const rows = [row(1, 'encoding'), row(2, 'queued')];
    const result = queueCountsFromRows(rows, 995);
    expect(result.pendingJobs).toBe(995);
    expect(result.activeJobs).toBe(2);
    expect(result.encodingJobs).toBe(1);
  });

  it('test_the_reported_scenario_4_encoding_995_queued', () => {
    // The forum report against v2.44.0: 4 running encodes, 995 waiting jobs.
    const rows = [
      ...Array.from({ length: 4 }, (_, i) => row(i + 1, 'encoding')),
      ...Array.from({ length: 995 }, (_, i) => row(i + 100, 'queued')),
    ];
    const result = queueCountsFromRows(rows, 995);
    expect(result.activeJobs).toBe(999);
    expect(result.encodingJobs).toBe(4);
    expect(result.pendingJobs).toBe(995);
    expect(result.encodingJobs).toBeLessThanOrEqual(result.activeJobs);
  });
});
