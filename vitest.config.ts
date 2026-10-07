import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
    },
  },
  test: {
    // `.ts` tests are server/lib code and run under plain node — building
    // a jsdom window per file was the largest single cost on CI. `.tsx` tests
    // (components) keep jsdom; a `.ts` file that needs a DOM opts in with a
    // `// @vitest-environment jsdom` docblock. Globs are repo-wide on purpose:
    // some tests live next to their source under src/.
    projects: [
      {
        extends: true,
        test: { name: 'node', include: ['**/*.test.ts'], environment: 'node' },
      },
      {
        extends: true,
        test: { name: 'jsdom', include: ['**/*.test.tsx'], environment: 'jsdom' },
      },
    ],
    setupFiles: ['./tests/setup.ts'],
    globals: false,
    // Shared CI runners under v8 coverage run 4x+ slower than a workstation;
    // the 5s default made a different set of tests time out on every MR run.
    // Locally keep the default so real hangs still surface fast.
    testTimeout: process.env.CI ? 30_000 : 5_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'cobertura'],
      reportsDirectory: 'coverage',
      include: [
        'src/**/*.{ts,tsx}',
        'app/**/*.{ts,tsx}',
        'components/**/*.{ts,tsx}',
        'lib/**/*.ts',
      ],
      exclude: [
        // Bootstrap / entry files — covered by integration render in app-shell tests.
        // glob patterns: brackets in [locale] are character classes, so we use
        // recursive globs that catch all layout / page / error / not-found files.
        'src/lib/logger.ts',
        // db singleton bootstrap is env-dependent (path resolution, mkdir).
        // Migration runner stays in coverage — it is critical infra.
        'src/lib/db/index.ts',
        'app/**/layout.tsx',
        'app/**/page.tsx',
        // audit-added G4: error pages tested via integration, not unit
        'app/**/error.tsx',
        'app/**/not-found.tsx',
        'app/global-error.tsx',
        // Next.js / next-intl / middleware — runtime-only
        'next.config.ts',
        'middleware.ts',
        'i18n/**',
        // shadcn vendor code
        'components/ui/**',
        // next/font — mocked in tests, not unit-testable
        'lib/fonts.ts',
      ],
      thresholds: {
        statements: 80,
        branches: 70,
        functions: 80,
        lines: 80,
      },
    },
  },
});
