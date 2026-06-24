// Phase 21 Plan 21-02 T3 Step 3 — EncoderReplayRunner tests (AC-6 + audit-M4 FLAT shape).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { wrap } from '../../test-utils';
import { EncoderReplayRunner } from '@/components/diagnostics/encoder-replay-runner';
import type { DiagnosticsPayload } from '@/src/lib/diagnostics/types';
import {
  EMPTY_BLOCKLIST_BLOCK_22_00,
  EMPTY_SLOW_REQUESTS_BLOCK_22_01,
  EMPTY_SLOW_QUERIES_BLOCK_22_01,
  EMPTY_CPU_ATTRIBUTION_BLOCK_40_01,
  EMPTY_WEB_VITALS_BLOCK_22_01,
  NULL_CONTAINER_IMAGE_BLOCK_22_00,
  NULL_CPU_BLOCK_23_05,
  DEFAULT_CACHE_BLOCK_24_03,
} from '@/tests/diagnostics/fixtures/empty-blocks-22-00';

const { mockToast } = vi.hoisted(() => ({
  mockToast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: mockToast }));

function payloadWithEncoders(detected: string[]): DiagnosticsPayload {
  return {
    app: { version: '2.17.3', gitHash: 'a', committedAt: null, committedAtCET: null },
    runtime: { nodeVersion: 'v20', platform: 'linux', arch: 'x64', uptimeSec: 1, pid: 1 },
    mounts: [],
    devices: { dri: [], nvidia: [], renderDevices: [] },
    encoders: { detected, warnings: [], outcome: [] },
    warnings: [],
    recentErrors: [],
    onboarding: { completed: true, hasShare: true },
    cache: DEFAULT_CACHE_BLOCK_24_03,
    cpu: NULL_CPU_BLOCK_23_05,
    blocklist: EMPTY_BLOCKLIST_BLOCK_22_00,
    containerImage: NULL_CONTAINER_IMAGE_BLOCK_22_00,
    slowRequests: EMPTY_SLOW_REQUESTS_BLOCK_22_01,
    slowQueries: EMPTY_SLOW_QUERIES_BLOCK_22_01,
    cpuAttribution: EMPTY_CPU_ATTRIBUTION_BLOCK_40_01,
    webVitals: EMPTY_WEB_VITALS_BLOCK_22_01,
    generatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('EncoderReplayRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockToast.error.mockReset();
    mockToast.success.mockReset();
  });

  it('click → POST /api/encoders/refresh + spinner', async () => {
    let resolveFetch: (v: Response) => void = () => undefined;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => new Promise<Response>((r) => (resolveFetch = r)));
    const initial = payloadWithEncoders(['libx265']);
    render(wrap(<EncoderReplayRunner initialPayload={initial} onPayload={vi.fn()} />));
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByRole('button')).toBeDisabled());
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/encoders/refresh',
      expect.objectContaining({ method: 'POST' }),
    );
    resolveFetch(jsonResponse({ refreshed: true, detected: ['libx265'], active: 'libx265' }));
  });

  it('no-change response shows toast "Detection unchanged"', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ refreshed: true, detected: ['libx265'], active: 'libx265' }),
    );
    const initial = payloadWithEncoders(['libx265']);
    render(wrap(<EncoderReplayRunner initialPayload={initial} onPayload={vi.fn()} />));
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(mockToast.success).toHaveBeenCalled());
  });

  it('with-change response renders unified-diff with +/- prefixes', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('/api/encoders/refresh')) {
        return jsonResponse({
          refreshed: true,
          detected: ['libx265', 'nvenc'],
          active: 'nvenc',
        });
      }
      // /api/diagnostics refresh after diff
      return jsonResponse(payloadWithEncoders(['libx265', 'nvenc']));
    });
    const initial = payloadWithEncoders(['libx265']);
    render(wrap(<EncoderReplayRunner initialPayload={initial} onPayload={vi.fn()} />));
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getAllByText(/nvenc/).length).toBeGreaterThan(0));
    expect(screen.getAllByText('+').length).toBeGreaterThan(0);
  });

  it('POSTs FLAT log-event payload {added, removed, activeFromAutoChanged} (audit-M4)', async () => {
    const captured: Array<{ url: string; body: unknown }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/api/encoders/refresh')) {
        return jsonResponse({
          refreshed: true,
          detected: ['libx265', 'nvenc'],
          active: 'nvenc',
        });
      }
      if (url.includes('/api/diagnostics/log-event')) {
        captured.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        return new Response(null, { status: 204 });
      }
      return jsonResponse(payloadWithEncoders(['libx265', 'nvenc']));
    });
    const initial = payloadWithEncoders(['libx265']);
    render(wrap(<EncoderReplayRunner initialPayload={initial} onPayload={vi.fn()} />));
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(captured.length).toBeGreaterThan(0));
    const body = captured[0]!.body as {
      event: string;
      payload: { added: string[]; removed: string[]; activeFromAutoChanged: boolean };
    };
    expect(body.event).toBe('encoderReplayTriggered');
    expect(body.payload.added).toEqual(['nvenc']);
    expect(body.payload.removed).toEqual([]);
    expect(typeof body.payload.activeFromAutoChanged).toBe('boolean');
    // FLAT shape — must NOT contain nested `diff` wrapper.
    expect((body.payload as Record<string, unknown>).diff).toBeUndefined();
  });

  it('HTTP error → toast.error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ error: 'x' }, 500));
    const initial = payloadWithEncoders(['libx265']);
    render(wrap(<EncoderReplayRunner initialPayload={initial} onPayload={vi.fn()} />));
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(mockToast.error).toHaveBeenCalled());
  });
});
