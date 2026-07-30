/*
 * 28-03 (R6) AC-3: scan-lock release survives a thrown engine run.
 *
 * The L6 refactor rewrites the scan/estimate route boilerplate. This test PINS
 * the pre-existing `finally { releaseScanLock() }` guarantee so the refactor can
 * never silently drop it: when runScan throws, the route returns 500, the lock
 * is released in finally, and a SUBSEQUENT scan is NOT rejected with 409.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const {
  mockSettingsGetAll,
  mockRunScan,
  mockListPaginated,
  mockEnqueue,
  mockListActive,
  mockCountByStatus,
  mockEmit,
  mockShareRepoListAll,
} = vi.hoisted(() => ({
  mockSettingsGetAll: vi.fn<() => Record<string, string>>(),
  mockRunScan: vi.fn(),
  mockListPaginated: vi.fn(),
  mockEnqueue: vi.fn(),
  mockListActive: vi.fn(() => []),
  mockCountByStatus: vi.fn(() => 0),
  mockEmit: vi.fn(),
  mockShareRepoListAll: vi.fn<() => unknown[]>(() => []),
}));

vi.mock('@/src/lib/db', () => ({
  fileRepo: () => ({ listPaginated: mockListPaginated }),
  settingRepo: () => ({ getAll: mockSettingsGetAll }),
  jobRepo: () => ({
    enqueue: mockEnqueue,
    listActive: mockListActive,
    countByStatus: mockCountByStatus,
  }),
  shareRepo: () => ({ listAll: mockShareRepoListAll }),
  default: {},
}));

vi.mock('@/src/lib/encode', () => ({
  engineEvents: { emit: mockEmit },
  isPaused: () => false,
}));

vi.mock('@/src/lib/scan/orchestrator', () => ({
  runScan: mockRunScan,
  default: { runScan: mockRunScan },
}));

vi.mock('@/src/lib/logger', () => {
  const child = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  return {
    logger: { child: vi.fn(() => child), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  };
});

// REAL scan-progress-flag — we assert genuine lock state, only spy the release.
import * as scanFlag from '@/src/lib/scan/scan-progress-flag';
import { POST } from '@/app/api/scan/route';

let tmpdir: string;

function jsonReq(body: unknown): Request {
  return new Request('http://localhost/api/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-lock-test-'));
  mockSettingsGetAll.mockReset().mockReturnValue({});
  mockRunScan.mockReset();
  mockListPaginated.mockReset().mockReturnValue({ rows: [], total: 0 });
  mockShareRepoListAll.mockReset().mockReturnValue([
    {
      id: 1,
      name: 'Library',
      path: tmpdir,
      min_size_mb: 1,
      extensions_csv: 'mp4,mkv',
      max_depth: 12,
      created_at: 1700000000,
      updated_at: 1700000000,
    },
  ]);
  // ensure no lock leaked in from a prior test
  scanFlag.releaseScanLock();
});

afterEach(() => {
  scanFlag.releaseScanLock();
  fs.rmSync(tmpdir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('POST /api/scan — R6 scan-lock release pinned in finally (AC-3)', () => {
  it('test_when_runScan_throws_then_releaseScanLock_runs_in_finally', async () => {
    const releaseSpy = vi.spyOn(scanFlag, 'releaseScanLock');
    mockRunScan.mockRejectedValue(new Error('boom mid-scan'));

    const res = await POST(jsonReq({}));

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('internal_error');
    expect(releaseSpy).toHaveBeenCalled();
  });

  it('test_when_first_scan_throws_then_second_scan_is_not_409_locked_out', async () => {
    mockRunScan.mockRejectedValueOnce(new Error('boom mid-scan'));
    const first = await POST(jsonReq({}));
    expect(first.status).toBe(500);

    // lock must be free now — a second scan acquires it (does NOT 409).
    mockRunScan.mockResolvedValueOnce({
      rootPath: tmpdir,
      filesScanned: 0,
      filesAdded: 0,
      filesUpdated: 0,
      filesUnchanged: 0,
      filesFailed: 0,
      durationMs: 1,
      startedAt: 1700000000,
      finishedAt: 1700000000,
    });
    const second = await POST(jsonReq({}));
    expect(second.status).not.toBe(409);
    expect(second.status).toBe(200);
  });
});
