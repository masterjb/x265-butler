/*
 * 05-13 UAT-fix regression test for queue list-staleness on orchestrator
 * auto-dispatch. See src/lib/api/use-refresh-on-dispatch.ts for full context.
 *
 * Behavior asserted (failing-test-first discipline):
 *   - First mount with null activeJob: NO router.refresh call
 *   - First mount with jobId=N: NO router.refresh call (initial state recorded)
 *   - null → jobId=N (dispatch from idle): router.refresh called once
 *   - jobId=N → jobId=M (dispatch after completion): router.refresh called once
 *   - jobId=N → null (active job completed): router.refresh called once
 *   - jobId=N → jobId=N (re-render with same value, eg progress event):
 *     NO refresh
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  useRefreshOnDispatch,
  useRefreshOnActiveSetChange,
  useRefreshOnReconnect,
  useRefreshOnVisibilityRegain,
} from '@/src/lib/api/use-refresh-on-dispatch';

function makeRouter(): { refresh: ReturnType<typeof vi.fn> } {
  return { refresh: vi.fn() };
}

// SR-3: document.visibilityState is GLOBAL jsdom state. Each visibility test
// sets its own known start; afterEach restores 'visible' so a test that leaves
// the document 'hidden' cannot contaminate the 7 useRefreshOnDispatch cases or
// a later visibility case (ordering-independent).
function setVisibility(value: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value, configurable: true });
}

afterEach(() => {
  setVisibility('visible');
});

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

// 36-02 (AC-10): set-change refresh, not lowest-jobId identity.
describe('useRefreshOnActiveSetChange', () => {
  it('test_useRefreshOnActiveSetChange_when_first_mount_then_does_NOT_call_refresh', () => {
    const router = makeRouter();
    renderHook(() => useRefreshOnActiveSetChange([{ jobId: 10 }, { jobId: 11 }], router));
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('test_useRefreshOnActiveSetChange_when_job_added_then_calls_refresh_once', () => {
    const router = makeRouter();
    const { rerender } = renderHook<void, { jobs: { jobId: number }[] }>(
      ({ jobs }) => useRefreshOnActiveSetChange(jobs, router),
      { initialProps: { jobs: [{ jobId: 10 }] } },
    );
    rerender({ jobs: [{ jobId: 10 }, { jobId: 11 }] }); // dispatch
    expect(router.refresh).toHaveBeenCalledOnce();
  });

  it('test_useRefreshOnActiveSetChange_when_job_removed_then_calls_refresh_once', () => {
    const router = makeRouter();
    const { rerender } = renderHook<void, { jobs: { jobId: number }[] }>(
      ({ jobs }) => useRefreshOnActiveSetChange(jobs, router),
      { initialProps: { jobs: [{ jobId: 10 }, { jobId: 11 }] } },
    );
    rerender({ jobs: [{ jobId: 10 }] }); // complete
    expect(router.refresh).toHaveBeenCalledOnce();
  });

  // THE regression the lowest-jobId hook misses: sibling completes + new job
  // dispatches, lowest jobId (10) unchanged across {10,11} → {10,12}.
  it('test_useRefreshOnActiveSetChange_when_sibling_swaps_same_lowest_then_calls_refresh', () => {
    const router = makeRouter();
    const { rerender } = renderHook<void, { jobs: { jobId: number }[] }>(
      ({ jobs }) => useRefreshOnActiveSetChange(jobs, router),
      { initialProps: { jobs: [{ jobId: 10 }, { jobId: 11 }] } },
    );
    rerender({ jobs: [{ jobId: 10 }, { jobId: 12 }] }); // 11 done, 12 dispatched
    expect(router.refresh).toHaveBeenCalledOnce();
  });

  it('test_useRefreshOnActiveSetChange_when_same_set_reordered_then_does_NOT_call_refresh', () => {
    const router = makeRouter();
    const { rerender } = renderHook<void, { jobs: { jobId: number }[] }>(
      ({ jobs }) => useRefreshOnActiveSetChange(jobs, router),
      { initialProps: { jobs: [{ jobId: 10 }, { jobId: 11 }] } },
    );
    // Same set, different array order (sorted key is identical) → no refresh.
    rerender({ jobs: [{ jobId: 11 }, { jobId: 10 }] });
    rerender({ jobs: [{ jobId: 10 }, { jobId: 11 }] });
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

describe('useRefreshOnReconnect', () => {
  it('test_useRefreshOnReconnect_when_first_mount_connected_then_does_NOT_call_refresh', () => {
    const router = makeRouter();
    renderHook(() => useRefreshOnReconnect(false, router));
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('test_useRefreshOnReconnect_when_first_mount_disconnected_then_does_NOT_call_refresh', () => {
    const router = makeRouter();
    renderHook(() => useRefreshOnReconnect(true, router));
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('test_useRefreshOnReconnect_when_disconnected_true_to_false_then_calls_refresh_once', () => {
    const router = makeRouter();
    const { rerender } = renderHook<void, { d: boolean }>(
      ({ d }) => useRefreshOnReconnect(d, router),
      { initialProps: { d: true } },
    );
    expect(router.refresh).not.toHaveBeenCalled();
    rerender({ d: false }); // reconnect
    expect(router.refresh).toHaveBeenCalledOnce();
  });

  it('test_useRefreshOnReconnect_when_disconnected_false_to_true_then_does_NOT_call_refresh', () => {
    const router = makeRouter();
    const { rerender } = renderHook<void, { d: boolean }>(
      ({ d }) => useRefreshOnReconnect(d, router),
      { initialProps: { d: false } },
    );
    rerender({ d: true }); // a drop, not a reconnect
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('test_useRefreshOnReconnect_when_steady_false_rerender_then_does_NOT_call_refresh', () => {
    const router = makeRouter();
    const { rerender } = renderHook<void, { d: boolean }>(
      ({ d }) => useRefreshOnReconnect(d, router),
      { initialProps: { d: false } },
    );
    rerender({ d: false });
    rerender({ d: false });
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('test_useRefreshOnReconnect_when_two_reconnects_then_calls_refresh_twice', () => {
    const router = makeRouter();
    const { rerender } = renderHook<void, { d: boolean }>(
      ({ d }) => useRefreshOnReconnect(d, router),
      { initialProps: { d: true } },
    );
    rerender({ d: false }); // reconnect 1
    rerender({ d: true }); // drop
    rerender({ d: false }); // reconnect 2
    expect(router.refresh).toHaveBeenCalledTimes(2);
  });
});

describe('useRefreshOnVisibilityRegain', () => {
  function fireVisibility(value: 'visible' | 'hidden'): void {
    setVisibility(value);
    document.dispatchEvent(new Event('visibilitychange'));
  }

  it('test_useRefreshOnVisibilityRegain_when_initial_visible_mount_then_does_NOT_call_refresh', () => {
    setVisibility('visible');
    const router = makeRouter();
    renderHook(() => useRefreshOnVisibilityRegain(router));
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('test_useRefreshOnVisibilityRegain_when_visible_hidden_visible_then_calls_refresh_once', () => {
    setVisibility('visible');
    const router = makeRouter();
    renderHook(() => useRefreshOnVisibilityRegain(router));
    fireVisibility('hidden');
    fireVisibility('visible');
    expect(router.refresh).toHaveBeenCalledOnce();
  });

  it('test_useRefreshOnVisibilityRegain_when_two_regains_then_calls_refresh_twice', () => {
    setVisibility('visible');
    const router = makeRouter();
    renderHook(() => useRefreshOnVisibilityRegain(router));
    fireVisibility('hidden');
    fireVisibility('visible'); // regain 1
    fireVisibility('hidden');
    fireVisibility('visible'); // regain 2
    expect(router.refresh).toHaveBeenCalledTimes(2);
  });

  it('test_useRefreshOnVisibilityRegain_when_unmounted_then_does_NOT_call_refresh', () => {
    setVisibility('visible');
    const router = makeRouter();
    const { unmount } = renderHook(() => useRefreshOnVisibilityRegain(router));
    unmount();
    fireVisibility('hidden');
    fireVisibility('visible');
    expect(router.refresh).not.toHaveBeenCalled();
  });
});
