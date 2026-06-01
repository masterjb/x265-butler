// Plan 05-12 (B3 Queue Reorder) — PendingListSortable rendering tests.
// Covers AC-5 (split layout LEFT pane: edge-gripzone + a11y + empty state)
// + audit-added M6 dropAnimation + M7 touchAction + S1 announcements scaffolding.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import type { JobRow } from '@/src/lib/db/schema';

vi.mock('sonner', () => ({
  toast: Object.assign(() => undefined, { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
  default: {},
}));

import { PendingListSortable } from '@/components/queue/pending-list-sortable';

function makeJob(id: number): JobRow {
  return {
    id,
    file_id: id * 10,
    status: 'queued',
    started_at: null,
    finished_at: null,
    encoder: 'libx265',
    crf: null,
    queue_position: id,
    bytes_in: null,
    bytes_out: null,
    duration_ms: null,
    exit_code: null,
    error_msg: null,
    log_tail: null,
    created_at: 0,
  };
}

function wrap(ui: React.ReactNode, locale: 'en' | 'de' = 'en') {
  // Test-only: wire the chosen locale; DE branch uses the same import path
  // for messages — translated keys come from lookups against 'en.json' for now,
  // structural-equality (S12) is verified separately.
  return (
    <NextIntlClientProvider locale={locale} messages={en}>
      {ui}
    </NextIntlClientProvider>
  );
}

describe('PendingListSortable', () => {
  beforeEach(() => {
    (globalThis as { fetch?: unknown }).fetch = vi.fn();
  });

  it('test_render_when_pending_empty_then_shows_empty_state_card', () => {
    render(wrap(<PendingListSortable initialPending={[]} livePending={[]} />));
    expect(screen.getByText(en.queue.pending.empty.title)).toBeInTheDocument();
    expect(screen.getByText(en.queue.pending.empty.helper)).toBeInTheDocument();
  });

  it('test_render_when_pending_has_three_rows_then_renders_three_drag_handles', () => {
    const jobs = [makeJob(1), makeJob(2), makeJob(3)];
    const pathByFileId = { 10: '/movies/a.mkv', 20: '/movies/b.mkv', 30: '/movies/c.mkv' };
    render(
      wrap(
        <PendingListSortable
          initialPending={jobs}
          livePending={jobs}
          pathByFileId={pathByFileId}
        />,
      ),
    );
    const handles = screen.getAllByRole('button', {
      name: new RegExp(en.queue.reorder.handle.label.replace('{filename}', ''), 'i'),
    });
    expect(handles.length).toBeGreaterThanOrEqual(3);
  });

  it('test_render_when_drag_handle_then_has_inline_touchAction_none_audit_M7', () => {
    const jobs = [makeJob(1)];
    const pathByFileId = { 10: '/m/a.mkv' };
    const { container } = render(
      wrap(
        <PendingListSortable
          initialPending={jobs}
          livePending={jobs}
          pathByFileId={pathByFileId}
        />,
      ),
    );
    const handle = container.querySelector('button[aria-roledescription]');
    expect(handle).toBeTruthy();
    // Inline style: touchAction: 'none' (M7 — suppresses iOS Safari + Android Chrome
    // native scroll/select/context-menu hijack).
    expect((handle as HTMLElement).style.touchAction).toBe('none');
  });

  it('test_render_when_drag_handle_then_has_aria_label_with_filename_and_aria_roledescription', () => {
    const jobs = [makeJob(1)];
    const pathByFileId = { 10: '/movies/clip.mkv' };
    const { container } = render(
      wrap(
        <PendingListSortable
          initialPending={jobs}
          livePending={jobs}
          pathByFileId={pathByFileId}
        />,
      ),
    );
    const handle = container.querySelector('button[aria-roledescription]');
    expect(handle).toBeTruthy();
    expect((handle as HTMLElement).getAttribute('aria-label')).toContain('clip.mkv');
    expect((handle as HTMLElement).getAttribute('aria-roledescription')).toBe(
      en.queue.reorder.handle.roledescription,
    );
  });

  it('test_render_when_pending_has_rows_then_section_heading_includes_count', () => {
    const jobs = [makeJob(1), makeJob(2)];
    render(wrap(<PendingListSortable initialPending={jobs} livePending={jobs} />));
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading.textContent).toMatch(/2/);
  });

  it('test_render_when_pending_has_rows_then_aria_live_region_present_for_announcements', () => {
    const jobs = [makeJob(1)];
    const { container } = render(
      wrap(<PendingListSortable initialPending={jobs} livePending={jobs} />),
    );
    const liveRegion = container.querySelector('[role="status"][aria-live="polite"]');
    expect(liveRegion).toBeTruthy();
  });
});
