// 15-02 T6: Codec-pie — note-tooltip icon, empty-state, legend lists codecs.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import en from '@/messages/en.json';

const useCodecPieMock = vi.fn();

vi.mock('@/components/storage/use-storage-data', () => ({
  useCodecPie: () => useCodecPieMock(),
  StorageFetchError: class extends Error {
    status = 500;
    code = 'http_error';
  },
}));

// Recharts uses ResizeObserver under the hood — JSDOM ships without it.
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver =
  ResizeObserverMock;

import { StorageCodecPieChart } from '@/components/storage/storage-codec-pie-chart';

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

beforeEach(() => useCodecPieMock.mockReset());

describe('<StorageCodecPieChart />', () => {
  it('renders legend rows for each codec', () => {
    useCodecPieMock.mockReturnValue({
      data: {
        codecs: [
          { codec: 'hevc', fileCount: 200, totalBytes: 10_000_000_000 },
          { codec: 'h264', fileCount: 100, totalBytes: 5_000_000_000 },
          { codec: 'unknown', fileCount: 5, totalBytes: 100_000_000 },
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
    render(wrap(<StorageCodecPieChart share="all" />));
    expect(screen.getByText('hevc')).toBeInTheDocument();
    expect(screen.getByText('h264')).toBeInTheDocument();
    expect(screen.getByText('unknown')).toBeInTheDocument();
  });

  it('shows empty-state when there are no codec slices', () => {
    useCodecPieMock.mockReturnValue({
      data: {
        codecs: [],
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
    render(wrap(<StorageCodecPieChart share="all" />));
    expect(screen.getByText('No codec data yet.')).toBeInTheDocument();
  });

  it('exposes the note via the info-tooltip button (AC-5)', () => {
    useCodecPieMock.mockReturnValue({
      data: {
        codecs: [{ codec: 'hevc', fileCount: 1, totalBytes: 1024 }],
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
    render(wrap(<StorageCodecPieChart share="all" />));
    expect(screen.getByRole('button', { name: /About this chart/i })).toBeInTheDocument();
  });
});
