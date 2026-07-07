// 13-02 T2 tests — useMultiSelect hook (≥8 cases per plan).

import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useMultiSelect } from '@/src/lib/ui/use-multi-select';

describe('useMultiSelect', () => {
  it('initial state is empty', () => {
    const { result } = renderHook(() =>
      useMultiSelect({ visibleIds: [1, 2, 3], resetSignal: 'page-1' }),
    );
    expect(result.current.selectedCount).toBe(0);
    expect(result.current.headerState).toBe('none');
    expect(result.current.isSelected(1)).toBe(false);
  });

  it('toggle(1) → selectedCount=1 + isSelected(1)=true', () => {
    const { result } = renderHook(() =>
      useMultiSelect({ visibleIds: [1, 2, 3], resetSignal: 'p1' }),
    );
    act(() => result.current.toggle(1));
    expect(result.current.selectedCount).toBe(1);
    expect(result.current.isSelected(1)).toBe(true);
  });

  it('toggle(1) twice → selectedCount=0 (off)', () => {
    const { result } = renderHook(() =>
      useMultiSelect({ visibleIds: [1, 2, 3], resetSignal: 'p1' }),
    );
    act(() => result.current.toggle(1));
    act(() => result.current.toggle(1));
    expect(result.current.selectedCount).toBe(0);
    expect(result.current.isSelected(1)).toBe(false);
  });

  it('selectAllOnPage from "none" → all 3 selected + headerState="all"', () => {
    const { result } = renderHook(() =>
      useMultiSelect({ visibleIds: [1, 2, 3], resetSignal: 'p1' }),
    );
    act(() => result.current.selectAllOnPage([1, 2, 3]));
    expect(result.current.selectedCount).toBe(3);
    expect(result.current.headerState).toBe('all');
  });

  it('selectAllOnPage from "all" → 0 selected + headerState="none"', () => {
    const { result } = renderHook(() =>
      useMultiSelect({ visibleIds: [1, 2, 3], resetSignal: 'p1' }),
    );
    act(() => result.current.selectAllOnPage([1, 2, 3]));
    expect(result.current.headerState).toBe('all');
    act(() => result.current.selectAllOnPage([1, 2, 3]));
    expect(result.current.selectedCount).toBe(0);
    expect(result.current.headerState).toBe('none');
  });

  it('selectAllOnPage from "some" (1 of 3 selected) → all 3 selected + headerState="all"', () => {
    const { result } = renderHook(() =>
      useMultiSelect({ visibleIds: [1, 2, 3], resetSignal: 'p1' }),
    );
    act(() => result.current.toggle(2));
    expect(result.current.headerState).toBe('some');
    act(() => result.current.selectAllOnPage([1, 2, 3]));
    expect(result.current.selectedCount).toBe(3);
    expect(result.current.headerState).toBe('all');
  });

  it('resetSignal change → selectedIds cleared', () => {
    const { result, rerender } = renderHook(
      ({ resetSignal }) => useMultiSelect({ visibleIds: [1, 2, 3], resetSignal }),
      { initialProps: { resetSignal: 'page-1' } },
    );
    act(() => result.current.toggle(1));
    act(() => result.current.toggle(2));
    expect(result.current.selectedCount).toBe(2);
    rerender({ resetSignal: 'page-2' });
    expect(result.current.selectedCount).toBe(0);
    expect(result.current.headerState).toBe('none');
  });

  it('headerState="some" with partial visibleIds overlap', () => {
    const { result } = renderHook(() =>
      useMultiSelect({ visibleIds: [1, 2, 3, 4, 5], resetSignal: 'p1' }),
    );
    act(() => result.current.toggle(2));
    act(() => result.current.toggle(4));
    expect(result.current.headerState).toBe('some');
    expect(result.current.selectedCount).toBe(2);
  });

  it('clear() empties the selection', () => {
    const { result } = renderHook(() =>
      useMultiSelect({ visibleIds: [1, 2, 3], resetSignal: 'p1' }),
    );
    act(() => result.current.selectAllOnPage([1, 2, 3]));
    expect(result.current.selectedCount).toBe(3);
    act(() => result.current.clear());
    expect(result.current.selectedCount).toBe(0);
    expect(result.current.headerState).toBe('none');
  });

  it('selection persists above maxCap (soft-cap, AC-11)', () => {
    const ids = Array.from({ length: 600 }, (_, i) => i + 1);
    const { result } = renderHook(() => useMultiSelect({ visibleIds: ids, resetSignal: 'p1' }));
    act(() => result.current.selectAllOnPage(ids));
    expect(result.current.selectedCount).toBe(600);
    expect(result.current.headerState).toBe('all');
  });
});
