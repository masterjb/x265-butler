import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@/src/lib/db/migrate';
import { makeFileRepo } from '@/src/lib/db/repos/file';
import { makeTrashRepo, type TrashRepo } from '@/src/lib/db/repos/trash';

type Db = InstanceType<typeof Database>;

const { mockTrashRepo, mockEnsureServerInit } = vi.hoisted(() => ({
  mockTrashRepo: { current: null as TrashRepo | null },
  mockEnsureServerInit: vi.fn(),
}));

vi.mock('@/src/lib/db', () => ({
  trashRepo: () => mockTrashRepo.current,
  default: {},
  shareRepo: () => ({ listAll: () => [] }),
}));

vi.mock('@/src/lib/server-init', () => ({
  ensureServerInit: mockEnsureServerInit,
  default: {},
}));

import { GET, runtime } from '@/app/api/trash/route';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function getReq(query = ''): Request {
  return new Request(`http://localhost/api/trash${query}`, { method: 'GET' });
}

describe('GET /api/trash', () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    db.pragma('foreign_keys = ON');
    const fileRepo = makeFileRepo(db);
    const repo = makeTrashRepo(db);
    mockTrashRepo.current = repo;
    mockEnsureServerInit.mockReset();

    // Seed 130 trash entries — distinct trash_paths required by UNIQUE constraint
    for (let i = 1; i <= 130; i++) {
      fileRepo.upsertByPath({
        path: `/m/f${i}.mp4`,
        size_bytes: 1000,
        mtime: 1_700_000_000 + i,
        content_hash: `h${i}`,
        codec: 'h264',
        bitrate: 1000,
        duration_seconds: 10,
        width: 100,
        height: 100,
        container: 'mp4',
        last_scanned_at: 1_700_000_000,

        share_id: null,
      });
      repo.create({
        file_id: i,
        original_path: `/m/f${i}.mp4`,
        trash_path: `/cache/trash/${i}-foo/f${i}.mp4`,
        size_bytes: 1000,
        retention_days: 30,
      });
    }
  });

  afterEach(() => {
    db.close();
    mockTrashRepo.current = null;
  });

  it('test_route_runtime_export_is_nodejs', () => {
    expect(runtime).toBe('nodejs');
  });

  it('test_GET_when_no_query_then_200_default_pagination', async () => {
    const response = await GET(getReq());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body.page).toBe(1);
    expect(body.size).toBe(50);
    expect(body.total).toBe(130);
    expect(body.totalPages).toBe(3);
    expect(body.rows).toHaveLength(50);
    expect(body.requestId).toMatch(UUID_V4);
    expect(mockEnsureServerInit).toHaveBeenCalledOnce();
  });

  it('test_GET_when_page_3_then_correct_slice', async () => {
    const response = await GET(getReq('?page=3&size=50'));
    const body = await response.json();
    expect(body.page).toBe(3);
    expect(body.rows).toHaveLength(30); // rows 101..130
    expect(body.total).toBe(130);
    expect(body.totalPages).toBe(3);
  });

  it('test_GET_when_page_999_then_empty_rows_but_correct_total', async () => {
    const response = await GET(getReq('?page=999&size=50'));
    const body = await response.json();
    expect(body.rows).toEqual([]);
    expect(body.total).toBe(130);
    expect(body.totalPages).toBe(3);
  });

  // audit-added S9: zod max(200) clamps via parse error (NOT silent)
  it('test_GET_when_size_9999_then_400_invalid_pagination', async () => {
    const response = await GET(getReq('?size=9999'));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('invalid_pagination');
  });

  it('test_GET_when_page_negative_then_400_invalid_pagination', async () => {
    const response = await GET(getReq('?page=-1'));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('invalid_pagination');
  });

  it('test_GET_when_page_abc_then_400_invalid_pagination', async () => {
    const response = await GET(getReq('?page=abc'));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('invalid_pagination');
  });

  it('test_GET_when_total_zero_then_totalPages_1_rows_empty', async () => {
    // Wipe all rows to test the zero case
    db.prepare('DELETE FROM trash_entry').run();
    const response = await GET(getReq());
    const body = await response.json();
    expect(body.rows).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.totalPages).toBe(1);
  });

  it('test_GET_when_extra_query_keys_then_400_zod_strict', async () => {
    const response = await GET(getReq('?page=1&foo=bar'));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('invalid_pagination');
  });
});
