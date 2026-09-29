// @vitest-environment node
// Phase 21 Plan 21-03 audit-M1 — middleware composed-wrapper x-pathname header tests.

import { describe, it, expect, vi } from 'vitest';

const { handleSpy } = vi.hoisted(() => {
  return {
    handleSpy: vi.fn((_req: unknown) => {
      // next-intl normally returns a NextResponse — mimic the parts we touch
      // (a headers map with get/set) without dragging in next/server runtime.
      const headers = new Headers();
      return { headers };
    }),
  };
});

vi.mock('next-intl/middleware', () => ({
  default: () => handleSpy,
}));

import middleware, { config } from '@/middleware';

function fakeRequest(pathname: string) {
  return { nextUrl: { pathname } } as unknown as Parameters<typeof middleware>[0];
}

describe('middleware x-pathname injection (audit-M1)', () => {
  it('writes x-pathname for /en/library', () => {
    const res = middleware(fakeRequest('/en/library'));
    expect(res.headers.get('x-pathname')).toBe('/en/library');
    expect(res.headers.get('x-original-pathname')).toBe('/en/library');
  });

  it('writes x-pathname for /fr/library (unknown-locale pass-through)', () => {
    const res = middleware(fakeRequest('/fr/library'));
    expect(res.headers.get('x-pathname')).toBe('/fr/library');
  });

  it('writes x-pathname for naked /library (locale-missing redirect target)', () => {
    const res = middleware(fakeRequest('/library'));
    expect(res.headers.get('x-pathname')).toBe('/library');
  });

  it('delegates request to handleI18nRouting (composed transparently)', () => {
    handleSpy.mockClear();
    middleware(fakeRequest('/en/foo'));
    expect(handleSpy).toHaveBeenCalledTimes(1);
  });

  it('preserves matcher exclusion for api/_next/_vercel/static assets', () => {
    expect(config.matcher).toEqual(['/((?!api|_next|_vercel|.*\\..*).*)']);
  });
});
