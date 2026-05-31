// 13-02 T5 tests — LibraryBulkActions cluster (≥6 cases per plan).
// ConfirmButton mocked to a plain <button> so we can test the unique toast/fetch/SR5 logic;
// the 10s P2 defer behavior is covered by 13-01a Foundation tests (ConfirmButton P2).

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
  }: {
    label: string;
    onConfirm: () => void | Promise<void>;
    disabled?: boolean;
    children?: React.ReactNode;
  }) => (
    <button
      type="button"
      onClick={() => void onConfirm()}
      disabled={disabled}
      data-testid={`mock-confirm-${label.split(' ')[0].toLowerCase()}`}
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
    fireEvent.click(screen.getAllByRole('button')[0]); // first ConfirmButton
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
    fireEvent.click(screen.getAllByRole('button')[0]);
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
    fireEvent.click(screen.getAllByRole('button')[0]);
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
    fireEvent.click(screen.getAllByRole('button')[0]);
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
    fireEvent.click(screen.getAllByRole('button')[0]);
    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(onAfter).not.toHaveBeenCalled();
  });

  it('disabled when ids.length === 0', () => {
    render(
      <Wrapper>
        <LibraryBulkActions ids={[]} onAfter={() => undefined} />
      </Wrapper>,
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons[0]).toBeDisabled();
    expect(buttons[1]).toBeDisabled();
  });

  it('disabled when ids.length > 500 (max-cap)', () => {
    const ids = Array.from({ length: 501 }, (_, i) => i + 1);
    render(
      <Wrapper>
        <LibraryBulkActions ids={ids} onAfter={() => undefined} />
      </Wrapper>,
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons[0]).toBeDisabled();
    expect(buttons[1]).toBeDisabled();
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
    fireEvent.click(screen.getAllByRole('button')[1]); // second ConfirmButton (retry)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/library/bulk-retry',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ ids: [5] }),
      }),
    );
  });
});
