import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EncodeNowAction, ELIGIBLE_STATES } from '@/components/library/encode-now-action';
import type { FileRow, FileStatus } from '@/src/lib/db/schema';
import { wrap } from './test-utils';
import en from '@/messages/en.json';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const baseRow: FileRow = {
  id: 5,
  path: '/media/movie.mkv',
  size_bytes: 2 * 1024 ** 3,
  mtime: 1_700_000_000,
  content_hash: 'b'.repeat(64),
  codec: 'h264',
  bitrate: 8_000_000,
  duration_seconds: 5400,
  width: 1920,
  height: 1080,
  container: 'mkv',
  status: 'pending',
  last_scanned_at: 1_700_000_000,
  created_at: 1_700_000_000,
  updated_at: 1_700_000_000,
  version: 0,
  container_override: null,
  share_id: null,
};

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  (globalThis as { fetch?: unknown }).fetch = mockFetch;
});

const NON_ELIGIBLE: FileStatus[] = [
  'queued',
  'encoding',
  'done-smaller',
  'skipped-codec',
  'blocklisted',
];

describe('EncodeNowAction — visibility', () => {
  it('test_EncodeNowAction_when_eligible_status_then_renders_button', () => {
    for (const status of ELIGIBLE_STATES) {
      const { unmount } = render(wrap(<EncodeNowAction file={{ ...baseRow, status }} />));
      expect(
        screen.getByRole('button', { name: new RegExp(en.library.encodeNow.button, 'i') }),
      ).toBeInTheDocument();
      unmount();
    }
  });

  it('test_EncodeNowAction_when_non_eligible_status_then_renders_nothing', () => {
    for (const status of NON_ELIGIBLE) {
      const { container, unmount } = render(
        wrap(<EncodeNowAction file={{ ...baseRow, status }} />),
      );
      expect(container.querySelector('button')).toBeNull();
      unmount();
    }
  });
});

describe('EncodeNowAction — harmonized size + primary treatment (27-02)', () => {
  it('test_EncodeNowAction_when_rendered_then_h11_no_h7_no_h8_leak', () => {
    // AC-1: equal height to ConfirmButton siblings (h-11/44px); NO h-7 (removed
    // size="sm") and NO h-8 (cva default-size leak). h-8 is the LIVE guard.
    render(wrap(<EncodeNowAction file={baseRow} />));
    const button = screen.getByRole('button', {
      name: new RegExp(en.library.encodeNow.button, 'i'),
    });
    expect(button.className).toMatch(/\bh-11\b/);
    expect(button.className).not.toMatch(/\bh-7\b/);
    expect(button.className).not.toMatch(/\bh-8\b/);
  });

  it('test_EncodeNowAction_when_rendered_then_filled_primary_not_outline', () => {
    // AC-2: filled/primary variant (bg-primary), NOT the outline variant.
    render(wrap(<EncodeNowAction file={baseRow} />));
    const button = screen.getByRole('button', {
      name: new RegExp(en.library.encodeNow.button, 'i'),
    });
    expect(button.className).toMatch(/bg-primary/);
    expect(button.className).not.toMatch(/border-border/);
    expect(button.className).not.toMatch(/bg-background/);
  });

  it('test_EncodeNowAction_when_rendered_then_gap2_spacing_parity_no_ml', () => {
    // AC-6: intra-button spacing = gap-2 (NOT gap-1.5 cva leak); label span has
    // no ml-1.5 → parity with ConfirmButton siblings.
    render(wrap(<EncodeNowAction file={baseRow} />));
    const button = screen.getByRole('button', {
      name: new RegExp(en.library.encodeNow.button, 'i'),
    });
    expect(button.className).toMatch(/\bgap-2\b/);
    expect(button.className).not.toMatch(/\bgap-1\.5\b/);
    const label = button.querySelector('span');
    expect(label?.className ?? '').not.toMatch(/\bml-1\.5\b/);
  });
});

