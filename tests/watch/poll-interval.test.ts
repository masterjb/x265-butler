// Phase 42 Plan 42-01 — poll-interval resolver tests.
//
// Covers AC-2 (rate cap), AC-3 (env reject-to-default + warn-once), AC-7 (scale
// over realPaths via PATHS_PER_FILE multiplier, NOT bare file-count), AC-8
// (stored old-default 2000 does NOT disable scaling; explicit ≠2000 wins), and
// AC-10 (computedStatsPerSec derived from realPaths).

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
  it('AC-3: valid env WATCH_POLL_INTERVAL_MS used verbatim (source=env)', () => {
    process.env[ENV_KEY] = '12000';
    const r = resolvePollIntervalMs({ watchedFileCount: 50_000 }, makeLog());
    expect(r.ms).toBe(12_000);
    expect(r.source).toBe('env');
  });

  it('AC-3: invalid env → falls to scaling + warns exactly ONCE across calls', () => {
    process.env[ENV_KEY] = 'abc';
    const log = makeLog();
    const r1 = resolvePollIntervalMs({ watchedFileCount: 100 }, log);
    const r2 = resolvePollIntervalMs({ watchedFileCount: 100 }, log);
    expect(r1.source).not.toBe('env');
    expect(r2.source).not.toBe('env');
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toMatchObject({ action: 'watch_poll_interval_invalid' });
  });

  it('AC-2/AC-7: large library scales over realPaths (×multiplier) ≥10× base', () => {
    const watchedFileCount = 11_685;
    const r = resolvePollIntervalMs({ watchedFileCount }, makeLog());
    // realPaths = files × PATHS_PER_FILE (depth:99 stats dirs too).
    expect(r.realPaths).toBe(watchedFileCount * PATHS_PER_FILE);
    expect(r.source).toBe('scaled');
    expect(r.ms).toBeGreaterThanOrEqual(10 * BASE_POLL_INTERVAL_MS);
    // honest self-diagnosis (AC-10): computed rate hugs the conservative target.
    expect(r.computedStatsPerSec).toBeLessThanOrEqual(TARGET_STATS_PER_SEC);
  });

  it('AC-2: pathological library is capped at MAX_POLL_INTERVAL_MS', () => {
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

  it('AC-8: a stored old-default (2000) setting does NOT disable scaling', () => {
    const r = resolvePollIntervalMs(
      { watchedFileCount: 11_685, settingExplicitMs: 2_000 },
      makeLog(),
    );
    expect(r.source).toBe('scaled');
    expect(r.ms).toBeGreaterThan(2_000);
  });

  it('AC-8: an explicit operator override ≠2000 wins over scaling (source=setting)', () => {
    const r = resolvePollIntervalMs(
      { watchedFileCount: 11_685, settingExplicitMs: 8_000 },
      makeLog(),
    );
    expect(r.ms).toBe(8_000);
    expect(r.source).toBe('setting');
  });
});
