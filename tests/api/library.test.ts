import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FileRow, ShareRow } from '@/src/lib/db/schema';
import type { CountByStatus, ListResult } from '@/src/lib/db/repos/file';

const { mockListPaginated, mockCountByStatus, mockCountOrphaned, mockShareListAll, mockLogWarn } =
  vi.hoisted(() => ({
    mockListPaginated: vi.fn<(opts: unknown) => ListResult>(),
    mockCountByStatus: vi.fn<() => CountByStatus>(),
    mockCountOrphaned: vi.fn<() => number>(),
    mockShareListAll: vi.fn<() => ShareRow[]>(),
    mockLogWarn: vi.fn(),
  }));

vi.mock('@/src/lib/db', () => ({
  fileRepo: () => ({
    listPaginated: mockListPaginated,
    countByStatus: mockCountByStatus,
    countOrphaned: mockCountOrphaned,
  }),
  shareRepo: () => ({
    listAll: mockShareListAll,
  }),
  default: {},
}));

vi.mock('@/src/lib/logger', () => ({
  logger: {
    child: () => ({
      warn: mockLogWarn,
      info: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

import { GET } from '@/app/api/library/route';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const emptyCounts: CountByStatus = {
  all: 0,
  pending: 0,
  queued: 0,
  encoding: 0,
  'done-smaller': 0,
  'done-larger': 0,
  'skipped-codec': 0,
  'skipped-bitrate': 0,
  'skipped-suffix': 0,
  'skipped-tag': 0,
  'skipped-sidecar': 0,
  'skipped-blocklist': 0,
  failed: 0,
  blocklisted: 0,
  interrupted: 0,
  vanished: 0,
  // 05-13: 3-bucket verdict + sidecar-driven skip evolution.
  'done-not-worth': 0,
  'done-already-evaluated': 0,
};

const sampleRow: FileRow = {
  id: 1,
  path: '/media/x.mp4',
  size_bytes: 1024,
  mtime: 1_700_000_000,
  content_hash: 'a'.repeat(64),
  codec: 'h264',
  bitrate: 1_000_000,
  duration_seconds: 60,
  width: 1920,
  height: 1080,
  container: 'mp4',
  status: 'pending',
  last_scanned_at: 1_700_000_100,
  created_at: 1_700_000_000,
  updated_at: 1_700_000_100,
  version: 0,
  container_override: null,
  share_id: null,
};

function getReq(query = ''): Request {
  return new Request(`http://localhost/api/library${query}`);
}

describe('GET /api/library', () => {
  beforeEach(() => {
    mockListPaginated.mockReset();
    mockCountByStatus.mockReset();
    mockCountByStatus.mockReturnValue(emptyCounts);
    mockCountOrphaned.mockReset();
    mockCountOrphaned.mockReturnValue(0);
    mockShareListAll.mockReset();
    mockShareListAll.mockReturnValue([]);
    mockLogWarn.mockReset();
  });

  it('test_GET_when_no_params_then_200_default_page_1_size_25_sort_size_desc', async () => {
    mockListPaginated.mockReturnValue({ rows: [sampleRow], total: 1 });
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = await res.json();
    expect(body.pagination).toEqual({ page: 1, size: 25, total: 1, pageCount: 1 });
    expect(body.rows).toHaveLength(1);
    expect(body.requestId).toMatch(UUID_V4);
    expect(body.effectiveFilters.sort).toBe('size');
    expect(body.effectiveFilters.dir).toBe('desc');
    const opts = mockListPaginated.mock.calls[0][0] as {
      sort: string;
      dir: string;
      page: number;
      size: number;
    };
    expect(opts.sort).toBe('size');
    expect(opts.dir).toBe('desc');
    expect(opts.page).toBe(1);
    expect(opts.size).toBe(25);
  });

  it('test_GET_when_filter_sort_page_size_then_passed_to_repo', async () => {
    mockListPaginated.mockReturnValue({ rows: [], total: 0 });
    const res = await GET(getReq('?status=pending&q=movie&sort=scanned&dir=asc&page=2&size=10'));
    expect(res.status).toBe(200);
    const opts = mockListPaginated.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.status).toBe('pending');
    expect(opts.q).toBe('movie');
    expect(opts.sort).toBe('scanned');
    expect(opts.dir).toBe('asc');
    expect(opts.page).toBe(2);
    expect(opts.size).toBe(10);
    const body = await res.json();
    expect(body.effectiveFilters).toEqual({
      q: 'movie',
      status: 'pending',
      sort: 'scanned',
      dir: 'asc',
      // 14-03: additive `share` key — `undefined` serialized as missing.
      share: undefined,
    });
    expect(body.pagination.pageCount).toBe(0);
  });

  it('test_GET_when_page_zero_then_400_invalid_query', async () => {
    const res = await GET(getReq('?page=0'));
    expect(res.status).toBe(400);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.error).toBe('invalid_query');
    expect(body.requestId).toMatch(UUID_V4);
  });

  it('test_GET_when_page_negative_then_400', async () => {
    const res = await GET(getReq('?page=-1'));
    expect(res.status).toBe(400);
  });

  it('test_GET_when_sort_invalid_then_400', async () => {
    const res = await GET(getReq('?sort=hacked'));
    expect(res.status).toBe(400);
  });

  it('test_GET_when_size_over_200_then_400', async () => {
    const res = await GET(getReq('?size=201'));
    expect(res.status).toBe(400);
  });

  it('test_GET_when_empty_db_then_200_with_zero_total_zero_pageCount', async () => {
    mockListPaginated.mockReturnValue({ rows: [], total: 0 });
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pagination.total).toBe(0);
    expect(body.pagination.pageCount).toBe(0);
    expect(body.rows).toEqual([]);
  });

  it('test_GET_when_repo_throws_then_500_with_requestId', async () => {
    mockListPaginated.mockImplementation(() => {
      throw new Error('boom');
    });
    const res = await GET(getReq());
    expect(res.status).toBe(500);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.error).toBe('internal_error');
    expect(body.requestId).toMatch(UUID_V4);
  });

  it('test_GET_when_called_multiple_times_then_each_response_has_unique_requestId', async () => {
    mockListPaginated.mockReturnValue({ rows: [], total: 0 });
    const r1 = await (await GET(getReq())).json();
    const r2 = await (await GET(getReq())).json();
    expect(r1.requestId).not.toBe(r2.requestId);
    expect(r1.requestId).toMatch(UUID_V4);
  });

  it('test_GET_when_pagination_then_pageCount_is_ceil_total_over_size', async () => {
    mockListPaginated.mockReturnValue({ rows: [], total: 247 });
    const res = await GET(getReq('?size=50'));
    const body = await res.json();
    expect(body.pagination.pageCount).toBe(5);
  });

  it('test_GET_when_status_all_then_passed_through', async () => {
    mockListPaginated.mockReturnValue({ rows: [], total: 0 });
    await GET(getReq('?status=all'));
    const opts = mockListPaginated.mock.calls[0][0] as { status: string };
    expect(opts.status).toBe('all');
  });

  // 14-03: share-axis filter
  it('test_GET_when_share_numeric_then_shareId_forwarded_and_reflected', async () => {
    mockListPaginated.mockReturnValue({ rows: [sampleRow], total: 1 });
    mockShareListAll.mockReturnValue([
      {
        id: 2,
        name: 'Movies',
        path: '/movies',
        min_size_mb: 1,
        extensions_csv: 'mkv',
        max_depth: null,
        created_at: 0,
        updated_at: 0,
      },
    ]);
    const res = await GET(getReq('?share=2'));
    expect(res.status).toBe(200);
    const opts = mockListPaginated.mock.calls[0][0] as { shareId: unknown };
    expect(opts.shareId).toBe(2);
    const body = await res.json();
    expect(body.effectiveFilters.share).toBe(2);
  });

  it('test_GET_when_share_orphan_then_shareId_literal_orphan_forwarded', async () => {
    mockListPaginated.mockReturnValue({ rows: [], total: 0 });
    const res = await GET(getReq('?share=orphan'));
    expect(res.status).toBe(200);
    const opts = mockListPaginated.mock.calls[0][0] as { shareId: unknown };
    expect(opts.shareId).toBe('orphan');
    const body = await res.json();
    expect(body.effectiveFilters.share).toBe('orphan');
  });

  it('test_GET_when_share_all_then_shareId_undefined_no_filter', async () => {
    mockListPaginated.mockReturnValue({ rows: [], total: 0 });
    const res = await GET(getReq('?share=all'));
    expect(res.status).toBe(200);
    const opts = mockListPaginated.mock.calls[0][0] as { shareId: unknown };
    expect(opts.shareId).toBeUndefined();
    const body = await res.json();
    expect(body.effectiveFilters.share).toBe('all');
  });

  it('test_GET_counts_orphan_always_present_in_response', async () => {
    mockListPaginated.mockReturnValue({ rows: [], total: 0 });
    mockCountOrphaned.mockReturnValue(7);
    const res = await GET(getReq());
    const body = await res.json();
    expect(body.counts.orphan).toBe(7);
    expect(typeof body.counts.pending).toBe('number'); // status counts preserved
  });

  // audit-added M1: AC-16 API slice — invalid / non-existent share-id
  it('test_GET_when_share_id_nonexistent_then_200_and_warn_log_fires', async () => {
    mockListPaginated.mockReturnValue({ rows: [], total: 0 });
    mockShareListAll.mockReturnValue([
      {
        id: 1,
        name: 'OnlyShare',
        path: '/x',
        min_size_mb: 1,
        extensions_csv: 'mkv',
        max_depth: null,
        created_at: 0,
        updated_at: 0,
      },
    ]);
    const res = await GET(getReq('?share=99999'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows).toEqual([]);
    expect(body.pagination.total).toBe(0);
    // M1: effectiveFilters reflects supplied id (NOT sanitized) so UI can mark active-state
    expect(body.effectiveFilters.share).toBe(99999);
    expect(mockLogWarn).toHaveBeenCalled();
    const warnArgs = mockLogWarn.mock.calls[0] as [Record<string, unknown>, string];
    expect(warnArgs[0]).toMatchObject({ requestedShareId: 99999 });
    expect(warnArgs[1]).toMatch(/share-id not in shares-table/);
  });

  // audit-added SR3: AC-18 `?file=N&share=M` AND-composition
  it('test_GET_when_file_and_share_mismatch_then_200_zero_rows', async () => {
    mockListPaginated.mockReturnValue({ rows: [], total: 0 });
    mockShareListAll.mockReturnValue([
      {
        id: 2,
        name: 'M',
        path: '/m',
        min_size_mb: 1,
        extensions_csv: 'mkv',
        max_depth: null,
        created_at: 0,
        updated_at: 0,
      },
    ]);
    const res = await GET(getReq('?file=42&share=2'));
    expect(res.status).toBe(200);
    const opts = mockListPaginated.mock.calls[0][0] as { idFilter: unknown; shareId: unknown };
    expect(opts.idFilter).toBe(42);
    expect(opts.shareId).toBe(2);
    const body = await res.json();
    expect(body.rows).toEqual([]);
    expect(body.pagination.total).toBe(0);
  });
});
