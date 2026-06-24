// Phase 21 Plan 21-02 T3 Step 5 — RefreshButton tests (AC-3).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { wrap } from '../../test-utils';
import { RefreshButton } from '@/components/diagnostics/refresh-button';
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

function fixture(): DiagnosticsPayload {
  return {
    app: { version: '2.17.3', gitHash: 'abc', committedAt: null, committedAtCET: null },
    runtime: { nodeVersion: 'v20', platform: 'linux', arch: 'x64', uptimeSec: 1, pid: 1 },
    mounts: [],
    devices: { dri: [], nvidia: [], renderDevices: [] },
    encoders: { detected: ['libx265'], warnings: [], outcome: [] },
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

describe('RefreshButton', () => {
  beforeEach(() => {
    mockToast.error.mockReset();
    vi.clearAllMocks();
  });

  it('click → fetch /api/diagnostics + setState called', async () => {
    const next = fixture();
    next.app.version = '2.99.99';
    const onPayload = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(next), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    render(wrap(<RefreshButton onPayload={onPayload} />));
    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(onPayload).toHaveBeenCalledTimes(1));
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/diagnostics',
      expect.objectContaining({ cache: 'no-store' }),
    );
    expect(onPayload.mock.calls[0]![0]).toMatchObject({ app: { version: '2.99.99' } });
  });

  it('aria-busy + disabled during in-flight', async () => {
    let resolveFetch: (v: Response) => void = () => undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => new Promise<Response>((r) => (resolveFetch = r)),
    );
    render(wrap(<RefreshButton onPayload={vi.fn()} />));
    const btn = screen.getByRole('button');
    fireEvent.click(btn);
    await waitFor(() => expect(btn).toBeDisabled());
    expect(btn.getAttribute('aria-busy')).toBe('true');
    resolveFetch(new Response(JSON.stringify(fixture()), { status: 200 }));
  });

  it('HTTP error → sonner toast.error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
    render(wrap(<RefreshButton onPayload={vi.fn()} />));
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(mockToast.error).toHaveBeenCalled());
  });
});
