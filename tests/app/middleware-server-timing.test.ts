// @vitest-environment node
// 22-01 T1 IMP-1 — middleware Server-Timing header tests.
// AC-1 contract: middleware sets `Server-Timing: i18n;dur=N` on i18n-matched routes
// AND preserves 21-03 audit-M1 x-pathname + x-original-pathname carry-forward.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockHandleI18n, mockNow } = vi.hoisted(() => ({
  mockHandleI18n: vi.fn(),
  mockNow: vi.fn(),
}));

vi.mock('next-intl/middleware', () => ({
  default: () => mockHandleI18n,
}));

vi.mock('./i18n/routing', () => ({
  routing: {},
}));

vi.mock('@/i18n/routing', () => ({
  routing: {},
}));

// Spy on performance.now for deterministic Server-Timing duration.
const originalNow = performance.now.bind(performance);
beforeEach(() => {
  mockHandleI18n.mockReset();
  mockNow.mockReset();
  vi.spyOn(performance, 'now').mockImplementation(() => mockNow());
});

function makeRequest(pathname: string): import('next/server').NextRequest {
  return {
    nextUrl: { pathname },
    headers: new Headers(),
    url: `http://localhost:3000${pathname}`,
  } as unknown as import('next/server').NextRequest;
}

function makeResponse(): { headers: Headers } {
  return { headers: new Headers() };
}

describe('22-01 T1: middleware Server-Timing header', () => {
  it('sets Server-Timing header with i18n duration on response', async () => {
    mockNow.mockReturnValueOnce(100).mockReturnValueOnce(150);
    const response = makeResponse();
    mockHandleI18n.mockReturnValue(response);

    const middleware = (await import('@/middleware')).default;
    const res = middleware(makeRequest('/en/library'));

    expect(res.headers.get('Server-Timing')).toBe('i18n;dur=50.0');
    vi.spyOn(performance, 'now').mockImplementation(originalNow);
  });

  it('preserves 21-03 x-pathname carry-forward when Server-Timing is added', async () => {
    mockNow.mockReturnValueOnce(0).mockReturnValueOnce(10);
    const response = makeResponse();
    mockHandleI18n.mockReturnValue(response);

    const middleware = (await import('@/middleware')).default;
    const res = middleware(makeRequest('/library/foo'));

    expect(res.headers.get('x-pathname')).toBe('/library/foo');
    expect(res.headers.get('x-original-pathname')).toBe('/library/foo');
    expect(res.headers.get('Server-Timing')).toBe('i18n;dur=10.0');
    vi.spyOn(performance, 'now').mockImplementation(originalNow);
  });

  it('Server-Timing duration uses toFixed(1) format (one decimal)', async () => {
    mockNow.mockReturnValueOnce(0).mockReturnValueOnce(12.3456);
    const response = makeResponse();
    mockHandleI18n.mockReturnValue(response);

    const middleware = (await import('@/middleware')).default;
    const res = middleware(makeRequest('/'));

    expect(res.headers.get('Server-Timing')).toBe('i18n;dur=12.3');
    vi.spyOn(performance, 'now').mockImplementation(originalNow);
  });
});
