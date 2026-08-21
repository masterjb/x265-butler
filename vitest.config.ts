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
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    globals: false,
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
        // 01-03: db singleton bootstrap is env-dependent (path resolution, mkdir).
        // Migration runner stays in coverage (audit S9) — it is critical infra.
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
