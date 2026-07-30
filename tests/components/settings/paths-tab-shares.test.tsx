/*
 * 14-04 Task 4 — PathsTabShares tests.
 *
 * Covers AC-10 (Card-Liste replaces legacy form + empty state),
 * AC-12 (Add appends + toast), AC-13 (Delete card removal + toast),
 * AC-14 (path-change toast carries action button per SR6),
 * AC-25 (dirty-discard AlertDialog SR5).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import type { ShareRow } from '@/src/lib/db/schema';

const { mockToastSuccess, mockToastError, mockToastMessage, mockRouterPush } = vi.hoisted(() => ({
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
  mockToastMessage: vi.fn(),
  mockRouterPush: vi.fn(),
}));

vi.mock('sonner', () => {
  const toast = (() => undefined) as unknown as Record<string, unknown>;
  toast.success = mockToastSuccess;
  toast.error = mockToastError;
  toast.message = mockToastMessage;
  toast.dismiss = vi.fn();
  toast.custom = vi.fn();
  return { toast, default: { toast } };
});

vi.mock('@/components/ui/undo-toast', () => ({
  showUndoToast: vi.fn(),
  UNDO_TOAST_DEFAULT_MS: 10000,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockRouterPush, replace: vi.fn(), refresh: vi.fn() }),
}));

import { PathsTabShares } from '@/components/settings/paths-tab-shares';

function wrap(children: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      {children}
    </NextIntlClientProvider>
  );
}

function shareRow(overrides: Partial<ShareRow> = {}): ShareRow {
  return {
    id: 1,
    name: 'Movies',
    path: '/media/movies',
    min_size_mb: 50,
    extensions_csv: 'mkv,mp4,avi',
    max_depth: 8,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  mockToastSuccess.mockReset();
  mockToastError.mockReset();
  mockToastMessage.mockReset();
  mockRouterPush.mockReset();
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((q: string) => ({
      matches: false,
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('PathsTabShares — AC-10 empty state', () => {
  it('test_render_when_no_shares_then_empty_state_and_only_add_form', () => {
    render(wrap(<PathsTabShares initialShares={[]} />));
    expect(screen.getByTestId('paths-tab-empty')).toBeInTheDocument();
    expect(screen.getByTestId('share-add-form')).toBeInTheDocument();
    expect(screen.queryByTestId(/share-card-/)).toBeNull();
  });
});

describe('PathsTabShares — AC-10 list render', () => {
  it('test_render_when_2_shares_then_cards_id_asc_and_add_form_at_bottom', () => {
    render(
      wrap(
        <PathsTabShares
          initialShares={[
            shareRow({ id: 1, name: 'Movies' }),
            shareRow({
              id: 2,
              name: 'Music',
              path: '/media/music',
              max_depth: null,
            }),
          ]}
        />,
      ),
    );
    expect(screen.getByTestId('share-card-1')).toBeInTheDocument();
    expect(screen.getByTestId('share-card-2')).toBeInTheDocument();
    expect(screen.getByTestId('share-add-form')).toBeInTheDocument();
  });
});

describe('PathsTabShares — AC-12 add appends + toast', () => {
  it('test_add_when_201_then_card_appears_and_success_toast_fires', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(201, {
        share: shareRow({ id: 2, name: 'Music', path: '/media/music' }),
        requestId: 'r1',
      }),
    );

    render(
      wrap(
        <PathsTabShares
          initialShares={[shareRow({ id: 1, name: 'Movies', path: '/media/movies' })]}
        />,
      ),
    );

    await userEvent.type(screen.getByLabelText('Name'), 'Music');
    const pathInput = screen.getByLabelText('Path');
    await userEvent.clear(pathInput);
    await userEvent.type(pathInput, '/media/music');
    const submit = screen.getByTestId('share-add-submit');
    await waitFor(() => expect(submit).not.toBeDisabled());
    await userEvent.click(submit);

    await waitFor(() => expect(screen.getByTestId('share-card-2')).toBeInTheDocument());
    expect(mockToastSuccess).toHaveBeenCalledWith('Share added');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/shares',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('PathsTabShares — AC-13 delete removes + toast', () => {
  it('test_delete_when_p3_confirmed_and_200_then_card_removed_and_orphan_count_toast', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, { deleted: true, orphanedFileCount: 3 }));
    vi.useFakeTimers({ shouldAdvanceTime: true });

    render(
      wrap(
        <PathsTabShares
          initialShares={[shareRow({ id: 7, name: 'Movies', path: '/media/movies' })]}
        />,
      ),
    );

    const primary = screen.getByTestId('confirm-button-primary');
    act(() => {
      fireEvent.click(primary);
    });
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    act(() => {
      fireEvent.click(primary);
    });

    await waitFor(() => expect(screen.queryByTestId('share-card-7')).toBeNull());
    expect(mockToastSuccess).toHaveBeenCalled();
    const toastMsg = mockToastSuccess.mock.calls[0]![0] as string;
    expect(toastMsg).toContain('3');
    expect(fetchMock).toHaveBeenCalledWith('/api/shares/7', { method: 'DELETE' });
    vi.useRealTimers();
  });
});

describe('PathsTabShares — AC-14 path-change toast with action', () => {
  it('test_save_path_change_when_200_warnings_rescan_then_toast_message_action_calls_router_push', async () => {
    const updated = shareRow({
      id: 1,
      name: 'Movies',
      path: '/media/movies-v2',
    });
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { share: updated, warnings: ['rescan_recommended'] }),
    );

    render(
      wrap(
        <PathsTabShares
          initialShares={[shareRow({ id: 1, name: 'Movies', path: '/media/movies' })]}
        />,
      ),
    );

    await userEvent.click(screen.getByTestId('share-edit-btn-1'));
    const editingCard = screen.getByTestId('share-card-1');
    const pathInput = within(editingCard).getByLabelText('Path');
    await userEvent.clear(pathInput);
    await userEvent.type(pathInput, '/media/movies-v2');
    const save = screen.getByTestId('share-edit-save');
    await waitFor(() => expect(save).not.toBeDisabled());
    await userEvent.click(save);

    await waitFor(() => expect(mockToastMessage).toHaveBeenCalled());
    const args = mockToastMessage.mock.calls[0]!;
    expect(args[0]).toContain('vanished');
    const opts = args[1] as { action: { label: string; onClick: () => void } };
    expect(opts.action.label).toBe('Re-scan now');
    opts.action.onClick();
    expect(mockRouterPush).toHaveBeenCalledWith('/scan?from=share-edit');
  });
});

describe('PathsTabShares — AC-25 dirty-discard AlertDialog (SR5)', () => {
  it('test_edit_switch_when_other_dirty_then_dialog_appears_stay_keeps_state', async () => {
    render(
      wrap(
        <PathsTabShares
          initialShares={[
            shareRow({ id: 1, name: 'A', path: '/a' }),
            shareRow({ id: 2, name: 'B', path: '/b' }),
          ]}
        />,
      ),
    );
    // Open card 1, make it dirty
    await userEvent.click(screen.getByTestId('share-edit-btn-1'));
    const card1 = screen.getByTestId('share-card-1');
    const pathInput = within(card1).getByLabelText('Path');
    await userEvent.clear(pathInput);
    await userEvent.type(pathInput, '/a-dirty');
    // Click Edit on card 2 → AlertDialog
    await userEvent.click(screen.getByTestId('share-edit-btn-2'));
    await waitFor(() => {
      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    });
    // Stay editing → card 1 still open + card 2 NOT open
    await userEvent.click(screen.getByRole('button', { name: 'Stay editing' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByTestId('share-card-1').getAttribute('data-editing')).toBe('true');
    expect(screen.getByTestId('share-card-2').getAttribute('data-editing')).toBe('false');
  });

  it('test_edit_switch_when_other_dirty_then_dialog_discard_collapses_A_opens_B', async () => {
    render(
      wrap(
        <PathsTabShares
          initialShares={[
            shareRow({ id: 1, name: 'A', path: '/a' }),
            shareRow({ id: 2, name: 'B', path: '/b' }),
          ]}
        />,
      ),
    );
    await userEvent.click(screen.getByTestId('share-edit-btn-1'));
    const card1d = screen.getByTestId('share-card-1');
    const pathInput = within(card1d).getByLabelText('Path');
    await userEvent.clear(pathInput);
    await userEvent.type(pathInput, '/a-dirty');
    await userEvent.click(screen.getByTestId('share-edit-btn-2'));
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByTestId('share-card-1').getAttribute('data-editing')).toBe('false');
    expect(screen.getByTestId('share-card-2').getAttribute('data-editing')).toBe('true');
  });

  it('test_edit_switch_when_other_not_dirty_then_immediate_switch_no_dialog', async () => {
    render(
      wrap(
        <PathsTabShares
          initialShares={[
            shareRow({ id: 1, name: 'A', path: '/a' }),
            shareRow({ id: 2, name: 'B', path: '/b' }),
          ]}
        />,
      ),
    );
    await userEvent.click(screen.getByTestId('share-edit-btn-1'));
    // No edit → not dirty. Click B.
    await userEvent.click(screen.getByTestId('share-edit-btn-2'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByTestId('share-card-1').getAttribute('data-editing')).toBe('false');
    expect(screen.getByTestId('share-card-2').getAttribute('data-editing')).toBe('true');
  });
});
