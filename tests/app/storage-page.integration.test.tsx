// 15-02 T6: Storage-page golden-path integration test. Mocks the 5
// use-storage-data hooks and renders StorageClient to assert:
//   - Toolbar + KPI-strip + 4 widgets mount in the expected grid.
//   - Top-level empty-state branches (no-shares / no-files) resolve.
//   - vitest-axe sees no serious/critical violations on the loaded tree.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';

import { wrap } from '../test-utils';

const useKpisMock = vi.fn();
const useBucketsMock = vi.fn();
const useCodecPieMock = vi.fn();
const useSharesTableMock = vi.fn();
const useTopFoldersMock = vi.fn();

vi.mock('@/components/storage/use-storage-data', () => ({
  useKpis: () => useKpisMock(),
  useBuckets: () => useBucketsMock(),
  useCodecPie: () => useCodecPieMock(),
  useSharesTable: () => useSharesTableMock(),
  useTopFolders: () => useTopFoldersMock(),
  StorageFetchError: class extends Error {
    status = 500;
    code = 'http_error';
  },
}));

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver =
  ResizeObserverMock;

import { StorageClient } from '@/app/[locale]/storage/storage-client';
import type { ShareRow } from '@/src/lib/db/schema';

const SHARES: ShareRow[] = [
  {
    id: 1,
    name: 'Movies',
    path: '/mnt/movies',
    min_size_mb: 50,
    extensions_csv: 'mkv,mp4',
    max_depth: null,
    created_at: 0,
    updated_at: 0,
  },
  {
    id: 2,
    name: 'Series',
    path: '/mnt/tv',
    min_size_mb: 50,
    extensions_csv: 'mkv,mp4',
    max_depth: null,
    created_at: 0,
    updated_at: 0,
  },
];

function loaded() {
  useKpisMock.mockReturnValue({
    data: {
      totalSizeBytes: 1_500_000_000,
      largestFolder: { shareId: 1, path: 'Movies/A', sizeBytes: 800_000_000 },
      mostOptimizedShare: { shareId: 2, hevcPercent: 70 },
      legacyCodecPercent: 12,
      computedAt: '2026-05-18T14:30:00Z',
      dataAsOf: '2026-05-18T14:30:00Z',
      requestId: 'r',
      effectiveFilters: { share: 'all' },
    },
    error: undefined,
    isLoading: false,
    isValidating: false,
    mutate: vi.fn(),
  });
  useBucketsMock.mockReturnValue({
    data: {
      buckets: [
        {
          label: '<100MB',
          minBytes: 0,
          maxBytes: 99_000_000,
          fileCount: 10,
          totalBytes: 500_000_000,
        },
        {
          label: '100MB-1GB',
          minBytes: 100_000_000,
          maxBytes: 999_000_000,
          fileCount: 8,
          totalBytes: 600_000_000,
        },
        {
          label: '1-10GB',
          minBytes: 1_000_000_000,
          maxBytes: 9_999_000_000,
          fileCount: 3,
          totalBytes: 400_000_000,
        },
        {
          label: '10GB+',
          minBytes: 10_000_000_000,
          maxBytes: Number.MAX_SAFE_INTEGER,
          fileCount: 0,
          totalBytes: 0,
        },
      ],
      computedAt: 'x',
      dataAsOf: 'x',
      requestId: 'r',
    },
    error: undefined,
    isLoading: false,
    isValidating: false,
    mutate: vi.fn(),
  });
  useCodecPieMock.mockReturnValue({
    data: {
      codecs: [
        { codec: 'hevc', fileCount: 10, totalBytes: 800_000_000 },
        { codec: 'h264', fileCount: 5, totalBytes: 400_000_000 },
      ],
      note: 'current-state codec only',
      computedAt: 'x',
      dataAsOf: 'x',
      requestId: 'r',
    },
    error: undefined,
    isLoading: false,
    isValidating: false,
    mutate: vi.fn(),
  });
  useSharesTableMock.mockReturnValue({
    data: {
      rows: [
        {
          shareId: 1,
          sharePath: '/mnt/movies',
          totalSizeBytes: 1_000_000_000,
          hevcPercent: 60,
          savingsBytes: 0,
          largestFolder: { path: 'Movies/A', sizeBytes: 800_000_000 },
        },
        {
          shareId: 2,
          sharePath: '/mnt/tv',
          totalSizeBytes: 500_000_000,
          hevcPercent: 70,
          savingsBytes: 100_000,
          largestFolder: null,
        },
      ],
      computedAt: 'x',
      dataAsOf: 'x',
      requestId: 'r',
    },
    error: undefined,
    isLoading: false,
    isValidating: false,
    mutate: vi.fn(),
  });
  useTopFoldersMock.mockReturnValue({
    data: {
      rows: [
        { shareId: 1, path: 'Movies/A', sizeBytes: 500_000_000, fileCount: 30 },
        { shareId: 2, path: 'Series/B', sizeBytes: 200_000_000, fileCount: 12 },
      ],
      depth: 2,
      share: 'all',
      truncated: false,
      effectiveFilters: { share: 'all', depth: 2 },
      computedAt: 'x',
      dataAsOf: 'x',
      requestId: 'r',
    },
    error: undefined,
    isLoading: false,
    isValidating: false,
    mutate: vi.fn(),
  });
}

