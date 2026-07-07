import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';

const { mockUseQueueCounts } = vi.hoisted(() => ({
  mockUseQueueCounts: vi.fn(() => ({ activeJobs: 0, pendingJobs: 0 })),
}));

vi.mock('@/src/lib/api/engine-events-client', () => ({
  useQueueCounts: mockUseQueueCounts,
}));

import { ActiveJobsBadge } from '@/components/app-shell/active-jobs-badge';

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

const ORIGINAL_TITLE = 'x265-butler';

describe('ActiveJobsBadge', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.title = ORIGINAL_TITLE;
    mockUseQueueCounts.mockReturnValue({ activeJobs: 0, pendingJobs: 0 });
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ encodingJobs: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    document.title = ORIGINAL_TITLE;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('test_activeJobsBadge_when_zero_jobs_then_renders_null', async () => {
    const { container } = render(wrap(<ActiveJobsBadge />));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // Component returns null — Link element should not be present
    expect(container.querySelector('a')).toBeNull();
  });

  it('test_activeJobsBadge_when_three_jobs_via_engineEvents_then_renders_with_count_label', async () => {
    mockUseQueueCounts.mockReturnValue({ activeJobs: 3, pendingJobs: 0 });
    render(wrap(<ActiveJobsBadge />));
    await waitFor(() => expect(screen.getByText('3')).toBeTruthy());
    expect(screen.getByText('encoding')).toBeTruthy();
  });

  it('test_activeJobsBadge_when_count_changes_via_engineEvents_then_re_renders', async () => {
    mockUseQueueCounts.mockReturnValue({ activeJobs: 1, pendingJobs: 0 });
    const { rerender } = render(wrap(<ActiveJobsBadge />));
    await waitFor(() => expect(screen.getByText('1')).toBeTruthy());
    mockUseQueueCounts.mockReturnValue({ activeJobs: 5, pendingJobs: 0 });
    rerender(wrap(<ActiveJobsBadge />));
    await waitFor(() => expect(screen.getByText('5')).toBeTruthy());
  });

  it('test_activeJobsBadge_when_active_then_document_title_prefix_added', async () => {
    mockUseQueueCounts.mockReturnValue({ activeJobs: 4, pendingJobs: 0 });
    render(wrap(<ActiveJobsBadge />));
    await waitFor(() => expect(document.title).toBe(`(4) ${ORIGINAL_TITLE}`));
  });

  it('test_activeJobsBadge_when_inactive_then_document_title_reset_to_base', async () => {
    mockUseQueueCounts.mockReturnValue({ activeJobs: 2, pendingJobs: 0 });
    const { rerender } = render(wrap(<ActiveJobsBadge />));
    await waitFor(() => expect(document.title).toBe(`(2) ${ORIGINAL_TITLE}`));
    mockUseQueueCounts.mockReturnValue({ activeJobs: 0, pendingJobs: 0 });
    rerender(wrap(<ActiveJobsBadge />));
    await waitFor(() => expect(document.title).toBe(ORIGINAL_TITLE));
  });

  it('test_activeJobsBadge_when_renders_then_aria_label_uses_i18n_count_message', async () => {
    mockUseQueueCounts.mockReturnValue({ activeJobs: 7, pendingJobs: 0 });
    render(wrap(<ActiveJobsBadge />));
    const link = await screen.findByRole('link');
    expect(link.getAttribute('aria-label')).toMatch(/7 jobs currently encoding/);
  });

  // 05-13 UAT: badge target switched dashboard → queue per operator request
  // ("when the NAV bar shows N in Queue, the link should go to the Queue page").
  it('test_activeJobsBadge_when_clicked_then_navigates_to_queue', async () => {
    mockUseQueueCounts.mockReturnValue({ activeJobs: 1, pendingJobs: 0 });
    render(wrap(<ActiveJobsBadge />));
    const link = await screen.findByRole('link');
    expect(link.getAttribute('href')).toMatch(/\/en\/queue$/);
  });

  it('test_activeJobsBadge_when_renders_then_min_touch_target_44_via_h_11_min_w_11', async () => {
    mockUseQueueCounts.mockReturnValue({ activeJobs: 1, pendingJobs: 0 });
    render(wrap(<ActiveJobsBadge />));
    const link = await screen.findByRole('link');
    expect(link.className).toMatch(/h-11/);
    expect(link.className).toMatch(/min-w-11/);
  });

  it('test_activeJobsBadge_when_renders_then_pulse_class_uses_motion_safe_prefix', async () => {
    mockUseQueueCounts.mockReturnValue({ activeJobs: 1, pendingJobs: 0 });
    render(wrap(<ActiveJobsBadge />));
    const link = await screen.findByRole('link');
    expect(link.className).toMatch(/motion-safe:animate-pulse/);
  });

  // audit S2: 1-retry on transient 5xx
  it('test_activeJobsBadge_when_first_fetch_500_then_retries_once_and_warns_on_second_failure', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(wrap(<ActiveJobsBadge />));
    // First fetch fires immediately
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Advance past 1s backoff
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      await Promise.resolve();
    });
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('active_jobs_badge_bootstrap_failed'),
    );
    vi.useRealTimers();
    consoleWarnSpy.mockRestore();
  });

  // audit S3: didPrefix tracking — unmount without ever prefixing must NOT touch title
  it('test_activeJobsBadge_when_unmount_without_prefixing_then_document_title_NOT_overwritten', async () => {
    document.title = 'Custom external title';
    mockUseQueueCounts.mockReturnValue({ activeJobs: 0, pendingJobs: 0 });
    const { unmount } = render(wrap(<ActiveJobsBadge />));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    unmount();
    // Did NOT touch title because didPrefix was never set
    expect(document.title).toBe('Custom external title');
  });
});
