/*
 * 04-02 Task 3: blocklist page Client Component tests.
 *
 * Mocks: next/navigation, sonner, fetch. Mirrors 03-05 onboarding-page.test.tsx
 * vi.hoisted pattern.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';

const { mockRouterRefresh, mockRouterPush, mockToastSuccess, mockToastError } = vi.hoisted(() => ({
  mockRouterRefresh: vi.fn(),
  mockRouterPush: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/en/blocklist',
  useRouter: () => ({
    push: mockRouterPush,
    refresh: mockRouterRefresh,
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('sonner', () => ({
  toast: { success: mockToastSuccess, error: mockToastError },
}));

import {
  BlocklistClient,
  type BlocklistRowWithFile,
} from '@/app/[locale]/blocklist/blocklist-client';
import { runtime } from '@/app/[locale]/blocklist/page';

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

const sampleRows: BlocklistRowWithFile[] = [
  {
    id: 1,
    file_id: 5,
    path_pattern: null,
    reason: 'operator',
    created_at: 1700000000,
    filePath: '/movies/Foo.mkv',
  },
  {
    id: 2,
    file_id: null,
    path_pattern: '/movies/Samples/*',
    reason: 'operator',
    created_at: 1700000000,
    filePath: null,
  },
];

beforeEach(() => {
  mockRouterRefresh.mockReset();
  mockToastSuccess.mockReset();
  mockToastError.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('BlocklistClient', () => {
  it('test_blocklistPage_runtime_export_is_nodejs', () => {
    expect(runtime).toBe('nodejs');
  });

  it('test_blocklistPage_when_renders_with_no_entries_then_empty_state_visible', () => {
    render(
      wrap(
        <BlocklistClient
          initialRows={[]}
          initialTotal={0}
          initialPage={1}
          initialSize={50}
          dbErrored={false}
        />,
      ),
    );
    expect(screen.getByRole('heading', { name: /No blocklist entries/i })).toBeInTheDocument();
  });

  it('test_blocklistPage_when_renders_with_entries_then_table_visible', () => {
    render(
      wrap(
        <BlocklistClient
          initialRows={sampleRows}
          initialTotal={2}
          initialPage={1}
          initialSize={50}
          dbErrored={false}
        />,
      ),
    );
    // File-pinned row shows the file path
    expect(screen.getAllByText('/movies/Foo.mkv').length).toBeGreaterThanOrEqual(1);
    // Pattern row shows the pattern
    expect(screen.getAllByText('/movies/Samples/*').length).toBeGreaterThanOrEqual(1);
  });

  it('test_blocklistPage_when_addPattern_clicked_then_form_expands', () => {
    render(
      wrap(
        <BlocklistClient
          initialRows={sampleRows}
          initialTotal={2}
          initialPage={1}
          initialSize={50}
          dbErrored={false}
        />,
      ),
    );
    const addButton = screen.getByRole('button', { name: /Add pattern/i });
    fireEvent.click(addButton);
    expect(screen.getByLabelText(/Path pattern/i)).toBeInTheDocument();
  });

  it('test_blocklistPage_when_addPattern_3_stars_then_inline_error_displayed', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(
      wrap(
        <BlocklistClient
          initialRows={[]}
          initialTotal={0}
          initialPage={1}
          initialSize={50}
          dbErrored={false}
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /Add pattern/i }));
    const input = screen.getByLabelText(/Path pattern/i);
    fireEvent.change(input, { target: { value: '/a/*/b/*/c/*' } });
    const submitBtn = screen.getByRole('button', { name: /^Add$/i });
    fireEvent.click(submitBtn);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/at most two/i);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('test_blocklistPage_when_addPattern_form_submitted_with_valid_pattern_then_POST_fires', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 99,
            fileId: null,
            pathPattern: '/movies/Samples/*',
            reason: 'operator',
            createdAt: 1700000000,
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(
      wrap(
        <BlocklistClient
          initialRows={[]}
          initialTotal={0}
          initialPage={1}
          initialSize={50}
          dbErrored={false}
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /Add pattern/i }));
    fireEvent.change(screen.getByLabelText(/Path pattern/i), {
      target: { value: '/movies/Samples/*' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Add$/i }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/library/0/blocklist',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith(en.blocklist.added.toast);
    });
  });

  it('test_blocklistPage_when_remove_clicked_then_confirm_phase_visible', () => {
    render(
      wrap(
        <BlocklistClient
          initialRows={sampleRows}
          initialTotal={2}
          initialPage={1}
          initialSize={50}
          dbErrored={false}
        />,
      ),
    );
    // Two Remove buttons (one per row); click first
    const removeButtons = screen.getAllByRole('button', { name: /^Remove$/i });
    fireEvent.click(removeButtons[0]);
    expect(
      screen.getAllByRole('button', { name: /^Confirm remove$/i }).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('test_blocklistPage_when_remove_confirmed_then_DELETE_fires_AND_toast_shown', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ removed: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(
      wrap(
        <BlocklistClient
          initialRows={sampleRows}
          initialTotal={2}
          initialPage={1}
          initialSize={50}
          dbErrored={false}
        />,
      ),
    );
    const removeButtons = screen.getAllByRole('button', { name: /^Remove$/i });
    fireEvent.click(removeButtons[0]);
    const confirmBtn = screen.getAllByRole('button', { name: /^Confirm remove$/i })[0];
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/library/1/blocklist',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith(en.blocklist.removed.toast);
    });
  });

  it('test_blocklistPage_when_dbErrored_true_then_error_state_visible', () => {
    render(
      wrap(
        <BlocklistClient
          initialRows={[]}
          initialTotal={0}
          initialPage={1}
          initialSize={50}
          dbErrored
        />,
      ),
    );
    expect(screen.getByText(/Could not load blocklist/i)).toBeInTheDocument();
  });
});
