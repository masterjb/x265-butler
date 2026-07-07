// 15-02 T6: StorageKpiStrip tests — render of 4 cards, empty-state branches,
// cross-share badge always visible, threshold color-zone labels.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import en from '@/messages/en.json';

// Hook mocks are hoisted before module evaluation.
const useKpisMock = vi.fn();
const useSharesTableMock = vi.fn();

vi.mock('@/components/storage/use-storage-data', () => ({
  useKpis: (...args: unknown[]) => useKpisMock(...args),
  useSharesTable: () => useSharesTableMock(),
  StorageFetchError: class extends Error {
    status = 500;
    code = 'http_error';
  },
}));

import { StorageKpiStrip } from '@/components/storage/storage-kpi-strip';

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

function baseKpiResponse() {
  return {
    data: {
      totalSizeBytes: 1_500_000_000,
      largestFolder: { shareId: 1, path: 'Movies/A', sizeBytes: 800_000_000 },
      mostOptimizedShare: { shareId: 2, hevcPercent: 87.4 },
      legacyCodecPercent: 12.3,
      computedAt: '2026-05-18T14:30:00Z',
      dataAsOf: '2026-05-18T14:30:00Z',
      requestId: 'r1',
      effectiveFilters: { share: 'all' as const },
    },
    error: undefined,
    isLoading: false,
    isValidating: false,
    mutate: vi.fn(),
  };
}

function baseSharesResponse() {
  return {
    data: {
      rows: [
        {
          shareId: 1,
          sharePath: '/mnt/movies',
          totalSizeBytes: 1_000_000_000,
          hevcPercent: 50,
          savingsBytes: 0,
          largestFolder: null,
        },
        {
          shareId: 2,
          sharePath: '/mnt/tv',
          totalSizeBytes: 500_000_000,
          hevcPercent: 87.4,
          savingsBytes: 100_000,
          largestFolder: null,
        },
      ],
      computedAt: '2026-05-18T14:30:00Z',
      dataAsOf: '2026-05-18T14:30:00Z',
      requestId: 'r2',
    },
    error: undefined,
    isLoading: false,
    isValidating: false,
    mutate: vi.fn(),
  };
}

beforeEach(() => {
  useKpisMock.mockReset();
  useSharesTableMock.mockReset();
});

describe('<StorageKpiStrip />', () => {
  it('renders 4 KPI cards with healthy zone for low legacy %', () => {
    useKpisMock.mockReturnValue(baseKpiResponse());
    useSharesTableMock.mockReturnValue(baseSharesResponse());

    render(wrap(<StorageKpiStrip share="all" />));

    expect(screen.getByText('Total Size')).toBeInTheDocument();
    expect(screen.getByText('Largest Folder')).toBeInTheDocument();
    expect(screen.getByText('Most Optimized Share')).toBeInTheDocument();
    expect(screen.getByText('Legacy Codec %')).toBeInTheDocument();
    // 12.3 % → "Healthy"
    expect(screen.getByText('Healthy')).toBeInTheDocument();
  });

  it('shows null-largestFolder empty state', () => {
    const r = baseKpiResponse();
    (r.data as { largestFolder: unknown }).largestFolder = null;
    useKpisMock.mockReturnValue(r);
    useSharesTableMock.mockReturnValue(baseSharesResponse());

    render(wrap(<StorageKpiStrip share="all" />));
    expect(screen.getByText('No folders yet')).toBeInTheDocument();
  });

  it('shows null-mostOptimizedShare empty state when no HEVC anywhere', () => {
    const r = baseKpiResponse();
    (r.data as { mostOptimizedShare: unknown }).mostOptimizedShare = null;
    useKpisMock.mockReturnValue(r);
    useSharesTableMock.mockReturnValue(baseSharesResponse());

    render(wrap(<StorageKpiStrip share="all" />));
    expect(screen.getByText('No HEVC data yet')).toBeInTheDocument();
  });

  it('cross-share badge is visible even when a share-filter is active', () => {
    useKpisMock.mockReturnValue(baseKpiResponse());
    useSharesTableMock.mockReturnValue(baseSharesResponse());

    render(wrap(<StorageKpiStrip share={2} />));
    expect(screen.getByText('across all shares')).toBeInTheDocument();
  });

  it('critical threshold shows critical icon + zone label', () => {
    const r = baseKpiResponse();
    r.data.legacyCodecPercent = 78.5;
    useKpisMock.mockReturnValue(r);
    useSharesTableMock.mockReturnValue(baseSharesResponse());

    render(wrap(<StorageKpiStrip share="all" />));
    expect(screen.getByText('Critical')).toBeInTheDocument();
  });

  it('renders skeletons while initial fetch is in flight', () => {
    useKpisMock.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: true,
      isValidating: false,
      mutate: vi.fn(),
    });
    useSharesTableMock.mockReturnValue(baseSharesResponse());

    const { container } = render(wrap(<StorageKpiStrip share="all" />));
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(4);
  });
});
