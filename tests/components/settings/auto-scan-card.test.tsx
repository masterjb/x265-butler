import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import de from '@/messages/de.json';
import type { ReactNode } from 'react';

// Mock SWR so the card has predictable data without network.
const useSwrMock = vi.fn();
vi.mock('swr', () => ({
  __esModule: true,
  default: (...args: unknown[]) => useSwrMock(...args),
  mutate: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { AutoScanCard } from '@/components/settings/auto-scan-card';

interface AutoScanHealth {
  status: 'running' | 'error' | 'stopped';
  lastEventAt: string | null;
  lastReconcileAt: string | null;
  bootReconcileCount: number;
  orphanReEnqueueCountAtBoot: number;
  droppedEventsLast24h: number;
  inotifyError: { code: string; message: string } | null;
  currentInotifyWatches: number | null;
  maxUserWatches: number | null;
  pollingModeByShare: Record<string, 'inotify' | 'polling-auto' | 'polling-forced'>;
}

function makeHealth(overrides: Partial<AutoScanHealth> = {}): AutoScanHealth {
  return {
    status: 'running',
    lastEventAt: null,
    lastReconcileAt: null,
    bootReconcileCount: 0,
    orphanReEnqueueCountAtBoot: 0,
    droppedEventsLast24h: 0,
    inotifyError: null,
    currentInotifyWatches: 100,
    maxUserWatches: 524288,
    pollingModeByShare: { media: 'inotify' },
    ...overrides,
  };
}

function setHealth(health: AutoScanHealth | null): void {
  useSwrMock.mockReturnValue({
    data: health ? { version: '2.11.0', autoScan: health } : undefined,
    error: undefined,
    isLoading: health === null,
  });
}

function wrap(children: ReactNode, locale: 'en' | 'de' = 'en') {
  return (
    <NextIntlClientProvider locale={locale} messages={locale === 'de' ? de : en}>
      {children}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  useSwrMock.mockReset();
});

describe('AutoScanCard', () => {
  it('renders running badge with triple-redundant encoding (color + icon + label)', () => {
    setHealth(makeHealth({ status: 'running' }));
    render(wrap(<AutoScanCard />));
    const badge = screen.getByRole('status');
    expect(badge.dataset.status).toBe('running');
    expect(badge.textContent).toContain('Active');
    expect(badge.className).toContain('text-primary');
    expect(badge.querySelector('svg')).toBeTruthy();
  });

  it('renders error badge with destructive tone + AlertCircle icon', () => {
    setHealth(
      makeHealth({
        status: 'error',
        inotifyError: { code: 'ENOSPC', message: 'System limit' },
      }),
    );
    render(wrap(<AutoScanCard />));
    const badge = screen.getByRole('status');
    expect(badge.dataset.status).toBe('error');
    expect(badge.textContent).toContain('Error');
    expect(badge.className).toContain('text-destructive');
  });

  it('renders stopped badge with muted tone', () => {
    setHealth(makeHealth({ status: 'stopped' }));
    render(wrap(<AutoScanCard />));
    const badge = screen.getByRole('status');
    expect(badge.dataset.status).toBe('stopped');
    expect(badge.textContent).toContain('Stopped');
    expect(badge.className).toContain('text-muted-foreground');
  });

  it('renders ENOSPC banner when status=error and code=ENOSPC', () => {
    setHealth(
      makeHealth({
        status: 'error',
        inotifyError: { code: 'ENOSPC', message: 'System limit' },
      }),
    );
    render(wrap(<AutoScanCard />));
    expect(screen.getByRole('alert', { name: '' }).dataset.banner).toBe('enospc');
    expect(screen.getByText('inotify limit reached (ENOSPC)')).toBeInTheDocument();
    expect(screen.getByText(/Auto-retry running/)).toBeInTheDocument();
  });

  it('inotify-budget bar at 50% → healthy (bg-primary, no warn icon)', () => {
    setHealth(makeHealth({ currentInotifyWatches: 100, maxUserWatches: 200 }));
    render(wrap(<AutoScanCard />));
    const bar = screen.getByRole('progressbar');
    expect(bar.dataset.budgetState).toBe('healthy');
    expect(bar.className).toContain('bg-primary');
  });

  it('inotify-budget bar at 85% → pressure (amber warn-color)', () => {
    setHealth(makeHealth({ currentInotifyWatches: 850, maxUserWatches: 1000 }));
    render(wrap(<AutoScanCard />));
    const bar = screen.getByRole('progressbar');
    expect(bar.dataset.budgetState).toBe('pressure');
    expect(bar.className).toContain('bg-amber-500');
  });

  it('inotify-budget bar with both null → unknown copy', () => {
    setHealth(makeHealth({ currentInotifyWatches: null, maxUserWatches: null }));
    render(wrap(<AutoScanCard />));
    expect(screen.getByText('(unknown — Linux only)')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('per-share table renders multiple shares with mixed polling modes', () => {
    setHealth(
      makeHealth({
        pollingModeByShare: {
          fast: 'inotify',
          slow: 'polling-forced',
          mid: 'polling-auto',
        },
      }),
    );
    render(wrap(<AutoScanCard />));
    expect(screen.getByText('fast')).toBeInTheDocument();
    expect(screen.getByText('slow')).toBeInTheDocument();
    expect(screen.getByText('mid')).toBeInTheDocument();
    expect(screen.getAllByText(/Polling/).length).toBeGreaterThanOrEqual(2);
  });

  it('lastEventAt = null → "no events yet" copy', () => {
    setHealth(makeHealth({ lastEventAt: null }));
    render(wrap(<AutoScanCard />));
    expect(screen.getByText('no events yet')).toBeInTheDocument();
  });

  it('DE locale renders German copy', () => {
    setHealth(makeHealth({ status: 'running' }));
    render(wrap(<AutoScanCard />, 'de'));
    expect(screen.getByText('Aktiv')).toBeInTheDocument();
    expect(screen.getByText(/Auto-Scan-Status|Auto-Scan/)).toBeInTheDocument();
  });

  it('audit M9: low-budget banner renders when maxUserWatches < 524288', () => {
    setHealth(
      makeHealth({
        currentInotifyWatches: 10,
        maxUserWatches: 8192,
      }),
    );
    render(wrap(<AutoScanCard />));
    const banners = screen.getAllByRole('alert');
    const low = banners.find((b) => b.dataset.banner === 'low');
    expect(low).toBeDefined();
  });

  it('audit M9: pressure-budget banner renders when ratio > 0.8 (no low)', () => {
    setHealth(
      makeHealth({
        currentInotifyWatches: 600_000,
        maxUserWatches: 700_000,
      }),
    );
    render(wrap(<AutoScanCard />));
    const banners = screen.getAllByRole('alert');
    const pressure = banners.find((b) => b.dataset.banner === 'pressure');
    expect(pressure).toBeDefined();
  });

  it('audit M9: no banner when ratio ≤ 0.8 AND maxUserWatches ≥ 524288', () => {
    setHealth(makeHealth({ currentInotifyWatches: 100, maxUserWatches: 524288 }));
    render(wrap(<AutoScanCard />));
    const banners = screen.queryAllByRole('alert');
    expect(
      banners.find((b) => b.dataset.banner === 'low' || b.dataset.banner === 'pressure'),
    ).toBeUndefined();
  });

  it('audit M4: droppedEventsLast24h footer entry hidden when 0, visible when > 0', () => {
    setHealth(makeHealth({ droppedEventsLast24h: 0 }));
    const { rerender } = render(wrap(<AutoScanCard />));
    expect(screen.queryByText(/Events dropped/)).not.toBeInTheDocument();
    setHealth(makeHealth({ droppedEventsLast24h: 7 }));
    rerender(wrap(<AutoScanCard />));
    expect(screen.getByText(/Events dropped/)).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
  });
});
