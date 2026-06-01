// 05-10 B2: RecentJobsCardList renders filename + parent path with truncate-tooltip.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RecentJobsCardList } from '@/components/queue/recent-jobs-card-list';
import { wrap } from '../test-utils';
import type { JobRow } from '@/src/lib/db/schema';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

function jobFix(over: Partial<JobRow> = {}): JobRow {
  return {
    id: 7,
    file_id: 42,
    status: 'done',
    started_at: 100,
    finished_at: 200,
    encoder: 'libx265',
    bytes_in: 1_000_000,
    bytes_out: 500_000,
    duration_ms: 60_000,
    exit_code: 0,
    error_msg: null,
    log_tail: null,
    created_at: 0,
    crf: null,
    queue_position: 0,
    ...over,
  };
}

describe('RecentJobsCardList — B2 filename + path', () => {
  it('renders filename + parent path with title-tooltip when path resolves', () => {
    render(
      wrap(
        <RecentJobsCardList
          jobs={[jobFix({ file_id: 42 })]}
          pathByFileId={{ 42: '/movies/foo/bar.mkv' }}
        />,
      ),
    );
    const filename = screen.getByText('bar.mkv');
    expect(filename).toBeInTheDocument();
    expect(filename.getAttribute('title')).toBe('/movies/foo/bar.mkv');
    expect(filename.className).toMatch(/truncate/);

    const parent = screen.getByText('/movies/foo');
    expect(parent).toBeInTheDocument();
    expect(parent.getAttribute('title')).toBe('/movies/foo/bar.mkv');
    expect(parent.className).toMatch(/font-mono/);
    expect(parent.className).toMatch(/truncate/);
  });

  it('falls back to #file_id when path lookup misses', () => {
    render(wrap(<RecentJobsCardList jobs={[jobFix({ file_id: 99 })]} pathByFileId={{}} />));
    expect(screen.getByText('#99')).toBeInTheDocument();
  });

  it('shows i18n root label when parent is empty', () => {
    render(
      wrap(<RecentJobsCardList jobs={[jobFix({ file_id: 7 })]} pathByFileId={{ 7: '/top.mkv' }} />),
    );
    expect(screen.getByText('top.mkv')).toBeInTheDocument();
    expect(screen.getByText('(root)')).toBeInTheDocument();
  });
});
