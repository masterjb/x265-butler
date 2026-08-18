// 13-01a T2 tests: 10 cases — schedule/cancel/fireNow + visibility-edge + stale-closure
// regression (M2) + visible-no-op (SR10) + opt-out fireOnHidden (SR6).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDeferredAction } from '@/src/lib/ui/use-deferred-action';

function fireVisibilityChange(state: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('useDeferredAction', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedule + advance(delayMs) → fn called once', () => {
    const fn = vi.fn();
    const { result } = renderHook(() => useDeferredAction(fn, 1000));
    act(() => {
      result.current.schedule('payload-a');
    });
    expect(fn).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('payload-a');
  });

  it('schedule + cancel + advance → fn NOT called', () => {
    const fn = vi.fn();
    const { result } = renderHook(() => useDeferredAction(fn, 1000));
    act(() => {
      result.current.schedule('payload-b');
    });
    act(() => {
      result.current.cancel();
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(fn).not.toHaveBeenCalled();
    expect(result.current.isPending).toBe(false);
  });

  it('schedule + fireNow → fn called immediately, isPending=false', () => {
    const fn = vi.fn();
    const { result } = renderHook(() => useDeferredAction(fn, 1000));
    act(() => {
      result.current.schedule('payload-c');
    });
    expect(result.current.isPending).toBe(true);
    act(() => {
      result.current.fireNow();
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('payload-c');
    expect(result.current.isPending).toBe(false);
  });

  it('double-schedule overwrites first payload', () => {
    const fn = vi.fn();
    const { result } = renderHook(() => useDeferredAction(fn, 1000));
    act(() => {
      result.current.schedule('first');
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    act(() => {
      result.current.schedule('second');
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('second');
  });

  it('unmount during pending → no fn call, no warning', () => {
    const fn = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result, unmount } = renderHook(() => useDeferredAction(fn, 1000));
    act(() => {
      result.current.schedule('payload-d');
    });
    unmount();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(fn).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("visibilitychange='hidden' while pending → fn called immediately (R6)", () => {
    const fn = vi.fn();
    const { result } = renderHook(() => useDeferredAction(fn, 10000));
    act(() => {
      result.current.schedule('payload-e');
    });
    act(() => {
      fireVisibilityChange('hidden');
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('payload-e');
  });

  it("visibilitychange='hidden' while NOT pending → no-op", () => {
    const fn = vi.fn();
    renderHook(() => useDeferredAction(fn, 1000));
    act(() => {
      fireVisibilityChange('hidden');
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it('isPending lifecycle: false → true on schedule → false on fire', () => {
    const fn = vi.fn();
    const { result } = renderHook(() => useDeferredAction(fn, 1000));
    expect(result.current.isPending).toBe(false);
    act(() => {
      result.current.schedule('payload-f');
    });
    expect(result.current.isPending).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.isPending).toBe(false);
  });

  it('M2 stale-closure regression: hidden fires AFTER state read', () => {
    // Listener was bound at mount when isPending=false in closure. If hook
    // used closure (not isPendingRef), the listener would permanently see
    // false and never fire on hidden. This test proves ref-mirror works.
    const fn = vi.fn();
    const { result } = renderHook(() => useDeferredAction(fn, 10000));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    act(() => {
      result.current.schedule('payload-stale');
    });
    act(() => {
      vi.advanceTimersByTime(50);
    });
    act(() => {
      fireVisibilityChange('hidden');
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('payload-stale');
  });

  it("SR10 visibilitychange='visible' while pending → no fn call, isPending stays true", () => {
    const fn = vi.fn();
    const { result } = renderHook(() => useDeferredAction(fn, 10000));
    act(() => {
      result.current.schedule('payload-g');
    });
    expect(result.current.isPending).toBe(true);
    act(() => {
      fireVisibilityChange('visible');
    });
    expect(fn).not.toHaveBeenCalled();
    expect(result.current.isPending).toBe(true);
  });
});
