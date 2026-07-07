// 13-02 Plan T2 — useMultiSelect hook (per-page-only persistence).
//
// State-machine for bulk-action multi-select on Library + Trash pages.
// Owned at the page level; checkbox + selection-bar are pure consumers.
//
// Per-page-only persistence (AC-9): when the parent page changes pagination,
// filter, or search, the parent passes a new `resetSignal` value (any value
// whose identity changes — string, object, number) and the hook clears the
// selection. No URL persistence, no cross-page state.
//
// Tristate header (AC-4): `headerState` is computed from the overlap between
// selectedIds and the currently-visible IDs. `selectAllOnPage` is a tristate
// toggle: from 'none' or 'some' it adds all visibleIds; from 'all' it removes
// all visibleIds (industry-standard Gmail/Notion pattern).
//
// Soft cap (AC-11 / S5): selection above `maxCap` (default 500) is allowed —
// only the consumer's action-buttons disable. This avoids frustrating "your
// selection has been truncated" surprises.

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

const DEFAULT_MAX_CAP = 500;

export type HeaderState = 'none' | 'some' | 'all';

export type UseMultiSelectResult = {
  selectedIds: ReadonlySet<number>;
  selectedCount: number;
  isSelected: (id: number) => boolean;
  toggle: (id: number) => void;
  /**
   * Tristate-aware select-all toggle. From 'none' or 'some' adds every
   * visibleId to the selection. From 'all' removes every visibleId.
   */
  selectAllOnPage: (visibleIds: readonly number[]) => void;
  clear: () => void;
  headerState: HeaderState;
};

export type UseMultiSelectOptions = {
  /** Currently visible IDs on this page; recomputed by the parent on every page/filter/search change. */
  visibleIds: readonly number[];
  /**
   * Identity-changing value that triggers `clear()` via useEffect. Pass a stable
   * string composed of `${page}|${filter}|${search}` (or any equivalent) so
   * navigating between pages drops the selection.
   */
  resetSignal: unknown;
  /** Soft-cap for action-button gating; default 500. Selection above this stays valid; consumer disables actions. */
  maxCap?: number;
};

export function useMultiSelect(opts: UseMultiSelectOptions): UseMultiSelectResult {
  const { visibleIds, resetSignal } = opts;
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<number>>(() => new Set<number>());

  useEffect(() => {
    setSelectedIds(new Set<number>());
  }, [resetSignal]);

  const isSelected = useCallback((id: number) => selectedIds.has(id), [selectedIds]);

  const toggle = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const headerState: HeaderState = useMemo(() => {
    if (visibleIds.length === 0) return 'none';
    let hits = 0;
    for (const id of visibleIds) {
      if (selectedIds.has(id)) hits++;
    }
    if (hits === 0) return 'none';
    if (hits === visibleIds.length) return 'all';
    return 'some';
  }, [visibleIds, selectedIds]);

  const selectAllOnPage = useCallback((ids: readonly number[]) => {
    setSelectedIds((prev) => {
      if (ids.length === 0) return prev;
      const next = new Set(prev);
      const allSelected = ids.every((id) => next.has(id));
      if (allSelected) {
        for (const id of ids) next.delete(id);
      } else {
        for (const id of ids) next.add(id);
      }
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setSelectedIds(new Set<number>());
  }, []);

  return {
    selectedIds,
    selectedCount: selectedIds.size,
    isSelected,
    toggle,
    selectAllOnPage,
    clear,
    headerState,
  };
}

export const MULTI_SELECT_DEFAULT_MAX_CAP = DEFAULT_MAX_CAP;
