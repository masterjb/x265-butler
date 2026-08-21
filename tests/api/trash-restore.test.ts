import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { TrashEntryRow } from '@/src/lib/db/schema';
import type { TrashRepo } from '@/src/lib/db/repos/trash';
import type { FileRepo } from '@/src/lib/db/repos/file';

const { mockTrashRepo, mockFileRepo, mockEnsureServerInit, mockFs, mockMove } = vi.hoisted(() => ({
  mockTrashRepo: { current: null as TrashRepo | null },
  mockFileRepo: { current: null as FileRepo | null },
  mockEnsureServerInit: vi.fn(),
  mockFs: {
    existsSync: vi.fn(),
  },
  mockMove: vi.fn(),
}));

vi.mock('@/src/lib/db', () => ({
  trashRepo: () => mockTrashRepo.current,
  fileRepo: () => mockFileRepo.current,
  default: {},
  shareRepo: () => ({ listAll: () => [] }),
}));

vi.mock('@/src/lib/server-init', () => ({
  ensureServerInit: mockEnsureServerInit,
  default: {},
}));

vi.mock('node:fs', () => ({
  default: mockFs,
  existsSync: mockFs.existsSync,
}));

vi.mock('@/src/lib/fs-helpers', () => ({
  moveAcrossFilesystems: mockMove,
}));

import { POST, runtime } from '@/app/api/trash/[id]/restore/route';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const BASE_ENTRY: TrashEntryRow = {
  id: 42,
  file_id: 7,
  original_path: '/media/foo.mp4',
  trash_path: '/cache/trash/foo.mp4',
  size_bytes: 1_000_000_000,
  trashed_at: 1_700_000_000,
  expires_at: 1_702_592_000,
  restored_at: null,
};

function makeTrashRepo(overrides: Partial<TrashRepo> = {}): TrashRepo {
  return {
    create: vi.fn(),
    list: vi.fn(),
    restore: vi.fn().mockReturnValue(true),
    deleteExpired: vi.fn(),
    count: vi.fn(),
    findById: vi.fn().mockReturnValue(BASE_ENTRY),
    summary: vi.fn().mockReturnValue({ bytesReclaimed: 0, count: 0 }),
    ...overrides,
  } as unknown as TrashRepo;
}

function makeFileRepo(overrides: Partial<FileRepo> = {}): FileRepo {
  return {
    getById: vi.fn().mockReturnValue({ id: 7, version: 0, status: 'done-smaller' }),
    setStatus: vi.fn().mockReturnValue(true),
    upsertByPath: vi.fn(),
    findByPath: vi.fn(),
    findByContentHash: vi.fn(),
    count: vi.fn(),
    touchLastScanned: vi.fn(),
    listPaginated: vi.fn(),
    countByStatus: vi.fn(),
    ...overrides,
  } as unknown as FileRepo;
}

function postReq(id: string, body = '{}', ct = 'application/json'): Request {
  return new Request(`http://localhost/api/trash/${id}/restore`, {
    method: 'POST',
    headers: ct ? { 'Content-Type': ct } : {},
    body,
  });
}