describe('EncodeNowAction — click behaviour', () => {
  it('test_EncodeNowAction_when_clicked_then_POST_api_queue_with_fileId', async () => {
    mockFetch.mockResolvedValue({ status: 201, json: vi.fn() });
    const user = userEvent.setup();
    render(wrap(<EncodeNowAction file={baseRow} />));
    await user.click(
      screen.getByRole('button', { name: new RegExp(en.library.encodeNow.button, 'i') }),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/queue',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ fileId: baseRow.id }),
      }),
    );
  });

  it('test_EncodeNowAction_when_clicked_then_optimistic_override_to_queued', async () => {
    mockFetch.mockResolvedValue({ status: 201, json: vi.fn() });
    const onOverride = vi.fn();
    const user = userEvent.setup();
    render(wrap(<EncodeNowAction file={baseRow} onOptimisticOverride={onOverride} />));
    await user.click(
      screen.getByRole('button', { name: new RegExp(en.library.encodeNow.button, 'i') }),
    );
    // First call must be the optimistic 'queued' override (before await fetch).
    expect(onOverride).toHaveBeenCalledWith(baseRow.id, 'queued');
  });

  it('test_EncodeNowAction_when_201_then_keeps_optimistic_override', async () => {
    mockFetch.mockResolvedValue({ status: 201, json: vi.fn() });
    const onOverride = vi.fn();
    const user = userEvent.setup();
    render(wrap(<EncodeNowAction file={baseRow} onOptimisticOverride={onOverride} />));
    await user.click(
      screen.getByRole('button', { name: new RegExp(en.library.encodeNow.button, 'i') }),
    );
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    // No revert call (null) after success.
    const revertCall = onOverride.mock.calls.find(([, s]) => s === null);
    expect(revertCall).toBeUndefined();
  });

  it('test_EncodeNowAction_when_409_already_queued_then_reverts_optimistic_override', async () => {
    mockFetch.mockResolvedValue({
      status: 409,
      json: vi.fn().mockResolvedValue({ error: 'already_queued' }),
    });
    const onOverride = vi.fn();
    const user = userEvent.setup();
    render(wrap(<EncodeNowAction file={baseRow} onOptimisticOverride={onOverride} />));
    await user.click(
      screen.getByRole('button', { name: new RegExp(en.library.encodeNow.button, 'i') }),
    );
    await waitFor(() => expect(onOverride).toHaveBeenCalledWith(baseRow.id, null));
  });

  it('test_EncodeNowAction_when_409_status_changed_then_reverts_optimistic_override', async () => {
    mockFetch.mockResolvedValue({
      status: 409,
      json: vi.fn().mockResolvedValue({ error: 'status_changed' }),
    });
    const onOverride = vi.fn();
    const user = userEvent.setup();
    render(wrap(<EncodeNowAction file={baseRow} onOptimisticOverride={onOverride} />));
    await user.click(
      screen.getByRole('button', { name: new RegExp(en.library.encodeNow.button, 'i') }),
    );
    await waitFor(() => expect(onOverride).toHaveBeenCalledWith(baseRow.id, null));
  });

  it('test_EncodeNowAction_when_5xx_then_reverts_optimistic_override', async () => {
    mockFetch.mockResolvedValue({ status: 500, json: vi.fn() });
    const onOverride = vi.fn();
    const user = userEvent.setup();
    render(wrap(<EncodeNowAction file={baseRow} onOptimisticOverride={onOverride} />));
    await user.click(
      screen.getByRole('button', { name: new RegExp(en.library.encodeNow.button, 'i') }),
    );
    await waitFor(() => expect(onOverride).toHaveBeenCalledWith(baseRow.id, null));
  });

  it('test_EncodeNowAction_when_fetch_throws_then_reverts_optimistic_override', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));
    const onOverride = vi.fn();
    const user = userEvent.setup();
    render(wrap(<EncodeNowAction file={baseRow} onOptimisticOverride={onOverride} />));
    await user.click(
      screen.getByRole('button', { name: new RegExp(en.library.encodeNow.button, 'i') }),
    );
    await waitFor(() => expect(onOverride).toHaveBeenCalledWith(baseRow.id, null));
  });
});
