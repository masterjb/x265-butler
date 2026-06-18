import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { BenchRunRow } from '@/src/lib/db/schema';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn() }),
}));

import { BenchHistoryTable, type TopBalancedSummary } from '@/components/bench/bench-history-table';
import en from '@/messages/en.json';

const MESSAGES = en;

function makeRun(id: number, encoders: string[] = ['libx265']): BenchRunRow {
  return {
    id,
    mode: 'native-sweep',
    status: 'complete',
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

describe('BenchHistoryTable', () => {
  beforeEach(() => {
    mockPush.mockReset();
    global.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ runs: [] }) } as Response),
    ) as unknown as typeof fetch;
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

  it('test_multiSelect_caps_at_three', () => {
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
    expect(fourth).toHaveAttribute('aria-disabled', 'true');
    expect(fourth).toHaveAttribute('title', 'Maximum 3 runs');
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
    const cta = screen.getByTestId('history-compare-cta') as HTMLButtonElement;
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
    const cta = screen.getByTestId('history-compare-cta') as HTMLButtonElement;
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
    fireEvent.click(screen.getByTestId('history-compare-cta'));
    expect(mockPush).toHaveBeenCalledWith(expect.stringMatching(/\/en\/bench\/compare\?ids=1,2/));
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
    const clearBtn = screen.getByTestId('history-clear-cta');
    expect(clearBtn).toBeInTheDocument();
    fireEvent.click(clearBtn);
    expect(screen.queryByTestId('history-clear-cta')).toBeNull();
    expect(screen.queryByTestId('history-compare-cta')).toBeNull();
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
});
