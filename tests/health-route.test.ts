import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WatcherStatus } from '@/src/lib/watch';

// Mock the watch service so /api/health unit-tests stay free of chokidar/DB.
vi.mock('@/src/lib/watch', () => ({
  getAutoScanStatus: vi.fn<() => WatcherStatus>(),
}));

import { GET } from '@/app/api/health/route';
import { getAutoScanStatus } from '@/src/lib/watch';

function defaultStatus(overrides: Partial<WatcherStatus> = {}): WatcherStatus {
  return {
    status: 'running',
    lastEventAt: null,
    lastReconcileAt: null,
    bootReconcileCount: 0,
    orphanReEnqueueCountAtBoot: 0,
    droppedEventsLast24h: 0,
    inotifyError: null,
    currentInotifyWatches: 17,
    maxUserWatches: 524288,
    pollingModeByShare: { media: 'inotify' },
    pollingShares: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(getAutoScanStatus).mockReturnValue(defaultStatus());
});

describe('GET /api/health (Route Handler)', () => {
  it('returns 200 + version + autoScan top-level keys', async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual([
      'autoScan',
      'committedAt',
      'committedAtCET',
      'gitHash',
      'version',
    ]);
  });

  // audit-added G3: verify Cache-Control no-store header
  it('returns no-store cache control', async () => {
    const response = await GET();
    expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
  });

  it('autoScan.status=running → still 200', async () => {
    vi.mocked(getAutoScanStatus).mockReturnValue(defaultStatus({ status: 'running' }));
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.autoScan.status).toBe('running');
  });

  it('audit AC-10: autoScan.status=error → STILL 200 (warn-only)', async () => {
    vi.mocked(getAutoScanStatus).mockReturnValue(
      defaultStatus({
        status: 'error',
        inotifyError: { code: 'ENOSPC', message: 'System limit' },
      }),
    );
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.autoScan.status).toBe('error');
    expect(body.autoScan.inotifyError).toEqual({ code: 'ENOSPC', message: 'System limit' });
  });

  it('autoScan.status=stopped → 200', async () => {
    vi.mocked(getAutoScanStatus).mockReturnValue(defaultStatus({ status: 'stopped' }));
    const response = await GET();
    expect(response.status).toBe(200);
  });

  it('lastEventAt = null when no events yet', async () => {
    const response = await GET();
    const body = await response.json();
    expect(body.autoScan.lastEventAt).toBeNull();
  });

  it('pollingModeByShare reflects detect-results', async () => {
    vi.mocked(getAutoScanStatus).mockReturnValue(
      defaultStatus({
        pollingModeByShare: { media: 'inotify', cache: 'polling-forced' },
      }),
    );
    const body = await (await GET()).json();
    expect(body.autoScan.pollingModeByShare).toEqual({
      media: 'inotify',
      cache: 'polling-forced',
    });
  });

  it('audit M4: response includes droppedEventsLast24h (default 0)', async () => {
    const body = await (await GET()).json();
    expect(body.autoScan.droppedEventsLast24h).toBe(0);
  });

  it('audit M10: response includes orphanReEnqueueCountAtBoot (default 0)', async () => {
    const body = await (await GET()).json();
    expect(body.autoScan.orphanReEnqueueCountAtBoot).toBe(0);
  });

  it('exposes maxUserWatches + currentInotifyWatches for budget bar', async () => {
    const body = await (await GET()).json();
    expect(body.autoScan.maxUserWatches).toBe(524288);
    expect(body.autoScan.currentInotifyWatches).toBe(17);
  });
});