function emptyKpis() {
  useKpisMock.mockReturnValue({
    data: {
      totalSizeBytes: 0,
      largestFolder: null,
      mostOptimizedShare: null,
      legacyCodecPercent: 0,
      computedAt: '2026-05-18T14:30:00Z',
      dataAsOf: '2026-05-18T14:30:00Z',
      requestId: 'r',
      effectiveFilters: { share: 'all' },
    },
    error: undefined,
    isLoading: false,
    isValidating: false,
    mutate: vi.fn(),
  });
}

beforeEach(() => {
  useKpisMock.mockReset();
  useBucketsMock.mockReset();
  useCodecPieMock.mockReset();
  useSharesTableMock.mockReset();
  useTopFoldersMock.mockReset();
});

describe('<StorageClient /> golden path', () => {
  it('renders title + 4 widget headlines when data is loaded', () => {
    loaded();
    render(wrap(<StorageClient initialShares={SHARES} initialOrphanCount={0} />));

    expect(screen.getByRole('heading', { name: 'Storage Analyzer' })).toBeInTheDocument();
    expect(screen.getByText('Size Distribution')).toBeInTheDocument();
    expect(screen.getByText('Codec Distribution')).toBeInTheDocument();
    expect(screen.getByText('Shares Comparison')).toBeInTheDocument();
    expect(screen.getByText('Top Folders by Size')).toBeInTheDocument();
  });

  it('renders the as-of label with the formatted time once kpis resolve', () => {
    loaded();
    render(wrap(<StorageClient initialShares={SHARES} initialOrphanCount={0} />));
    const asOf = screen.getByTestId('as-of-label');
    expect(asOf.textContent).toMatch(/As of/);
    // formatTime emits HH:MM:SS in local timezone — assert shape, not value.
    expect(asOf.textContent).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('shows the no-shares empty state when initialShares is empty', () => {
    loaded();
    render(wrap(<StorageClient initialShares={[]} initialOrphanCount={0} />));
    expect(screen.getByText('No shares configured')).toBeInTheDocument();
  });

  it('shows the no-files empty state when shares exist but total size is 0', () => {
    emptyKpis();
    useBucketsMock.mockReturnValue({
      data: { buckets: [], computedAt: 'x', dataAsOf: 'x', requestId: 'r' },
      error: undefined,
      isLoading: false,
      isValidating: false,
      mutate: vi.fn(),
    });
    useCodecPieMock.mockReturnValue({
      data: { codecs: [], note: 'n', computedAt: 'x', dataAsOf: 'x', requestId: 'r' },
      error: undefined,
      isLoading: false,
      isValidating: false,
      mutate: vi.fn(),
    });
    useSharesTableMock.mockReturnValue({
      data: { rows: [], computedAt: 'x', dataAsOf: 'x', requestId: 'r' },
      error: undefined,
      isLoading: false,
      isValidating: false,
      mutate: vi.fn(),
    });
    useTopFoldersMock.mockReturnValue({
      data: {
        rows: [],
        depth: 2,
        share: 'all',
        truncated: false,
        computedAt: 'x',
        dataAsOf: 'x',
        requestId: 'r',
      },
      error: undefined,
      isLoading: false,
      isValidating: false,
      mutate: vi.fn(),
    });
    render(wrap(<StorageClient initialShares={SHARES} initialOrphanCount={0} />));
    expect(screen.getByText('No files scanned yet')).toBeInTheDocument();
  });

  it('vitest-axe finds no serious/critical violations on the loaded tree (AC-15)', async () => {
    loaded();
    const { container } = render(
      wrap(<StorageClient initialShares={SHARES} initialOrphanCount={0} />),
    );
    const results = await axe(container);
    const blocking = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    if (blocking.length > 0) {
      console.error(
        'storage-page axe violations:',
        blocking.map((v) => ({ id: v.id, impact: v.impact, help: v.help })),
      );
    }
    expect(blocking).toHaveLength(0);
  });
});
