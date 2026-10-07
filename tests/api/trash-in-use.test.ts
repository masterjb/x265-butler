// A trash row is written before its original is moved, and the move can take
// minutes across filesystems. While the file's job is still encoding, restore
// and permanent delete refuse the entry, so neither can act on a half-moved file.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { JobRow, TrashEntryRow } from '@/src/lib/db/schema';

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  restore: vi.fn(),
  deleteRow: vi.fn(),
  findJobByFileId: vi.fn(),
  dbRun: vi.fn(),
  fsUnlink: vi.fn(),
  move: vi.fn(),
}));

vi.mock('@/src/lib/db', () => ({
  getDb: () => ({
    prepare: () => ({ run: mocks.dbRun }),
    transaction: <T>(fn: T) => fn,
  }),
  trashRepo: () => ({
    findById: mocks.findById,
    restore: mocks.restore,
    deleteRow: mocks.deleteRow,
  }),
  fileRepo: () => ({ getById: () => undefined, setStatus: () => true }),
  jobRepo: () => ({ findByFileId: mocks.findJobByFileId }),
  default: {},
  shareRepo: () => ({ listAll: () => [] }),
}));

vi.mock('@/src/lib/server-init', () => ({ ensureServerInit: vi.fn(), default: {} }));
vi.mock('@/src/lib/fs-helpers', () => ({ moveAcrossFilesystems: mocks.move }));
vi.mock('node:fs/promises', () => ({
  default: { unlink: mocks.fsUnlink },
  unlink: mocks.fsUnlink,
}));
vi.mock('@/src/lib/logger', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), telemetry: vi.fn() };
  return { logger: { ...log, child: () => log }, default: {} };
});

import { POST as restorePost } from '@/app/api/trash/[id]/restore/route';
import { POST as bulkRestorePost } from '@/app/api/trash/bulk-restore/route';
import { POST as bulkDeletePost } from '@/app/api/trash/bulk-delete/route';
import { isTrashEntryInUse } from '@/src/lib/trash/in-use';

const entry: TrashEntryRow = {
  id: 5,
  file_id: 7,
  original_path: '/media/A.mkv',
  trash_path: '/cache/trash/9-20260101000000/A.mkv',
  size_bytes: 10,
  trashed_at: 1,
  expires_at: 2,
  restored_at: null,
};

function job(status: JobRow['status']): Partial<JobRow> {
  return { id: 9, file_id: 7, status };
}

function post(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.findById.mockReturnValue(entry);
  mocks.restore.mockReturnValue(true);
  mocks.deleteRow.mockReturnValue(true);
});

describe('isTrashEntryInUse', () => {
  it('is true only while the latest job of the file is encoding', () => {
    const jobs = { findByFileId: vi.fn() };
    jobs.findByFileId.mockReturnValue(job('encoding'));
    expect(isTrashEntryInUse(entry, jobs)).toBe(true);
    for (const s of ['done', 'failed', 'queued', 'cancelled', 'interrupted'] as const) {
      jobs.findByFileId.mockReturnValue(job(s));
      expect(isTrashEntryInUse(entry, jobs)).toBe(false);
    }
    jobs.findByFileId.mockReturnValue(undefined);
    expect(isTrashEntryInUse(entry, jobs)).toBe(false);
    expect(isTrashEntryInUse({ file_id: null }, jobs)).toBe(false);
  });
});

describe('routes refuse entries whose file is encoding', () => {
  beforeEach(() => {
    mocks.findJobByFileId.mockReturnValue(job('encoding'));
  });

  it('restore refuses an entry whose file is encoding', async () => {
    const res = await restorePost(post('http://t/api/trash/5/restore', {}), {
      params: Promise.resolve({ id: '5' }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('in_use');
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(mocks.move).not.toHaveBeenCalled();
  });

  it('bulk restore reports in_use', async () => {
    const res = await bulkRestorePost(post('http://t/api/trash/bulk-restore', { ids: [5] }));
    const body = await res.json();
    expect(body.failed).toEqual([{ id: 5, reason: 'in_use' }]);
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(mocks.move).not.toHaveBeenCalled();
  });

  it('bulk delete reports in_use', async () => {
    const res = await bulkDeletePost(post('http://t/api/trash/bulk-delete', { ids: [5] }));
    const body = await res.json();
    expect(body.failed).toEqual([{ id: 5, reason: 'in_use' }]);
    expect(mocks.deleteRow).not.toHaveBeenCalled();
    expect(mocks.fsUnlink).not.toHaveBeenCalled();
  });
});

describe('unchanged without a running job', () => {
  beforeEach(() => {
    mocks.findJobByFileId.mockReturnValue(job('done'));
    mocks.fsUnlink.mockResolvedValue(undefined);
  });

  it('bulk delete still deletes', async () => {
    const res = await bulkDeletePost(post('http://t/api/trash/bulk-delete', { ids: [5] }));
    const body = await res.json();
    expect(body.failed).toEqual([]);
    expect(mocks.deleteRow).toHaveBeenCalledWith(5);
  });

  it('bulk restore still restores', async () => {
    mocks.move.mockResolvedValue(undefined);
    const res = await bulkRestorePost(post('http://t/api/trash/bulk-restore', { ids: [5] }));
    const body = await res.json();
    expect(body.failed).toEqual([]);
    expect(mocks.restore).toHaveBeenCalledWith(5);
  });
});
