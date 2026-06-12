/*
 * 14-04 Task 4 — ShareAddForm tests.
 *
 * Covers AC-12 add affordance + server-409 nested → field error.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import { ShareAddForm } from '@/components/settings/share-add-form';
import type { ShareSaveResult } from '@/components/settings/share-edit-form';

function wrap(children: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      {children}
    </NextIntlClientProvider>
  );
}

async function fillValid(): Promise<void> {
  await userEvent.type(screen.getByLabelText('Name'), 'Music');
  await userEvent.type(screen.getByLabelText('Path'), '/media/music');
  const minInput = screen.getByLabelText('Min Size (MB)');
  await userEvent.clear(minInput);
  await userEvent.type(minInput, '5');
  const extInput = screen.getByLabelText('Extensions');
  await userEvent.clear(extInput);
  await userEvent.type(extInput, 'flac,mp3');
}

describe('ShareAddForm', () => {
  it('test_render_when_mounted_then_add_button_disabled_until_valid', () => {
    render(wrap(<ShareAddForm onAdd={vi.fn()} />));
    expect(screen.getByTestId('share-add-submit')).toBeDisabled();
  });

  it('test_submit_when_valid_then_calls_onAdd_with_create_body_and_resets', async () => {
    const onAdd = vi.fn<(b: unknown) => Promise<ShareSaveResult>>(async () => ({
      ok: true,
    }));
    render(wrap(<ShareAddForm onAdd={onAdd} />));
    await fillValid();
    const submit = screen.getByTestId('share-add-submit');
    await waitFor(() => expect(submit).not.toBeDisabled());
    await userEvent.click(submit);
    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
    expect(onAdd.mock.calls[0]![0]).toEqual({
      name: 'Music',
      path: '/media/music',
      min_size_mb: 5,
      extensions_csv: 'flac,mp3',
      max_depth: null,
    });
    // Form reset → Name field empty again.
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue(''));
  });

  it('test_submit_when_server_409_nested_then_path_field_error_shown', async () => {
    const onAdd = vi.fn<(b: unknown) => Promise<ShareSaveResult>>(async () => ({
      ok: false,
      error: {
        kind: 'nested',
        conflictingShareName: 'Library',
        conflictingSharePath: '/media',
      },
    }));
    render(wrap(<ShareAddForm onAdd={onAdd} />));
    await fillValid();
    const submit = screen.getByTestId('share-add-submit');
    await waitFor(() => expect(submit).not.toBeDisabled());
    await userEvent.click(submit);
    await waitFor(() => {
      const msg = screen.getByText(/shares cannot nest/i);
      expect(msg).toBeInTheDocument();
    });
  });

  it('test_submit_when_server_400_validation_then_field_errors_inline', async () => {
    const onAdd = vi.fn<(b: unknown) => Promise<ShareSaveResult>>(async () => ({
      ok: false,
      error: {
        kind: 'validation',
        fieldErrors: { name: 'name_invalid_chars' },
      },
    }));
    render(wrap(<ShareAddForm onAdd={onAdd} />));
    await fillValid();
    const submit = screen.getByTestId('share-add-submit');
    await waitFor(() => expect(submit).not.toBeDisabled());
    await userEvent.click(submit);
    await waitFor(() => expect(screen.getByText('name_invalid_chars')).toBeInTheDocument());
  });

  it('test_submit_when_server_409_duplicate_path_then_path_field_error_shown', async () => {
    const onAdd = vi.fn<(b: unknown) => Promise<ShareSaveResult>>(async () => ({
      ok: false,
      error: { kind: 'duplicate', field: 'path' },
    }));
    render(wrap(<ShareAddForm onAdd={onAdd} />));
    await fillValid();
    const submit = screen.getByTestId('share-add-submit');
    await waitFor(() => expect(submit).not.toBeDisabled());
    await userEvent.click(submit);
    await waitFor(() => expect(screen.getByText('Path already in use')).toBeInTheDocument());
  });

  it('test_submit_when_server_409_duplicate_name_then_name_field_error_shown', async () => {
    const onAdd = vi.fn<(b: unknown) => Promise<ShareSaveResult>>(async () => ({
      ok: false,
      error: { kind: 'duplicate', field: 'name' },
    }));
    render(wrap(<ShareAddForm onAdd={onAdd} />));
    await fillValid();
    const submit = screen.getByTestId('share-add-submit');
    await waitFor(() => expect(submit).not.toBeDisabled());
    await userEvent.click(submit);
    await waitFor(() => expect(screen.getByText('Name already in use')).toBeInTheDocument());
  });

  it('test_add_button_when_aria_label_then_matches_i18n_button_text', () => {
    render(wrap(<ShareAddForm onAdd={vi.fn()} />));
    expect(screen.getByRole('button', { name: 'Add Share' })).toBeInTheDocument();
  });
});
