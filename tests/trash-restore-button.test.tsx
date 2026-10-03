/*
 * 02-04 → 13-01b T2: RestoreButton tests rewritten for ConfirmButton P1
 * migration. base-ui Popover assertions removed (popover wrapper gone);
 * 4 response-path branching (200 / 409 already_restored / 409 collision /
 * 410 / generic) preserved.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RestoreButton } from '@/components/trash/restore-button';
import { wrap } from './test-utils';
import en from '@/messages/en.json';
import type { TrashEntryRow } from '@/src/lib/db/schema';

const { mockToast } = vi.hoisted(() => {
  const fn = vi.fn() as ReturnType<typeof vi.fn> & {
    success: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    warning: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    dismiss: ReturnType<typeof vi.fn>;
    custom: ReturnType<typeof vi.fn>;
  };
  fn.success = vi.fn();
  fn.error = vi.fn();
  fn.warning = vi.fn();
  fn.info = vi.fn();
  fn.dismiss = vi.fn();
  fn.custom = vi.fn(() => 'sonner-id');
  return { mockToast: fn };
});

vi.mock('sonner', () => ({ toast: mockToast }));

const { mockShowUndoToast } = vi.hoisted(() => ({
  mockShowUndoToast: vi.fn<
    (args: {
      message: string;
      undoLabel?: string;
      onUndo: () => void | Promise<void>;
      durationMs?: number;
    }) => string
  >(() => 'undo-id'),
}));

vi.mock('@/components/ui/undo-toast', () => ({
  showUndoToast: mockShowUndoToast,
  UNDO_TOAST_DEFAULT_MS: 10_000,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  mockToast.success.mockReset();
  mockToast.error.mockReset();
  mockToast.dismiss.mockReset();
  mockShowUndoToast.mockReset();
  (globalThis as { fetch?: unknown }).fetch = mockFetch;
});

const baseEntry: TrashEntryRow = {
  id: 10,
  file_id: 5,
  original_path: '/media/test.mkv',
  trash_path: '/cache/trash/test.mkv',
  size_bytes: 1_000_000_000,
  trashed_at: 1_700_000_000,
  expires_at: 1_700_000_000 + 30 * 86_400,
  restored_at: null,
};

function renderButton(onRemoveRow = vi.fn(), onSummaryRefetch = vi.fn()) {
  return render(
    wrap(
      <RestoreButton
        entry={baseEntry}
        onRemoveRow={onRemoveRow}
        onSummaryRefetch={onSummaryRefetch}
      />,
    ),
  );
}

function getRestoreBtn() {
  return screen.getByRole('button', { name: en.trash.restore.button });
}

describe('RestoreButton — P1 idle render', () => {
  it('test_RestoreButton_when_rendered_then_shows_restore_button', () => {
    renderButton();
    expect(getRestoreBtn()).toBeInTheDocument();
  });

  it('test_RestoreButton_when_rendered_then_no_popover_dialog_in_DOM', () => {
    renderButton();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('test_RestoreButton_when_rendered_then_no_undo_toast_invoked', () => {
    renderButton();
    expect(mockShowUndoToast).not.toHaveBeenCalled();
  });
});

describe('RestoreButton — P1 confirm flow 200 success', () => {
  it('test_RestoreButton_when_clicked_then_POSTs_to_restore_endpoint', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({}),
    });
    renderButton();
    fireEvent.click(getRestoreBtn());
    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        `/api/trash/${baseEntry.id}/restore`,
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('test_RestoreButton_when_200_then_calls_onRemoveRow', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({}),
    });
    const onRemoveRow = vi.fn();
    renderButton(onRemoveRow);
    fireEvent.click(getRestoreBtn());
    await waitFor(() => expect(onRemoveRow).toHaveBeenCalledWith(baseEntry.id));
  });

  it('test_RestoreButton_when_200_then_calls_onSummaryRefetch', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({}),
    });
    const onSummaryRefetch = vi.fn();
    renderButton(vi.fn(), onSummaryRefetch);
    fireEvent.click(getRestoreBtn());
    await waitFor(() => expect(onSummaryRefetch).toHaveBeenCalled());
  });

  it('test_RestoreButton_when_200_then_toast_success_called', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({}),
    });
    renderButton();
    fireEvent.click(getRestoreBtn());
    await waitFor(() => expect(mockToast.success).toHaveBeenCalled());
  });
});

describe('RestoreButton — P1 error flows', () => {
  it('test_RestoreButton_when_409_already_restored_then_calls_onRemoveRow', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: vi.fn().mockResolvedValue({ error: 'already_restored' }),
    });
    const onRemoveRow = vi.fn();
    renderButton(onRemoveRow);
    fireEvent.click(getRestoreBtn());
    await waitFor(() => expect(onRemoveRow).toHaveBeenCalledWith(baseEntry.id));
  });

  it('test_RestoreButton_when_409_original_path_exists_then_does_not_remove_row', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: vi
        .fn()
        .mockResolvedValue({ error: 'original_path_exists', originalPath: '/media/test.mkv' }),
    });
    const onRemoveRow = vi.fn();
    renderButton(onRemoveRow);
    fireEvent.click(getRestoreBtn());
    await waitFor(() => expect(mockToast.error).toHaveBeenCalled());
    expect(onRemoveRow).not.toHaveBeenCalled();
  });

  it('test_RestoreButton_when_410_then_does_not_remove_row', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 410,
      json: vi.fn().mockResolvedValue({ error: 'trash_file_missing' }),
    });
    const onRemoveRow = vi.fn();
    renderButton(onRemoveRow);
    fireEvent.click(getRestoreBtn());
    await waitFor(() => expect(mockToast.error).toHaveBeenCalled());
    expect(onRemoveRow).not.toHaveBeenCalled();
  });

  it('test_RestoreButton_when_5xx_then_does_not_remove_row', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: vi.fn().mockResolvedValue({ error: 'internal_error' }),
    });
    const onRemoveRow = vi.fn();
    renderButton(onRemoveRow);
    fireEvent.click(getRestoreBtn());
    await waitFor(() => expect(mockToast.error).toHaveBeenCalled());
    expect(onRemoveRow).not.toHaveBeenCalled();
  });

  it('test_RestoreButton_when_fetch_throws_then_does_not_remove_row', async () => {
    mockFetch.mockRejectedValue(new Error('network'));
    const onRemoveRow = vi.fn();
    renderButton(onRemoveRow);
    fireEvent.click(getRestoreBtn());
    await waitFor(() => expect(mockToast.error).toHaveBeenCalled());
    expect(onRemoveRow).not.toHaveBeenCalled();
  });
});
