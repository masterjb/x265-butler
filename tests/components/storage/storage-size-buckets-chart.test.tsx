// 15-02 T6: Buckets chart — 4 bars rendered with weighted %, empty-DB still
// emits 4 buckets at 0 % (SR4 canonical-empty), error-card on fetch failure.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import en from '@/messages/en.json';

const useBucketsMock = vi.fn();

vi.mock('@/components/storage/use-storage-data', () => ({
  useBuckets: () => useBucketsMock(),
  StorageFetchError: class extends Error {
    status = 500;
    code = 'http_error';
  },
}));

import { StorageSizeBucketsChart } from '@/components/storage/storage-size-buckets-chart';

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

const ZERO_BUCKETS = [
  { label: '<100MB', minBytes: 0, maxBytes: 99 * 1024 ** 2, fileCount: 0, totalBytes: 0 },
  {
    label: '100MB-1GB',
    minBytes: 100 * 1024 ** 2,
    maxBytes: 1024 ** 3 - 1,
    fileCount: 0,
    totalBytes: 0,
  },
  {
    label: '1-10GB',
    minBytes: 1024 ** 3,
    maxBytes: 10 * 1024 ** 3 - 1,
    fileCount: 0,
    totalBytes: 0,
  },
  {
    label: '10GB+',
    minBytes: 10 * 1024 ** 3,
    maxBytes: Number.MAX_SAFE_INTEGER,
    fileCount: 0,
    totalBytes: 0,
  },
];

beforeEach(() => useBucketsMock.mockReset());

describe('<StorageSizeBucketsChart />', () => {
  it('renders 4 bars when populated', () => {
    useBucketsMock.mockReturnValue({
      data: {
        buckets: [
          { ...ZERO_BUCKETS[0], fileCount: 12, totalBytes: 850_000_000 },
          { ...ZERO_BUCKETS[1], fileCount: 488, totalBytes: 180_000_000_000 },
          { ...ZERO_BUCKETS[2], fileCount: 211, totalBytes: 220_000_000_000 },
          { ...ZERO_BUCKETS[3], fileCount: 8, totalBytes: 60_000_000_000 },
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
    render(wrap(<StorageSizeBucketsChart share="all" />));
    expect(screen.getAllByRole('progressbar')).toHaveLength(4);
  });

  it('empty DB still renders 4 buckets (SR4)', () => {
    useBucketsMock.mockReturnValue({
      data: {
        buckets: ZERO_BUCKETS,
        computedAt: 'x',
        dataAsOf: 'x',
        requestId: 'r',
      },
      error: undefined,
      isLoading: false,
      isValidating: false,
      mutate: vi.fn(),
    });
    render(wrap(<StorageSizeBucketsChart share="all" />));
    const bars = screen.getAllByRole('progressbar');
    expect(bars).toHaveLength(4);
    bars.forEach((b) => expect(b).toHaveAttribute('aria-valuenow', '0'));
  });

  it('shows skeleton during initial load', () => {
    useBucketsMock.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: true,
      isValidating: false,
      mutate: vi.fn(),
    });
    const { container } = render(wrap(<StorageSizeBucketsChart share="all" />));
    expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull();
  });

  it('surfaces an error card on fetch failure', () => {
    useBucketsMock.mockReturnValue({
      data: undefined,
      error: new Error('boom'),
      isLoading: false,
      isValidating: false,
      mutate: vi.fn(),
    });
    render(wrap(<StorageSizeBucketsChart share="all" />));
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
