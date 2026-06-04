import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FileRow, JobRow } from '@/src/lib/db/schema';

const mocks = vi.hoisted(() => ({
  mockDbPrepareRun: vi.fn(),
  mockFileGetById: vi.fn(),
  mockFileSetStatus: vi.fn(),
  mockJobFindByFileId: vi.fn(),
  mockJobMarkCancelled: vi.fn(),
  mockEnsureServerInit: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockLoggerError: vi.fn(),
  mockBlocklistListAllPatterns: vi.fn(),
  mockBlocklistFindByFileId: vi.fn(),
}));

vi.mock('@/src/lib/db', () => ({
  getDb: () => ({
    prepare: () => ({ run: mocks.mockDbPrepareRun }),
    transaction: <T>(fn: T) => fn,
  }),
  fileRepo: () => ({
    getById: mocks.mockFileGetById,
    setStatus: mocks.mockFileSetStatus,
  }),
  jobRepo: () => ({
    findByFileId: mocks.mockJobFindByFileId,
    markCancelled: mocks.mockJobMarkCancelled,
  }),
  blocklistRepo: () => ({
    listAllPatterns: mocks.mockBlocklistListAllPatterns,
    findByFileId: mocks.mockBlocklistFindByFileId,
  }),
  default: {},
  shareRepo: () => ({ listAll: () => [] }),
}));

vi.mock('@/src/lib/server-init', () => ({
  ensureServerInit: mocks.mockEnsureServerInit,
  default: {},
}));

vi.mock('@/src/lib/logger', () => ({
  logger: {
    child: () => ({
      info: mocks.mockLoggerInfo,
      warn: mocks.mockLoggerWarn,
      error: mocks.mockLoggerError,
    }),
  },
  default: {},
}));

import { POST, runtime } from '@/app/api/library/bulk-retry/route';

const ROUTE_URL = 'http://test/api/library/bulk-retry';

function makeRequest(body?: unknown, headers?: Record<string, string>): Request {
  return new Request(ROUTE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const baseFile: FileRow = {
  id: 1,
  path: '/movies/A.mkv',
  size_bytes: 1024,
  mtime: 1700000000,
  content_hash: 'a'.repeat(64),
  codec: 'h264',
  bitrate: 1000000,
  duration_seconds: 60,
  width: 1920,
  height: 1080,
  container: 'mp4',
  status: 'failed',
  last_scanned_at: 1700000000,
  created_at: 1700000000,
  updated_at: 1700000000,
  version: 0,
  container_override: null,
  share_id: null,
};

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.mockFileSetStatus.mockReturnValue(true);
  mocks.mockJobFindByFileId.mockReturnValue(undefined);
  mocks.mockBlocklistListAllPatterns.mockReturnValue([]);
  mocks.mockBlocklistFindByFileId.mockReturnValue(undefined);
});

