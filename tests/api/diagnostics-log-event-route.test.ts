// @vitest-environment node
// Phase 21 Plan 21-02 T3 Step 7 — POST /api/diagnostics/log-event tests.
// AC-9 + AC-17 (audit-M1 auth-gate + M3 server-only-event blocklist + payload filter).

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockLogger, mockEnsureServerInit, authMode } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  mockEnsureServerInit: vi.fn(),
  authMode: { value: 'disabled' as 'disabled' | 'authenticated' | 'denied' },
}));

vi.mock('@/src/lib/server-init', () => ({
  ensureServerInit: mockEnsureServerInit,
}));

vi.mock('@/src/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(async () => {
    if (authMode.value === 'denied') {
      return { ok: false, status: 401, body: { error_code: 'auth_required' } };
    }
    if (authMode.value === 'authenticated') {
      return {
        ok: true,
        mode: 'authenticated',
        username: 'admin',
        renewCookie: 'session=NEW; Path=/; HttpOnly',
      };
    }
    return { ok: true, mode: 'disabled', username: null };
  }),
  authGuard: (decision: { ok: boolean; status?: number; body?: unknown }) => {
    if (decision.ok) return null;
    return new Response(JSON.stringify(decision.body), {
      status: decision.status,
      headers: { 'Content-Type': 'application/json' },
    });
  },
  withRenewCookie: (res: Response, decision: { renewCookie?: string }) => {
    if (decision.renewCookie) res.headers.append('Set-Cookie', decision.renewCookie);
    return res;
  },
}));

vi.mock('@/src/lib/logger', () => ({
  logger: mockLogger,
}));

import { POST } from '@/app/api/diagnostics/log-event/route';
import {
  __resetInvalidOutcomeWarnedForTests,
  __resetInvalidSourceWarnedForTests,
  __resetInvalidWarningCodeWarnedForTests,
  isClientAllowedEvent,
} from '@/src/lib/diagnostics/log-event-allowlist';

