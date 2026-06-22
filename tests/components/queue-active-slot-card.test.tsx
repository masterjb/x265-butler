// 05-10 B2: ActiveSlotCard splits filePath into filename + parent path.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ActiveSlotCard } from '@/components/queue/active-slot-card';
import { wrap } from '../test-utils';
import type { ActiveJob } from '@/src/lib/api/engine-events-client';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
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

describe('ActiveSlotCard — B2 filename + path split', () => {
  it('renders idle state when activeJob is null', () => {
    render(wrap(<ActiveSlotCard activeJob={null} />));
    // idleHelper / idleHeadline localized — just assert idle MoonStar markup absent of filename
    expect(screen.queryByText('bar.mkv')).toBeNull();
  });

  it('renders filename + parent path when filePath provided', () => {
    render(
      wrap(
        <ActiveSlotCard
          activeJob={activeJobFix()}
          filePath="/movies/foo/bar.mkv"
          fileDurationSeconds={120}
          fileSizeBytes={1_000_000}
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
    // Header fallback + footer jobIdBadge both render '#99' — assert the
    // header span exists (font-mono text-sm class on the fallback span).
    const matches = screen.getAllByText('#99');
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches.some((el) => el.className.includes('text-sm'))).toBe(true);
  });

  it('shows root label when parent is empty', () => {
    render(
      wrap(
        <ActiveSlotCard
          activeJob={activeJobFix()}
          filePath="/top.mkv"
          fileDurationSeconds={null}
          fileSizeBytes={null}
        />,
      ),
    );
    expect(screen.getByText('top.mkv')).toBeInTheDocument();
    expect(screen.getByText('(root)')).toBeInTheDocument();
  });
});
