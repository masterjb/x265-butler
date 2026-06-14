// 05-02 T1: authFetch 401-redirect interceptor tests.
// Phase 5 Plan 05-02 — AC-10.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  authFetch,
  markLogoutClicked,
  AuthRedirectError,
  validateNext,
} from '@/components/auth/auth-fetcher';

describe('authFetch — 401 redirect interceptor', () => {
  const originalFetch = global.fetch;
  let replaceMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    replaceMock = vi.fn();
    Object.defineProperty(window, 'location', {
      value: {
        pathname: '/en/library',
        search: '?filter=foo',
        replace: replaceMock,
      },
      writable: true,
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockFetch(status: number, body: unknown): void {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ) as typeof fetch;
  }

  it('redirects to /login?expired=1&next=<encoded> on 401 with auth_required', async () => {
    mockFetch(401, { error_code: 'auth_required' });
    await expect(authFetch('/api/library')).rejects.toBeInstanceOf(AuthRedirectError);
    expect(replaceMock).toHaveBeenCalledWith(
      '/login?expired=1&next=' + encodeURIComponent('/en/library?filter=foo'),
    );
  });

  it('skips interception for /api/health', async () => {
    mockFetch(401, { error_code: 'auth_required' });
    const res = await authFetch('/api/health');
    expect(replaceMock).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
  });

  it('skips interception for /api/auth/* paths', async () => {
    mockFetch(401, { error_code: 'invalid_credentials' });
    const res = await authFetch('/api/auth/login', { method: 'POST' });
    expect(replaceMock).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
  });

  it('skips interception within 500ms post-logout', async () => {
    markLogoutClicked();
    mockFetch(401, { error_code: 'auth_required' });
    const res = await authFetch('/api/library');
    expect(replaceMock).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
    // Wait out the 500ms grace so subsequent tests don't see stale state.
    await new Promise((resolve) => setTimeout(resolve, 510));
  });

  it('does not redirect on 401 without error_code=auth_required', async () => {
    mockFetch(401, { error_code: 'something_else' });
    const res = await authFetch('/api/library');
    expect(replaceMock).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
  });

  it('passes through 200 responses', async () => {
    mockFetch(200, { ok: true });
    const res = await authFetch('/api/library');
    expect(res.status).toBe(200);
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('passes through non-401 errors (500)', async () => {
    mockFetch(500, { error: 'server' });
    const res = await authFetch('/api/library');
    expect(res.status).toBe(500);
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('handles malformed JSON body gracefully (no redirect)', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response('not json', { status: 401 })) as typeof fetch;
    const res = await authFetch('/api/library');
    expect(res.status).toBe(401);
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('throws AuthRedirectError so caller code never resumes', async () => {
    mockFetch(401, { error_code: 'auth_required' });
    let resumed = false;
    try {
      const res = await authFetch('/api/library');
      resumed = true;
      void res;
    } catch (err) {
      expect(err).toBeInstanceOf(AuthRedirectError);
    }
    expect(resumed).toBe(false);
  });
});

describe('validateNext re-export sanity', () => {
  it('exports validateNext from same module', () => {
    expect(typeof validateNext).toBe('function');
  });
});
