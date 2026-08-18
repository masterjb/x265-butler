import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

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
