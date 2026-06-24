import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { BlocklistRow } from '@/src/lib/db/schema';

const { mockBlocklistList, mockEnsureServerInit, mockLoggerError } = vi.hoisted(() => ({
  mockBlocklistList: vi.fn(),
  mockEnsureServerInit: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock('@/src/lib/db', () => ({
  blocklistRepo: () => ({ list: mockBlocklistList }),
  default: {},
  shareRepo: () => ({ listAll: () => [] }),
}));

vi.mock('@/src/lib/server-init', () => ({
  ensureServerInit: mockEnsureServerInit,
  default: {},
}));

vi.mock('@/src/lib/logger', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: mockLoggerError,
    }),
  },
  default: {},
}));

import { GET, runtime } from '@/app/api/blocklist/route';

const sampleRow: BlocklistRow = {
  id: 1,
  file_id: null,
  path_pattern: '/movies/Samples/*',
  reason: 'operator',
  created_at: 1700000000,
};

beforeEach(() => {
  mockBlocklistList.mockReset();
  mockEnsureServerInit.mockReset();
  mockLoggerError.mockReset();
  delete process.env.NEXT_PHASE;
});

describe('GET /api/blocklist', () => {
  it('test_GET_runtime_export_is_nodejs', () => {
    expect(runtime).toBe('nodejs');
  });

  it('test_GET_when_no_entries_then_returns_empty_rows_total_zero', async () => {
    mockBlocklistList.mockReturnValue({ rows: [], total: 0 });
    const res = await GET(new Request('http://test/api/blocklist?page=1&size=50'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('test_GET_when_entries_exist_then_returns_paginated_rows', async () => {
    mockBlocklistList.mockReturnValue({ rows: [sampleRow], total: 1 });
    const res = await GET(new Request('http://test/api/blocklist?page=1&size=50'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.page).toBe(1);
    expect(body.size).toBe(50);
  });

  it('test_GET_when_size_too_large_then_400_size_too_large', async () => {
    const res = await GET(new Request('http://test/api/blocklist?page=1&size=999'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('size_too_large');
  });

  it('test_GET_when_invalid_query_then_400', async () => {
    const res = await GET(new Request('http://test/api/blocklist?page=foo&size=50'));
    expect(res.status).toBe(400);
  });

  it('test_GET_when_called_then_cache_control_no_store', async () => {
    mockBlocklistList.mockReturnValue({ rows: [], total: 0 });
    const res = await GET(new Request('http://test/api/blocklist'));
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('test_GET_when_NEXT_PHASE_build_then_short_circuits', async () => {
    process.env.NEXT_PHASE = 'phase-production-build';
    const res = await GET(new Request('http://test/api/blocklist'));
    expect(res.status).toBe(200);
    expect(mockBlocklistList).not.toHaveBeenCalled();
  });
});
