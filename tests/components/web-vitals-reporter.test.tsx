// @vitest-environment jsdom
// 22-01 T4 IMP-4: WebVitalsReporter component tests.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';

const { mockUsePathname, mockFetch } = vi.hoisted(() => ({
  mockUsePathname: vi.fn(() => '/library'),
  mockFetch: vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(),
}));

vi.mock('next/navigation', () => ({ usePathname: mockUsePathname }));

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
  mockUsePathname.mockReturnValue('/library');
  global.fetch = mockFetch as unknown as typeof fetch;
  // PerformanceObserver stub: stores callback so test can fire entries.
  class FakeObserver {
    callback: (list: { getEntries: () => unknown[] }) => void;
    constructor(cb: (list: { getEntries: () => unknown[] }) => void) {
      this.callback = cb;
    }
    observe(): void {
      /* no-op */
    }
    disconnect(): void {
      /* no-op */
    }
  }
  (global as unknown as { PerformanceObserver: typeof PerformanceObserver }).PerformanceObserver =
    FakeObserver as unknown as typeof PerformanceObserver;

  // Navigation Timing stub: responseStart=180ms for TTFB.
  Object.defineProperty(performance, 'getEntriesByType', {
    configurable: true,
    value: vi.fn((type: string) =>
      type === 'navigation' ? [{ responseStart: 180 } as PerformanceNavigationTiming] : [],
    ),
  });
});

describe('22-01 T4: WebVitalsReporter', () => {
  it('posts ttfb on mount (audit-M2 once-per-mount)', async () => {
    const { WebVitalsReporter } = await import('@/components/web-vitals-reporter');
    render(<WebVitalsReporter />);
    // Allow microtask queue to flush
    await new Promise((r) => setTimeout(r, 0));
    const ttfbCall = mockFetch.mock.calls.find((c) => {
      const init = c[1] as RequestInit | undefined;
      if (!init) return false;
      const body = JSON.parse(init.body as string);
      return body.metric === 'ttfb';
    });
    expect(ttfbCall).toBeDefined();
    const ttfbInit = ttfbCall![1] as RequestInit;
    const payload = JSON.parse(ttfbInit.body as string);
    expect(payload.event).toBe('webVitalCaptured');
    expect(payload.metric).toBe('ttfb');
    expect(payload.value).toBe(180);
    expect(payload.route).toBe('/library');
  });

  it('audit-SR1: route normalized — share-token redacted before post', async () => {
    mockUsePathname.mockReturnValue('/en/share/abc123def456ghi789jkl012mno345pqr/play');
    const { WebVitalsReporter } = await import('@/components/web-vitals-reporter');
    render(<WebVitalsReporter />);
    await new Promise((r) => setTimeout(r, 0));
    const call = mockFetch.mock.calls.find((c) => {
      const init = c[1] as RequestInit | undefined;
      if (!init) return false;
      const body = JSON.parse(init.body as string);
      return body.metric === 'ttfb';
    });
    expect(call).toBeDefined();
    const callInit = call![1] as RequestInit;
    const payload = JSON.parse(callInit.body as string);
    expect(payload.route).toBe('/en/share/[token]/play');
  });
});
