// useReorderQueue hook tests (queue reorder).
// Covers optimistic state, the PATCH body (one job and its new neighbour, never
// the whole list), 409 rollback, network-error retry, no-op short-circuit,
// clientNonce contract, Undo toast back to the old neighbour, submitLock and the
// onApplied reload hook.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import type { JobRow } from '@/src/lib/db/schema';
import { moveForDrop, useReorderQueue } from '@/components/queue/use-reorder-queue';

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
    queue_pinned: 0,
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
      result.current.reorder(3, 1);
    });
    expect(result.current.orderedPending.map((j) => j.id)).toEqual([3, 1, 2]);
  });

  it('test_reorder_when_called_then_PATCH_carries_jobId_and_beforeJobId_not_the_list', async () => {
    const initial = [makeJob(1), makeJob(2)];
    const fetchSpy = mockFetch200();
    (globalThis as { fetch?: unknown }).fetch = fetchSpy;
    const { result } = renderHook(
      () => useReorderQueue({ initialPending: initial, livePending: initial }),
      { wrapper },
    );
    await act(async () => {
      result.current.reorder(2, 1);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const callArgs = fetchSpy.mock.calls[0];
    expect(callArgs[0]).toBe('/api/queue/reorder');
    const body = JSON.parse(callArgs[1].body as string);
    expect(Object.keys(body).sort()).toEqual(['beforeJobId', 'clientNonce', 'jobId']);
    expect(body).toMatchObject({ jobId: 2, beforeJobId: 1 });
    expect(body.clientNonce).toMatch(UUID_V4);
  });

  // Over http://<LAN-IP> (no secure context) the browser has no
  // crypto.randomUUID; getRandomValues stays available. The nonce must still be
  // a v4 UUID or the route rejects it with reorder_invalid_nonce.
  it('test_reorder_when_crypto_randomUUID_missing_then_PATCH_still_carries_uuid_v4_nonce', async () => {
    const initial = [makeJob(1), makeJob(2)];
    const fetchSpy = mockFetch200();
    (globalThis as { fetch?: unknown }).fetch = fetchSpy;
    const original = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
    try {
      const { result } = renderHook(
        () => useReorderQueue({ initialPending: initial, livePending: initial }),
        { wrapper },
      );
      await act(async () => {
        result.current.reorder(2, 1);
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
      expect(body.clientNonce).toMatch(UUID_V4);
    } finally {
      if (original) Object.defineProperty(crypto, 'randomUUID', original);
      else delete (crypto as { randomUUID?: unknown }).randomUUID;
    }
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
      result.current.reorder(1, 2); // 1 already sits in front of 2
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
      result.current.reorder(2, 1);
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
      result.current.reorder(3, 1);
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
      result.current.reorder(2, 1);
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
      result.current.reorder(2, 1);
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

  it('test_reorder_when_undo_clicked_then_moves_back_before_old_neighbour_with_FRESH_nonce', async () => {
    const initial = [makeJob(1), makeJob(2), makeJob(3)];
    const captured: Array<{ move: [number, number | null]; nonce: string }> = [];
    (globalThis as { fetch?: unknown }).fetch = vi.fn().mockImplementation((_, init) => {
      const body = JSON.parse(init.body as string);
      captured.push({ move: [body.jobId, body.beforeJobId], nonce: body.clientNonce });
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
      result.current.reorder(3, 1);
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
    // First PATCH: 3 before 1; Undo: 3 back to the end (it was the last job).
    expect(captured[0].move).toEqual([3, 1]);
    expect(captured[1].move).toEqual([3, null]);
    expect(result.current.orderedPending.map((j) => j.id)).toEqual([1, 2, 3]);
    // Distinct nonces — Undo is a NEW logical operation.
    expect(captured[0].nonce).not.toBe(captured[1].nonce);
  });

  it('test_reorder_when_undo_clicked_after_old_neighbour_left_queue_then_shows_disabled_tooltip_no_PATCH', async () => {
    const initial = [makeJob(1), makeJob(2)];
    const captured: Array<{ move: [number, number | null]; nonce: string }> = [];
    (globalThis as { fetch?: unknown }).fetch = vi.fn().mockImplementation((_, init) => {
      const body = JSON.parse(init.body as string);
      captured.push({ move: [body.jobId, body.beforeJobId], nonce: body.clientNonce });
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
      result.current.reorder(2, 1);
    });
    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalled();
    });
    // 2 moved before 1; its old neighbour was none (last), so make 2 itself
    // leave the queue: claimed externally, only id=1 remains queued.
    rerender({ live: [makeJob(1)] });
    const undoFn = mockToastSuccess.mock.calls[0][1].action.onClick;
    await act(async () => {
      undoFn();
    });
    expect(mockToastInfo).toHaveBeenCalledWith(en.queue.reorder.undo.disabled.tooltip);
    // Only the original PATCH was issued; Undo did NOT dispatch.
    expect(captured.length).toBe(1);
  });

  it('test_reorder_when_middle_job_moved_then_undo_targets_its_old_successor', async () => {
    const initial = [makeJob(1), makeJob(2), makeJob(3), makeJob(4)];
    const moves: Array<[number, number | null]> = [];
    (globalThis as { fetch?: unknown }).fetch = vi.fn().mockImplementation((_, init) => {
      const body = JSON.parse(init.body as string);
      moves.push([body.jobId, body.beforeJobId]);
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
    });
    const { result } = renderHook(
      () => useReorderQueue({ initialPending: initial, livePending: initial }),
      { wrapper },
    );
    await act(async () => {
      result.current.reorder(2, null);
    });
    expect(result.current.orderedPending.map((j) => j.id)).toEqual([1, 3, 4, 2]);
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled());
    await act(async () => {
      mockToastSuccess.mock.calls[0][1].action.onClick();
    });
    await waitFor(() => expect(moves.length).toBe(2));
    expect(moves[1]).toEqual([2, 3]);
  });

  it('test_reorder_when_old_neighbour_left_queue_then_undo_is_disabled', async () => {
    const initial = [makeJob(1), makeJob(2), makeJob(3)];
    const fetchSpy = mockFetch200();
    (globalThis as { fetch?: unknown }).fetch = fetchSpy;
    const { result, rerender } = renderHook(
      ({ live }: { live: JobRow[] }) =>
        useReorderQueue({ initialPending: initial, livePending: live }),
      { wrapper, initialProps: { live: initial } },
    );
    await act(async () => {
      result.current.reorder(1, null); // undo would be "1 before 2"
    });
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled());
    rerender({ live: [makeJob(1), makeJob(3)] });
    await act(async () => {
      mockToastSuccess.mock.calls[0][1].action.onClick();
    });
    expect(mockToastInfo).toHaveBeenCalledWith(en.queue.reorder.undo.disabled.tooltip);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('test_reorder_when_server_accepts_then_onApplied_runs_once_and_not_on_409', async () => {
    const initial = [makeJob(1), makeJob(2)];
    const onApplied = vi.fn();
    (globalThis as { fetch?: unknown }).fetch = mockFetch200();
    const { result } = renderHook(
      () => useReorderQueue({ initialPending: initial, livePending: initial, onApplied }),
      { wrapper },
    );
    await act(async () => {
      result.current.reorder(2, 1);
    });
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));

    (globalThis as { fetch?: unknown }).fetch = mockFetch409([1]);
    await act(async () => {
      result.current.reorder(1, 2);
    });
    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  it('test_moveForDrop_when_dragged_up_down_or_to_the_end_then_names_the_new_neighbour', () => {
    const rows = [makeJob(1), makeJob(2), makeJob(3), makeJob(4)];
    expect(moveForDrop(rows, 3, 0)).toEqual({ jobId: 4, beforeJobId: 1 });
    expect(moveForDrop(rows, 0, 2)).toEqual({ jobId: 1, beforeJobId: 4 });
    expect(moveForDrop(rows, 1, 3)).toEqual({ jobId: 2, beforeJobId: null });
    expect(moveForDrop(rows, 2, 1)).toEqual({ jobId: 3, beforeJobId: 2 });
  });
});
