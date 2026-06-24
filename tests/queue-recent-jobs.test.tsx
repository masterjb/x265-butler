import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RecentJobsTable } from '@/components/queue/recent-jobs-table';
import { RecentJobsCardList } from '@/components/queue/recent-jobs-card-list';
import { JobStatusChip } from '@/components/queue/job-status-chip';
import { wrap } from './test-utils';
import en from '@/messages/en.json';
import type { JobRow, JobStatus } from '@/src/lib/db/schema';

const baseJob: JobRow = {
  id: 1,
  file_id: 42,
  status: 'done',
  started_at: 1_700_000_000,
  finished_at: 1_700_000_060,
  encoder: 'libx265',
  crf: 23,
  queue_position: 0,
  bytes_in: 1_000_000_000,
  bytes_out: 500_000_000,
  duration_ms: 60_000,
  exit_code: null,
  error_msg: null,
  log_tail: null,
  created_at: 1_700_000_000,
};

describe('RecentJobsTable — rendering', () => {
  it('test_RecentJobsTable_when_jobs_then_renders_rows', () => {
    render(wrap(<RecentJobsTable jobs={[baseJob]} />));
    expect(screen.getByText(/#42/)).toBeInTheDocument();
  });

  it('test_RecentJobsTable_when_no_jobs_then_shows_empty_state', () => {
    render(wrap(<RecentJobsTable jobs={[]} />));
    expect(screen.getByText(en.queue.recent.empty.headline)).toBeInTheDocument();
  });

  it('test_RecentJobsTable_when_row_clicked_then_onRowClick_called_with_job', () => {
    const onRowClick = vi.fn();
    render(wrap(<RecentJobsTable jobs={[baseJob]} onRowClick={onRowClick} />));
    const row = screen.getByRole('button', { name: /#42/ });
    fireEvent.click(row);
    expect(onRowClick).toHaveBeenCalledWith(baseJob, expect.any(HTMLElement));
  });

  it('test_RecentJobsTable_when_sort_header_clicked_then_onSort_called', () => {
    const onSort = vi.fn();
    render(wrap(<RecentJobsTable jobs={[baseJob]} onSort={onSort} />));
    const durationBtn = screen.getByRole('button', {
      name: new RegExp(en.queue.recent.column.duration, 'i'),
    });
    fireEvent.click(durationBtn);
    expect(onSort).toHaveBeenCalledWith('duration');
  });

  it('test_RecentJobsTable_when_sort_finished_desc_then_aria_sort_descending', () => {
    const { container } = render(
      wrap(<RecentJobsTable jobs={[baseJob]} sort="finished" dir="desc" />),
    );
    const ths = Array.from(container.querySelectorAll('th[aria-sort="descending"]'));
    expect(ths.length).toBeGreaterThan(0);
  });
});

describe('RecentJobsTable — savings formatting', () => {
  it('test_RecentJobsTable_when_positive_savings_then_green_plus', () => {
    // bytes_in=1GB, bytes_out=500MB → +50%
    render(wrap(<RecentJobsTable jobs={[baseJob]} />));
    expect(screen.getByText(/\+50\.0%/)).toBeInTheDocument();
  });

  it('test_RecentJobsTable_when_negative_savings_then_red_minus', () => {
    const biggerJob: JobRow = { ...baseJob, bytes_out: 1_500_000_000 };
    render(wrap(<RecentJobsTable jobs={[biggerJob]} />));
    expect(screen.getByText(/-50\.0%/)).toBeInTheDocument();
  });

  it('test_RecentJobsTable_when_bytes_null_then_dash', () => {
    const nullJob: JobRow = { ...baseJob, bytes_in: null, bytes_out: null };
    render(wrap(<RecentJobsTable jobs={[nullJob]} />));
    // There will be multiple — (duration and bytes), so just verify at least one
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});

describe('RecentJobsCardList', () => {
  it('test_RecentJobsCardList_when_jobs_then_renders_cards', () => {
    render(wrap(<RecentJobsCardList jobs={[baseJob]} />));
    expect(screen.getByText(/#42/)).toBeInTheDocument();
  });

  it('test_RecentJobsCardList_when_card_clicked_then_onCardClick_called', () => {
    const onCardClick = vi.fn();
    render(wrap(<RecentJobsCardList jobs={[baseJob]} onCardClick={onCardClick} />));
    const card = screen.getByRole('button', { name: /#42/ });
    fireEvent.click(card);
    expect(onCardClick).toHaveBeenCalledWith(baseJob, expect.any(HTMLElement));
  });
});

describe('JobStatusChip — all 6 statuses', () => {
  const statuses: JobStatus[] = [
    'queued',
    'encoding',
    'done',
    'failed',
    'cancelled',
    'interrupted',
  ];

  for (const status of statuses) {
    it(`test_JobStatusChip_when_${status}_then_renders_chip`, () => {
      render(wrap(<JobStatusChip status={status} label={status} />));
      const chip = screen.getByText(status);
      expect(chip).toBeInTheDocument();
      expect(chip.closest('[data-job-status]')?.getAttribute('data-job-status')).toBe(status);
    });
  }
});