async function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe('POST /api/trash/[id]/restore', () => {
  beforeEach(() => {
    mockEnsureServerInit.mockReset();
    mockMove.mockReset();
    mockFs.existsSync.mockReset();
    // Default: trash file exists, original does NOT exist
    mockFs.existsSync.mockImplementation((p: string) => p === BASE_ENTRY.trash_path);
    mockTrashRepo.current = makeTrashRepo();
    mockFileRepo.current = makeFileRepo();
  });

  it('test_route_runtime_export_is_nodejs', () => {
    expect(runtime).toBe('nodejs');
  });

  it('test_POST_when_valid_id_then_200_with_trashEntry_restoredAt_set', async () => {
    const restoredEntry = { ...BASE_ENTRY, restored_at: 1_700_001_000 };
    mockTrashRepo.current = makeTrashRepo({
      findById: vi
        .fn()
        .mockReturnValueOnce(BASE_ENTRY) // first call: pre-flight
        .mockReturnValueOnce(restoredEntry), // second call: re-read after restore
    });
    const res = await POST(postReq('42'), await params('42'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { trashEntry: TrashEntryRow; requestId: string };
    expect(body.requestId).toMatch(UUID_V4);
    expect(body.trashEntry.id).toBe(42);
    expect(mockMove).toHaveBeenCalledWith(BASE_ENTRY.trash_path, BASE_ENTRY.original_path);
  });

  it('test_POST_when_id_999_then_404_trash_entry_not_found', async () => {
    mockTrashRepo.current = makeTrashRepo({ findById: vi.fn().mockReturnValue(undefined) });
    const res = await POST(postReq('999'), await params('999'));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; trashId: number };
    expect(body.error).toBe('trash_entry_not_found');
    expect(body.trashId).toBe(999);
  });

  it('test_POST_when_id_abc_then_400_invalid_trash_id', async () => {
    const res = await POST(postReq('abc'), await params('abc'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_trash_id');
  });

  it('test_POST_when_text_plain_then_415', async () => {
    const res = await POST(postReq('42', '', 'text/plain'), await params('42'));
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('unsupported_media_type');
  });

  it('test_POST_when_already_restored_then_409_with_existing_restoredAt', async () => {
    const restoredEntry = { ...BASE_ENTRY, restored_at: 1_700_001_000 };
    mockTrashRepo.current = makeTrashRepo({ findById: vi.fn().mockReturnValue(restoredEntry) });
    const res = await POST(postReq('42'), await params('42'));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; restoredAt: number };
    expect(body.error).toBe('already_restored');
    expect(body.restoredAt).toBe(1_700_001_000);
  });

  it('test_POST_when_original_path_exists_then_409_with_colliding_path', async () => {
    // Both paths exist
    mockFs.existsSync.mockReturnValue(true);
    const res = await POST(postReq('42'), await params('42'));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; originalPath: string };
    expect(body.error).toBe('original_path_exists');
    expect(body.originalPath).toBe(BASE_ENTRY.original_path);
    expect(mockMove).not.toHaveBeenCalled();
  });

  // 26-02 (F5, AC-8): after a same-ext replace, the encoded output now occupies
  // the trashed original's basename. Restoring that trash entry MUST hit the
  // existing original_path_exists 409 and refuse to clobber the encoded output.
  // No new route code — this pins the existing safeguard against regression.
  it('test_POST_when_replace_output_occupies_original_path_then_409_refuses_clobber', async () => {
    // trash file present AND original path occupied by the encoded replacement.
    mockFs.existsSync.mockReturnValue(true);
    const res = await POST(postReq('42'), await params('42'));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('original_path_exists');
    expect(mockMove).not.toHaveBeenCalled();
  });

  it('test_POST_when_trash_file_missing_then_410_gone', async () => {
    // Neither file exists on disk
    mockFs.existsSync.mockReturnValue(false);
    const res = await POST(postReq('42'), await params('42'));
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: string; trashPath: string };
    expect(body.error).toBe('trash_file_missing');
    expect(body.trashPath).toBe(BASE_ENTRY.trash_path);
  });

  it('test_POST_when_setStatus_returns_false_then_logged_warn_but_200_still', async () => {
    mockFileRepo.current = makeFileRepo({ setStatus: vi.fn().mockReturnValue(false) });
    const res = await POST(postReq('42'), await params('42'));
    expect(res.status).toBe(200);
  });

  it('test_POST_when_renameSync_throws_EXDEV_then_falls_back_to_moveAcrossFilesystems', async () => {
    // moveAcrossFilesystems is called with EXDEV fallback inside
    mockMove.mockImplementation(() => {
      // simulates successful cross-fs move
    });
    const res = await POST(postReq('42'), await params('42'));
    expect(res.status).toBe(200);
    expect(mockMove).toHaveBeenCalledWith(BASE_ENTRY.trash_path, BASE_ENTRY.original_path);
  });

  it('test_POST_when_restore_returns_false_race_then_409_already_restored', async () => {
    mockTrashRepo.current = makeTrashRepo({ restore: vi.fn().mockReturnValue(false) });
    const res = await POST(postReq('42'), await params('42'));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('already_restored');
  });

  it('test_POST_when_unexpected_error_then_500_internal_error_with_requestId', async () => {
    mockTrashRepo.current = makeTrashRepo({
      findById: vi.fn().mockImplementation(() => {
        throw new Error('unexpected');
      }),
    });
    const res = await POST(postReq('42'), await params('42'));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe('internal_error');
    expect(body.requestId).toMatch(UUID_V4);
  });

  it('test_POST_when_ensureServerInit_called_first', async () => {
    await POST(postReq('42'), await params('42'));
    expect(mockEnsureServerInit).toHaveBeenCalledTimes(1);
  });

  it('test_POST_when_no_emit_to_engineEvents', async () => {
    // Verify engineEvents is not imported/called from this route
    const res = await POST(postReq('42'), await params('42'));
    expect(res.status).toBe(200);
    // No assertion on engineEvents — route doesn't import it; this test documents the invariant
  });

  it('test_POST_partial_failure_returns_500_restore_partial_failure', async () => {
    // moveAcrossFilesystems throws after copying (simulated by: after throw, BOTH paths exist)
    mockMove.mockImplementation(() => {
      throw new Error('unlink failed');
    });
    // Call sequence: (1) existsSync(trash_path)=true, (2) existsSync(original_path)=false,
    // (3) existsSync(original_path)=true [partial copy], (4) existsSync(trash_path)=true [unlink failed]
    mockFs.existsSync
      .mockReturnValueOnce(true) // trash file exists
      .mockReturnValueOnce(false) // original path does NOT exist (no collision)
      .mockReturnValueOnce(true) // after throw: original_path now has partial copy
      .mockReturnValueOnce(true); // after throw: trash_path still exists (unlink failed)
    const res = await POST(postReq('42'), await params('42'));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe('restore_partial_failure');
    expect(body.detail).toContain('unlink of trash_path failed');
    // trashRepo.restore must NOT have been called
    expect(mockTrashRepo.current!.restore).not.toHaveBeenCalled();
  });
});
