import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { BlocklistRow, FileRow } from '@/src/lib/db/schema';

const mocks = vi.hoisted(() => ({
  mockDbPrepareRun: vi.fn(),
  mockDbTransaction: vi.fn(),
  mockBlocklistAdd: vi.fn(),
  mockBlocklistFindByFileId: vi.fn(),
  mockFileGetById: vi.fn(),
  mockFileSetStatus: vi.fn(),
  mockEnsureServerInit: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock('@/src/lib/db', () => ({
  getDb: () => ({
    prepare: () => ({ run: mocks.mockDbPrepareRun }),
    transaction: <T>(fn: T) => fn,
  }),
  blocklistRepo: () => ({
    add: mocks.mockBlocklistAdd,
    findByFileId: mocks.mockBlocklistFindByFileId,
  }),
  fileRepo: () => ({
    getById: mocks.mockFileGetById,
    setStatus: mocks.mockFileSetStatus,
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

import { POST, runtime } from '@/app/api/library/bulk-blocklist/route';

const ROUTE_URL = 'http://test/api/library/bulk-blocklist';

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
  status: 'pending',
  last_scanned_at: 1700000000,
  created_at: 1700000000,
  updated_at: 1700000000,
  version: 0,
  container_override: null,
  share_id: null,
};

const baseBlRow: BlocklistRow = {
  id: 99,
  file_id: 1,
  path_pattern: null,
  reason: 'operator',
  created_at: 1700000000,
};

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.mockBlocklistFindByFileId.mockReturnValue(undefined);
  mocks.mockBlocklistAdd.mockReturnValue(baseBlRow);
  mocks.mockFileSetStatus.mockReturnValue(true);
});

describe('POST /api/library/bulk-blocklist', () => {
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
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(mocks.mockBlocklistAdd).toHaveBeenCalledTimes(3);
    expect(mocks.mockBlocklistAdd).toHaveBeenCalledWith({ file_id: 1, reason: 'operator' });
    expect(mocks.mockFileSetStatus).toHaveBeenCalledTimes(3);
    expect(mocks.mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ audit: 'bulk_library_blocklist', successCount: 3 }),
      'bulk_library_blocklist',
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
    const body = await res.json();
    expect(body.error).toBe('unsupported_media_type');
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

  it('400 on zod fail — empty ids array', async () => {
    const res = await POST(makeRequest({ ids: [] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
  });

  it('400 on zod fail — over 500 ids', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => i + 1);
    const res = await POST(makeRequest({ ids }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
  });

  it('400 on zod fail — duplicate ids', async () => {
    const res = await POST(makeRequest({ ids: [1, 2, 1] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
  });

  it('partial-success — not_found + not_eligible + already_blocked + success', async () => {
    mocks.mockFileGetById.mockImplementation((id: number) => {
      if (id === 1) return undefined; // not_found
      if (id === 2) return { ...baseFile, id: 2, status: 'queued' }; // not_eligible
      if (id === 3) return { ...baseFile, id: 3 }; // already_blocked (findByFileId returns row)
      if (id === 4) return { ...baseFile, id: 4 }; // success
      return undefined;
    });
    mocks.mockBlocklistFindByFileId.mockImplementation((id: number) =>
      id === 3 ? { ...baseBlRow, file_id: 3 } : undefined,
    );
    const res = await POST(makeRequest({ ids: [1, 2, 3, 4] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.successCount).toBe(1);
    expect(body.failed).toEqual([
      { id: 1, reason: 'not_found' },
      { id: 2, reason: 'not_eligible' },
      { id: 3, reason: 'already_blocked' },
    ]);
  });

  it('SAVEPOINT-rollback isolates internal_error to one ID — others commit', async () => {
    mocks.mockFileGetById.mockImplementation((id: number) => ({ ...baseFile, id }));
    mocks.mockBlocklistAdd.mockImplementation((input: { file_id: number }) => {
      if (input.file_id === 2) throw new Error('boom');
      return baseBlRow;
    });
    const res = await POST(makeRequest({ ids: [1, 2, 3] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.successCount).toBe(2);
    expect(body.failed).toEqual([{ id: 2, reason: 'internal_error' }]);
    expect(mocks.mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ id: 2 }),
      'bulk-blocklist per-id internal_error',
    );
  });

  it('tx-throw → 500 internal_error', async () => {
    // Override db.transaction to make tx-call throw.
    vi.resetModules();
    vi.doMock('@/src/lib/db', () => ({
      getDb: () => ({
        prepare: () => ({ run: mocks.mockDbPrepareRun }),
        transaction: () => () => {
          throw new Error('db-corruption');
        },
      }),
      blocklistRepo: () => ({
        add: mocks.mockBlocklistAdd,
        findByFileId: mocks.mockBlocklistFindByFileId,
      }),
      fileRepo: () => ({
        getById: mocks.mockFileGetById,
        setStatus: mocks.mockFileSetStatus,
      }),
      default: {},
    }));
    const { POST: POST2 } = await import('@/app/api/library/bulk-blocklist/route');
    const res = await POST2(makeRequest({ ids: [1] }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('internal_error');
  });

  it('all-failed-known-reasons still returns 200 (audit M2)', async () => {
    mocks.mockFileGetById.mockReturnValue(undefined); // every id → not_found
    const res = await POST(makeRequest({ ids: [1, 2, 3] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.successCount).toBe(0);
    expect(body.failed.length).toBe(3);
    expect(body.failed.every((f: { reason: string }) => f.reason === 'not_found')).toBe(true);
  });
});
