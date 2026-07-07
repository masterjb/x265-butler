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
