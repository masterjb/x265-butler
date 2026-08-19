// 05-02 T1: useAuthStatus context tests.
// Phase 5 Plan 05-02 — audit M2 (SSR-seeded, no mount fetch) + S12 (tab-B stale recovery).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuthStatusProvider, useAuthStatus } from '@/components/auth/auth-status-provider';

function StatusProbe() {
  const s = useAuthStatus();
  return (
    <div>
      <span data-testid="enabled">{String(s.authEnabled)}</span>
      <span data-testid="authed">{String(s.authenticated)}</span>
      <span data-testid="user">{s.username ?? 'null'}</span>
    </div>
  );
}

describe('useAuthStatus — audit M2 + S12', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('reads initialStatus synchronously without mount-time fetch (audit M2)', () => {
    const initial = {
      authEnabled: false,
      setupCompleted: false,
      authenticated: false,
      username: null,
    };
    render(
      <AuthStatusProvider initialStatus={initial}>
        <StatusProbe />
      </AuthStatusProvider>,
    );
    expect(screen.getByTestId('enabled').textContent).toBe('false');
    expect(screen.getByTestId('authed').textContent).toBe('false');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('exposes authenticated initial state', () => {
    const initial = {
      authEnabled: true,
      setupCompleted: true,
      authenticated: true,
      username: 'admin',
    };
    render(
      <AuthStatusProvider initialStatus={initial}>
        <StatusProbe />
      </AuthStatusProvider>,
    );
    expect(screen.getByTestId('enabled').textContent).toBe('true');
    expect(screen.getByTestId('authed').textContent).toBe('true');
    expect(screen.getByTestId('user').textContent).toBe('admin');
  });

  it('re-fetches /api/auth/status on visibilitychange when visible', async () => {
    const initial = {
      authEnabled: true,
      setupCompleted: true,
      authenticated: true,
      username: 'admin',
    };
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          authEnabled: true,
          setupCompleted: true,
          authenticated: false,
          username: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    render(
      <AuthStatusProvider initialStatus={initial}>
        <StatusProbe />
      </AuthStatusProvider>,
    );
    expect(screen.getByTestId('authed').textContent).toBe('true');

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    fireEvent(document, new Event('visibilitychange'));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/auth/status', { cache: 'no-store' });
    });
    await waitFor(() => {
      expect(screen.getByTestId('authed').textContent).toBe('false');
    });
  });

  it('S12 tab-B stale-state recovery — cluster removed after visibilitychange', async () => {
    const initial = {
      authEnabled: true,
      setupCompleted: true,
      authenticated: true,
      username: 'admin',
    };
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          authEnabled: true,
          setupCompleted: true,
          authenticated: false,
          username: null,
        }),
        { status: 200 },
      ),
    );
    render(
      <AuthStatusProvider initialStatus={initial}>
        <StatusProbe />
      </AuthStatusProvider>,
    );
    expect(screen.getByTestId('user').textContent).toBe('admin');

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    fireEvent(document, new Event('visibilitychange'));

    await waitFor(() => {
      expect(screen.getByTestId('user').textContent).toBe('null');
    });
  });

  it('does NOT re-fetch when visibilitychange fires with hidden state', async () => {
    const initial = {
      authEnabled: true,
      setupCompleted: true,
      authenticated: true,
      username: 'admin',
    };
    render(
      <AuthStatusProvider initialStatus={initial}>
        <StatusProbe />
      </AuthStatusProvider>,
    );
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    fireEvent(document, new Event('visibilitychange'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('falls back when called without provider (defensive path)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<StatusProbe />);
    expect(screen.getByTestId('enabled').textContent).toBe('false');
    expect(screen.getByTestId('authed').textContent).toBe('false');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('keeps last known good snapshot when fetch fails', async () => {
    const initial = {
      authEnabled: true,
      setupCompleted: true,
      authenticated: true,
      username: 'admin',
    };
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network'));
    render(
      <AuthStatusProvider initialStatus={initial}>
        <StatusProbe />
      </AuthStatusProvider>,
    );
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    fireEvent(document, new Event('visibilitychange'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByTestId('user').textContent).toBe('admin');
  });
});
