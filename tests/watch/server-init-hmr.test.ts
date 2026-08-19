// Phase 16-01 T4 audit-added S2: HMR no-duplicate-bind verification.
//
// In dev, Next.js may re-import server-init.ts during HMR. The globalThis
// singleton guard (state.started flag) must prevent a second watcher boot —
// otherwise chokidar would bind twice and emit-amplify every event.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock heavy modules so the HMR test only exercises the singleton-guard path.
vi.mock('@/src/lib/db', () => ({
  settingRepo: () => ({ get: () => undefined, set: vi.fn(), getAll: () => ({}) }),
  trashRepo: () => ({ deleteExpired: () => 0 }),
  jobRepo: () => ({ countByStatus: () => 0, listActive: () => [] }),
  benchRunRepo: () => ({ resetStuckRunningToFailed: () => 0 }),
  fileRepo: () => ({}),
  shareRepo: () => ({ listAll: () => [] }),
  blocklistRepo: () => ({ listAllPatterns: () => [] }),
  getDb: () => ({ prepare: () => ({ all: () => [] }) }),
}));

vi.mock('@/src/lib/encode', () => ({
  startEncoderLoop: vi.fn(),
  stopEncoderLoop: vi.fn(async () => {}),
  probeFfmpegVersionAtBoot: vi.fn(),
}));

vi.mock('@/src/lib/log/sweep', () => ({
  sweepJobLogs: vi.fn(async () => undefined),
}));

vi.mock('@/src/lib/watch', () => ({
  startWatcherService: vi.fn(async () => {}),
  stopWatcherService: vi.fn(async () => {}),
  getAutoScanStatus: vi.fn(() => ({})),
}));

import { ensureServerInit, __forTests_resetServerInit } from '@/src/lib/server-init';
import { startWatcherService as startWatcherServiceMock } from '@/src/lib/watch';

beforeEach(() => {
  __forTests_resetServerInit();
  vi.mocked(startWatcherServiceMock).mockClear();
});

afterEach(() => {
  __forTests_resetServerInit();
});

describe('server-init HMR singleton guard (audit S2)', () => {
  it('double ensureServerInit() call → only ONE startWatcherService invocation', () => {
    ensureServerInit();
    ensureServerInit();
    ensureServerInit();
    expect(vi.mocked(startWatcherServiceMock)).toHaveBeenCalledTimes(1);
  });

  it('after reset, ensureServerInit can bind again (test isolation works)', () => {
    ensureServerInit();
    expect(vi.mocked(startWatcherServiceMock)).toHaveBeenCalledTimes(1);
    __forTests_resetServerInit();
    vi.mocked(startWatcherServiceMock).mockClear();
    ensureServerInit();
    expect(vi.mocked(startWatcherServiceMock)).toHaveBeenCalledTimes(1);
  });
});
