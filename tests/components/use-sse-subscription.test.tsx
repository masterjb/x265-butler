// 05-03 T2.J: useSseSubscription tests (audit S9 closure).
// Phase 5 Plan 05-03 — AC-8.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { useSseSubscription, __resetForTesting } from '@/components/logs/use-sse-subscription';
import { useEffect } from 'react';

type FakeEs = {
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  close: ReturnType<typeof vi.fn>;
};

const captured: FakeEs[] = [];
const MockEventSource = vi.fn().mockImplementation(() => {
  const es: FakeEs = { onopen: null, onmessage: null, onerror: null, close: vi.fn() };
  captured.push(es);
  return es;
});

const mocks = vi.hoisted(() => ({
  markLogout: vi.fn(),
}));

vi.mock('@/components/auth/auth-fetcher', () => ({
  markLogoutClicked: () => mocks.markLogout(),
}));

vi.stubGlobal('EventSource', MockEventSource);

beforeEach(() => {
  vi.useFakeTimers();
  captured.length = 0;
  MockEventSource.mockClear();
  mocks.markLogout.mockReset();
  __resetForTesting();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function lastEs(): FakeEs {
  return captured[captured.length - 1];
}

function Probe(props: { url: string; enabled?: boolean; fetchImpl?: typeof fetch }) {
  const r = useSseSubscription({
    url: props.url,
    enabled: props.enabled ?? true,
    fetchImpl: props.fetchImpl,
  });
  useEffect(() => {
    void r;
  }, [r]);
  return null;
}

describe('useSseSubscription — happy', () => {
  it('opens EventSource with withCredentials=true on mount', () => {
    render(<Probe url="/api/test" />);
    expect(MockEventSource).toHaveBeenCalledWith('/api/test', { withCredentials: true });
  });

  it('does not open when enabled=false', () => {
    render(<Probe url="/api/test" enabled={false} />);
    expect(MockEventSource).not.toHaveBeenCalled();
  });

  it('cleans up EventSource on unmount', () => {
    const { unmount } = render(<Probe url="/api/test" />);
    const es = lastEs();
    unmount();
    expect(es.close).toHaveBeenCalled();
  });

  it('cleans up EventSource when enabled flips to false', () => {
    const { rerender } = render(<Probe url="/api/test" enabled={true} />);
    const es = lastEs();
    rerender(<Probe url="/api/test" enabled={false} />);
    expect(es.close).toHaveBeenCalled();
  });
});

describe('useSseSubscription — 401 redirect (audit S9)', () => {
  it('on error → fetch HEAD probe → 401 with auth_required → redirect ONCE', async () => {
    const fakeFetch = vi.fn(async () => ({
      status: 401,
      clone: () => ({
        json: async () => ({ error_code: 'auth_required' }),
      }),
    })) as unknown as typeof fetch;

    const replace = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { pathname: '/en/logs', search: '?jobId=1', replace },
    });

    render(<Probe url="/api/logs/1?live=1" fetchImpl={fakeFetch} />);
    const es = lastEs();
    act(() => {
      es.onerror?.(new Event('error'));
    });
    // Flush the fetch promise.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.markLogout).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith(expect.stringContaining('/login?expired=1'));

    // Second error must NOT trigger a second redirect — module flag guards.
    act(() => {
      es.onerror?.(new Event('error'));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // mock.calls.length still 1 from first redirect.
    expect(replace).toHaveBeenCalledTimes(1);
  });
});

describe('useSseSubscription — non-401 error → reconnect-with-backoff', () => {
  it('on 500 error → schedules reconnect, no redirect', async () => {
    const fakeFetch = vi.fn(async () => ({
      status: 500,
      clone: () => ({ json: async () => ({}) }),
    })) as unknown as typeof fetch;

    render(<Probe url="/api/test" fetchImpl={fakeFetch} />);
    const initialCalls = MockEventSource.mock.calls.length;
    const es = lastEs();
    act(() => {
      es.onerror?.(new Event('error'));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // No redirect.
    expect(mocks.markLogout).not.toHaveBeenCalled();

    // Advance timer past max backoff jitter window.
    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
    });
    // A new EventSource is created on reconnect tick.
    expect(MockEventSource.mock.calls.length).toBeGreaterThan(initialCalls);
  });
});
