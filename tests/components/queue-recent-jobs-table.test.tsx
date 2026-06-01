// 05-10 B2: RecentJobsTable renders filename + parent path with truncate-tooltip.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RecentJobsTable } from '@/components/queue/recent-jobs-table';
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

describe('RecentJobsTable — B2 filename + path', () => {
  it('renders filename + parent path with title-tooltip when path resolves', () => {
    const job = jobFix({ file_id: 42 });
    render(wrap(<RecentJobsTable jobs={[job]} pathByFileId={{ 42: '/movies/foo/bar.mkv' }} />));
    const filename = screen.getByText('bar.mkv');
    expect(filename).toBeInTheDocument();
    expect(filename.getAttribute('title')).toBe('/movies/foo/bar.mkv');
    expect(filename.className).toMatch(/truncate/);

    const parent = screen.getByText('/movies/foo');
    expect(parent).toBeInTheDocument();
    expect(parent.getAttribute('title')).toBe('/movies/foo/bar.mkv');
    expect(parent.className).toMatch(/truncate/);
    expect(parent.className).toMatch(/font-mono/);
  });

  it('falls back to #file_id when path lookup misses (e.g. SSE-pushed row)', () => {
    const job = jobFix({ file_id: 99 });
    render(wrap(<RecentJobsTable jobs={[job]} pathByFileId={{}} />));
    const fallback = screen.getByText('#99');
    expect(fallback).toBeInTheDocument();
    expect(fallback.className).toMatch(/font-mono/);
  });

  it('shows i18n root label when parent is empty', () => {
    const job = jobFix({ file_id: 7 });
    render(wrap(<RecentJobsTable jobs={[job]} pathByFileId={{ 7: '/top.mkv' }} />));
    expect(screen.getByText('top.mkv')).toBeInTheDocument();
    expect(screen.getByText('(root)')).toBeInTheDocument();
  });

  it('preserves Skip cell from 05-09 when row is queued', () => {
    const job = jobFix({ status: 'queued', file_id: 5 });
    render(wrap(<RecentJobsTable jobs={[job]} pathByFileId={{ 5: '/scan/movie.mkv' }} />));
    // SkipRowAction renders ≥1 button matching /skip/i (trigger + possibly an
    // AlertDialog action). Just assert presence — count not the contract here.
    const skipButtons = screen.getAllByRole('button', { name: /skip/i });
    expect(skipButtons.length).toBeGreaterThan(0);
    expect(screen.getByText('movie.mkv')).toBeInTheDocument();
  });
});
