// 13-02 T5 tests — LibraryBulkActions cluster.
// ConfirmButton mocked to a plain <button> so we can test the unique toast/fetch/SR5 logic;
// the 10s P2 defer behavior is covered by 13-01a Foundation tests (ConfirmButton P2).
// 32-01 — 4th button: bulk-encode P1 (primary positive action, placed FIRST). Queries use
// data-testid (mock-confirm-<label-first-word>) so they are robust to button ordering.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';

const { mockToast, mockToastSuccess, mockToastError, mockRouterRefresh } = vi.hoisted(() => {
  const t = vi.fn();
  return {
    mockToast: t,
    mockToastSuccess: vi.fn(),
    mockToastError: vi.fn(),
    mockRouterRefresh: vi.fn(),
  };
});

vi.mock('sonner', () => {
  const toast = mockToast as unknown as Record<string, unknown>;
  toast.success = mockToastSuccess;
  toast.error = mockToastError;
  return { toast };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRouterRefresh }),
}));

vi.mock('@/components/ui/confirm-button', () => ({
  ConfirmButton: ({
    label,
    onConfirm,
    disabled,
    children,
    variant,
    undoDelayMs,
    successToastMessage,
  }: {
    label: string;
    onConfirm: () => void | Promise<void>;
    disabled?: boolean;
    children?: React.ReactNode;
    variant?: string;
    undoDelayMs?: number;
    successToastMessage?: string;
  }) => (
    <button
      type="button"
      onClick={() => void onConfirm()}
      disabled={disabled}
      data-testid={`mock-confirm-${label.split(' ')[0].toLowerCase()}`}
      data-variant={variant}
      data-undo-delay={undoDelayMs ?? ''}
      data-has-undo-toast={successToastMessage ? '1' : '0'}
    >
      {children}
      <span>{label}</span>
    </button>
  ),
}));

import { LibraryBulkActions } from '@/components/library/library-bulk-actions';

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      {children}
    </NextIntlClientProvider>
  );
}

// Testid helpers — robust to button ordering.
const encodeBtn = () => screen.getByTestId('mock-confirm-encode');
const blocklistBtn = () => screen.getByTestId('mock-confirm-blocklist');
const retryBtn = () => screen.getByTestId('mock-confirm-retry');
const deleteBtn = () => screen.getByTestId('mock-confirm-delete');

const fetchMock = vi.fn();

