import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

// 52-03: GitLab's docker executor mounts a writable /cache into every job
// container. The real /cache probe in src/lib/encode/cache-path.ts would then
// flip every cache-resolver test to `cache-mount`. Pin it off; tests of the
// /cache tier pass their own probe as an argument.
globalThis.__x265butler_cache_mount_probe = () => false;

// waitFor/findBy* give up after 1s by default; on shared CI runners under
// coverage an async render can take longer (apply-from-bench-button stayed on
// "Loading…"). Mirrors testTimeout in vitest.config.ts.
if (process.env.CI) {
  configure({ asyncUtilTimeout: 5_000 });
}

// JSDOM doesn't ship matchMedia; next-themes uses it for system theme detection.
// Without this stub, any test rendering a component inside <ThemeProvider> crashes.
if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(), // legacy
      removeListener: vi.fn(), // legacy
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

// Auto-cleanup the DOM between tests so renders don't bleed into each other.
afterEach(() => {
  cleanup();
});

// audit-added G5: mock next/font/google.
// next/font only resolves in the Next.js build context — without this mock,
// any test importing a component that uses lib/fonts.ts crashes vitest.
vi.mock('next/font/google', () => ({
  Fira_Sans: () => ({
    className: 'font-fira-sans-mock',
    variable: '--font-fira-sans',
    style: { fontFamily: 'Fira Sans' },
  }),
  Fira_Code: () => ({
    className: 'font-fira-code-mock',
    variable: '--font-fira-code',
    style: { fontFamily: 'Fira Code' },
  }),
}));

// audit-added G5: mock next/navigation for components using usePathname/useRouter.
// These hooks throw outside the App Router runtime; mocking provides a stable
// active-route assumption for tests (sidebar active-state etc.).
vi.mock('next/navigation', () => ({
  usePathname: () => '/en/library',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT: ${url}`);
  },
}));
