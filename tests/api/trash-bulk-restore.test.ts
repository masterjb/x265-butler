import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { TrashEntryRow } from '@/src/lib/db/schema';

const mocks = vi.hoisted(() => ({
  mockDbPrepareRun: vi.fn(),
  mockTrashFindById: vi.fn(),
  mockTrashRestore: vi.fn(),
  mockFileGetById: vi.fn(),
  mockFileSetStatus: vi.fn(),
  mockMoveAcrossFs: vi.fn(),
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
  trashRepo: () => ({
    findById: mocks.mockTrashFindById,
    restore: mocks.mockTrashRestore,
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

vi.mock('@/src/lib/fs-helpers', () => ({
  moveAcrossFilesystems: mocks.mockMoveAcrossFs,
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

import { POST, runtime } from '@/app/api/trash/bulk-restore/route';

const ROUTE_URL = 'http://test/api/trash/bulk-restore';

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
  mocks.mockTrashRestore.mockReturnValue(true);
  mocks.mockFileGetById.mockReturnValue({ id: 7, version: 0, status: 'done-smaller' });
  mocks.mockFileSetStatus.mockReturnValue(true);
  mocks.mockMoveAcrossFs.mockReturnValue(undefined);
});

describe('POST /api/trash/bulk-restore', () => {
  it('runtime is nodejs', () => {
    expect(runtime).toBe('nodejs');
  });

  it('happy path — 2 IDs success → 200 + moveAcrossFilesystems called per id', async () => {
    mocks.mockTrashFindById.mockImplementation((id: number) => ({
      ...baseEntry,
      id,
      trash_path: `/cache/trash/${id}.mkv`,
      original_path: `/movies/${id}.mkv`,
    }));
    const res = await POST(makeRequest({ ids: [1, 2] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.successCount).toBe(2);
    expect(body.failed).toEqual([]);
    expect(mocks.mockTrashRestore).toHaveBeenCalledTimes(2);
    expect(mocks.mockMoveAcrossFs).toHaveBeenCalledTimes(2);
    expect(mocks.mockMoveAcrossFs).toHaveBeenCalledWith('/cache/trash/1.mkv', '/movies/1.mkv');
    expect(mocks.mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ audit: 'bulk_trash_restore', successCount: 2 }),
      'bulk_trash_restore',
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

  it('400 on zod fail — ids missing', async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
  });

  it('partial-success — not_found + already_restored + success', async () => {
    mocks.mockTrashFindById.mockImplementation((id: number) => {
      if (id === 1) return undefined;
      if (id === 2) return { ...baseEntry, id: 2, restored_at: 1700001000 };
      if (id === 3) return { ...baseEntry, id: 3 };
      return undefined;
    });
    const res = await POST(makeRequest({ ids: [1, 2, 3] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.successCount).toBe(1);
    expect(body.failed).toEqual([
      { id: 1, reason: 'not_found' },
      { id: 2, reason: 'already_restored' },
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
      'bulk-restore per-id internal_error',
    );
  });

  it('post-commit moveAcrossFilesystems failure → fs_orphan + warning logged', async () => {
    mocks.mockTrashFindById.mockReturnValue({ ...baseEntry });
    const eacces = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    mocks.mockMoveAcrossFs.mockImplementationOnce(() => {
      throw eacces;
    });
    const res = await POST(makeRequest({ ids: [1] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.successCount).toBe(0);
    expect(body.failed).toEqual([{ id: 1, reason: 'fs_orphan' }]);
    expect(mocks.mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        audit: 'bulk_trash_restore_orphan_warning',
        id: 1,
        errno: 'EACCES',
      }),
      'fs-op failed post-commit',
    );
  });

  it('file-status flip best-effort warns on OCC-fail (not added to failed[])', async () => {
    mocks.mockTrashFindById.mockReturnValue({ ...baseEntry });
    mocks.mockFileSetStatus.mockReturnValue(false); // OCC mismatch on file flip
    const res = await POST(makeRequest({ ids: [1] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.successCount).toBe(1); // trash restore committed regardless
    expect(body.failed).toEqual([]);
    expect(mocks.mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, fileId: 7 }),
      'file-status flip returned false; trash restore committed regardless',
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
        restore: mocks.mockTrashRestore,
      }),
      fileRepo: () => ({
        getById: mocks.mockFileGetById,
        setStatus: mocks.mockFileSetStatus,
      }),
      default: {},
    }));
    const { POST: POST2 } = await import('@/app/api/trash/bulk-restore/route');
    const res = await POST2(makeRequest({ ids: [1] }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('internal_error');
  });
});