function jsonReq(body: unknown, opts: { contentType?: string } = {}): Request {
  return new Request('http://test/api/diagnostics/log-event', {
    method: 'POST',
    headers: { 'content-type': opts.contentType ?? 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/diagnostics/log-event', () => {
  beforeEach(() => {
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockEnsureServerInit.mockReset();
    authMode.value = 'disabled';
  });

  it('allowed event + valid payload → 204 + logger.info called with source=log-event-route', async () => {
    const res = await POST(
      jsonReq({ event: 'diagnosticsReportCopied', payload: { byteLength: 1234 } }),
    );
    expect(res.status).toBe(204);
    expect(mockLogger.info).toHaveBeenCalledTimes(1);
    const call = mockLogger.info.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.event).toBe('diagnosticsReportCopied');
    expect(call.source).toBe('log-event-route');
    expect(call.byteLength).toBe(1234);
  });

  it('unknown event → 400 unknown_event + no logger.info', async () => {
    const res = await POST(jsonReq({ event: 'fooBar' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('unknown_event');
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it('body >16 KB → 413', async () => {
    const huge = 'x'.repeat(17 * 1024);
    const res = await POST(
      jsonReq(
        JSON.stringify({
          event: 'diagnosticsReportCopied',
          payload: { byteLength: 1 },
          junk: huge,
        }),
      ),
    );
    expect(res.status).toBe(413);
  });

  it('non-JSON Content-Type → 415', async () => {
    const res = await POST(
      jsonReq({ event: 'diagnosticsReportCopied' }, { contentType: 'text/plain' }),
    );
    expect(res.status).toBe(415);
  });

  it('extra payload keys filtered before logger.info', async () => {
    await POST(
      jsonReq({
        event: 'feedbackLinkOpened',
        payload: { type: 'bug', maliciousField: 'rm -rf /', anotherJunk: 99 },
      }),
    );
    const call = mockLogger.info.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.type).toBe('bug');
    expect(call.maliciousField).toBeUndefined();
    expect(call.anotherJunk).toBeUndefined();
    expect(call.source).toBe('log-event-route');
  });

  it('malformed JSON → 400', async () => {
    const res = await POST(jsonReq('{not json}'));
    expect(res.status).toBe(400);
  });

  it('auth_enabled=true + no session → 401 + no logger.info (audit-M1)', async () => {
    authMode.value = 'denied';
    const res = await POST(
      jsonReq({ event: 'diagnosticsReportCopied', payload: { byteLength: 1 } }),
    );
    expect(res.status).toBe(401);
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it('auth_enabled=true + valid session → 204 + withRenewCookie applied (Set-Cookie present)', async () => {
    authMode.value = 'authenticated';
    const res = await POST(
      jsonReq({ event: 'diagnosticsReportCopied', payload: { byteLength: 9 } }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Set-Cookie')).toMatch(/session=NEW/);
  });

  it('event=diagnosticsPageOpened from client → 400 unknown_event (server-only event blocklist M3)', async () => {
    const res = await POST(jsonReq({ event: 'diagnosticsPageOpened' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('unknown_event');
  });

  it('event=testEncodeTriggered from client → 400 unknown_event (server-only event blocklist M3)', async () => {
    const res = await POST(jsonReq({ event: 'testEncodeTriggered' }));
    expect(res.status).toBe(400);
  });

  it('errorBoundaryTriggered with full payload → 204 + source overrides route-default (21-03 audit-M5)', async () => {
    await POST(
      jsonReq({
        event: 'errorBoundaryTriggered',
        payload: {
          source: 'error-boundary-locale',
          kind: 'stale-cache',
          boundary: 'locale',
          digest: 'abc123',
          versionFingerprint: { actual: '2.17.4', expected: '2.17.5' },
        },
      }),
    );
    const call = mockLogger.info.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.event).toBe('errorBoundaryTriggered');
    expect(call.source).toBe('error-boundary-locale');
    expect(call.kind).toBe('stale-cache');
    expect(call.boundary).toBe('locale');
    expect(call.digest).toBe('abc123');
    expect((call.versionFingerprint as Record<string, string>).actual).toBe('2.17.4');
  });

  it('errorBoundaryTriggered with extra junk → unknown keys stripped (21-03 audit-M5)', async () => {
    await POST(
      jsonReq({
        event: 'errorBoundaryTriggered',
        payload: {
          source: 'error-boundary-root',
          kind: 'unknown',
          boundary: 'root',
          maliciousField: 'rm -rf',
          extraNoise: { junk: true },
        },
      }),
    );
    const call = mockLogger.info.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.source).toBe('error-boundary-root');
    expect(call.maliciousField).toBeUndefined();
    expect(call.extraNoise).toBeUndefined();
  });

  it('errorBoundaryTriggered without source → defaults to log-event-route (21-03 audit-M5 spoof-defense)', async () => {
    await POST(
      jsonReq({
        event: 'errorBoundaryTriggered',
        payload: { kind: 'unknown', boundary: 'global', digest: 'd' },
      }),
    );
    const call = mockLogger.info.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.event).toBe('errorBoundaryTriggered');
    expect(call.source).toBe('log-event-route');
    expect(call.boundary).toBe('global');
  });

  // Plan 21-04 T2 — bannerDismissed + bannerRestored + audit-M6 code-validator.

  it('bannerDismissed with allowlisted payload keys → 204 + logger.info has source=topbar-banner', async () => {
    await POST(
      jsonReq({
        event: 'bannerDismissed',
        payload: {
          source: 'topbar-banner',
          code: 'mount.media_unreadable',
          severity: 'warn',
          warningSource: 'mount',
        },
      }),
    );
    const call = mockLogger.info.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.event).toBe('bannerDismissed');
    expect(call.source).toBe('topbar-banner');
    expect(call.code).toBe('mount.media_unreadable');
    expect(call.severity).toBe('warn');
    expect(call.warningSource).toBe('mount');
  });

  it('bannerDismissed without source → defaults to log-event-route (21-03 audit-M5 lineage)', async () => {
    await POST(
      jsonReq({
        event: 'bannerDismissed',
        payload: {
          code: 'onboarding.incomplete',
          severity: 'warn',
          warningSource: 'onboarding',
        },
      }),
    );
    const call = mockLogger.info.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.event).toBe('bannerDismissed');
    expect(call.source).toBe('log-event-route');
    expect(call.code).toBe('onboarding.incomplete');
  });

  it('bannerRestored with restoredCount → 204 + logger.info preserves count', async () => {
    await POST(
      jsonReq({
        event: 'bannerRestored',
        payload: { source: 'topbar-banner', restoredCount: 3 },
      }),
    );
    const call = mockLogger.info.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.event).toBe('bannerRestored');
    expect(call.source).toBe('topbar-banner');
    expect(call.restoredCount).toBe(3);
  });

  it('bannerDismissed extra payload keys filtered before logger.info', async () => {
    await POST(
      jsonReq({
        event: 'bannerDismissed',
        payload: {
          source: 'topbar-banner',
          code: 'mount.media_unreadable',
          severity: 'warn',
          warningSource: 'mount',
          maliciousField: 'rm -rf /',
          junk: { nested: true },
        },
      }),
    );
    const call = mockLogger.info.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.maliciousField).toBeUndefined();
    expect(call.junk).toBeUndefined();
    expect(call.code).toBe('mount.media_unreadable');
  });

  it('audit-M6: bannerDismissed code with path separator → substituted with <invalid_code>', async () => {
    __resetInvalidWarningCodeWarnedForTests();
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const res = await POST(
        jsonReq({
          event: 'bannerDismissed',
          payload: {
            source: 'topbar-banner',
            code: 'mount.media_unreadable:/srv/sensitive',
            severity: 'warn',
            warningSource: 'mount',
          },
        }),
      );
      expect(res.status).toBe(204);
      const call = mockLogger.info.mock.calls[0]![0] as Record<string, unknown>;
      expect(call.code).toBe('<invalid_code>');
      expect(consoleSpy).toHaveBeenCalledTimes(1);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('audit-M6: bannerDismissed code with uppercase or whitespace → <invalid_code>', async () => {
    __resetInvalidWarningCodeWarnedForTests();
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await POST(
        jsonReq({
          event: 'bannerDismissed',
          payload: {
            source: 'topbar-banner',
            code: 'Mount.Media Unreadable',
            severity: 'warn',
            warningSource: 'mount',
          },
        }),
      );
      const call = mockLogger.info.mock.calls[0]![0] as Record<string, unknown>;
      expect(call.code).toBe('<invalid_code>');
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('audit-M6: bannerDismissed with valid code passes through unchanged', async () => {
    __resetInvalidWarningCodeWarnedForTests();
    await POST(
      jsonReq({
        event: 'bannerDismissed',
        payload: {
          source: 'topbar-banner',
          code: 'aggregator.no_encoders',
          severity: 'error',
          warningSource: 'aggregator',
        },
      }),
    );
    const call = mockLogger.info.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.code).toBe('aggregator.no_encoders');
  });

  it('encoderReplayTriggered payload with extra field → 204 with FLAT schema only (audit-M4)', async () => {
    await POST(
      jsonReq({
        event: 'encoderReplayTriggered',
        payload: {
          added: ['nvenc'],
          removed: [],
          activeFromAutoChanged: true,
          extraField: 'malicious',
          diff: { nested: 'should-not-survive' },
        },
      }),
    );
    const call = mockLogger.info.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.event).toBe('encoderReplayTriggered');
    expect(call.source).toBe('log-event-route');
    expect(call.added).toEqual(['nvenc']);
    expect(call.removed).toEqual([]);
    expect(call.activeFromAutoChanged).toBe(true);
    expect(call.extraField).toBeUndefined();
    expect(call.diff).toBeUndefined();
  });

  // Plan 21-05 T3 — copyReportGated + copyReportUnlocked allowlist + AC-17/18/19.

  it('21-05 isClientAllowedEvent recognises copyReportGated + copyReportUnlocked (AC-10)', () => {
    expect(isClientAllowedEvent('copyReportGated')).toBe(true);
    expect(isClientAllowedEvent('copyReportUnlocked')).toBe(true);
  });

  it('21-05 copyReportGated with valid source → 204 + logger.info preserves source', async () => {
    const res = await POST(
      jsonReq({
        event: 'copyReportGated',
        payload: { source: 'diagnostics-client' },
      }),
    );
    expect(res.status).toBe(204);
    const call = mockLogger.info.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.event).toBe('copyReportGated');
    expect(call.source).toBe('diagnostics-client');
  });

  it('21-05 copyReportUnlocked with valid payload → 204 + logger.info preserves outcome+encoderPicked', async () => {
    const res = await POST(
      jsonReq({
        event: 'copyReportUnlocked',
        payload: {
          source: 'diagnostics-client',
          outcome: 'success',
          encoderPicked: 'libx265',
        },
      }),
    );
    expect(res.status).toBe(204);
    const call = mockLogger.info.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.event).toBe('copyReportUnlocked');
    expect(call.source).toBe('diagnostics-client');
    expect(call.outcome).toBe('success');
    expect(call.encoderPicked).toBe('libx265');
  });

  it('21-05 copyReportUnlocked extra payload keys dropped via filterPayloadKeys', async () => {
    await POST(
      jsonReq({
        event: 'copyReportUnlocked',
        payload: {
          source: 'diagnostics-client',
          outcome: 'failed',
          encoderPicked: 'hevc_nvenc',
          maliciousField: 'rm -rf /',
          extra: 'leak',
        },
      }),
    );
    const call = mockLogger.info.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.outcome).toBe('failed');
    expect(call.maliciousField).toBeUndefined();
    expect(call.extra).toBeUndefined();
  });

  it('audit-M1 21-05: copyReportUnlocked with injected outcome → <invalid_outcome> + warn-once across 2 POSTs (AC-17)', async () => {
    __resetInvalidOutcomeWarnedForTests();
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await POST(
        jsonReq({
          event: 'copyReportUnlocked',
          payload: {
            source: 'diagnostics-client',
            outcome: 'success-injected\nfake-line',
            encoderPicked: 'libx265',
          },
        }),
      );
      const call = mockLogger.info.mock.calls[0]![0] as Record<string, unknown>;
      expect(call.outcome).toBe('<invalid_outcome>');
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      // Second POST — warn-once flag prevents duplicate console output.
      await POST(
        jsonReq({
          event: 'copyReportUnlocked',
          payload: {
            source: 'diagnostics-client',
            outcome: 'another-bad-value',
            encoderPicked: 'libx265',
          },
        }),
      );
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const second = mockLogger.info.mock.calls[1]![0] as Record<string, unknown>;
      expect(second.outcome).toBe('<invalid_outcome>');
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('audit-M2 21-05: encoderPicked > 256 UTF-8 bytes → <truncated> + truncatedKeys sidecar (AC-18)', async () => {
    await POST(
      jsonReq({
        event: 'copyReportUnlocked',
        payload: {
          source: 'diagnostics-client',
          outcome: 'success',
          encoderPicked: 'x'.repeat(257),
        },
      }),
    );
    const call = mockLogger.info.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.encoderPicked).toBe('<truncated>');
    expect(call.truncatedKeys).toEqual(['encoderPicked']);
  });

  it('audit-M2 21-05: encoderPicked = exactly 256 UTF-8 bytes → unchanged, NO sidecar', async () => {
    const exactly256 = 'a'.repeat(256);
    await POST(
      jsonReq({
        event: 'copyReportUnlocked',
        payload: {
          source: 'diagnostics-client',
          outcome: 'success',
          encoderPicked: exactly256,
        },
      }),
    );
    const call = mockLogger.info.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.encoderPicked).toBe(exactly256);
    expect(call.truncatedKeys).toBeUndefined();
  });

  it('audit-SR6 21-05: copyReportGated with spoofed source → <invalid_source> + warn-once across 2 POSTs (AC-19)', async () => {
    __resetInvalidSourceWarnedForTests();
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await POST(
        jsonReq({
          event: 'copyReportGated',
          payload: { source: 'spoofed-broker' },
        }),
      );
      const call = mockLogger.info.mock.calls[0]![0] as Record<string, unknown>;
      expect(call.source).toBe('<invalid_source>');
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      await POST(
        jsonReq({
          event: 'copyReportGated',
          payload: { source: 'another-fake' },
        }),
      );
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const second = mockLogger.info.mock.calls[1]![0] as Record<string, unknown>;
      expect(second.source).toBe('<invalid_source>');
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
