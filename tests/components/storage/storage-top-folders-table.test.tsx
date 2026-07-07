// 15-02 T6: Top-folders table — row-click navigation, truncated banner
// conditional render, URL-encoding for special characters.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import en from '@/messages/en.json';

const useTopFoldersMock = vi.fn();
const routerPush = vi.fn();

vi.mock('@/components/storage/use-storage-data', () => ({
  useTopFolders: () => useTopFoldersMock(),
  StorageFetchError: class extends Error {
    status = 500;
    code = 'http_error';
  },
}));

vi.mock('next/navigation', async () => {
  const actual = await vi.importActual<typeof import('next/navigation')>('next/navigation');
  return {
    ...actual,
    usePathname: () => '/en/storage',
    useRouter: () => ({
      push: routerPush,
      replace: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
    }),
    useSearchParams: () => new URLSearchParams(),
  };
});

import { StorageTopFoldersTable } from '@/components/storage/storage-top-folders-table';

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

function baseData(truncated = false) {
  return {
    data: {
      rows: [
        { shareId: 1, path: 'Movies/A', sizeBytes: 500_000_000, fileCount: 50 },
        { shareId: 2, path: 'Café/Ñoño#1?bar', sizeBytes: 200_000_000, fileCount: 12 },
      ],
      depth: 2,
      share: 'all' as const,
      truncated,
      effectiveFilters: { share: 'all' as const, depth: 2 },
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

beforeEach(() => {
  useTopFoldersMock.mockReset();
  routerPush.mockReset();
});

describe('<StorageTopFoldersTable />', () => {
  it('renders rows with rank, path, size, files columns', () => {
    useTopFoldersMock.mockReturnValue(baseData(false));
    render(wrap(<StorageTopFoldersTable share="all" depth={2} />));
    expect(screen.getByText('Movies/A')).toBeInTheDocument();
    expect(screen.getByText(/Café/)).toBeInTheDocument();
  });

  it('row click pushes /library?share=X&pathPrefix=<encoded path>', () => {
    useTopFoldersMock.mockReturnValue(baseData(false));
    render(wrap(<StorageTopFoldersTable share="all" depth={2} />));
    const row = screen.getByRole('button', { name: /View files in Movies\/A/i });
    fireEvent.click(row);
    expect(routerPush).toHaveBeenCalledWith('/en/library?share=1&pathPrefix=Movies%2FA');
  });

  it('correctly URL-encodes special characters (#, ?, é, space)', () => {
    useTopFoldersMock.mockReturnValue(baseData(false));
    render(wrap(<StorageTopFoldersTable share="all" depth={2} />));
    const row = screen.getByRole('button', { name: /View files in Café/i });
    fireEvent.click(row);
    const url = routerPush.mock.calls[0][0] as string;
    expect(url).toContain('%23'); // #
    expect(url).toContain('%3F'); // ?
    expect(url).toContain('Caf%C3%A9'); // é NFC
  });

  it('truncated=true shows the warning banner', () => {
    useTopFoldersMock.mockReturnValue(baseData(true));
    render(wrap(<StorageTopFoldersTable share="all" depth={2} />));
    expect(screen.getByText(/Results limited/i)).toBeInTheDocument();
  });

  it('truncated=false hides the warning banner', () => {
    useTopFoldersMock.mockReturnValue(baseData(false));
    render(wrap(<StorageTopFoldersTable share="all" depth={2} />));
    expect(screen.queryByText(/Results limited/i)).toBeNull();
  });

  it('shows empty-state when rows is empty', () => {
    useTopFoldersMock.mockReturnValue({
      data: {
        rows: [],
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
    render(wrap(<StorageTopFoldersTable share="all" depth={2} />));
    expect(screen.getByText('No folders to rank yet.')).toBeInTheDocument();
  });
});
