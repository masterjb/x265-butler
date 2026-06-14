// Plan 05-12 (B3 Queue Reorder) — useReorderQueue hook tests.
// Covers AC-6: optimistic state, PATCH dispatch, 409 rollback, network-error
// retry, no-op short-circuit, clientNonce contract, Undo toast, submitLock.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import type { JobRow } from '@/src/lib/db/schema';
import { useReorderQueue } from '@/components/queue/use-reorder-queue';

const { mockToastSuccess, mockToastError, mockToastInfo } = vi.hoisted(() => ({
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
  mockToastInfo: vi.fn(),
}));

vi.mock('sonner', () => {
  const toast = (() => undefined) as unknown as Record<string, unknown>;
  toast.success = mockToastSuccess;
  toast.error = mockToastError;
  toast.info = mockToastInfo;
  return { toast, default: { toast } };
});

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function makeJob(id: number): JobRow {
  return {
    id,
    file_id: id * 10,
    status: 'queued',
    started_at: null,
    finished_at: null,
    encoder: 'libx265',
    crf: null,
    queue_position: id,
    bytes_in: null,
    bytes_out: null,
    duration_ms: null,
    exit_code: null,
    error_msg: null,
    log_tail: null,
    created_at: 0,
  };
}

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      {children}
    </NextIntlClientProvider>
  );
}

function mockFetch200(applied: Array<{ jobId: number; queuePosition: number }> = []) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, applied, requestId: 'r1' }),
  });
}

function mockFetch409(conflict: number[] = [2]) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status: 409,
    json: async () => ({ error: 'reorder_race_status_changed', conflictingJobIds: conflict }),
  });
}

function mockFetchNetworkError() {
  return vi.fn().mockRejectedValue(new Error('network'));
}

