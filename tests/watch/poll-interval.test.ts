// Poll-interval resolver tests.
//
// Covers the rate cap, env reject-to-default + warn-once, scaling over realPaths
// via the PATHS_PER_FILE multiplier (NOT bare file-count), a stored old-default
// 2000 that does NOT disable scaling (explicit ≠2000 wins), and
// computedStatsPerSec derived from realPaths.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolvePollIntervalMs,
  __forTests_resetPollIntervalEnv,
  BASE_POLL_INTERVAL_MS,
  MAX_POLL_INTERVAL_MS,
  TARGET_STATS_PER_SEC,
  PATHS_PER_FILE,
} from '@/src/lib/watch/poll-interval';

function makeLog() {
  return { info: vi.fn(), warn: vi.fn() };
}

const ENV_KEY = 'WATCH_POLL_INTERVAL_MS';
const savedEnv = process.env[ENV_KEY];

beforeEach(() => {
  delete process.env[ENV_KEY];
  __forTests_resetPollIntervalEnv();
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  __forTests_resetPollIntervalEnv();
});

describe('resolvePollIntervalMs', () => {
  it('valid env WATCH_POLL_INTERVAL_MS used verbatim (source=env)', () => {
    process.env[ENV_KEY] = '12000';
    const r = resolvePollIntervalMs({ watchedFileCount: 50_000 }, makeLog());
    expect(r.ms).toBe(12_000);
    expect(r.source).toBe('env');
  });

  it('invalid env → falls to scaling + warns exactly ONCE across calls', () => {
    process.env[ENV_KEY] = 'abc';
    const log = makeLog();
    const r1 = resolvePollIntervalMs({ watchedFileCount: 100 }, log);
    const r2 = resolvePollIntervalMs({ watchedFileCount: 100 }, log);
    expect(r1.source).not.toBe('env');
    expect(r2.source).not.toBe('env');
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toMatchObject({ action: 'watch_poll_interval_invalid' });
  });

  it('large library scales over realPaths (×multiplier) ≥10× base', () => {
    const watchedFileCount = 11_685;
    const r = resolvePollIntervalMs({ watchedFileCount }, makeLog());
    // realPaths = files × PATHS_PER_FILE (depth:99 stats dirs too).
    expect(r.realPaths).toBe(watchedFileCount * PATHS_PER_FILE);
    expect(r.source).toBe('scaled');
    expect(r.ms).toBeGreaterThanOrEqual(10 * BASE_POLL_INTERVAL_MS);
    // honest self-diagnosis: computed rate hugs the conservative target.
    expect(r.computedStatsPerSec).toBeLessThanOrEqual(TARGET_STATS_PER_SEC);
  });

  it('pathological library is capped at MAX_POLL_INTERVAL_MS', () => {
    const r = resolvePollIntervalMs({ watchedFileCount: 10_000_000 }, makeLog());
    expect(r.ms).toBe(MAX_POLL_INTERVAL_MS);
  });

  it('small library stays at base interval (source=default)', () => {
    const r = resolvePollIntervalMs({ watchedFileCount: 100 }, makeLog());
    expect(r.ms).toBe(BASE_POLL_INTERVAL_MS);
    expect(r.source).toBe('default');
  });

  it('boundary N=0 → base interval, realPaths=0', () => {
    const r = resolvePollIntervalMs({ watchedFileCount: 0 }, makeLog());
    expect(r.ms).toBe(BASE_POLL_INTERVAL_MS);
    expect(r.realPaths).toBe(0);
    expect(r.computedStatsPerSec).toBe(0);
  });

  it('a stored old-default (2000) setting does NOT disable scaling', () => {
    const r = resolvePollIntervalMs(
      { watchedFileCount: 11_685, settingExplicitMs: 2_000 },
      makeLog(),
    );
    expect(r.source).toBe('scaled');
    expect(r.ms).toBeGreaterThan(2_000);
  });

  it('an explicit operator override ≠2000 wins over scaling (source=setting)', () => {
    const r = resolvePollIntervalMs(
      { watchedFileCount: 11_685, settingExplicitMs: 8_000 },
      makeLog(),
    );
    expect(r.ms).toBe(8_000);
    expect(r.source).toBe('setting');
  });
});
