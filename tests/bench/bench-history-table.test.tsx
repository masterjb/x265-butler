import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { BenchRunRow, BenchRunStatus } from '@/src/lib/db/schema';

const { mockPush, mockRefresh, mockPurge, mockBulkDelete } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockRefresh: vi.fn(),
  mockPurge: vi.fn(),
  mockBulkDelete: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn(), refresh: mockRefresh }),
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
    custom: vi.fn(() => 'sonner-id'),
  }),
}));

vi.mock('@/components/ui/undo-toast', () => ({
  showUndoToast: vi.fn(() => 'undo-id'),
  UNDO_TOAST_DEFAULT_MS: 10_000,
}));

vi.mock('@/src/lib/api/bench-client', () => ({
  purgeBenchRun: mockPurge,
  bulkDeleteBenchRuns: mockBulkDelete,
}));

import { BenchHistoryTable, type TopBalancedSummary } from '@/components/bench/bench-history-table';
import en from '@/messages/en.json';

const MESSAGES = en;

function makeRun(
  id: number,
  encoders: string[] = ['libx265'],
  status: BenchRunStatus = 'complete',
): BenchRunRow {
  return {
    id,
    mode: 'native-sweep',
    status,
    fileIds: [1],
    matrix: { encoders, presets: ['medium'], nativeValues: [23] },
    sample_count: 3,
    sample_duration_seconds: 20,
    vmaf_buckets_json: null,
    vmaf_model: 'vmaf_v0.6.1',
    actor_id: null,
    error_reason: null,
    created_at: 1_700_000_000 + id,
    started_at: null,
    completed_at: null,
    version: 1,
  };
}

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={MESSAGES} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

const EMPTY_TOP: Record<number, TopBalancedSummary | null> = {};

/**
 * SelectionBar renders a desktop AND a mobile variant simultaneously, so every child
 * supplied to it exists TWICE in the DOM. getByTestId/queryByTestId THROW on multiple
 * matches — every selection-cluster query in this file must use the *All* variants
 * (AC-5 / audit M9).
 */
function selectionChild(testId: string): HTMLElement {
  const all = screen.getAllByTestId(testId);
  return all[0];
}

/** Row-scoped query: ConfirmButton hard-codes data-testid="confirm-button-primary", so
 *  an unscoped lookup would match every row plus both bulk copies (audit M9). */
function rowDeleteButton(runId: number): HTMLElement {
  return within(screen.getByTestId(`history-row-${runId}`)).getByTestId('confirm-button-primary');
}