describe('useReorderQueue', () => {
  beforeEach(() => {
    mockToastSuccess.mockReset();
    mockToastError.mockReset();
    mockToastInfo.mockReset();
  });

  it('test_initial_state_when_initialPending_then_orderedPending_equals_initialPending', () => {
    const initial = [makeJob(1), makeJob(2), makeJob(3)];
    (globalThis as { fetch?: unknown }).fetch = mockFetch200();
    const { result } = renderHook(
      () => useReorderQueue({ initialPending: initial, livePending: initial }),
      { wrapper },
    );
    expect(result.current.orderedPending.map((j) => j.id)).toEqual([1, 2, 3]);
  });

  it('test_reorder_when_called_then_optimistically_mutates_orderedPending_immediately', () => {
    const initial = [makeJob(1), makeJob(2), makeJob(3)];
    (globalThis as { fetch?: unknown }).fetch = mockFetch200();
    const { result } = renderHook(
      () => useReorderQueue({ initialPending: initial, livePending: initial }),
      { wrapper },
    );
    act(() => {
      result.current.reorder([3, 1, 2]);
    });
    expect(result.current.orderedPending.map((j) => j.id)).toEqual([3, 1, 2]);
  });

  it('test_reorder_when_called_then_PATCH_issued_exactly_once_with_clientNonce_and_orderedJobIds', async () => {
    const initial = [makeJob(1), makeJob(2)];
    const fetchSpy = mockFetch200();
    (globalThis as { fetch?: unknown }).fetch = fetchSpy;
    const { result } = renderHook(
      () => useReorderQueue({ initialPending: initial, livePending: initial }),
      { wrapper },
    );
    await act(async () => {
      result.current.reorder([2, 1]);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const callArgs = fetchSpy.mock.calls[0];
    expect(callArgs[0]).toBe('/api/queue/reorder');
    const body = JSON.parse(callArgs[1].body as string);
    expect(body.orderedJobIds).toEqual([2, 1]);
    expect(body.clientNonce).toMatch(UUID_V4);
  });

  it('test_reorder_when_no_op_drop_then_zero_PATCH_no_toast', async () => {
    const initial = [makeJob(1), makeJob(2), makeJob(3)];
    const fetchSpy = mockFetch200();
    (globalThis as { fetch?: unknown }).fetch = fetchSpy;
    const { result } = renderHook(
      () => useReorderQueue({ initialPending: initial, livePending: initial }),
      { wrapper },
    );
    await act(async () => {
      result.current.reorder([1, 2, 3]); // identical to current
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  it('test_reorder_when_200_success_then_Undo_toast_shown_with_undo_action', async () => {
    const initial = [makeJob(1), makeJob(2)];
    (globalThis as { fetch?: unknown }).fetch = mockFetch200();
    const { result } = renderHook(
      () => useReorderQueue({ initialPending: initial, livePending: initial }),
      { wrapper },
    );
    await act(async () => {
      result.current.reorder([2, 1]);
    });
    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledTimes(1);
    });
    const args = mockToastSuccess.mock.calls[0];
    expect(args[0]).toBe(en.queue.reorder.toast.success);
    expect(args[1]).toMatchObject({
      action: { label: en.queue.reorder.toast.undo },
      duration: 5000,
    });
  });

  it('test_reorder_when_409_conflict_then_reverts_state_to_livePending_and_shows_conflict_toast', async () => {
    const initial = [makeJob(1), makeJob(2), makeJob(3)];
    (globalThis as { fetch?: unknown }).fetch = mockFetch409([2]);
    const { result } = renderHook(
      () => useReorderQueue({ initialPending: initial, livePending: initial }),
      { wrapper },
    );
    await act(async () => {
      result.current.reorder([3, 1, 2]);
    });
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(en.queue.reorder.toast.conflict);
    });
    // State is reverted to livePending snapshot ([1,2,3] order).
    expect(result.current.orderedPending.map((j) => j.id)).toEqual([1, 2, 3]);
  });

  it('test_reorder_when_network_error_then_reverts_and_shows_error_toast_with_retry_action', async () => {
    const initial = [makeJob(1), makeJob(2)];
    (globalThis as { fetch?: unknown }).fetch = mockFetchNetworkError();
    const { result } = renderHook(
      () => useReorderQueue({ initialPending: initial, livePending: initial }),
      { wrapper },
    );
    await act(async () => {
      result.current.reorder([2, 1]);
    });
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalled();
    });
    const errCall = mockToastError.mock.calls.find((c) => c[0] === en.queue.reorder.toast.error);
    expect(errCall).toBeDefined();
    expect(errCall![1]).toMatchObject({ action: { label: en.queue.reorder.toast.retry } });
    expect(result.current.orderedPending.map((j) => j.id)).toEqual([1, 2]);
  });

  it('test_reorder_when_retry_invoked_then_uses_same_clientNonce_as_original_failed_attempt', async () => {
    const initial = [makeJob(1), makeJob(2)];
    let fetchCount = 0;
    const capturedNonces: string[] = [];
    (globalThis as { fetch?: unknown }).fetch = vi.fn().mockImplementation((_, init) => {
      fetchCount++;
      const body = JSON.parse(init.body as string);
      capturedNonces.push(body.clientNonce);
      if (fetchCount === 1) return Promise.reject(new Error('network'));
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, applied: [], requestId: 'r' }),
      });
    });
    const { result } = renderHook(
      () => useReorderQueue({ initialPending: initial, livePending: initial }),
      { wrapper },
    );
    await act(async () => {
      result.current.reorder([2, 1]);
    });
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalled();
    });
    const errArgs = mockToastError.mock.calls.find((c) => c[0] === en.queue.reorder.toast.error);
    const retryFn = errArgs![1].action.onClick;
    await act(async () => {
      retryFn();
    });
    await waitFor(() => {
      expect(capturedNonces.length).toBe(2);
    });
    expect(capturedNonces[0]).toBe(capturedNonces[1]);
  });

  it('test_reorder_when_undo_clicked_then_issues_second_PATCH_with_prior_order_and_FRESH_nonce', async () => {
    const initial = [makeJob(1), makeJob(2), makeJob(3)];
    const captured: Array<{ ids: number[]; nonce: string }> = [];
    (globalThis as { fetch?: unknown }).fetch = vi.fn().mockImplementation((_, init) => {
      const body = JSON.parse(init.body as string);
      captured.push({ ids: body.orderedJobIds, nonce: body.clientNonce });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, applied: [], requestId: 'r' }),
      });
    });
    const { result } = renderHook(
      () => useReorderQueue({ initialPending: initial, livePending: initial }),
      { wrapper },
    );
    await act(async () => {
      result.current.reorder([3, 1, 2]);
    });
    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalled();
    });
    const undoFn = mockToastSuccess.mock.calls[0][1].action.onClick;
    await act(async () => {
      undoFn();
    });
    await waitFor(() => {
      expect(captured.length).toBe(2);
    });
    // First PATCH: new order; second PATCH: prior order.
    expect(captured[0].ids).toEqual([3, 1, 2]);
    expect(captured[1].ids).toEqual([1, 2, 3]);
    // Distinct nonces — Undo is a NEW logical operation.
    expect(captured[0].nonce).not.toBe(captured[1].nonce);
  });

  it('test_reorder_when_undo_clicked_after_livePending_lost_priorIds_then_shows_disabled_tooltip_no_PATCH', async () => {
    const initial = [makeJob(1), makeJob(2)];
    const captured: Array<{ ids: number[]; nonce: string }> = [];
    (globalThis as { fetch?: unknown }).fetch = vi.fn().mockImplementation((_, init) => {
      const body = JSON.parse(init.body as string);
      captured.push({ ids: body.orderedJobIds, nonce: body.clientNonce });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, applied: [], requestId: 'r' }),
      });
    });
    // livePending starts with both ids; after PATCH success, ASSUME livePending
    // changes to drop id=1 (claimed mid-flight). The Undo gate checks current
    // livePendingRef which holds the LATEST pass — re-render with livePending=[2 only].
    const { result, rerender } = renderHook(
      ({ live }: { live: JobRow[] }) =>
        useReorderQueue({ initialPending: initial, livePending: live }),
      { wrapper, initialProps: { live: initial } },
    );
    await act(async () => {
      result.current.reorder([2, 1]);
    });
    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalled();
    });
    // Simulate id=1 being claimed externally — only id=2 remains queued.
    rerender({ live: [makeJob(2)] });
    const undoFn = mockToastSuccess.mock.calls[0][1].action.onClick;
    await act(async () => {
      undoFn();
    });
    expect(mockToastInfo).toHaveBeenCalledWith(en.queue.reorder.undo.disabled.tooltip);
    // Only the original PATCH was issued; Undo did NOT dispatch.
    expect(captured.length).toBe(1);
  });
});
