// 05-09: POST /api/queue/cancel-all — mass-skip every active+queued row.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockCancelAllQueued, mockEnsureServerInit, mockLoggerInfo } = vi.hoisted(() => ({
  mockCancelAllQueued:
    vi.fn<(actorId: string) => Promise<{ skipped: number; cancelled: number }>>(),
  mockEnsureServerInit: vi.fn(),
  mockLoggerInfo: vi.fn(),
}));

vi.mock('@/src/lib/encode', () => ({
  cancelAllQueued: mockCancelAllQueued,
  default: {},
}));

vi.mock('@/src/lib/server-init', () => ({
  ensureServerInit: mockEnsureServerInit,
  default: {},
}));

vi.mock('@/src/lib/logger', () => {
  const child = vi.fn(() => ({
    info: mockLoggerInfo,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }));
  return {
    logger: { child, info: mockLoggerInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    default: {},
  };
});

import { POST, runtime } from '@/app/api/queue/cancel-all/route';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function postReq(
  body: string | undefined = '{}',
  headers: Record<string, string> = { 'content-type': 'application/json' },
): Request {
  const init: RequestInit = { method: 'POST', headers };
  if (body !== undefined) init.body = body;
  return new Request('http://localhost/api/queue/cancel-all', init);
}

describe('POST /api/queue/cancel-all', () => {
  beforeEach(() => {
    mockCancelAllQueued.mockReset();
    mockEnsureServerInit.mockReset();
    mockLoggerInfo.mockReset();
  });

  it('test_route_runtime_export_is_nodejs', () => {
    expect(runtime).toBe('nodejs');
  });

  it('test_POST_when_mixed_active_and_queued_then_200_with_counts', async () => {
    mockCancelAllQueued.mockResolvedValue({ skipped: 1, cancelled: 4 });
    const response = await POST(postReq());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.skipped).toBe(1);
    expect(body.cancelled).toBe(4);
    expect(body.requestId).toMatch(UUID_V4);
    expect(mockCancelAllQueued).toHaveBeenCalledWith(expect.any(String));
  });

  it('test_POST_when_only_queued_no_active_then_200_skipped_zero', async () => {
    mockCancelAllQueued.mockResolvedValue({ skipped: 0, cancelled: 5 });
    const response = await POST(postReq());
    const body = await response.json();
    expect(body.skipped).toBe(0);
    expect(body.cancelled).toBe(5);
  });

  it('test_POST_when_only_active_no_queued_then_200_cancelled_zero', async () => {
    mockCancelAllQueued.mockResolvedValue({ skipped: 1, cancelled: 0 });
    const response = await POST(postReq());
    const body = await response.json();
    expect(body.skipped).toBe(1);
    expect(body.cancelled).toBe(0);
  });

  it('test_POST_when_empty_M0_N0_then_200_zero_zero_no_route_mirror_audit_S2', async () => {
    mockCancelAllQueued.mockResolvedValue({ skipped: 0, cancelled: 0 });
    const response = await POST(postReq());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.skipped).toBe(0);
    expect(body.cancelled).toBe(0);
    // Audit S2: route does NOT mirror queue_cancelled_all when both counts are 0.
    const summary = mockLoggerInfo.mock.calls.find(
      (c) =>
        typeof c[0] === 'object' &&
        c[0] !== null &&
        (c[0] as { action?: string }).action === 'queue_cancelled_all',
    );
    expect(summary).toBeUndefined();
  });

  it('test_POST_when_wrong_content_type_then_415', async () => {
    const response = await POST(postReq('{}', { 'content-type': 'text/plain' }));
    expect(response.status).toBe(415);
  });

  it('test_POST_when_content_length_exceeds_16384_then_413_body_too_large_audit_M6', async () => {
    const response = await POST(
      postReq('{}', { 'content-type': 'application/json', 'content-length': '20000' }),
    );
    expect(response.status).toBe(413);
  });

  it('test_POST_when_cancelAllQueued_throws_then_500', async () => {
    mockCancelAllQueued.mockRejectedValue(new Error('boom'));
    const response = await POST(postReq());
    expect(response.status).toBe(500);
  });

  it('test_POST_when_non_empty_then_emits_route_level_queue_cancelled_all_audit_log', async () => {
    mockCancelAllQueued.mockResolvedValue({ skipped: 2, cancelled: 3 });
    await POST(postReq());
    const matched = mockLoggerInfo.mock.calls.find(
      (c) =>
        typeof c[0] === 'object' &&
        c[0] !== null &&
        (c[0] as { action?: string }).action === 'queue_cancelled_all',
    );
    expect(matched).toBeDefined();
    expect((matched![0] as { actorId?: unknown }).actorId).toEqual(expect.any(String));
    expect((matched![0] as { skipped?: number }).skipped).toBe(2);
    expect((matched![0] as { cancelled?: number }).cancelled).toBe(3);
  });
});
