// 13-02 T5 tests — TrashBulkActions cluster (≥6 cases per plan).
// ConfirmButton mocked to a plain <button> so we can test the unique toast/fetch/SR5 logic;
// P1 instant-fire + P3 cooldown semantics covered by 13-01a Foundation tests.

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
    variant,
    onConfirm,
    disabled,
    children,
  }: {
    label: string;
    variant: string;
    onConfirm: () => void | Promise<void>;
    disabled?: boolean;
    children?: React.ReactNode;
  }) => (
    <button
      type="button"
      onClick={() => void onConfirm()}
      disabled={disabled}
      data-testid={`mock-confirm-${variant.toLowerCase()}`}
    >
      {children}
      <span>{label}</span>
    </button>
  ),
}));

import { TrashBulkActions } from '@/components/trash/trash-bulk-actions';

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

describe('TrashBulkActions', () => {
  it('click bulk-restore (P1) → fetch /api/trash/bulk-restore with ids', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ successCount: 2, failed: [], requestId: 'r' }),
    });
    render(
      <Wrapper>
        <TrashBulkActions ids={[1, 2]} onAfter={() => undefined} />
      </Wrapper>,
    );
    const restoreBtn = screen.getByTestId('mock-confirm-p1');
    fireEvent.click(restoreBtn);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/trash/bulk-restore',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ ids: [1, 2] }),
      }),
    );
  });

  it('click bulk-delete (P3) → fetch /api/trash/bulk-delete with ids', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ successCount: 1, failed: [], requestId: 'r' }),
    });
    render(
      <Wrapper>
        <TrashBulkActions ids={[7]} onAfter={() => undefined} />
      </Wrapper>,
    );
    const deleteBtn = screen.getByTestId('mock-confirm-p3');
    fireEvent.click(deleteBtn);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/trash/bulk-delete',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ ids: [7] }),
      }),
    );
  });

  it('all-OK restore → toast.success + onAfter + router.refresh', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ successCount: 3, failed: [], requestId: 'r' }),
    });
    const onAfter = vi.fn();
    render(
      <Wrapper>
        <TrashBulkActions ids={[1, 2, 3]} onAfter={onAfter} />
      </Wrapper>,
    );
    fireEvent.click(screen.getByTestId('mock-confirm-p1'));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled());
    expect(onAfter).toHaveBeenCalledTimes(1);
    expect(mockRouterRefresh).toHaveBeenCalledTimes(1);
  });

  it('partial delete → toast (no level) + onAfter called (SR5)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        successCount: 2,
        failed: [{ id: 5, reason: 'fs_orphan' }],
        requestId: 'r',
      }),
    });
    const onAfter = vi.fn();
    render(
      <Wrapper>
        <TrashBulkActions ids={[1, 2, 5]} onAfter={onAfter} />
      </Wrapper>,
    );
    fireEvent.click(screen.getByTestId('mock-confirm-p3'));
    await waitFor(() => expect(mockToast).toHaveBeenCalled());
    expect(onAfter).toHaveBeenCalledTimes(1);
  });

  it('all-failed restore → toast.error + onAfter NOT called (SR5)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        successCount: 0,
        failed: [
          { id: 1, reason: 'already_restored' },
          { id: 2, reason: 'already_restored' },
        ],
        requestId: 'r',
      }),
    });
    const onAfter = vi.fn();
    render(
      <Wrapper>
        <TrashBulkActions ids={[1, 2]} onAfter={onAfter} />
      </Wrapper>,
    );
    fireEvent.click(screen.getByTestId('mock-confirm-p1'));
    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(onAfter).not.toHaveBeenCalled();
    expect(mockRouterRefresh).not.toHaveBeenCalled();
  });

  it('network throw on delete → toast.error + onAfter NOT called', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const onAfter = vi.fn();
    render(
      <Wrapper>
        <TrashBulkActions ids={[1]} onAfter={onAfter} />
      </Wrapper>,
    );
    fireEvent.click(screen.getByTestId('mock-confirm-p3'));
    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(onAfter).not.toHaveBeenCalled();
  });

  it('disabled when ids.length === 0', () => {
    render(
      <Wrapper>
        <TrashBulkActions ids={[]} onAfter={() => undefined} />
      </Wrapper>,
    );
    expect(screen.getByTestId('mock-confirm-p1')).toBeDisabled();
    expect(screen.getByTestId('mock-confirm-p3')).toBeDisabled();
  });

  it('disabled when ids.length > 500 (max-cap)', () => {
    const ids = Array.from({ length: 501 }, (_, i) => i + 1);
    render(
      <Wrapper>
        <TrashBulkActions ids={ids} onAfter={() => undefined} />
      </Wrapper>,
    );
    expect(screen.getByTestId('mock-confirm-p1')).toBeDisabled();
    expect(screen.getByTestId('mock-confirm-p3')).toBeDisabled();
  });
});
