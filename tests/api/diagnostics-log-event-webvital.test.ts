// @vitest-environment node
// 22-01 T4 IMP-4: POST /api/diagnostics/log-event webVitalCaptured branch tests.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockLogger, mockEnsureServerInit } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockEnsureServerInit: vi.fn(),
}));

vi.mock('@/src/lib/logger', () => ({ logger: mockLogger }));
vi.mock('@/src/lib/server-init', () => ({ ensureServerInit: mockEnsureServerInit }));
vi.mock('@/src/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(async () => ({ ok: true, mode: 'disabled', username: null })),
  authGuard: () => null,
  withRenewCookie: (res: Response) => res,
}));

import { POST } from '@/app/api/diagnostics/log-event/route';
import { _resetBuckets } from '@/src/lib/diagnostics/log-event-rate-limit';

function jsonReq(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request('http://test/api/diagnostics/log-event', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1', ...headers },
    body: JSON.stringify(body),
  });
}

describe('22-01 T4: POST /api/diagnostics/log-event webVitalCaptured', () => {
  beforeEach(() => {
    mockLogger.debug.mockReset();
    mockLogger.warn.mockReset();
    _resetBuckets();
  });

  it('happy 204: valid webVitalCaptured emits pino-debug web_vital_captured', async () => {
    const res = await POST(
      jsonReq({
        event: 'webVitalCaptured',
        metric: 'ttfb',
        value: 250,
        route: '/library',
        atIso: '2026-05-24T10:00:00.000Z',
      }),
    );
    expect(res.status).toBe(204);
    expect(mockLogger.debug).toHaveBeenCalledTimes(1);
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'web_vital_captured',
        metric: 'ttfb',
        value: 250,
        route: '/library',
      }),
      'web_vital_captured',
    );
  });

  it('400 on bad metric', async () => {
    const res = await POST(
      jsonReq({
        event: 'webVitalCaptured',
        metric: 'cls',
        value: 0.1,
        route: '/x',
        atIso: '2026-05-24',
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_payload');
    expect(body.reason).toBe('metric_invalid');
  });

  it('400 on bad value (negative)', async () => {
    const res = await POST(
      jsonReq({
        event: 'webVitalCaptured',
        metric: 'lcp',
        value: -5,
        route: '/x',
        atIso: '2026-05-24',
      }),
    );
    expect(res.status).toBe(400);
  });

  it('400 on bad route (too long)', async () => {
    const res = await POST(
      jsonReq({
        event: 'webVitalCaptured',
        metric: 'inp',
        value: 50,
        route: '/' + 'a'.repeat(300),
        atIso: '2026-05-24',
      }),
    );
    expect(res.status).toBe(400);
  });

  it('audit-M1 cross-origin rejected with 403 and audit-log emit', async () => {
    delete process.env.ALLOWED_ORIGINS;
    const res = await POST(
      jsonReq(
        {
          event: 'webVitalCaptured',
          metric: 'ttfb',
          value: 100,
          route: '/x',
          atIso: '2026-05-24',
        },
        { origin: 'https://evil.com', host: 'good.com' },
      ),
    );
    expect(res.status).toBe(403);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'log_event_origin_rejected' }),
      'log_event_origin_rejected',
    );
  });

  it('audit-M1 same-origin accepted (origin matches host)', async () => {
    const res = await POST(
      jsonReq(
        {
          event: 'webVitalCaptured',
          metric: 'ttfb',
          value: 100,
          route: '/x',
          atIso: '2026-05-24',
        },
        { origin: 'http://test', host: 'test' },
      ),
    );
    expect(res.status).toBe(204);
  });
});
