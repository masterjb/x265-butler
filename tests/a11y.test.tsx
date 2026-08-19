import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { Topbar } from '@/components/app-shell/topbar';
import { Sidebar } from '@/components/app-shell/sidebar';
import { SkipLink } from '@/components/app-shell/skip-link';
import { wrap } from './test-utils';

// audit-added G9 (01-02) + 01-04 page additions: zero critical/serious violations
// across app shell + Library + Settings.

// QueuePauseToggle (added 02-04) uses usePausedState; ActiveJobsBadge (added
// 03-04) uses useQueueCounts. Stub both so Topbar renders without an
// EngineEventsProvider in the test tree.
const { mockUsePausedState, mockUseQueueCounts } = vi.hoisted(() => ({
  mockUsePausedState: vi.fn<() => boolean>(() => false),
  mockUseQueueCounts: vi.fn(() => ({ activeJobs: 0, pendingJobs: 0 })),
}));

vi.mock('@/src/lib/api/engine-events-client', () => ({
  usePausedState: mockUsePausedState,
  useQueueCounts: mockUseQueueCounts,
}));

const {
  mockListPaginated,
  mockCountByStatus,
  mockSettingsGet,
  mockSettingsGetAll,
  mockStatSync,
  mockStatPromise,
} = vi.hoisted(() => ({
  mockListPaginated: vi.fn(),
  mockCountByStatus: vi.fn(),
  mockSettingsGet: vi.fn(),
  mockSettingsGetAll: vi.fn(),
  mockStatSync: vi.fn(),
  mockStatPromise: vi.fn(),
}));

vi.mock('@/src/lib/db', () => ({
  fileRepo: () => ({
    listPaginated: mockListPaginated,
    countByStatus: mockCountByStatus,
    // 14-03: orphan-bucket counter; pill stays hidden when shares are empty.
    countOrphaned: () => 0,
  }),
  settingRepo: () => ({ get: mockSettingsGet, getAll: mockSettingsGetAll }),
  shareRepo: () => ({ listAll: () => [] }),
  jobRepo: () => ({}),
  trashRepo: () => ({}),
  default: {},
}));

// 03-03: SettingsPage parallel-fetches detectEncoders for first-paint pill row.
vi.mock('@/src/lib/encode', () => ({
  detectEncoders: vi.fn().mockResolvedValue({
    detected: ['libx265'],
    activeFromAuto: 'libx265',
  }),
  ENCODER_IDS: ['nvenc', 'qsv', 'vaapi', 'libx265'] as const,
  resolveEffectiveCachePathCached: () => ({
    effectivePath: '/config/cache',
    resolution: 'config-fallback',
  }),
  default: {},
}));

vi.mock('node:fs', () => ({
  default: { statSync: (...a: unknown[]) => mockStatSync(...a) },
  statSync: (...a: unknown[]) => mockStatSync(...a),
}));

vi.mock('node:fs/promises', () => ({
  default: { stat: (...a: unknown[]) => mockStatPromise(...a) },
  stat: (...a: unknown[]) => mockStatPromise(...a),
}));

import LibraryPage from '@/app/[locale]/library/page';
import SettingsPage from '@/app/[locale]/settings/page';

describe('a11y smoke (audit-added G9 + 01-04)', () => {
  it('test_appShell_when_rendered_has_zero_critical_or_serious_axe_violations', async () => {
    const { container } = render(
      wrap(
        <>
          <SkipLink />
          <Topbar />
          <main id="main">
            <Sidebar />
          </main>
        </>,
      ),
    );
    const results = await axe(container);
    const blocking = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    if (blocking.length > 0) {
      console.error(
        'axe violations:',
        blocking.map((v) => ({ id: v.id, impact: v.impact, help: v.help })),
      );
    }
    expect(blocking).toHaveLength(0);
  });

  describe('library page', () => {
    beforeEach(() => {
      mockListPaginated.mockReset();
      mockCountByStatus.mockReset();
      mockSettingsGet.mockReset();
      mockStatSync.mockReset();
      mockSettingsGet.mockReturnValue('/media');
      mockStatSync.mockReturnValue({ isDirectory: () => true });
      mockListPaginated.mockReturnValue({ rows: [], total: 0 });
      mockCountByStatus.mockReturnValue({
        all: 0,
        pending: 0,
        queued: 0,
        encoding: 0,
        'done-smaller': 0,
        'done-larger': 0,
        'skipped-codec': 0,
        'skipped-bitrate': 0,
        'skipped-suffix': 0,
        'skipped-tag': 0,
        'skipped-blocklist': 0,
        failed: 0,
        blocklisted: 0,
        interrupted: 0,
      });
    });

    it('test_libraryPage_when_rendered_then_zero_critical_or_serious_axe_violations', async () => {
      const ui = await LibraryPage({
        params: Promise.resolve({ locale: 'en' }),
        searchParams: Promise.resolve({}),
      });
      const { container } = render(wrap(ui));
      const results = await axe(container);
      const blocking = results.violations.filter(
        (v) => v.impact === 'critical' || v.impact === 'serious',
      );
      if (blocking.length > 0) {
        console.error(
          'library axe violations:',
          blocking.map((v) => ({ id: v.id, impact: v.impact, help: v.help })),
        );
      }
      expect(blocking).toHaveLength(0);
    });
  });

  describe('settings page', () => {
    beforeEach(() => {
      mockSettingsGetAll.mockReset();
      mockStatPromise.mockReset();
      mockSettingsGetAll.mockReturnValue({
        scan_root: '/media',
        min_size_mb: '50',
        extensions: 'mp4,mkv',
        max_depth: '12',
      });
      mockStatPromise.mockResolvedValue({ isDirectory: () => true });
    });

    it('test_settingsPage_when_rendered_then_zero_critical_or_serious_axe_violations', async () => {
      const ui = await SettingsPage();
      const { container } = render(wrap(ui));
      const results = await axe(container);
      const blocking = results.violations.filter(
        (v) => v.impact === 'critical' || v.impact === 'serious',
      );
      if (blocking.length > 0) {
        console.error(
          'settings axe violations:',
          blocking.map((v) => ({ id: v.id, impact: v.impact, help: v.help })),
        );
      }
      expect(blocking).toHaveLength(0);
    });
  });
});
