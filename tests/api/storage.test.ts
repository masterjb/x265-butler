// 15-01 T4: /api/storage/* contract — 5 endpoints + auth + canonical empty +
// reflect-supplied unknown share + computedAt/dataAsOf + structured pino logs +
// uniform error-shape + SR1 truncated flag.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  KpiResult,
  BucketResult,
  CodecSlice,
  ShareTableRow,
  TopFoldersResult,
} from '@/src/lib/db/repos/storage';
import type { ShareRow } from '@/src/lib/db/schema';

type AuthDecision =
  | { ok: true; mode: 'disabled' | 'authenticated'; username: string | null }
  | { ok: false; status: 401; body: { error_code: 'auth_required' } };

const mocks = vi.hoisted(() => ({
  mockGetKpis: vi.fn<(opts: { shareId: 'all' | number }) => KpiResult>(),
  mockGetSizeBuckets: vi.fn<(opts: { shareId: 'all' | number }) => BucketResult[]>(),
  mockGetCodecPie: vi.fn<(opts: { shareId: 'all' | number }) => CodecSlice[]>(),
  mockGetSharesTable: vi.fn<() => ShareTableRow[]>(),
  mockGetTopFolders:
    vi.fn<(opts: { shareId: 'all' | number; depth: number; limit?: number }) => TopFoldersResult>(),
  mockShareListAll: vi.fn<() => ShareRow[]>(),
  mockRequireAuth: vi.fn<() => Promise<AuthDecision>>(),
  mockLogInfo: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock('@/src/lib/db', () => ({
  storageRepo: () => ({
    getKpis: mocks.mockGetKpis,
    getSizeBuckets: mocks.mockGetSizeBuckets,
    getCodecPie: mocks.mockGetCodecPie,
    getSharesTable: mocks.mockGetSharesTable,
    getTopFolders: mocks.mockGetTopFolders,
  }),
  shareRepo: () => ({ listAll: mocks.mockShareListAll }),
}));

vi.mock('@/src/lib/logger', () => ({
  logger: {
    child: () => ({
      info: mocks.mockLogInfo,
      warn: mocks.mockLogWarn,
      error: mocks.mockLogError,
    }),
  },
}));

vi.mock('@/src/lib/auth/require-auth', () => ({
  requireAuth: mocks.mockRequireAuth,
}));

import { GET as kpisGET } from '@/app/api/storage/kpis/route';
import { GET as bucketsGET } from '@/app/api/storage/buckets/route';
import { GET as codecPieGET } from '@/app/api/storage/codec-pie/route';
import { GET as sharesTableGET } from '@/app/api/storage/shares-table/route';
import { GET as topFoldersGET } from '@/app/api/storage/top-folders/route';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const emptyKpis: KpiResult = {
  totalSizeBytes: 0,
  largestFolder: null,
  mostOptimizedShare: null,
  legacyCodecPercent: 0,
};

const zeroBuckets: BucketResult[] = [
  { label: '<100MB', minBytes: 0, maxBytes: 0, fileCount: 0, totalBytes: 0 },
  { label: '100MB-1GB', minBytes: 0, maxBytes: 0, fileCount: 0, totalBytes: 0 },
  { label: '1-10GB', minBytes: 0, maxBytes: 0, fileCount: 0, totalBytes: 0 },
  { label: '10GB+', minBytes: 0, maxBytes: 0, fileCount: 0, totalBytes: 0 },
];

function getReq(endpoint: string, query = ''): Request {
  return new Request(`http://localhost/api/storage/${endpoint}${query}`);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.mockRequireAuth.mockResolvedValue({ ok: true, mode: 'disabled', username: null });
  mocks.mockGetKpis.mockReturnValue(emptyKpis);
  mocks.mockGetSizeBuckets.mockReturnValue(zeroBuckets);
  mocks.mockGetCodecPie.mockReturnValue([]);
  mocks.mockGetSharesTable.mockReturnValue([]);
  mocks.mockGetTopFolders.mockReturnValue({ rows: [], truncated: false });
  mocks.mockShareListAll.mockReturnValue([]);
});

describe('GET /api/storage/* — envelope invariants', () => {
  const endpoints: Array<{ name: string; handler: (r: Request) => Promise<Response> }> = [
    { name: 'kpis', handler: kpisGET },
    { name: 'buckets', handler: bucketsGET },
    { name: 'codec-pie', handler: codecPieGET },
    { name: 'shares-table', handler: sharesTableGET },
    { name: 'top-folders', handler: topFoldersGET },
  ];

  for (const ep of endpoints) {
    it(`${ep.name}: 200 response carries computedAt + dataAsOf (identical, live-SQL) + requestId`, async () => {
      const res = await ep.handler(getReq(ep.name));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/application\/json/);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = await res.json();
      expect(body.computedAt).toMatch(ISO_UTC);
      expect(body.dataAsOf).toBe(body.computedAt);
      expect(body.requestId).toMatch(UUID_V4);
    });
  }

  it('storage_query_executed info-log emitted on every successful endpoint', async () => {
    for (const ep of endpoints) {
      mocks.mockLogInfo.mockClear();
      await ep.handler(getReq(ep.name));
      const events = mocks.mockLogInfo.mock.calls.map((c) => c[1]);
      expect(events).toContain('storage_query_executed');
    }
  });
});

describe('GET /api/storage/kpis', () => {
  it('reflect-supplied unknown share-id: 200 + canonical empty + storage_share_id_unknown warn', async () => {
    mocks.mockShareListAll.mockReturnValue([{ id: 1, name: 'A' } as ShareRow]);
    const res = await kpisGET(getReq('kpis', '?share=999'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.effectiveFilters.share).toBe(999);
    expect(body.totalSizeBytes).toBe(0);
    const warnEvents = mocks.mockLogWarn.mock.calls.map((c) => c[1]);
    expect(warnEvents).toContain('storage_share_id_unknown');
  });

  it('share=all default when no query param', async () => {
    await kpisGET(getReq('kpis'));
    const callArgs = mocks.mockGetKpis.mock.calls[0][0];
    expect(callArgs.shareId).toBe('all');
  });
});

describe('GET /api/storage/top-folders', () => {
  it('depth=6 out-of-range → 400 invalid_query uniform shape', async () => {
    const res = await topFoldersGET(getReq('top-folders', '?depth=6'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_query');
    expect(typeof body.message).toBe('string');
    expect(body.requestId).toMatch(UUID_V4);
  });

  it('SR1 truncated:true surfaces in response body', async () => {
    mocks.mockGetTopFolders.mockReturnValue({
      rows: Array.from({ length: 10 }, (_, i) => ({
        shareId: 1,
        path: `f${i}`,
        sizeBytes: 100,
        fileCount: 1,
      })),
      truncated: true,
    });
    const res = await topFoldersGET(getReq('top-folders'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.truncated).toBe(true);
    expect(body.rows).toHaveLength(10);
  });
});

describe('GET /api/storage/codec-pie', () => {
  it('note field surfaces Q2 fallback explanation', async () => {
    const res = await codecPieGET(getReq('codec-pie'));
    const body = await res.json();
    expect(body.note).toMatch(/current-state codec only/);
  });
});

describe('auth + error responses (M2 uniform shape)', () => {
  it('auth-enabled + denied → 401 with { error:unauthorized, message, requestId }', async () => {
    mocks.mockRequireAuth.mockResolvedValue({
      ok: false,
      status: 401,
      body: { error_code: 'auth_required' },
    });
    const res = await kpisGET(getReq('kpis'));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('unauthorized');
    expect(typeof body.message).toBe('string');
    expect(body.requestId).toMatch(UUID_V4);
  });

  it('auth-disabled (single-tenant per SR6) → 200 short-circuit', async () => {
    // already mocked as disabled in beforeEach
    const res = await kpisGET(getReq('kpis'));
    expect(res.status).toBe(200);
  });

  it('repo throws → 500 with internal_error body; stack stays out of response', async () => {
    mocks.mockGetKpis.mockImplementation(() => {
      throw new Error('boom — secret stack content');
    });
    const res = await kpisGET(getReq('kpis'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('internal_error');
    expect(body.message).toBe('unexpected error');
    expect(body.requestId).toMatch(UUID_V4);
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toMatch(/secret stack content/);
  });
});

describe('storage_query_slow gate', () => {
  it('synthetic slow repo (>1000ms wall-clock) emits warn', async () => {
    // Each Date.now() call advances by 2000ms — duration math reads a value
    // 2000ms after startedAt, tripping the >1000ms slow gate. Stub restored
    // in finally so other tests stay unaffected.
    const real = Date.now;
    let counter = 0;
    Date.now = vi.fn(() => {
      counter += 2000;
      return counter;
    }) as unknown as typeof Date.now;
    try {
      await kpisGET(getReq('kpis'));
      const events = mocks.mockLogWarn.mock.calls.map((c) => c[1]);
      expect(events).toContain('storage_query_slow');
    } finally {
      Date.now = real;
    }
  });
});
