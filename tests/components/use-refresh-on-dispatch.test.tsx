/*
 * 05-13 UAT-fix regression test for queue list-staleness on orchestrator
 * auto-dispatch. See src/lib/api/use-refresh-on-dispatch.ts for full context.
 *
 * Behavior asserted (per CARL TESTING rule 2 — failing-test-first):
 *   - First mount with null activeJob: NO router.refresh call
 *   - First mount with jobId=N: NO router.refresh call (initial state recorded)
 *   - null → jobId=N (dispatch from idle): router.refresh called once
 *   - jobId=N → jobId=M (dispatch after completion): router.refresh called once
 *   - jobId=N → null (active job completed): router.refresh called once
 *   - jobId=N → jobId=N (re-render with same value, eg progress event):
 *     NO refresh
 */

import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRefreshOnDispatch } from '@/src/lib/api/use-refresh-on-dispatch';

function makeRouter(): { refresh: ReturnType<typeof vi.fn> } {
  return { refresh: vi.fn() };
}

describe('useRefreshOnDispatch', () => {
  it('test_useRefreshOnDispatch_when_first_mount_null_then_does_NOT_call_refresh', () => {
    const router = makeRouter();
    renderHook(() => useRefreshOnDispatch(null, router));
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('test_useRefreshOnDispatch_when_first_mount_with_jobId_then_does_NOT_call_refresh', () => {
    const router = makeRouter();
    renderHook(() => useRefreshOnDispatch({ jobId: 7 }, router));
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('test_useRefreshOnDispatch_when_null_then_jobId_then_calls_refresh_once', () => {
    const router = makeRouter();
    const { rerender } = renderHook<void, { aj: { jobId: number } | null }>(
      ({ aj }) => useRefreshOnDispatch(aj, router),
      { initialProps: { aj: null } },
    );
    expect(router.refresh).not.toHaveBeenCalled();
    rerender({ aj: { jobId: 7 } });
    expect(router.refresh).toHaveBeenCalledOnce();
  });

  it('test_useRefreshOnDispatch_when_jobId_changes_then_calls_refresh_once', () => {
    const router = makeRouter();
    const { rerender } = renderHook<void, { aj: { jobId: number } | null }>(
      ({ aj }) => useRefreshOnDispatch(aj, router),
      { initialProps: { aj: { jobId: 7 } } },
    );
    expect(router.refresh).not.toHaveBeenCalled();
    rerender({ aj: { jobId: 8 } });
    expect(router.refresh).toHaveBeenCalledOnce();
  });

  it('test_useRefreshOnDispatch_when_jobId_then_null_then_calls_refresh_once', () => {
    const router = makeRouter();
    const { rerender } = renderHook<void, { aj: { jobId: number } | null }>(
      ({ aj }) => useRefreshOnDispatch(aj, router),
      { initialProps: { aj: { jobId: 7 } } },
    );
    rerender({ aj: null });
    expect(router.refresh).toHaveBeenCalledOnce();
  });

  it('test_useRefreshOnDispatch_when_same_jobId_re_rendered_then_does_NOT_call_refresh', () => {
    const router = makeRouter();
    const { rerender } = renderHook<void, { aj: { jobId: number } | null }>(
      ({ aj }) => useRefreshOnDispatch(aj, router),
      { initialProps: { aj: { jobId: 7 } } },
    );
    rerender({ aj: { jobId: 7 } }); // same identity — progress event, not dispatch
    rerender({ aj: { jobId: 7 } });
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('test_useRefreshOnDispatch_when_three_dispatches_in_sequence_then_calls_refresh_three_times', () => {
    const router = makeRouter();
    const { rerender } = renderHook<void, { aj: { jobId: number } | null }>(
      ({ aj }) => useRefreshOnDispatch(aj, router),
      { initialProps: { aj: null } },
    );
    rerender({ aj: { jobId: 1 } }); // dispatch 1 — refresh
    rerender({ aj: null }); // complete 1 — refresh
    rerender({ aj: { jobId: 2 } }); // dispatch 2 — refresh
    expect(router.refresh).toHaveBeenCalledTimes(3);
  });
});