/** idle → cooldown(3000ms) → armed → fired. There is NO direct idle→armed edge. */
function armAndConfirm(btn: HTMLElement): void {
  act(() => {
    fireEvent.click(btn);
  });
  act(() => {
    vi.advanceTimersByTime(3000);
  });
  act(() => {
    fireEvent.click(btn);
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('BenchHistoryTable', () => {
  beforeEach(() => {
    mockPush.mockReset();
    mockRefresh.mockReset();
    mockPurge.mockReset();
    mockBulkDelete.mockReset();
    global.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ runs: [] }) } as Response),
    ) as unknown as typeof fetch;
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((q: string) => ({
        matches: false,
        media: q,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        onchange: null,
        dispatchEvent: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('test_renders_rows_for_initialRuns', () => {
    const runs = [makeRun(1), makeRun(2), makeRun(3)];
    render(
      wrap(
        <BenchHistoryTable
          initialRuns={runs}
          topBalancedByRunId={EMPTY_TOP}
          totalCount={3}
          locale="en"
        />,
      ),
    );
    expect(screen.getByTestId('history-row-1')).toBeInTheDocument();
    expect(screen.getByTestId('history-row-2')).toBeInTheDocument();
    expect(screen.getByTestId('history-row-3')).toBeInTheDocument();
  });

  it('test_renders_emptyState_when_totalCount_is_zero', () => {
    render(
      wrap(
        <BenchHistoryTable
          initialRuns={[]}
          topBalancedByRunId={EMPTY_TOP}
          totalCount={0}
          locale="en"
        />,
      ),
    );
    expect(screen.queryByTestId('history-table')).toBeNull();
  });

  it('test_search_filters_by_encoder_substring', () => {
    const runs = [makeRun(1, ['libx265']), makeRun(2, ['hevc_nvenc'])];
    render(
      wrap(
        <BenchHistoryTable
          initialRuns={runs}
          topBalancedByRunId={EMPTY_TOP}
          totalCount={2}
          locale="en"
        />,
      ),
    );
    const input = screen.getByLabelText(/Filter by encoder/i);
    fireEvent.change(input, { target: { value: 'nvenc' } });
    expect(screen.queryByTestId('history-row-1')).toBeNull();
    expect(screen.getByTestId('history-row-2')).toBeInTheDocument();
  });

  it('test_sort_toggle_reverses_direction', () => {
    const runs = [makeRun(1), makeRun(2)];
    render(
      wrap(
        <BenchHistoryTable
          initialRuns={runs}
          topBalancedByRunId={EMPTY_TOP}
          totalCount={2}
          locale="en"
        />,
      ),
    );
    const sortBtn = screen.getByTestId('history-sort-created');
    const initialHeader = sortBtn.textContent ?? '';
    fireEvent.click(sortBtn);
    expect(sortBtn.textContent).not.toBe(initialHeader);
  });

  // 47-02 AC-4 (Pick B2) — REPLACES test_multiSelect_caps_at_three. The 3-cap moved off
  // the checkbox and onto the compare CTA; selecting a 4th run is now legal (it feeds the
  // bulk purge). This is an intentional behaviour change, not a broken test.
  it('test_selection_stays_enabled_past_three_and_compareCta_goes_disabled', () => {
    const runs = [makeRun(1), makeRun(2), makeRun(3), makeRun(4)];
    render(
      wrap(
        <BenchHistoryTable
          initialRuns={runs}
          topBalancedByRunId={EMPTY_TOP}
          totalCount={4}
          locale="en"
        />,
      ),
    );
    fireEvent.click(screen.getByTestId('history-checkbox-1'));
    fireEvent.click(screen.getByTestId('history-checkbox-2'));
    fireEvent.click(screen.getByTestId('history-checkbox-3'));

    const fourth = screen.getByTestId('history-checkbox-4');
    expect(fourth).not.toHaveAttribute('aria-disabled', 'true');
    expect(fourth).not.toHaveAttribute('title');

    fireEvent.click(fourth);
    expect(screen.getByTestId('history-checkbox-4')).toHaveAttribute('aria-checked', 'true');

    const cta = selectionChild('history-compare-cta') as HTMLButtonElement;
    expect(cta).toBeDisabled();
    expect(selectionChild('history-compare-hint')).toHaveTextContent(/2–3 runs/i);
  });

  it('test_compareCta_disabled_below_two_selected', () => {
    const runs = [makeRun(1), makeRun(2)];
    render(
      wrap(
        <BenchHistoryTable
          initialRuns={runs}
          topBalancedByRunId={EMPTY_TOP}
          totalCount={2}
          locale="en"
        />,
      ),
    );
    fireEvent.click(screen.getByTestId('history-checkbox-1'));
    const cta = selectionChild('history-compare-cta') as HTMLButtonElement;
    expect(cta).toBeDisabled();
  });

  it('test_compareCta_enabled_at_two_selected', () => {
    const runs = [makeRun(1), makeRun(2)];
    render(
      wrap(
        <BenchHistoryTable
          initialRuns={runs}
          topBalancedByRunId={EMPTY_TOP}
          totalCount={2}
          locale="en"
        />,
      ),
    );
    fireEvent.click(screen.getByTestId('history-checkbox-1'));
    fireEvent.click(screen.getByTestId('history-checkbox-2'));
    const cta = selectionChild('history-compare-cta') as HTMLButtonElement;
    expect(cta).not.toBeDisabled();
  });

  it('test_compareCta_click_routes_to_compare', () => {
    const runs = [makeRun(1), makeRun(2)];
    render(
      wrap(
        <BenchHistoryTable
          initialRuns={runs}
          topBalancedByRunId={EMPTY_TOP}
          totalCount={2}
          locale="en"
        />,
      ),
    );
    fireEvent.click(screen.getByTestId('history-checkbox-1'));
    fireEvent.click(screen.getByTestId('history-checkbox-2'));
    fireEvent.click(selectionChild('history-compare-cta'));
    expect(mockPush).toHaveBeenCalledWith(expect.stringMatching(/\/en\/bench\/compare\?ids=1,2/));
  });

  // AC-5: SelectionBar renders desktop AND mobile at once, so each child is exactly two
  // DOM nodes. Pinned so a future single-variant regression is caught.
  it('test_selectionBar_renders_each_child_exactly_twice_and_both_are_wired', () => {
    const runs = [makeRun(1), makeRun(2)];
    render(
      wrap(
        <BenchHistoryTable
          initialRuns={runs}
          topBalancedByRunId={EMPTY_TOP}
          totalCount={2}
          locale="en"
        />,
      ),
    );
    fireEvent.click(screen.getByTestId('history-checkbox-1'));
    fireEvent.click(screen.getByTestId('history-checkbox-2'));

    expect(screen.getAllByTestId('history-compare-cta')).toHaveLength(2);
    expect(screen.getByTestId('selection-bar-desktop')).toBeInTheDocument();
    expect(screen.getByTestId('selection-bar-mobile')).toBeInTheDocument();

    // The MOBILE copy shares the same handler as the desktop one.
    fireEvent.click(screen.getAllByTestId('history-compare-cta')[1]);
    expect(mockPush).toHaveBeenCalledWith(expect.stringMatching(/ids=1,2/));
  });

  it('test_row_link_href_points_to_runs_detail', () => {
    const runs = [makeRun(5)];
    render(
      wrap(
        <BenchHistoryTable
          initialRuns={runs}
          topBalancedByRunId={EMPTY_TOP}
          totalCount={1}
          locale="en"
        />,
      ),
    );
    const link = screen.getByTestId('history-row-link-5') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/en/bench/runs/5');
  });

  it('test_loadMore_button_visible_when_more_remaining', () => {
    const runs = [makeRun(1)];
    render(
      wrap(
        <BenchHistoryTable
          initialRuns={runs}
          topBalancedByRunId={EMPTY_TOP}
          totalCount={5}
          locale="en"
        />,
      ),
    );
    expect(screen.getByTestId('history-load-more')).toBeInTheDocument();
  });

  it('test_loadMore_fetches_next_page', async () => {
    const runs = [makeRun(1)];
    const newRun = makeRun(2);
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ runs: [newRun] }),
    } as Response);
    render(
      wrap(
        <BenchHistoryTable
          initialRuns={runs}
          topBalancedByRunId={EMPTY_TOP}
          totalCount={5}
          locale="en"
        />,
      ),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('history-load-more'));
      await Promise.resolve();
    });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/bench?limit=50&offset=1'),
      expect.any(Object),
    );
  });

  it('test_emptyFiltered_state_when_filter_has_no_match', () => {
    const runs = [makeRun(1, ['libx265'])];
    render(
      wrap(
        <BenchHistoryTable
          initialRuns={runs}
          topBalancedByRunId={EMPTY_TOP}
          totalCount={1}
          locale="en"
        />,
      ),
    );
    fireEvent.change(screen.getByLabelText(/Filter by encoder/i), {
      target: { value: 'no-match' },
    });
    expect(screen.getByText(/No runs match this filter/i)).toBeInTheDocument();
  });

  // audit M9: queryByTestId THROWS on multiple matches — the compare CTA now lives in
  // SelectionBar and exists twice, so this assertion had to become queryAllByTestId.
  it('test_clearSelection_button_visible_with_selection_and_resets', () => {
    const runs = [makeRun(1), makeRun(2)];
    render(
      wrap(
        <BenchHistoryTable
          initialRuns={runs}
          topBalancedByRunId={EMPTY_TOP}
          totalCount={2}
          locale="en"
        />,
      ),
    );
    fireEvent.click(screen.getByTestId('history-checkbox-1'));
    fireEvent.click(screen.getByTestId('history-checkbox-2'));

    const clearBtn = screen.getByTestId('selection-bar-clear-desktop');
    expect(clearBtn).toBeInTheDocument();
    fireEvent.click(clearBtn);

    expect(screen.queryByTestId('selection-bar-clear-desktop')).toBeNull();
    expect(screen.queryAllByTestId('history-compare-cta')).toHaveLength(0);
    expect(screen.queryByTestId('selection-bar-desktop')).toBeNull();
  });

  it('test_row_anchor_keyboard_activation_via_Enter', () => {
    const runs = [makeRun(7)];
    render(
      wrap(
        <BenchHistoryTable
          initialRuns={runs}
          topBalancedByRunId={EMPTY_TOP}
          totalCount={1}
          locale="en"
        />,
      ),
    );
    const link = screen.getByTestId('history-row-link-7') as HTMLAnchorElement;
    // Anchor is natively keyboard-activated by Enter — assert it's focusable + correct href.
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('/en/bench/runs/7');
    link.focus();
    expect(document.activeElement).toBe(link);
  });

  // ── 47-02 ──────────────────────────────────────────────────────────────────────

  it('test_rowDelete_removes_the_row_without_a_reload_and_keeps_other_selection (AC-1)', async () => {
    vi.useFakeTimers();
    mockPurge.mockResolvedValue({ deleted: true, combosDeleted: 4 });
    const runs = [makeRun(1), makeRun(2), makeRun(3)];
    render(
      wrap(
        <BenchHistoryTable
          initialRuns={runs}
          topBalancedByRunId={EMPTY_TOP}
          totalCount={3}
          locale="en"
        />,
      ),
    );
    // Select an unrelated row — its selection must survive the delete.
    act(() => {
      fireEvent.click(screen.getByTestId('history-checkbox-3'));
    });

    armAndConfirm(rowDeleteButton(2));
    await flush();

    expect(mockPurge).toHaveBeenCalledTimes(1);
    expect(mockPurge).toHaveBeenCalledWith(2);
    expect(screen.queryByTestId('history-row-2')).toBeNull();
    expect(screen.getByTestId('history-row-1')).toBeInTheDocument();
    expect(screen.getByTestId('history-checkbox-3')).toHaveAttribute('aria-checked', 'true');
  });

  it('test_rowDelete_affordance_hidden_for_pending_and_running (AC-2)', () => {
    const runs = [
      makeRun(1, ['libx265'], 'pending'),
      makeRun(2, ['libx265'], 'running'),
      makeRun(3, ['libx265'], 'complete'),
    ];
    render(
      wrap(
        <BenchHistoryTable
          initialRuns={runs}
          topBalancedByRunId={EMPTY_TOP}
          totalCount={3}
          locale="en"
        />,
      ),
    );
    expect(
      within(screen.getByTestId('history-row-1')).queryByTestId('confirm-button-primary'),
    ).toBeNull();
    expect(
      within(screen.getByTestId('history-row-2')).queryByTestId('confirm-button-primary'),
    ).toBeNull();
    expect(rowDeleteButton(3)).toBeInTheDocument();
  });

  it('test_emptyState_flips_when_the_last_run_is_deleted (AC-7)', async () => {
    vi.useFakeTimers();
    mockPurge.mockResolvedValue({ deleted: true, combosDeleted: 0 });
    render(
      wrap(
        <BenchHistoryTable
          initialRuns={[makeRun(1)]}
          topBalancedByRunId={EMPTY_TOP}
          totalCount={1}
          locale="en"
        />,
      ),
    );

    armAndConfirm(rowDeleteButton(1));
    await flush();

    expect(screen.queryByTestId('history-table')).toBeNull();
    expect(screen.getByText(/No benchmarks yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/No runs match this filter/i)).toBeNull();
  });

  it('test_emptyPage_not_emptyFiltered_when_page_is_cleared_but_runs_remain (AC-7)', async () => {
    vi.useFakeTimers();
    mockPurge.mockResolvedValue({ deleted: true, combosDeleted: 1 });
    render(
      wrap(
        <BenchHistoryTable
          initialRuns={[makeRun(1)]}
          topBalancedByRunId={EMPTY_TOP}
          totalCount={120}
          locale="en"
        />,
      ),
    );

    armAndConfirm(rowDeleteButton(1));
    await flush();

    // total is still 119 → NOT the empty state, and the copy must not claim a filter.
    expect(screen.getByTestId('history-table')).toBeInTheDocument();
    expect(screen.queryByText(/No benchmarks yet/i)).toBeNull();
    expect(screen.queryByText(/No runs match this filter/i)).toBeNull();
    expect(screen.getByText(/All runs on this page were deleted/i)).toBeInTheDocument();
    expect(screen.getByTestId('history-load-more')).toBeInTheDocument();
  });

  // audit SR9: the SelectionBar wiring (two DOM copies sharing one handler and one ids
  // array) has no other test that executes it — a component green in isolation can still
  // be mounted with the wrong props.
  it('test_bulkDelete_through_the_table_removes_rows_and_unmounts_the_bar (AC-6)', async () => {
    vi.useFakeTimers();
    mockBulkDelete.mockResolvedValue({ successCount: 2, failed: [] });
    const runs = [makeRun(1), makeRun(2), makeRun(3)];
    render(
      wrap(
        <BenchHistoryTable
          initialRuns={runs}
          topBalancedByRunId={EMPTY_TOP}
          totalCount={3}
          locale="en"
        />,
      ),
    );
    act(() => {
      fireEvent.click(screen.getByTestId('history-checkbox-1'));
      fireEvent.click(screen.getByTestId('history-checkbox-2'));
    });

    const bulkBtn = within(screen.getByTestId('selection-bar-desktop')).getByTestId(
      'confirm-button-primary',
    );
    armAndConfirm(bulkBtn);
    await flush();

    expect(mockBulkDelete).toHaveBeenCalledTimes(1);
    expect(mockBulkDelete).toHaveBeenCalledWith([1, 2]);
    expect(screen.queryByTestId('history-row-1')).toBeNull();
    expect(screen.queryByTestId('history-row-2')).toBeNull();
    expect(screen.getByTestId('history-row-3')).toBeInTheDocument();
    expect(screen.queryByTestId('selection-bar-desktop')).toBeNull();
  });

  it('test_no_cancel_control_renders_in_any_row (AC-9)', () => {
    const statuses: BenchRunStatus[] = ['pending', 'running', 'complete', 'failed', 'cancelled'];
    const runs = statuses.map((s, i) => makeRun(i + 1, ['libx265'], s));
    render(
      wrap(
        <BenchHistoryTable
          initialRuns={runs}
          topBalancedByRunId={EMPTY_TOP}
          totalCount={runs.length}
          locale="en"
        />,
      ),
    );
    // 47-01's D1 stale-client safety proof holds ONLY because cancel stays status-gated
    // to run-detail. A cancel affordance on a terminal-status row would void it.
    expect(screen.queryByRole('button', { name: /cancel run/i })).toBeNull();
    expect(screen.queryByText(/Cancel run/i)).toBeNull();
  });

  it('test_row_checkbox_and_view_link_copy_come_from_i18n (AC-10 / SR7)', () => {
    render(
      wrap(
        <BenchHistoryTable
          initialRuns={[makeRun(9)]}
          topBalancedByRunId={EMPTY_TOP}
          totalCount={1}
          locale="en"
        />,
      ),
    );
    expect(screen.getByLabelText('Select run #9')).toBeInTheDocument();
    expect(within(screen.getByTestId('history-row-9')).getByText('View →')).toBeInTheDocument();
  });
});
