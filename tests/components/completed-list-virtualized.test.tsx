// Plan 05-12 (B3 Queue Reorder) — CompletedListVirtualized rendering tests.
// Covers AC-5 (RIGHT pane: always card-list, virtualizer >50 threshold,
// 3 filter chips done/failed/cancelled, pagination footer).

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import type { JobRow } from '@/src/lib/db/schema';
import { CompletedListVirtualized } from '@/components/queue/completed-list-virtualized';

function makeJob(id: number, status: JobRow['status'] = 'done'): JobRow {
  return {
    id,
    file_id: id * 10,
    status,
    started_at: 100,
    finished_at: 200,
    encoder: 'libx265',
    crf: 23,
    queue_position: 0,
    bytes_in: 1_000_000,
    bytes_out: 500_000,
    duration_ms: 60_000,
    exit_code: 0,
    error_msg: null,
    log_tail: null,
    created_at: 0,
  };
}

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      {ui}
    </NextIntlClientProvider>
  );
}

const baseProps = {
  pathByFileId: {} as Record<number, string>,
  pagination: { page: 1, size: 25, total: 0, pageCount: 0 },
  statusGroup: 'completed' as const,
  onStatusGroupChange: vi.fn(),
  onPageChange: vi.fn(),
  onSizeChange: vi.fn(),
};

describe('CompletedListVirtualized', () => {
  it('test_render_when_empty_then_shows_empty_helper_text', () => {
    render(
      wrap(
        <CompletedListVirtualized
          {...baseProps}
          initialCompleted={[]}
          pagination={{ ...baseProps.pagination, total: 0 }}
        />,
      ),
    );
    expect(screen.getByText(en.queue.completed.empty.helper)).toBeInTheDocument();
  });

  it('test_render_when_three_filter_chips_then_done_failed_cancelled_present_no_all_chip', () => {
    render(wrap(<CompletedListVirtualized {...baseProps} initialCompleted={[]} />));
    const chips = screen.getAllByRole('radio');
    expect(chips.length).toBe(3);
    const labels = chips.map((c) => c.textContent);
    expect(labels).toContain(en.queue.completed.filter.done);
    expect(labels).toContain(en.queue.completed.filter.failed);
    expect(labels).toContain(en.queue.completed.filter.cancelled);
  });

  it('test_render_when_filter_chip_clicked_then_onStatusGroupChange_called_with_value', () => {
    const onChange = vi.fn();
    render(
      wrap(
        <CompletedListVirtualized
          {...baseProps}
          onStatusGroupChange={onChange}
          initialCompleted={[]}
        />,
      ),
    );
    const failedChip = screen.getByRole('radio', { name: en.queue.completed.filter.failed });
    fireEvent.click(failedChip);
    expect(onChange).toHaveBeenCalledWith('failed');
  });

  it('test_render_when_active_chip_clicked_again_then_onStatusGroupChange_called_with_completed_default', () => {
    const onChange = vi.fn();
    render(
      wrap(
        <CompletedListVirtualized
          {...baseProps}
          statusGroup="failed"
          onStatusGroupChange={onChange}
          initialCompleted={[]}
        />,
      ),
    );
    const failedChip = screen.getByRole('radio', { name: en.queue.completed.filter.failed });
    fireEvent.click(failedChip);
    // Active chip click resets to default ('completed').
    expect(onChange).toHaveBeenCalledWith('completed');
  });

  it('test_render_when_count_under_50_then_uses_flat_card_list_no_virtualizer', () => {
    const jobs = Array.from({ length: 5 }, (_, i) => makeJob(i + 1));
    const { container } = render(
      wrap(
        <CompletedListVirtualized
          {...baseProps}
          initialCompleted={jobs}
          pagination={{ ...baseProps.pagination, total: 5, pageCount: 1 }}
        />,
      ),
    );
    // Flat card-list path renders <ul> with N <li> children. Virtualizer scroll-container
    // (data-testid='completed-virtualizer-scroll') is NOT mounted.
    expect(container.querySelector('[data-testid="completed-virtualizer-scroll"]')).toBeNull();
    const list = container.querySelector('ul');
    expect(list).toBeTruthy();
    expect(list!.children.length).toBe(5);
  });

  it('test_render_when_count_above_50_then_mounts_virtualizer_scroll_container', () => {
    const jobs = Array.from({ length: 60 }, (_, i) => makeJob(i + 1));
    const { container } = render(
      wrap(
        <CompletedListVirtualized
          {...baseProps}
          initialCompleted={jobs}
          pagination={{ ...baseProps.pagination, total: 60, pageCount: 3 }}
        />,
      ),
    );
    expect(container.querySelector('[data-testid="completed-virtualizer-scroll"]')).toBeTruthy();
  });

  it('test_render_when_total_above_zero_then_pagination_footer_renders', () => {
    const jobs = [makeJob(1)];
    render(
      wrap(
        <CompletedListVirtualized
          {...baseProps}
          initialCompleted={jobs}
          pagination={{ page: 1, size: 25, total: 30, pageCount: 2 }}
        />,
      ),
    );
    // Pagination renders a "Next" button (Library precedent).
    const nextBtn = screen.queryByRole('button', { name: /next|nächste/i });
    expect(nextBtn).toBeTruthy();
  });
});