describe('POST /api/library/bulk-retry', () => {
  it('runtime is nodejs', () => {
    expect(runtime).toBe('nodejs');
  });

  it('happy path — 3 IDs all succeed → 200 successCount=3', async () => {
    mocks.mockFileGetById.mockImplementation((id: number) => ({ ...baseFile, id }));
    const res = await POST(makeRequest({ ids: [1, 2, 3] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.successCount).toBe(3);
    expect(body.failed).toEqual([]);
    expect(mocks.mockFileSetStatus).toHaveBeenCalledTimes(3);
    expect(mocks.mockFileSetStatus).toHaveBeenCalledWith(1, 'pending', 0);
    expect(mocks.mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ audit: 'bulk_library_retry', successCount: 3 }),
      'bulk_library_retry',
    );
  });

  it('415 on wrong Content-Type', async () => {
    const req = new Request(ROUTE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ ids: [1] }),
    });
    const res = await POST(req);
    expect(res.status).toBe(415);
  });

  it('400 on invalid JSON', async () => {
    const req = new Request(ROUTE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_json');
  });

  it('400 on zod fail — empty ids', async () => {
    const res = await POST(makeRequest({ ids: [] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
  });

  it('partial-success — not_found + not_eligible (done-smaller) + success', async () => {
    mocks.mockFileGetById.mockImplementation((id: number) => {
      if (id === 1) return undefined;
      if (id === 2) return { ...baseFile, id: 2, status: 'done-smaller' };
      if (id === 3) return { ...baseFile, id: 3, status: 'failed' };
      return undefined;
    });
    const res = await POST(makeRequest({ ids: [1, 2, 3] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.successCount).toBe(1);
    expect(body.failed).toEqual([
      { id: 1, reason: 'not_found' },
      { id: 2, reason: 'not_eligible' },
    ]);
  });

  it('ELIGIBLE_STATES allows done-not-worth (audit-extension per 05-13)', async () => {
    mocks.mockFileGetById.mockReturnValue({ ...baseFile, status: 'done-not-worth' });
    const res = await POST(makeRequest({ ids: [1] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.successCount).toBe(1);
    expect(body.failed).toEqual([]);
  });

  it('OCC-mismatch on setStatus → not_eligible', async () => {
    mocks.mockFileGetById.mockReturnValue({ ...baseFile });
    mocks.mockFileSetStatus.mockReturnValue(false); // OCC version mismatch
    const res = await POST(makeRequest({ ids: [1] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.successCount).toBe(0);
    expect(body.failed).toEqual([{ id: 1, reason: 'not_eligible' }]);
  });

  it('defensively cancels active job row before flipping status', async () => {
    mocks.mockFileGetById.mockReturnValue({ ...baseFile });
    const job: JobRow = {
      id: 7,
      file_id: 1,
      status: 'queued',
      encoder: 'libx265',
      retry_count: 0,
      crf: null,
      preset_used: null,
      force_container: null,
      created_at: 1700000000,
      updated_at: 1700000000,
      claimed_at: null,
      completed_at: null,
      failure_reason: null,
      stderr_excerpt: null,
      input_path: null,
      output_path: null,
      output_size_bytes: null,
      input_size_bytes: null,
      ffmpeg_version: null,
      encode_duration_ms: null,
      worker_id: null,
      queue_position: 1,
    } as unknown as JobRow;
    mocks.mockJobFindByFileId.mockReturnValue(job);
    const res = await POST(makeRequest({ ids: [1] }));
    expect(res.status).toBe(200);
    expect(mocks.mockJobMarkCancelled).toHaveBeenCalledWith(7);
    expect(mocks.mockFileSetStatus).toHaveBeenCalledWith(1, 'pending', 0);
  });

  it('SAVEPOINT-rollback isolates internal_error to one ID', async () => {
    mocks.mockFileGetById.mockImplementation((id: number) => {
      if (id === 2) throw new Error('boom');
      return { ...baseFile, id };
    });
    const res = await POST(makeRequest({ ids: [1, 2, 3] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.successCount).toBe(2);
    expect(body.failed).toEqual([{ id: 2, reason: 'internal_error' }]);
    expect(mocks.mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ id: 2 }),
      'bulk-retry per-id internal_error',
    );
  });

  it('tx-throw → 500', async () => {
    vi.resetModules();
    vi.doMock('@/src/lib/db', () => ({
      getDb: () => ({
        prepare: () => ({ run: mocks.mockDbPrepareRun }),
        transaction: () => () => {
          throw new Error('db-corruption');
        },
      }),
      fileRepo: () => ({
        getById: mocks.mockFileGetById,
        setStatus: mocks.mockFileSetStatus,
      }),
      jobRepo: () => ({
        findByFileId: mocks.mockJobFindByFileId,
        markCancelled: mocks.mockJobMarkCancelled,
      }),
      blocklistRepo: () => ({
        listAllPatterns: mocks.mockBlocklistListAllPatterns,
        findByFileId: mocks.mockBlocklistFindByFileId,
      }),
      default: {},
    }));
    const { POST: POST2 } = await import('@/app/api/library/bulk-retry/route');
    const res = await POST2(makeRequest({ ids: [1] }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('internal_error');
  });

  // 13-06 T4-C — Layer-2 encode-path guard for /api/library/bulk-retry.

  it('test_AC3_mixed_result_1ok_1blocklisted_1ineligible_1notfound', async () => {
    mocks.mockFileGetById.mockImplementation((id: number) => {
      if (id === 1) return { ...baseFile, id: 1, status: 'failed', path: '/normal/a.mkv' };
      if (id === 2) return { ...baseFile, id: 2, status: 'failed', path: '/movies/Samples/b.mkv' };
      if (id === 3) return { ...baseFile, id: 3, status: 'done', path: '/normal/c.mkv' };
      return undefined;
    });
    // Pattern entry matches id=2 path.
    mocks.mockBlocklistListAllPatterns.mockReturnValue([
      {
        id: 10,
        file_id: null,
        path_pattern: '*/Samples/*',
        reason: 'operator',
        created_at: 1,
      },
    ]);
    const res = await POST(makeRequest({ ids: [1, 2, 3, 4] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.successCount).toBe(1);
    const reasonsById = new Map(
      (body.failed as Array<{ id: number; reason: string }>).map((f) => [f.id, f.reason]),
    );
    expect(reasonsById.get(2)).toBe('blocklisted');
    expect(reasonsById.get(3)).toBe('not_eligible');
    expect(reasonsById.get(4)).toBe('not_found');
    // setStatus only for id=1.
    expect(mocks.mockFileSetStatus).toHaveBeenCalledTimes(1);
    expect(mocks.mockFileSetStatus).toHaveBeenCalledWith(1, 'pending', 0);
  });

  it('test_all_blocklisted_successCount_zero_all_failed_blocklisted', async () => {
    mocks.mockFileGetById.mockImplementation((id: number) => ({
      ...baseFile,
      id,
      status: 'failed',
      path: `/movies/Samples/f${id}.mkv`,
    }));
    mocks.mockBlocklistListAllPatterns.mockReturnValue([
      {
        id: 10,
        file_id: null,
        path_pattern: '*/Samples/*',
        reason: 'operator',
        created_at: 1,
      },
    ]);
    const res = await POST(makeRequest({ ids: [1, 2, 3] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.successCount).toBe(0);
    expect(body.failed).toHaveLength(3);
    for (const entry of body.failed as Array<{ id: number; reason: string }>) {
      expect(entry.reason).toBe('blocklisted');
    }
  });

  it('test_pino_audit_failedSample_contains_blocklisted_entries', async () => {
    mocks.mockFileGetById.mockImplementation((id: number) => ({
      ...baseFile,
      id,
      status: 'failed',
      path: `/movies/Samples/${id}.mkv`,
    }));
    mocks.mockBlocklistListAllPatterns.mockReturnValue([
      {
        id: 10,
        file_id: null,
        path_pattern: '*/Samples/*',
        reason: 'operator',
        created_at: 1,
      },
    ]);
    await POST(makeRequest({ ids: [1, 2] }));
    const auditCall = mocks.mockLoggerInfo.mock.calls.find(
      (c) => c[0].audit === 'bulk_library_retry',
    );
    expect(auditCall).toBeDefined();
    const failedSample = auditCall![0].failedSample as Array<{ reason: string }>;
    expect(failedSample.some((f) => f.reason === 'blocklisted')).toBe(true);
  });

  it('test_AC4_file_pinned_blocks_via_findByFileId', async () => {
    mocks.mockFileGetById.mockImplementation((id: number) => ({
      ...baseFile,
      id,
      status: 'failed',
      path: `/normal/${id}.mkv`,
    }));
    // file_id=7 is pinned in blocklist (file-mode entry).
    mocks.mockBlocklistFindByFileId.mockImplementation((id: number) =>
      id === 7
        ? { id: 99, file_id: 7, path_pattern: null, reason: 'operator', created_at: 1 }
        : undefined,
    );
    const res = await POST(makeRequest({ ids: [1, 7] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.successCount).toBe(1);
    const reasonsById = new Map(
      (body.failed as Array<{ id: number; reason: string }>).map((f) => [f.id, f.reason]),
    );
    expect(reasonsById.get(7)).toBe('blocklisted');
  });

  it('test_SR1_listAllPatterns_called_ONCE_per_request_despite_many_ids', async () => {
    mocks.mockFileGetById.mockImplementation((id: number) => ({
      ...baseFile,
      id,
      status: 'failed',
      path: `/normal/f${id}.mkv`,
    }));
    mocks.mockBlocklistListAllPatterns.mockReturnValue([]);
    await POST(makeRequest({ ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }));
    // SR1 hoist: listAllPatterns called exactly once even though loop iterates 10x.
    expect(mocks.mockBlocklistListAllPatterns).toHaveBeenCalledTimes(1);
  });
});
