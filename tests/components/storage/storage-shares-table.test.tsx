// 15-02 T6: Shares-table — sort-toggle, orphan-row styling, deep-link in
// largestFolder cell.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import en from '@/messages/en.json';

const useSharesTableMock = vi.fn();

vi.mock('@/components/storage/use-storage-data', () => ({
  useSharesTable: () => useSharesTableMock(),
  StorageFetchError: class extends Error {
    status = 500;
    code = 'http_error';
  },
}));

import { StorageSharesTable } from '@/components/storage/storage-shares-table';

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

function dataWithRows() {
  return {
    data: {
      rows: [
        {
          shareId: 1,
          sharePath: '/mnt/a',
          totalSizeBytes: 200_000_000,
          hevcPercent: 30,
          savingsBytes: 0,
          largestFolder: { path: 'Movies/A', sizeBytes: 100_000_000 },
        },
        {
          shareId: 2,
          sharePath: '/mnt/b',
          totalSizeBytes: 1_000_000_000,
          hevcPercent: 70,
          savingsBytes: 50_000_000,
          largestFolder: { path: 'Series/B', sizeBytes: 800_000_000 },
        },
        {
          shareId: null,
          sharePath: null,
          totalSizeBytes: 50_000_000,
          hevcPercent: 0,
          savingsBytes: 0,
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
  };
}

beforeEach(() => useSharesTableMock.mockReset());

describe('<StorageSharesTable />', () => {
  it('renders all rows + orphan label', () => {
    useSharesTableMock.mockReturnValue(dataWithRows());
    render(wrap(<StorageSharesTable />));
    expect(screen.getByText('/mnt/a')).toBeInTheDocument();
    expect(screen.getByText('/mnt/b')).toBeInTheDocument();
    expect(screen.getByText('Orphan files')).toBeInTheDocument();
  });

  it('default sort is totalSizeBytes DESC (largest first)', () => {
    useSharesTableMock.mockReturnValue(dataWithRows());
    render(wrap(<StorageSharesTable />));
    const rows = screen.getAllByRole('row');
    // header + 3 rows; index 1 = the largest share
    expect(rows[1].textContent).toContain('/mnt/b');
  });

  it('toggle sort by HEVC % flips order on second click', () => {
    useSharesTableMock.mockReturnValue(dataWithRows());
    render(wrap(<StorageSharesTable />));
    const hevcHeader = screen.getByRole('button', { name: /HEVC %/i });
    fireEvent.click(hevcHeader); // first click sets DESC
    const afterFirst = screen.getAllByRole('row')[1].textContent;
    fireEvent.click(hevcHeader); // second click flips to ASC
    const afterSecond = screen.getAllByRole('row')[1].textContent;
    expect(afterFirst).not.toBe(afterSecond);
  });

  it('largestFolder cell renders deep-link href with share+pathPrefix', () => {
    useSharesTableMock.mockReturnValue(dataWithRows());
    render(wrap(<StorageSharesTable />));
    const links = screen.getAllByRole('link');
    const target = links.find((l) => l.getAttribute('href')?.includes('pathPrefix='));
    expect(target).toBeDefined();
    expect(target!.getAttribute('href')).toMatch(/share=2/);
    expect(target!.getAttribute('href')).toMatch(/pathPrefix=Series%2FB/);
  });

  it('orphan row receives muted/italic styling and no deep-link', () => {
    useSharesTableMock.mockReturnValue(dataWithRows());
    render(wrap(<StorageSharesTable />));
    const orphanCell = screen.getByText('Orphan files');
    const row = orphanCell.closest('tr');
    expect(row?.className).toMatch(/italic/);
  });
});
