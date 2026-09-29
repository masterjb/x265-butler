/*
 * Phase 21 Plan 21-04 T3 — TopbarWarningsBanner component tests.
 *
 * 16 cases covering ACs:
 *  1. AC-1   happy-path render with 2 non-encoder warnings → count + 2 X buttons + CTA
 *  2. AC-2   encoder-source warning filtered out (return null)
 *  3. AC-4   dismiss click → POST + localStorage + re-render
 *  4. AC-5   24h auto-revive on stale timestamp
 *  5. AC-6   muted restore-pill + Restore click → POST bannerRestored + localStorage cleared
 *  6. AC-7   kill-switch (NEXT_PUBLIC_DIAGNOSTICS_BANNER_DISABLED=1) → null + no fetch + no localStorage
 *  7. AC-9   polling 60s + AbortController cleanup on unmount
 *  8. AC-10  audit-emit POST body shape matches PAYLOAD_SCHEMA_BY_EVENT
 *  9. AC-12  a11y: role=status + aria-label + focus-visible + touch-target
 * 10. fetch-failure resilience → silent (no toast); banner does NOT empty
 * 11. AC-16  localStorage SecurityError → in-memory dismiss still works (no crash)
 * 12. AC-16  corrupted JSON → readDismissed returns {} cleanly
 * 13. AC-16  quota exhausted → in-memory updates; POST still fires
 * 14. AC-17  POST 500 during dismiss → localStorage write occurs; UI stays dismissed
 * 15. AC-18  poll-fetch 500 after success → keeps last-known-good warnings
 * 16. AC-2 (audit-SR2) unknown source default-hide + audit-M6 invalid-code default-hide
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => '/en/library',
}));

import { TopbarWarningsBanner } from '@/components/app-shell/topbar-warnings-banner';

const STORAGE_KEY = 'x265butler.diagnosticsBanner.dismissed';
const ENCODER_WARN = {
  severity: 'warn' as const,
  source: 'encoder' as const,
  code: 'encoder.nvenc_no_runtime',
  message: '/dev/nvidia* present but nvidia-smi missing',
};
const MOUNT_WARN = {
  severity: 'warn' as const,
  source: 'mount' as const,
  code: 'mount.media_unreadable',
  message: '/media not readable',
};
const ONBOARDING_WARN = {
  severity: 'warn' as const,
  source: 'onboarding' as const,
  code: 'onboarding.incomplete',
  message: 'Onboarding incomplete',
};
const AGGREGATOR_ERR = {
  severity: 'error' as const,
  source: 'aggregator' as const,
  code: 'aggregator.no_encoders',
  message: 'No encoders detected',
};

function diagPayload(warnings: object[]) {
  return {
    app: { version: 'test', gitHash: 'abc', committedAt: 0, committedAtCET: null },
    runtime: { nodeVersion: 'v22', platform: 'linux', arch: 'x64', uptimeSec: 1, pid: 1 },
    mounts: [],
    devices: { dri: [], nvidia: [], renderDevices: [] },
    encoders: { detected: [], warnings: [] },
    warnings,
    recentErrors: [],
    onboarding: { completed: true, hasShare: true },
    generatedAt: '2026-05-23T00:00:00Z',
  };
}

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return impl(url, init);
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

describe('TopbarWarningsBanner', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('AC-1: renders count + 2 X buttons + CTA when 2 non-encoder warnings active', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(async (url) => {
        if (url.endsWith('/api/diagnostics')) {
          return jsonResponse(diagPayload([MOUNT_WARN, ONBOARDING_WARN, ENCODER_WARN]));
        }
        return jsonResponse({}, 204);
      }),
    );
    render(wrap(<TopbarWarningsBanner />));
    await screen.findByText(/2 warnings active/i);
    expect(screen.getAllByRole('button', { name: /Dismiss.*warning for 24 hours/i })).toHaveLength(
      2,
    );
    expect(screen.getByRole('link', { name: /View diagnostics/i })).toBeTruthy();
  });

  it('AC-2: encoder-source warning → banner returns null (Bell coexistence)', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(async () => jsonResponse(diagPayload([ENCODER_WARN]))),
    );
    const { container } = render(wrap(<TopbarWarningsBanner />));
    await waitFor(() => {
      expect(container.querySelector('[data-testid="topbar-warnings-wrapper"]')).toBeNull();
      expect(container.querySelector('[data-testid="topbar-warnings-restore-wrapper"]')).toBeNull();
    });
  });

  it('AC-4: dismiss click → POST /api/diagnostics/log-event + localStorage write + re-render hides entry', async () => {
    const postedBodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      mockFetch(async (url, init) => {
        if (url.endsWith('/api/diagnostics')) {
          return jsonResponse(diagPayload([MOUNT_WARN, ONBOARDING_WARN]));
        }
        if (url.endsWith('/api/diagnostics/log-event')) {
          postedBodies.push(JSON.parse((init?.body as string) ?? '{}'));
          return new Response(null, { status: 204 });
        }
        return jsonResponse({}, 204);
      }),
    );
    render(wrap(<TopbarWarningsBanner />));
    const xButtons = await screen.findAllByRole('button', {
      name: /Dismiss.*warning for 24 hours/i,
    });
    fireEvent.click(xButtons[0]);
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
      expect(stored[MOUNT_WARN.code]).toEqual(expect.any(Number));
    });
    await waitFor(() => expect(postedBodies.length).toBeGreaterThanOrEqual(1));
    const body = postedBodies[0] as { event: string; payload: Record<string, unknown> };
    expect(body.event).toBe('bannerDismissed');
    expect(body.payload.source).toBe('topbar-banner');
    expect(body.payload.code).toBe(MOUNT_WARN.code);
    expect(body.payload.severity).toBe('warn');
    expect(body.payload.warningSource).toBe('mount');
    await screen.findByText(/1 warning active/i);
  });

  it('AC-5: 24h auto-revive on stale dismiss timestamp', async () => {
    const longAgo = Date.now() - 25 * 60 * 60 * 1000;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ [MOUNT_WARN.code]: longAgo }));
    vi.stubGlobal(
      'fetch',
      mockFetch(async () => jsonResponse(diagPayload([MOUNT_WARN]))),
    );
    render(wrap(<TopbarWarningsBanner />));
    await screen.findByText(/1 warning active/i);
  });

  it('AC-6: muted restore-pill + Restore click → POST bannerRestored + localStorage cleared', async () => {
    const now = Date.now();
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ [MOUNT_WARN.code]: now, [ONBOARDING_WARN.code]: now }),
    );
    const postedBodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      mockFetch(async (url, init) => {
        if (url.endsWith('/api/diagnostics')) {
          return jsonResponse(diagPayload([MOUNT_WARN, ONBOARDING_WARN]));
        }
        if (url.endsWith('/api/diagnostics/log-event')) {
          postedBodies.push(JSON.parse((init?.body as string) ?? '{}'));
          return new Response(null, { status: 204 });
        }
        return jsonResponse({}, 204);
      }),
    );
    render(wrap(<TopbarWarningsBanner />));
    const restoreBtn = await screen.findByRole('button', {
      name: /Restore all dismissed warnings/i,
    });
    expect(restoreBtn).toBeTruthy();
    fireEvent.click(restoreBtn);
    await waitFor(() => {
      expect(localStorage.getItem(STORAGE_KEY)).toBe('{}');
    });
    await waitFor(() => expect(postedBodies.length).toBeGreaterThanOrEqual(1));
    const body = postedBodies[0] as { event: string; payload: Record<string, unknown> };
    expect(body.event).toBe('bannerRestored');
    expect(body.payload.source).toBe('topbar-banner');
    expect(body.payload.restoredCount).toBe(2);
  });

  it('AC-7: KILL switch via stubEnv + dynamic import → renders null + zero fetch + localStorage untouched', async () => {
    vi.stubEnv('NEXT_PUBLIC_DIAGNOSTICS_BANNER_DISABLED', '1');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const lsGetSpy = vi.spyOn(Storage.prototype, 'getItem');
    const lsSetSpy = vi.spyOn(Storage.prototype, 'setItem');
    vi.resetModules();
    const mod = await import('@/components/app-shell/topbar-warnings-banner');
    const { container } = render(wrap(<mod.TopbarWarningsBanner />));
    // give microtasks a chance to run
    await new Promise((r) => setTimeout(r, 0));
    expect(container.firstChild).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lsGetSpy).not.toHaveBeenCalledWith(STORAGE_KEY);
    expect(lsSetSpy).not.toHaveBeenCalledWith(STORAGE_KEY, expect.anything());
  });

  it('AC-9: AbortController cleanup on unmount (no setState-on-unmounted warning)', async () => {
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal(
      'fetch',
      mockFetch(async () => jsonResponse(diagPayload([MOUNT_WARN]))),
    );
    const { unmount } = render(wrap(<TopbarWarningsBanner />));
    await screen.findByText(/1 warning active/i);
    unmount();
    await new Promise((r) => setTimeout(r, 50));
    const stateOnUnmounted = consoleErrSpy.mock.calls.find((call) =>
      call.some((arg) => typeof arg === 'string' && arg.includes('unmounted')),
    );
    expect(stateOnUnmounted).toBeUndefined();
    consoleErrSpy.mockRestore();
  });

  it('AC-10: bannerDismissed POST body matches PAYLOAD_SCHEMA_BY_EVENT keys (source/code/severity/warningSource)', async () => {
    const postedBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      mockFetch(async (url, init) => {
        if (url.endsWith('/api/diagnostics')) {
          return jsonResponse(diagPayload([AGGREGATOR_ERR]));
        }
        if (url.endsWith('/api/diagnostics/log-event')) {
          postedBodies.push(JSON.parse((init?.body as string) ?? '{}'));
          return new Response(null, { status: 204 });
        }
        return jsonResponse({}, 204);
      }),
    );
    render(wrap(<TopbarWarningsBanner />));
    const xBtns = await screen.findAllByRole('button', { name: /Dismiss.*warning for 24 hours/i });
    fireEvent.click(xBtns[0]);
    await waitFor(() => expect(postedBodies.length).toBeGreaterThanOrEqual(1));
    const payload = (postedBodies[0]!.payload as Record<string, unknown>) ?? {};
    expect(Object.keys(payload).sort()).toEqual(
      ['code', 'severity', 'source', 'warningSource'].sort(),
    );
    expect(payload.severity).toBe('error');
    expect(payload.warningSource).toBe('aggregator');
  });

  it('AC-12: role=status + aria-label on X buttons + focus-visible:ring class', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(async () => jsonResponse(diagPayload([MOUNT_WARN]))),
    );
    const { container } = render(wrap(<TopbarWarningsBanner />));
    await screen.findByText(/1 warning active/i);
    const statusRegion = container.querySelector('[role="status"]');
    expect(statusRegion).toBeTruthy();
    expect(statusRegion?.getAttribute('aria-atomic')).toBe('true');
    expect(statusRegion?.getAttribute('aria-live')).toBe('off');
    const xBtn = screen.getByRole('button', { name: /Dismiss.*warning for 24 hours/i });
    expect(xBtn.className).toContain('focus-visible:ring-2');
    expect(xBtn.className).toMatch(/h-11/);
  });

  it('fetch-failure resilience: 500 GET → banner stays in last-known-good (silent-fail)', async () => {
    let firstCall = true;
    vi.stubGlobal(
      'fetch',
      mockFetch(async (url) => {
        if (url.endsWith('/api/diagnostics')) {
          if (firstCall) {
            firstCall = false;
            return jsonResponse(diagPayload([MOUNT_WARN]));
          }
          return new Response('boom', { status: 500 });
        }
        return jsonResponse({}, 204);
      }),
    );
    render(wrap(<TopbarWarningsBanner />));
    await screen.findByText(/1 warning active/i);
    // text persists after error path (no toast, no empty-out)
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/1 warning active/i)).toBeTruthy();
  });

  it('AC-16: localStorage SecurityError → in-memory dismiss still works', async () => {
    const lsGetSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key) => {
      if (key === STORAGE_KEY) throw new Error('SecurityError');
      return null;
    });
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal(
      'fetch',
      mockFetch(async (url) => {
        if (url.endsWith('/api/diagnostics')) {
          return jsonResponse(diagPayload([MOUNT_WARN]));
        }
        return new Response(null, { status: 204 });
      }),
    );
    render(wrap(<TopbarWarningsBanner />));
    const xBtns = await screen.findAllByRole('button', { name: /Dismiss.*warning for 24 hours/i });
    fireEvent.click(xBtns[0]);
    // in-memory state still removes the row
    await waitFor(() => {
      expect(screen.queryByText(/1 warning active/i)).toBeNull();
    });
    lsGetSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  it('AC-16: corrupted JSON in localStorage → readDismissed returns {} (banner renders all)', async () => {
    localStorage.setItem(STORAGE_KEY, '{"mount.media_unreadable":');
    vi.stubGlobal(
      'fetch',
      mockFetch(async () => jsonResponse(diagPayload([MOUNT_WARN]))),
    );
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(wrap(<TopbarWarningsBanner />));
    await screen.findByText(/1 warning active/i);
    consoleWarnSpy.mockRestore();
  });

  it('AC-16: QuotaExceededError on setItem → in-memory state updates + POST audit-emit still fires', async () => {
    const lsSetSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key) => {
      if (key === STORAGE_KEY) {
        const err = new Error('QuotaExceededError');
        err.name = 'QuotaExceededError';
        throw err;
      }
    });
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const postedBodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      mockFetch(async (url, init) => {
        if (url.endsWith('/api/diagnostics')) {
          return jsonResponse(diagPayload([MOUNT_WARN]));
        }
        if (url.endsWith('/api/diagnostics/log-event')) {
          postedBodies.push(JSON.parse((init?.body as string) ?? '{}'));
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 204 });
      }),
    );
    render(wrap(<TopbarWarningsBanner />));
    const xBtns = await screen.findAllByRole('button', { name: /Dismiss.*warning for 24 hours/i });
    fireEvent.click(xBtns[0]);
    await waitFor(() => expect(postedBodies.length).toBeGreaterThanOrEqual(1));
    // banner reflects in-memory state (entry hidden) even though storage write threw
    await waitFor(() => expect(screen.queryByText(/1 warning active/i)).toBeNull());
    lsSetSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  it('AC-17: POST 500 during dismiss → localStorage write occurs + dismiss-map updates (UX not blocked)', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal(
      'fetch',
      mockFetch(async (url) => {
        if (url.endsWith('/api/diagnostics')) {
          return jsonResponse(diagPayload([MOUNT_WARN]));
        }
        if (url.endsWith('/api/diagnostics/log-event')) {
          return new Response('boom', { status: 500 });
        }
        return new Response(null, { status: 204 });
      }),
    );
    render(wrap(<TopbarWarningsBanner />));
    const xBtns = await screen.findAllByRole('button', { name: /Dismiss.*warning for 24 hours/i });
    fireEvent.click(xBtns[0]);
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
      expect(stored[MOUNT_WARN.code]).toEqual(expect.any(Number));
    });
    await waitFor(() => expect(screen.queryByText(/1 warning active/i)).toBeNull());
    consoleWarnSpy.mockRestore();
  });

  it('AC-18: poll-fetch 500 keeps last-known-good warnings + console.warn fires once', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers({
      toFake: ['setInterval', 'setTimeout', 'clearInterval', 'clearTimeout', 'Date'],
    });
    let firstGet = true;
    vi.stubGlobal(
      'fetch',
      mockFetch(async (url) => {
        if (url.endsWith('/api/diagnostics')) {
          if (firstGet) {
            firstGet = false;
            return jsonResponse(diagPayload([MOUNT_WARN]));
          }
          return new Response('boom', { status: 500 });
        }
        return new Response(null, { status: 204 });
      }),
    );
    render(wrap(<TopbarWarningsBanner />));
    // flush initial GET microtasks
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(0);
    // last-known-good still rendered (banner did NOT empty out)
    expect(screen.queryByText(/1 warning active/i)).toBeTruthy();
    expect(consoleWarnSpy).toHaveBeenCalled();
    consoleWarnSpy.mockRestore();
  });

  it('AC-2 (audit-SR2/M6): unknown-source + invalid-code entries default-hide', async () => {
    const WEIRD = {
      severity: 'warn' as const,
      source: 'sneaky_unknown' as unknown as 'mount',
      code: 'whatever.x',
      message: 'should be hidden',
    };
    const INVALID_CODE = {
      severity: 'warn' as const,
      source: 'mount' as const,
      code: 'Mount.Media_Unreadable WITH SPACES', // uppercase + whitespace → invalid regex
      message: 'invalid-format-code',
    };
    vi.stubGlobal(
      'fetch',
      mockFetch(async (url) => {
        if (url.endsWith('/api/diagnostics')) {
          return jsonResponse(diagPayload([WEIRD, INVALID_CODE, MOUNT_WARN]));
        }
        return new Response(null, { status: 204 });
      }),
    );
    render(wrap(<TopbarWarningsBanner />));
    // Only MOUNT_WARN passes → count = 1.
    await screen.findByText(/1 warning active/i);
  });
});
