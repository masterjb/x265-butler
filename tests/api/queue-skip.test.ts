// 05-09: POST /api/queue/[jobId]/skip — single-job hard-cancel + file→pending.
// Replaces /api/queue/stop forward (05-08 B1 semantic SUPERSEDED).
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockSkipActive, mockEnsureServerInit, mockFindById, mockLoggerInfo, mockLoggerWarn } =
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
    mockLoggerInfo: vi.fn(),
    mockLoggerWarn: vi.fn(),
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
  jobRepo: () => ({ findById: mockFindById }),
  default: {},
  shareRepo: () => ({ listAll: () => [] }),
}));

vi.mock('@/src/lib/logger', () => {
  const child = vi.fn(() => ({
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: vi.fn(),
    debug: vi.fn(),
  }));
  return {
    logger: { child, info: mockLoggerInfo, warn: mockLoggerWarn, error: vi.fn(), debug: vi.fn() },
    default: {},
  };
});

import { POST, runtime } from '@/app/api/queue/[jobId]/skip/route';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function postReq(
  jobId: string,
  body: string | undefined = '{}',
  headers: Record<string, string> = { 'content-type': 'application/json' },
): { request: Request; context: { params: Promise<{ jobId: string }> } } {
  const init: RequestInit = { method: 'POST', headers };
  if (body !== undefined) init.body = body;
  const request = new Request(`http://localhost/api/queue/${jobId}/skip`, init);
  const context = { params: Promise.resolve({ jobId }) };
  return { request, context };
}

describe('POST /api/queue/[jobId]/skip', () => {
  beforeEach(() => {
    mockSkipActive.mockReset();
    mockEnsureServerInit.mockReset();
    mockFindById.mockReset();
    mockLoggerInfo.mockReset();
    mockLoggerWarn.mockReset();
  });

  it('test_route_runtime_export_is_nodejs', () => {
    expect(runtime).toBe('nodejs');
  });

  it('test_POST_when_status_encoding_then_200_skipped_alreadyTerminal_false', async () => {
    mockFindById.mockReturnValue({ id: 7, file_id: 42, status: 'encoding' });
    mockSkipActive.mockResolvedValue({
      skipped: true,
      prevStatus: 'encoding',
      alreadyTerminal: false,
    });
    const { request, context } = postReq('7');
    const response = await POST(request, context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.skipped).toBe(true);
    expect(body.jobId).toBe(7);
    expect(body.jobStatus).toBe('encoding');
    expect(body.alreadyTerminal).toBe(false);
    expect(body.requestId).toMatch(UUID_V4);
    expect(mockSkipActive).toHaveBeenCalledWith(7, expect.any(String));
  });

  it('test_POST_when_status_queued_then_200_skipped', async () => {
    mockFindById.mockReturnValue({ id: 8, file_id: 99, status: 'queued' });
    mockSkipActive.mockResolvedValue({
      skipped: true,
      prevStatus: 'queued',
      alreadyTerminal: false,
    });
    const { request, context } = postReq('8');
    const response = await POST(request, context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.jobStatus).toBe('queued');
    expect(body.alreadyTerminal).toBe(false);
  });

  it('test_POST_when_status_terminal_then_200_alreadyTerminal_true_idempotent', async () => {
    mockFindById.mockReturnValue({ id: 9, file_id: 1, status: 'done' });
    mockSkipActive.mockResolvedValue({
      skipped: true,
      prevStatus: 'done',
      alreadyTerminal: true,
    });
    const { request, context } = postReq('9');
    const response = await POST(request, context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.alreadyTerminal).toBe(true);
  });

  it('test_POST_when_jobId_unknown_then_404_job_not_found', async () => {
    mockFindById.mockReturnValue(undefined);
    const { request, context } = postReq('999');
    const response = await POST(request, context);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe('job_not_found');
    expect(mockSkipActive).not.toHaveBeenCalled();
  });

  it.each(['abc', '0', '-5', '1.5', '', 'NaN'])(
    'test_POST_when_invalid_jobId_%s_then_400',
    async (raw) => {
      const { request, context } = postReq(raw);
      const response = await POST(request, context);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('invalid_job_id');
    },
  );

  it('test_POST_when_wrong_content_type_then_415_unsupported', async () => {
    const { request, context } = postReq('7', '{}', { 'content-type': 'text/plain' });
    const response = await POST(request, context);
    expect(response.status).toBe(415);
    const body = await response.json();
    expect(body.error).toBe('unsupported_media_type');
  });

  it('test_POST_when_content_length_exceeds_16384_then_413_body_too_large_audit_M6', async () => {
    const { request, context } = postReq('7', '{}', {
      'content-type': 'application/json',
      'content-length': '20000',
    });
    const response = await POST(request, context);
    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body.error).toBe('body_too_large');
  });

  it('test_POST_when_skipActive_throws_then_500_internal_error', async () => {
    mockFindById.mockReturnValue({ id: 7, file_id: 42, status: 'encoding' });
    mockSkipActive.mockRejectedValue(new Error('boom'));
    const { request, context } = postReq('7');
    const response = await POST(request, context);
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe('internal_error');
  });

  it('test_POST_emits_job_skipped_pino_with_actorId_audit_AC10', async () => {
    mockFindById.mockReturnValue({ id: 7, file_id: 42, status: 'encoding' });
    mockSkipActive.mockResolvedValue({
      skipped: true,
      prevStatus: 'encoding',
      alreadyTerminal: false,
    });
    const { request, context } = postReq('7');
    await POST(request, context);
    const matched = mockLoggerInfo.mock.calls.find(
      (c) =>
        typeof c[0] === 'object' &&
        c[0] !== null &&
        (c[0] as { action?: string }).action === 'job_skipped',
    );
    expect(matched).toBeDefined();
    expect((matched![0] as { actorId?: unknown }).actorId).toEqual(expect.any(String));
  });
});
