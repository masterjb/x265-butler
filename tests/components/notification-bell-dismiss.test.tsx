/*
 * Phase 18 Plan 18-02 — NotificationBell dismiss (Option A localStorage).
 *
 * 5 cases:
 *  1. Dismiss click writes localStorage + decrements badge
 *  2. Dismiss persists across remount (localStorage)
 *  3. 24h TTL: expired dismissals re-surface
 *  4. Dismiss click does NOT trigger router.push (stopPropagation)
 *  5. Bell auto-hides when all notifications dismissed
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';

const { mockRouterPush } = vi.hoisted(() => ({ mockRouterPush: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockRouterPush,
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => '/en/dashboard',
}));

import { NotificationBell, DISMISSED_STORAGE_KEY } from '@/components/app-shell/notification-bell';

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

function mockFetch(response: object) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

const TWO_WARNINGS_RESPONSE = {
  notifications: [
    {
      id: 'notif_nvenc_no_runtime',
      source: 'detection',
      severity: 'warn',
      code: 'nvenc_no_runtime',
      title: 'notification.detection.nvenc_no_runtime.title',
      detail: '/dev/nvidia* present but nvidia-smi missing',
      deeplink: '/settings#encoder-config',
      createdAt: 1700000000000,
    },
    {
      id: 'notif_vainfo_binary_missing',
      source: 'detection',
      severity: 'warn',
      code: 'vainfo_binary_missing',
      title: 'notification.detection.vainfo_binary_missing.title',
      detail: 'vainfo not installed',
      deeplink: '/settings#encoder-config',
      createdAt: 1700000000000,
    },
  ],
  count: 2,
  severityCounts: { info: 0, warn: 2 },
};

async function findBell(): Promise<HTMLElement> {
  return await screen.findByRole('button', { name: /Driver warnings/i });
}

describe('NotificationBell — dismiss UX (Option A localStorage)', () => {
  beforeEach(() => {
    localStorage.clear();
    mockRouterPush.mockReset();
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('test_dismiss_click_writes_localStorage_with_timestamp', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', mockFetch(TWO_WARNINGS_RESPONSE));
    render(wrap(<NotificationBell />));
    const bell = await findBell();
    expect(bell.textContent).toContain('2');
    // The DropdownMenu trigger opens on the full pointer sequence
    // (pointerdown→pointerup), NOT a bare `click` — fireEvent.click did not open
    // the portal under CI, so the dismiss buttons never mounted (flaky timeout).
    // userEvent.click dispatches the full sequence; matches the suite-wide pattern
    // (see encoder-warnings-badge.test.tsx).
    await user.click(bell);
    const dismissBtns = await screen.findAllByLabelText(/Dismiss notification:/i, undefined, {
      timeout: 5000,
    });
    expect(dismissBtns).toHaveLength(2);
    await user.click(dismissBtns[0]);
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(DISMISSED_STORAGE_KEY) ?? '{}');
      expect(stored.nvenc_no_runtime).toEqual(expect.any(Number));
    });
  }, 15000);

  it('test_dismiss_persists_across_remount_via_localStorage', async () => {
    localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify({ nvenc_no_runtime: Date.now() }));
    vi.stubGlobal('fetch', mockFetch(TWO_WARNINGS_RESPONSE));
    render(wrap(<NotificationBell />));
    const bell = await findBell();
    // Only the non-dismissed (vainfo) row counts → badge = 1.
    expect(bell.textContent).toContain('1');
    expect(bell.textContent).not.toContain('2');
  });

  it('test_dismiss_expired_24h_re_surfaces', async () => {
    const longAgo = Date.now() - 25 * 60 * 60 * 1000;
    localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify({ nvenc_no_runtime: longAgo }));
    vi.stubGlobal('fetch', mockFetch(TWO_WARNINGS_RESPONSE));
    render(wrap(<NotificationBell />));
    const bell = await findBell();
    expect(bell.textContent).toContain('2');
  });

  it('test_dismiss_click_does_not_trigger_row_deeplink', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', mockFetch(TWO_WARNINGS_RESPONSE));
    render(wrap(<NotificationBell />));
    const bell = await findBell();
    // userEvent.click drives the full pointer sequence the DropdownMenu opens on.
    await user.click(bell);
    const dismissBtns = await screen.findAllByLabelText(/Dismiss notification:/i, undefined, {
      timeout: 5000,
    });
    await user.click(dismissBtns[0]);
    // stopPropagation prevents the DropdownMenuItem onClick → router.push.
    expect(mockRouterPush).not.toHaveBeenCalled();
  }, 15000);

  it('test_bell_auto_hides_when_all_notifications_dismissed', async () => {
    localStorage.setItem(
      DISMISSED_STORAGE_KEY,
      JSON.stringify({
        nvenc_no_runtime: Date.now(),
        vainfo_binary_missing: Date.now(),
      }),
    );
    vi.stubGlobal('fetch', mockFetch(TWO_WARNINGS_RESPONSE));
    const { container } = render(wrap(<NotificationBell />));
    // Fetch resolves → bell evaluates dismissed-filter → returns null.
    await waitFor(() => {
      expect(container.querySelector('[aria-label*="Driver warnings"]')).toBeNull();
    });
  });
});