beforeEach(() => {
  mockToast.mockReset();
  mockToastSuccess.mockReset();
  mockToastError.mockReset();
  mockRouterRefresh.mockReset();
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

describe('LibraryBulkActions', () => {
  // 32-01 — bulk-encode P1 (FIRST, primary positive action).

  it('encode button is P1 with NO undo-toast and NO undo-delay (additive action)', () => {
    render(
      <Wrapper>
        <LibraryBulkActions ids={[1, 2]} onAfter={() => undefined} />
      </Wrapper>,
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(4);
    // Encode is FIRST in the DOM (primary-action ordering).
    expect(buttons[0]).toBe(encodeBtn());
    expect(encodeBtn()).toHaveAttribute('data-variant', 'P1');
    expect(encodeBtn()).toHaveAttribute('data-has-undo-toast', '0');
    expect(encodeBtn()).toHaveAttribute('data-undo-delay', '');
  });

  it('encode click → fetch /api/library/bulk-encode with ids', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ successCount: 2, failed: [], requestId: 'r' }),
    });
    render(
      <Wrapper>
        <LibraryBulkActions ids={[1, 2]} onAfter={() => undefined} />
      </Wrapper>,
    );
    fireEvent.click(encodeBtn());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/library/bulk-encode',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ ids: [1, 2] }),
      }),
    );
  });

  it('encode all-OK → toast.success (bulk.encode.success) + onAfter + router.refresh', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ successCount: 3, failed: [], requestId: 'r' }),
    });
    const onAfter = vi.fn();
    render(
      <Wrapper>
        <LibraryBulkActions ids={[1, 2, 3]} onAfter={onAfter} />
      </Wrapper>,
    );
    fireEvent.click(encodeBtn());
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled());
    expect(String(mockToastSuccess.mock.calls[0][0])).toContain('queued for encoding');
    expect(onAfter).toHaveBeenCalledTimes(1);
    expect(mockRouterRefresh).toHaveBeenCalledTimes(1);
  });

  it('encode partial → neutral toast + onAfter (at-least-some-success)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        successCount: 1,
        failed: [{ id: 2, reason: 'already_queued' }],
        requestId: 'r',
      }),
    });
    const onAfter = vi.fn();
    render(
      <Wrapper>
        <LibraryBulkActions ids={[1, 2]} onAfter={onAfter} />
      </Wrapper>,
    );
    fireEvent.click(encodeBtn());
    await waitFor(() => expect(mockToast).toHaveBeenCalled());
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();
    expect(onAfter).toHaveBeenCalledTimes(1);
  });

  it('encode all-failed → toast.error + onAfter NOT called (SR5)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        successCount: 0,
        failed: [
          { id: 1, reason: 'blocklisted' },
          { id: 2, reason: 'not_eligible' },
        ],
        requestId: 'r',
      }),
    });
    const onAfter = vi.fn();
    render(
      <Wrapper>
        <LibraryBulkActions ids={[1, 2]} onAfter={onAfter} />
      </Wrapper>,
    );
    fireEvent.click(encodeBtn());
    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(onAfter).not.toHaveBeenCalled();
    expect(mockRouterRefresh).not.toHaveBeenCalled();
  });

  it('encode network throw → network_error toast + onAfter NOT called (SR5)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const onAfter = vi.fn();
    render(
      <Wrapper>
        <LibraryBulkActions ids={[1]} onAfter={onAfter} />
      </Wrapper>,
    );
    fireEvent.click(encodeBtn());
    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(mockToastError).toHaveBeenCalledWith(en.library.bulk.encode.network_error);
    expect(onAfter).not.toHaveBeenCalled();
  });

  it('click bulk-blocklist → fetch /api/library/bulk-blocklist with ids', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ successCount: 2, failed: [], requestId: 'r' }),
    });
    const onAfter = vi.fn();
    render(
      <Wrapper>
        <LibraryBulkActions ids={[1, 2]} onAfter={onAfter} />
      </Wrapper>,
    );
    fireEvent.click(blocklistBtn());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/library/bulk-blocklist',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ ids: [1, 2] }),
      }),
    );
  });

  it('all-OK response → toast.success + onAfter called + router.refresh', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ successCount: 3, failed: [], requestId: 'r' }),
    });
    const onAfter = vi.fn();
    render(
      <Wrapper>
        <LibraryBulkActions ids={[1, 2, 3]} onAfter={onAfter} />
      </Wrapper>,
    );
    fireEvent.click(blocklistBtn());
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled());
    expect(onAfter).toHaveBeenCalledTimes(1);
    expect(mockRouterRefresh).toHaveBeenCalledTimes(1);
  });

  it('partial response → toast (no level) + onAfter called (SR5: at-least-some-success)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        successCount: 1,
        failed: [
          { id: 2, reason: 'not_found' },
          { id: 3, reason: 'already_blocked' },
        ],
        requestId: 'r',
      }),
    });
    const onAfter = vi.fn();
    render(
      <Wrapper>
        <LibraryBulkActions ids={[1, 2, 3]} onAfter={onAfter} />
      </Wrapper>,
    );
    fireEvent.click(blocklistBtn());
    await waitFor(() => expect(mockToast).toHaveBeenCalled());
    expect(onAfter).toHaveBeenCalledTimes(1);
  });

  it('all-failed response → toast.error + onAfter NOT called (SR5: preserve selection)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        successCount: 0,
        failed: [
          { id: 1, reason: 'not_found' },
          { id: 2, reason: 'not_found' },
        ],
        requestId: 'r',
      }),
    });
    const onAfter = vi.fn();
    render(
      <Wrapper>
        <LibraryBulkActions ids={[1, 2]} onAfter={onAfter} />
      </Wrapper>,
    );
    fireEvent.click(blocklistBtn());
    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(onAfter).not.toHaveBeenCalled();
    expect(mockRouterRefresh).not.toHaveBeenCalled();
  });

  it('network throw → toast.error + onAfter NOT called (SR5)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const onAfter = vi.fn();
    render(
      <Wrapper>
        <LibraryBulkActions ids={[1]} onAfter={onAfter} />
      </Wrapper>,
    );
    fireEvent.click(blocklistBtn());
    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(onAfter).not.toHaveBeenCalled();
  });

  it('disabled when ids.length === 0 (all buttons)', () => {
    render(
      <Wrapper>
        <LibraryBulkActions ids={[]} onAfter={() => undefined} />
      </Wrapper>,
    );
    for (const b of screen.getAllByRole('button')) expect(b).toBeDisabled();
  });

  it('disabled when ids.length > 500 (max-cap, all buttons)', () => {
    const ids = Array.from({ length: 501 }, (_, i) => i + 1);
    render(
      <Wrapper>
        <LibraryBulkActions ids={ids} onAfter={() => undefined} />
      </Wrapper>,
    );
    for (const b of screen.getAllByRole('button')) expect(b).toBeDisabled();
  });

  it('bulk-retry click → fetch /api/library/bulk-retry', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ successCount: 1, failed: [], requestId: 'r' }),
    });
    render(
      <Wrapper>
        <LibraryBulkActions ids={[5]} onAfter={() => undefined} />
      </Wrapper>,
    );
    fireEvent.click(retryBtn());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/library/bulk-retry',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ ids: [5] }),
      }),
    );
  });

  // 29-03 — 3rd button: bulk-delete P3 one-way-door (row-only forget).
  it('delete button is P3 with NO undo-toast (one-way-door); siblings P2 carry undo-window', () => {
    render(
      <Wrapper>
        <LibraryBulkActions ids={[1, 2]} onAfter={() => undefined} />
      </Wrapper>,
    );
    expect(screen.getAllByRole('button')).toHaveLength(4);
    expect(deleteBtn()).toHaveAttribute('data-variant', 'P3');
    expect(deleteBtn()).toHaveAttribute('data-has-undo-toast', '0'); // no successToastMessage
    expect(deleteBtn()).toHaveAttribute('data-undo-delay', ''); // no undoDelayMs
    // sibling P2 buttons carry the undo-window — proves the difference is intentional
    expect(blocklistBtn()).toHaveAttribute('data-variant', 'P2');
    expect(blocklistBtn()).toHaveAttribute('data-undo-delay', '10000');
  });

  it('bulk-delete click → fetch /api/library/bulk-delete with ids', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ successCount: 2, failed: [], requestId: 'r' }),
    });
    render(
      <Wrapper>
        <LibraryBulkActions ids={[7, 8]} onAfter={() => undefined} />
      </Wrapper>,
    );
    fireEvent.click(deleteBtn());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/library/bulk-delete',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ ids: [7, 8] }),
      }),
    );
  });

  it('bulk-delete all-OK → toast.success (bulk.forget.success) + onAfter + router.refresh', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ successCount: 2, failed: [], requestId: 'r' }),
    });
    const onAfter = vi.fn();
    render(
      <Wrapper>
        <LibraryBulkActions ids={[1, 2]} onAfter={onAfter} />
      </Wrapper>,
    );
    fireEvent.click(deleteBtn());
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled());
    expect(String(mockToastSuccess.mock.calls[0][0])).toContain('forgotten');
    expect(onAfter).toHaveBeenCalledTimes(1);
    expect(mockRouterRefresh).toHaveBeenCalledTimes(1);
  });

  it('bulk-delete mixed → neutral toast + onAfter (at-least-some-success)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        successCount: 1,
        failed: [{ id: 2, reason: 'active_job' }],
        requestId: 'r',
      }),
    });
    const onAfter = vi.fn();
    render(
      <Wrapper>
        <LibraryBulkActions ids={[1, 2]} onAfter={onAfter} />
      </Wrapper>,
    );
    fireEvent.click(deleteBtn());
    await waitFor(() => expect(mockToast).toHaveBeenCalled());
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();
    expect(onAfter).toHaveBeenCalledTimes(1);
  });

  it('bulk-delete all-failed → toast.error + onAfter NOT called (SR5)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        successCount: 0,
        failed: [
          { id: 1, reason: 'bench_reference' },
          { id: 2, reason: 'active_job' },
        ],
        requestId: 'r',
      }),
    });
    const onAfter = vi.fn();
    render(
      <Wrapper>
        <LibraryBulkActions ids={[1, 2]} onAfter={onAfter} />
      </Wrapper>,
    );
    fireEvent.click(deleteBtn());
    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(onAfter).not.toHaveBeenCalled();
    expect(mockRouterRefresh).not.toHaveBeenCalled();
  });

  it('bulk-delete network throw → network_error toast + onAfter NOT called (SR5)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const onAfter = vi.fn();
    render(
      <Wrapper>
        <LibraryBulkActions ids={[1]} onAfter={onAfter} />
      </Wrapper>,
    );
    fireEvent.click(deleteBtn());
    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(mockToastError).toHaveBeenCalledWith(en.library.bulk.delete.network_error);
    expect(onAfter).not.toHaveBeenCalled();
  });
});
