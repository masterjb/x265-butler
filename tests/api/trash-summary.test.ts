import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { TrashRepo } from '@/src/lib/db/repos/trash';

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

import { GET, runtime } from '@/app/api/trash/summary/route';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function makeRepo(overrides: Partial<TrashRepo> = {}): TrashRepo {
  return {
    create: vi.fn(),
    list: vi.fn(),
    restore: vi.fn(),
    deleteExpired: vi.fn(),
    count: vi.fn(),
    findById: vi.fn(),
    summary: vi.fn().mockReturnValue({ bytesReclaimed: 0, count: 0 }),
    ...overrides,
  } as unknown as TrashRepo;
}

describe('GET /api/trash/summary', () => {
  beforeEach(() => {
    mockEnsureServerInit.mockReset();
  });

  it('test_runtime_is_nodejs', () => {
    expect(runtime).toBe('nodejs');
  });

  it('test_GET_returns_200_with_summary', async () => {
    mockTrashRepo.current = makeRepo({
      summary: vi.fn().mockReturnValue({ bytesReclaimed: 1_234_567_890, count: 42 }),
    });
    const req = new Request('http://localhost/api/trash/summary', { method: 'GET' });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bytesReclaimed: number; count: number; requestId: string };
    expect(body.bytesReclaimed).toBe(1_234_567_890);
    expect(body.count).toBe(42);
    expect(body.requestId).toMatch(UUID_V4);
  });

  it('test_GET_when_empty_returns_zero_zero', async () => {
    mockTrashRepo.current = makeRepo({
      summary: vi.fn().mockReturnValue({ bytesReclaimed: 0, count: 0 }),
    });
    const req = new Request('http://localhost/api/trash/summary', { method: 'GET' });
    const res = await GET(req);
    const body = (await res.json()) as { bytesReclaimed: number; count: number };
    expect(res.status).toBe(200);
    expect(body.count).toBe(0);
    expect(body.bytesReclaimed).toBe(0);
  });

  it('test_GET_calls_ensureServerInit', async () => {
    mockTrashRepo.current = makeRepo();
    const req = new Request('http://localhost/api/trash/summary', { method: 'GET' });
    await GET(req);
    expect(mockEnsureServerInit).toHaveBeenCalledTimes(1);
  });

  it('test_GET_cache_control_no_store', async () => {
    mockTrashRepo.current = makeRepo();
    const req = new Request('http://localhost/api/trash/summary', { method: 'GET' });
    const res = await GET(req);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('test_GET_when_summary_throws_returns_500', async () => {
    mockTrashRepo.current = makeRepo({
      summary: vi.fn().mockImplementation(() => {
        throw new Error('db error');
      }),
    });
    const req = new Request('http://localhost/api/trash/summary', { method: 'GET' });
    const res = await GET(req);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe('internal_error');
    expect(body.requestId).toMatch(UUID_V4);
  });
});
