// 05-09 audit M4: legacy DELETE /api/queue/[jobId]/cancel endpoint kept as
// deprecated alias of /skip (Decision §1). Tests assert:
//   - pino warn `api_deprecated_endpoint_called` fires on every hit
//   - skipActive() is called (file→'pending' semantic; NOT 'interrupted')
//   - 202 Accepted response shape preserved + alreadyTerminal flag added
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockSkipActive, mockEnsureServerInit, mockFindById, mockLoggerWarn, mockLoggerInfo } =
  vi.hoisted(() => ({
    mockSkipActive:
      vi.fn<
        (
          jobId: number,
          actorId: string,
        ) => Promise<{ skipped: boolean; prevStatus: string; alreadyTerminal: boolean }>
      >(),
    mockEnsureServerInit: vi.fn(),
    mockFindById: vi.fn<(id: number) => unknown>(),
    mockLoggerWarn: vi.fn(),
    mockLoggerInfo: vi.fn(),
  }));

vi.mock('@/src/lib/encode', () => ({
  skipActive: mockSkipActive,
  default: {},
}));

vi.mock('@/src/lib/server-init', () => ({
  ensureServerInit: mockEnsureServerInit,
  default: {},
}));

vi.mock('@/src/lib/db', () => ({
  jobRepo: () => ({
    findById: mockFindById,
  }),
  default: {},
  shareRepo: () => ({ listAll: () => [] }),
}));

vi.mock('@/src/lib/logger', () => {
  const child = vi.fn(() => ({
    warn: mockLoggerWarn,
    info: mockLoggerInfo,
    error: vi.fn(),
    debug: vi.fn(),
  }));
  return {
    logger: { child, warn: mockLoggerWarn, info: mockLoggerInfo, error: vi.fn(), debug: vi.fn() },
    default: {},
  };
});

import { DELETE, runtime } from '@/app/api/queue/[jobId]/cancel/route';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function delReq(jobId: string): {
  request: Request;
  context: { params: Promise<{ jobId: string }> };
} {
  const request = new Request(`http://localhost/api/queue/${jobId}/cancel`, {
    method: 'DELETE',
  });
  const context = { params: Promise.resolve({ jobId }) };
  return { request, context };
}

describe('DELETE /api/queue/[jobId]/cancel — deprecated alias of /skip', () => {
  beforeEach(() => {
    mockSkipActive.mockReset();
    mockEnsureServerInit.mockReset();
    mockFindById.mockReset();
    mockLoggerWarn.mockReset();
    mockLoggerInfo.mockReset();
  });

  it('test_route_runtime_export_is_nodejs', () => {
    expect(runtime).toBe('nodejs');
  });

  it('test_DELETE_when_active_encoding_then_202_skipActive_called_file_pending_semantic', async () => {
    mockFindById.mockReturnValue({ id: 7, file_id: 42, status: 'encoding' });
    mockSkipActive.mockResolvedValue({
      skipped: true,
      prevStatus: 'encoding',
      alreadyTerminal: false,
    });
    const { request, context } = delReq('7');
    const response = await DELETE(request, context);
    expect(response.status).toBe(202);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body.jobId).toBe(7);
    expect(body.status).toBe('cancelling');
    expect(body.pollUrl).toBe('/api/queue/status');
    expect(body.alreadyTerminal).toBe(false);
    expect(body.requestId).toMatch(UUID_V4);
    expect(mockSkipActive).toHaveBeenCalledWith(7, expect.any(String));
    expect(mockEnsureServerInit).toHaveBeenCalledOnce();
  });

  it('test_DELETE_emits_api_deprecated_endpoint_called_pino_warn_audit_S1', async () => {
    mockFindById.mockReturnValue({ id: 7, file_id: 42, status: 'queued' });
    mockSkipActive.mockResolvedValue({
      skipped: true,
      prevStatus: 'queued',
      alreadyTerminal: false,
    });
    const { request, context } = delReq('7');
    await DELETE(request, context);
    // Audit S1: deprecation telemetry — pino warn fires on every hit.
    const calls = mockLoggerWarn.mock.calls;
    const matched = calls.find(
      (c) =>
        typeof c[0] === 'object' &&
        c[0] !== null &&
        (c[0] as { action?: string }).action === 'api_deprecated_endpoint_called',
    );
    expect(matched).toBeDefined();
    expect((matched![0] as { endpoint: string }).endpoint).toBe('/api/queue/[jobId]/cancel');
    expect((matched![0] as { actorId: string }).actorId).toEqual(expect.any(String));
  });

  it('test_DELETE_when_unknown_jobId_then_404_not_active', async () => {
    mockFindById.mockReturnValue(undefined);
    const { request, context } = delReq('999');
    const response = await DELETE(request, context);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe('not_active');
    expect(body.jobId).toBe(999);
    expect(mockSkipActive).not.toHaveBeenCalled();
  });

  it.each(['abc', '0', '-5', '1.5', '', 'NaN'])(
    'test_DELETE_when_invalid_jobId_%s_then_400_invalid_job_id',
    async (raw) => {
      const { request, context } = delReq(raw);
      const response = await DELETE(request, context);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('invalid_job_id');
      expect(mockSkipActive).not.toHaveBeenCalled();
    },
  );

  it('test_DELETE_when_skipActive_throws_then_500_internal_error', async () => {
    mockFindById.mockReturnValue({ id: 7, file_id: 42, status: 'encoding' });
    mockSkipActive.mockRejectedValue(new Error('boom'));
    const { request, context } = delReq('7');
    const response = await DELETE(request, context);
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe('internal_error');
  });

  it('test_DELETE_when_terminal_then_alreadyTerminal_true_idempotent', async () => {
    mockFindById.mockReturnValue({ id: 7, file_id: 42, status: 'done' });
    mockSkipActive.mockResolvedValue({
      skipped: true,
      prevStatus: 'done',
      alreadyTerminal: true,
    });
    const { request, context } = delReq('7');
    const response = await DELETE(request, context);
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.alreadyTerminal).toBe(true);
  });
});
