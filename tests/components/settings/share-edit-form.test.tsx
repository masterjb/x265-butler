/*
 * 14-04 Task 4 — ShareEditForm tests.
 *
 * Covers AC-11 inline-edit toggle anatomy + AC-14 server-409 → field-error
 * inline display.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import { ShareEditForm, type ShareSaveResult } from '@/components/settings/share-edit-form';
import type { ShareRow } from '@/src/lib/db/schema';

function wrap(children: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      {children}
    </NextIntlClientProvider>
  );
}

function sampleShare(overrides: Partial<ShareRow> = {}): ShareRow {
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

describe('ShareEditForm', () => {
  it('test_render_when_mounted_then_pre_filled_with_initial_values', () => {
    render(wrap(<ShareEditForm initial={sampleShare()} onSave={vi.fn()} onCancel={vi.fn()} />));
    expect(screen.getByLabelText('Name')).toHaveValue('Movies');
    expect(screen.getByLabelText('Path')).toHaveValue('/media/movies');
    expect(screen.getByLabelText('Min Size (MB)')).toHaveValue(50);
    expect(screen.getByLabelText('Extensions')).toHaveValue('mkv,mp4,avi');
    expect(screen.getByLabelText('Max Depth')).toHaveValue(8);
  });

  it('test_save_when_not_dirty_then_disabled_and_no_api_call', () => {
    const onSave = vi.fn();
    render(wrap(<ShareEditForm initial={sampleShare()} onSave={onSave} onCancel={vi.fn()} />));
    const save = screen.getByTestId('share-edit-save');
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('test_cancel_when_clicked_then_calls_onCancel_no_save', async () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    render(wrap(<ShareEditForm initial={sampleShare()} onSave={onSave} onCancel={onCancel} />));
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    await userEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('test_save_when_dirty_then_calls_onSave_with_diff_patch', async () => {
    const onSave = vi.fn<(patch: unknown) => Promise<ShareSaveResult>>(async () => ({
      ok: true,
    }));
    render(wrap(<ShareEditForm initial={sampleShare()} onSave={onSave} onCancel={vi.fn()} />));
    const nameInput = screen.getByLabelText('Name');
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Renamed');
    const save = screen.getByTestId('share-edit-save');
    await waitFor(() => expect(save).not.toBeDisabled());
    await userEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0]).toEqual({ name: 'Renamed' });
  });

  it('test_save_when_server_409_nested_then_path_field_error_shown', async () => {
    const onSave = vi.fn<(p: unknown) => Promise<ShareSaveResult>>(async () => ({
      ok: false,
      error: {
        kind: 'nested',
        conflictingShareName: 'Library',
        conflictingSharePath: '/media',
      },
    }));
    render(wrap(<ShareEditForm initial={sampleShare()} onSave={onSave} onCancel={vi.fn()} />));
    const pathInput = screen.getByLabelText('Path');
    await userEvent.clear(pathInput);
    await userEvent.type(pathInput, '/media/sub');
    const save = screen.getByTestId('share-edit-save');
    await waitFor(() => expect(save).not.toBeDisabled());
    await userEvent.click(save);
    await waitFor(() => {
      const msg = screen.getByText(/shares cannot nest/i);
      expect(msg).toBeInTheDocument();
    });
  });

  it('test_dirty_change_propagates_to_parent', async () => {
    const onDirtyChange = vi.fn();
    render(
      wrap(
        <ShareEditForm
          initial={sampleShare()}
          onSave={vi.fn()}
          onCancel={vi.fn()}
          onDirtyChange={onDirtyChange}
        />,
      ),
    );
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    const nameInput = screen.getByLabelText('Name');
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'X');
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
  });
});

// 48-02 (audit S2 → AC-20): server fieldErrors are CODES. Before this plan the
// raw token was rendered verbatim (`settings.paths.shares.error.*` had zero
// consumers — a dead-key state), so the operator saw `path_forbidden_prefix`.
describe('ShareEditForm — 48-02 server-error-code translation (AC-20)', () => {
  function renderWithValidationError(fieldErrors: Record<string, string>) {
    const onSave = vi.fn<(p: unknown) => Promise<ShareSaveResult>>(async () => ({
      ok: false,
      error: { kind: 'validation', fieldErrors },
    }));
    render(wrap(<ShareEditForm initial={sampleShare()} onSave={onSave} onCancel={vi.fn()} />));
    return onSave;
  }

  async function dirtyPathAndSave(value: string) {
    const pathInput = screen.getByLabelText('Path');
    await userEvent.clear(pathInput);
    await userEvent.type(pathInput, value);
    const save = screen.getByTestId('share-edit-save');
    await waitFor(() => expect(save).not.toBeDisabled());
    await userEvent.click(save);
  }

  it('test_save_when_server_returns_path_forbidden_prefix_then_translated_sentence_shown', async () => {
    renderWithValidationError({ path: 'path_forbidden_prefix' });
    await dirtyPathAndSave('/sys');
    await waitFor(() => {
      expect(screen.getByText(/points at a system directory/i)).toBeInTheDocument();
    });
    expect(screen.queryByText('path_forbidden_prefix')).not.toBeInTheDocument();
  });

  it('test_save_when_server_returns_preexisting_code_then_also_translated', async () => {
    // Ends the dead-key state: path_traversal_rejected had a message in BOTH
    // locale files and zero consumers before 48-02.
    renderWithValidationError({ path: 'path_traversal_rejected' });
    await dirtyPathAndSave('/media/x');
    await waitFor(() => {
      expect(screen.getByText(/may not contain '\.\.' segments/i)).toBeInTheDocument();
    });
  });

  it('test_save_when_server_returns_unknown_code_then_raw_code_shown_and_no_crash', async () => {
    renderWithValidationError({ path: 'some_future_server_code' });
    await dirtyPathAndSave('/media/x');
    await waitFor(() => {
      expect(screen.getByText('some_future_server_code')).toBeInTheDocument();
    });
  });
});
