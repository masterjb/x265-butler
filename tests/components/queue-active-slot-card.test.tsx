// 05-10 B2 → 36-02: compact multi-row panel. ActiveJobsPanel renders one row
// per concurrent encode; ActiveSlotCard stays as the single-job wrapper.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import {
  ActiveSlotCard,
  ActiveJobsPanel,
  type ActiveJobMeta,
} from '@/components/queue/active-slot-card';
import { wrap } from '../test-utils';
import type { ActiveJob } from '@/src/lib/api/engine-events-client';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

function activeJobFix(over: Partial<ActiveJob> = {}): ActiveJob {
  return {
    jobId: 1,
    fileId: 42,
    outTimeMs: 30_000,
    fps: 60,
    totalSize: 500_000,
    encoder: 'libx265',
    ...over,
  };
}

function metaFix(over: Partial<ActiveJobMeta> = {}): ActiveJobMeta {
  return { path: null, durationSeconds: null, sizeBytes: null, ...over };
}

describe('ActiveJobsPanel — multi-row (36-02 D1=B)', () => {
  it('renders idle MoonStar state when zero jobs', () => {
    render(wrap(<ActiveJobsPanel jobs={[]} metaById={{}} />));
    // Idle headline from queue.active.idleHeadline.
    expect(screen.getByText('Encoder idle')).toBeInTheDocument();
    // No progressbar in idle.
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('renders TWO rows each with its own progressbar + Skip group (AC-1, AC-4)', () => {
    const jobs = [
      activeJobFix({ jobId: 10, fileId: 1, outTimeMs: 30_000, fps: 24 }),
      activeJobFix({ jobId: 11, fileId: 2, outTimeMs: 60_000, fps: 30, encoder: 'qsv' }),
    ];
    const metaById: Record<number, ActiveJobMeta> = {
      1: metaFix({ path: '/movies/a.mkv', durationSeconds: 120 }),
      2: metaFix({ path: '/movies/b.mkv', durationSeconds: 120 }),
    };
    render(wrap(<ActiveJobsPanel jobs={jobs} metaById={metaById} />));

    // "Active (2)" header.
    expect(screen.getByText('Active (2)')).toBeInTheDocument();

    // Two independent progressbars.
    const bars = screen.getAllByRole('progressbar');
    expect(bars).toHaveLength(2);
    // 30000ms / (120s*1000) = 25%, 60000 / 120000 = 50%.
    expect(bars[0].getAttribute('aria-valuenow')).toBe('25');
    expect(bars[1].getAttribute('aria-valuenow')).toBe('50');

    // Two per-job Skip groups, named for each file (AC-4).
    expect(screen.getByRole('group', { name: 'Skip a.mkv' })).toBeInTheDocument();
    const bGroup = screen.getByRole('group', { name: 'Skip b.mkv' });
    expect(within(bGroup).getByRole('button')).toBeInTheDocument();

    // Both filenames render.
    expect(screen.getByText('a.mkv')).toBeInTheDocument();
    expect(screen.getByText('b.mkv')).toBeInTheDocument();
  });

  it('shows tabular-nums metric line with pct · fps, "—" when unknown', () => {
    const jobs = [
      activeJobFix({ jobId: 10, fileId: 1, outTimeMs: null, fps: null, encoder: null }),
    ];
    render(wrap(<ActiveJobsPanel jobs={jobs} metaById={{ 1: metaFix() }} />));
    // pct unknown (no outTimeMs/duration) + fps unknown → "— · — fps".
    const metric = screen.getByText('— · — fps');
    expect(metric.className).toMatch(/tabular-nums/);
  });

  it('indeterminate progressbar uses motion-safe pulse (AC-9 reduced-motion)', () => {
    const jobs = [activeJobFix({ jobId: 10, fileId: 1, outTimeMs: null })];
    const { container } = render(wrap(<ActiveJobsPanel jobs={jobs} metaById={{ 1: metaFix() }} />));
    expect(container.innerHTML).toContain('motion-safe:animate-pulse');
  });

  it('row falls back to #jobId when no filePath', () => {
    const jobs = [activeJobFix({ jobId: 77, fileId: 9 })];
    render(wrap(<ActiveJobsPanel jobs={jobs} metaById={{}} />));
    const fallback = screen.getByText('#77');
    expect(fallback.className).toMatch(/font-mono/);
    // Skip group named by #jobId fallback.
    expect(screen.getByRole('group', { name: 'Skip #77' })).toBeInTheDocument();
  });
});

describe('ActiveSlotCard — single-job wrapper (dashboard / back-compat)', () => {
  it('renders idle state when activeJob is null', () => {
    render(wrap(<ActiveSlotCard activeJob={null} />));
    expect(screen.getByText('Encoder idle')).toBeInTheDocument();
    expect(screen.queryByText('bar.mkv')).toBeNull();
  });

  it('renders filename + parent path when filePath provided', () => {
    render(
      wrap(
        <ActiveSlotCard
          activeJob={activeJobFix()}
          filePath="/movies/foo/bar.mkv"
          fileDurationSeconds={120}
        />,
      ),
    );
    const filename = screen.getByText('bar.mkv');
    expect(filename).toBeInTheDocument();
    expect(filename.getAttribute('title')).toBe('/movies/foo/bar.mkv');
    expect(filename.className).toMatch(/truncate/);

    const parent = screen.getByText('/movies/foo');
    expect(parent).toBeInTheDocument();
    expect(parent.className).toMatch(/font-mono/);
  });

  it('falls back to #jobId when filePath null', () => {
    render(wrap(<ActiveSlotCard activeJob={activeJobFix({ jobId: 99 })} filePath={null} />));
    const match = screen.getByText('#99');
    expect(match.className).toMatch(/text-sm/);
  });

  it('shows root label when parent is empty', () => {
    render(
      wrap(
        <ActiveSlotCard
          activeJob={activeJobFix()}
          filePath="/top.mkv"
          fileDurationSeconds={null}
        />,
      ),
    );
    expect(screen.getByText('top.mkv')).toBeInTheDocument();
    expect(screen.getByText('(root)')).toBeInTheDocument();
  });
});
