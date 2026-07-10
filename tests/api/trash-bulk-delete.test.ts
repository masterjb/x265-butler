import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { TrashEntryRow } from '@/src/lib/db/schema';

const mocks = vi.hoisted(() => ({
  mockDbPrepareRun: vi.fn(),
  mockTrashFindById: vi.fn(),
  mockTrashDeleteRow: vi.fn(),
  mockEnsureServerInit: vi.fn(),
  mockFsUnlink: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock('@/src/lib/db', () => ({
  getDb: () => ({
    prepare: () => ({ run: mocks.mockDbPrepareRun }),
    transaction: <T>(fn: T) => fn,
  }),
  trashRepo: () => ({
    findById: mocks.mockTrashFindById,
    deleteRow: mocks.mockTrashDeleteRow,
  }),
  default: {},
  shareRepo: () => ({ listAll: () => [] }),
}));

vi.mock('@/src/lib/server-init', () => ({
  ensureServerInit: mocks.mockEnsureServerInit,
  default: {},
}));

vi.mock('node:fs/promises', () => ({
  default: {
    unlink: mocks.mockFsUnlink,
  },
  unlink: mocks.mockFsUnlink,
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

import { POST, runtime } from '@/app/api/trash/bulk-delete/route';

const ROUTE_URL = 'http://test/api/trash/bulk-delete';

function makeRequest(body?: unknown, headers?: Record<string, string>): Request {
  return new Request(ROUTE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const baseEntry: TrashEntryRow = {
  id: 1,
  file_id: 7,
  original_path: '/movies/A.mkv',
  trash_path: '/cache/trash/A.mkv',
  size_bytes: 1024,
  trashed_at: 1700000000,
  expires_at: 1702592000,
  restored_at: null,
};

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.mockTrashDeleteRow.mockReturnValue(true);
  mocks.mockFsUnlink.mockResolvedValue(undefined);
});

describe('POST /api/trash/bulk-delete', () => {
  it('runtime is nodejs', () => {
    expect(runtime).toBe('nodejs');
  });

  it('happy path — 2 IDs success → 200 successCount=2 + fs unlink called', async () => {
    mocks.mockTrashFindById.mockImplementation((id: number) => ({
      ...baseEntry,
      id,
      trash_path: `/cache/trash/${id}.mkv`,
    }));
    const res = await POST(makeRequest({ ids: [1, 2] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.successCount).toBe(2);
    expect(body.failed).toEqual([]);
    expect(mocks.mockTrashDeleteRow).toHaveBeenCalledTimes(2);
    expect(mocks.mockFsUnlink).toHaveBeenCalledTimes(2);
    expect(mocks.mockFsUnlink).toHaveBeenCalledWith('/cache/trash/1.mkv');
    expect(mocks.mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ audit: 'bulk_trash_delete', successCount: 2 }),
      'bulk_trash_delete',
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

  it('400 on zod fail — empty ids', async () => {
    const res = await POST(makeRequest({ ids: [] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
  });

  it('partial-success — not_found + already-restored (not_eligible) + success', async () => {
    mocks.mockTrashFindById.mockImplementation((id: number) => {
      if (id === 1) return undefined; // not_found
      if (id === 2) return { ...baseEntry, id: 2, restored_at: 1700001000 }; // not_eligible
      if (id === 3) return { ...baseEntry, id: 3 }; // success
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

  it('SAVEPOINT-rollback isolates internal_error to one ID', async () => {
    mocks.mockTrashFindById.mockImplementation((id: number) => {
      if (id === 2) throw new Error('boom');
      return { ...baseEntry, id };
    });
    const res = await POST(makeRequest({ ids: [1, 2, 3] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.successCount).toBe(2);
    expect(body.failed).toEqual([{ id: 2, reason: 'internal_error' }]);
    expect(mocks.mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ id: 2 }),
      'bulk-delete per-id internal_error',
    );
  });

  it('post-commit ENOENT = soft-degrade success (NO failed entry)', async () => {
    mocks.mockTrashFindById.mockReturnValue({ ...baseEntry });
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mocks.mockFsUnlink.mockRejectedValueOnce(enoent);
    const res = await POST(makeRequest({ ids: [1] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.successCount).toBe(1); // soft-degrade success
    expect(body.failed).toEqual([]);
  });

  it('post-commit EACCES → fs_orphan in failed[] + orphan_warning logged', async () => {
    mocks.mockTrashFindById.mockReturnValue({ ...baseEntry });
    const eacces = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    mocks.mockFsUnlink.mockRejectedValueOnce(eacces);
    const res = await POST(makeRequest({ ids: [1] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.successCount).toBe(0);
    expect(body.failed).toEqual([{ id: 1, reason: 'fs_orphan' }]);
    expect(mocks.mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        audit: 'bulk_trash_delete_orphan_warning',
        id: 1,
        errno: 'EACCES',
      }),
      'fs-op failed post-commit',
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
      trashRepo: () => ({
        findById: mocks.mockTrashFindById,
        deleteRow: mocks.mockTrashDeleteRow,
      }),
      default: {},
    }));
    const { POST: POST2 } = await import('@/app/api/trash/bulk-delete/route');
    const res = await POST2(makeRequest({ ids: [1] }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('internal_error');
  });
});
