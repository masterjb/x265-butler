// 05-09: ActiveSlotCard — Skip replaces 05-08 2-step Cancel. Pause concept
// retired entirely; idle state renders the muted "Encoder idle" copy without
// the prior "Queue stopped" branch.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ActiveSlotCard } from '@/components/queue/active-slot-card';
import { wrap } from './test-utils';
import en from '@/messages/en.json';
import type { ActiveJob } from '@/src/lib/api/engine-events-client';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

beforeEach(() => {
  (globalThis as { fetch?: unknown }).fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue({ activeJobs: 0 }),
  });
});

const activeJob: ActiveJob = {
  jobId: 7,
  fileId: 3,
  outTimeMs: null,
  fps: null,
  totalSize: null,
  speed: null,
  encoder: 'libx265',
};

describe('ActiveSlotCard — idle state', () => {
  it('test_ActiveSlotCard_when_no_activeJob_then_renders_idle_headline', () => {
    render(wrap(<ActiveSlotCard activeJob={null} />));
    expect(screen.getByText(en.queue.active.idleHeadline)).toBeInTheDocument();
  });

  it('test_ActiveSlotCard_when_no_activeJob_then_no_skip_button', () => {
    render(wrap(<ActiveSlotCard activeJob={null} />));
    expect(screen.queryByRole('button', { name: en.queue.skip.button })).toBeNull();
  });
});

describe('ActiveSlotCard — active state', () => {
  it('test_ActiveSlotCard_when_activeJob_then_renders_skip_button', () => {
    render(wrap(<ActiveSlotCard activeJob={activeJob} />));
    expect(
      screen.getByRole('button', { name: new RegExp(en.queue.skip.button, 'i') }),
    ).toBeInTheDocument();
  });

  it('test_ActiveSlotCard_when_activeJob_then_no_paused_branch_renders', () => {
    render(wrap(<ActiveSlotCard activeJob={activeJob} />));
    // 05-09 AC-7: stopped/paused banner is gone; only the active card renders.
    expect(screen.queryByText('Queue is stopped')).toBeNull();
  });

  it('test_ActiveSlotCard_when_activeJob_with_file_path_then_shows_filename_and_parent', () => {
    // 05-10 B2: filePath now splits into filename (top) + parent path (muted).
    // Both spans carry title=fullPath for the truncate-tooltip contract.
    render(wrap(<ActiveSlotCard activeJob={activeJob} filePath="/media/test.mkv" />));
    expect(screen.getByText('test.mkv')).toBeInTheDocument();
    expect(screen.getByText('/media')).toBeInTheDocument();
  });

  it('test_ActiveSlotCard_when_activeJob_then_encoder_badge_visible', () => {
    render(wrap(<ActiveSlotCard activeJob={activeJob} />));
    expect(screen.getByText(/libx265/)).toBeInTheDocument();
  });
});
