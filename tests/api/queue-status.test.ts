// 05-09: Pause concept retired (Decision §2/§3) — `paused` field permanently
// false on the wire; `hasEncodingJob` retained for the Skip-confirm modal gate.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { JobRow } from '@/src/lib/db/schema';

const { mockListActive, mockCountByStatus, mockEnsureServerInit } = vi.hoisted(() => ({
  mockListActive: vi.fn<() => JobRow[]>(),
  mockCountByStatus: vi.fn<(status: string) => number>(),
  mockEnsureServerInit: vi.fn(),
}));

vi.mock('@/src/lib/db', () => ({
  jobRepo: () => ({ listActive: mockListActive, countByStatus: mockCountByStatus }),
  default: {},
  shareRepo: () => ({ listAll: () => [] }),
}));

vi.mock('@/src/lib/server-init', () => ({
  ensureServerInit: mockEnsureServerInit,
  default: {},
}));

import { GET, runtime } from '@/app/api/queue/status/route';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function getReq(): Request {
  return new Request('http://localhost/api/queue/status', { method: 'GET' });
}

describe('GET /api/queue/status', () => {
  beforeEach(() => {
    mockListActive.mockReset();
    mockCountByStatus.mockReset();
    mockEnsureServerInit.mockReset();
    mockListActive.mockReturnValue([]);
    mockCountByStatus.mockReturnValue(0);
  });

  it('test_route_runtime_export_is_nodejs', () => {
    expect(runtime).toBe('nodejs');
  });

  it('test_GET_status_when_default_then_200_with_paused_false_and_counts', async () => {
    mockListActive.mockReturnValue([{ id: 1 } as JobRow]);
    mockCountByStatus.mockReturnValue(7);
    const response = await GET(getReq());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    // 05-09 Decision §3: paused permanently false.
    expect(body.paused).toBe(false);
    expect(body.activeJobs).toBe(1);
    expect(body.pendingJobs).toBe(7);
    expect(body.requestId).toMatch(UUID_V4);
    expect(mockEnsureServerInit).toHaveBeenCalledOnce();
    // audit-added M2: countByStatus invoked with 'queued' literal
    expect(mockCountByStatus).toHaveBeenCalledWith('queued');
  });

  it('test_GET_status_paused_field_is_always_literal_false', async () => {
    // Even with no settings, no module state — paused MUST stay false.
    mockListActive.mockReturnValue([]);
    mockCountByStatus.mockReturnValue(0);
    const response = await GET(getReq());
    const body = await response.json();
    expect(body.paused).toBe(false);
  });

  it('test_GET_status_when_called_then_response_includes_encodingJobs_count', async () => {
    mockListActive.mockReturnValue([{ id: 1 } as JobRow, { id: 2 } as JobRow]);
    mockCountByStatus.mockReturnValue(1);
    const response = await GET(getReq());
    const body = await response.json();
    expect(body).toMatchObject({
      activeJobs: 2,
      pendingJobs: 1,
      encodingJobs: 1,
    });
  });

  // 05-09: hasEncodingJob still exposed — consumed by Skip-confirm modal gate
  // (replaces 05-08 stop-confirm semantic).
  it('test_GET_status_when_encoding_present_then_hasEncodingJob_true', async () => {
    mockListActive.mockReturnValue([{ id: 1 } as JobRow]);
    mockCountByStatus.mockImplementation((status) => (status === 'encoding' ? 1 : 0));
    const response = await GET(getReq());
    const body = await response.json();
    expect(body.hasEncodingJob).toBe(true);
  });

  it('test_GET_status_when_only_queued_jobs_then_encodingJobs_zero_and_hasEncodingJob_false', async () => {
    mockListActive.mockReturnValue([{ id: 1 } as JobRow, { id: 2 } as JobRow]);
    mockCountByStatus.mockImplementation((status) => (status === 'encoding' ? 0 : 2));
    const response = await GET(getReq());
    const body = await response.json();
    expect(body.encodingJobs).toBe(0);
    expect(body.pendingJobs).toBe(2);
    expect(body.hasEncodingJob).toBe(false);
  });

  it('test_GET_status_when_listActive_throws_then_500_internal_error', async () => {
    mockListActive.mockImplementation(() => {
      throw new Error('db down');
    });
    const response = await GET(getReq());
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe('internal_error');
    expect(body.requestId).toMatch(UUID_V4);
  });
});
