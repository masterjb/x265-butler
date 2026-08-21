// Phase 16-02 audit-added M8 — defensive read-time fallback for malformed DB.
//
// Asserts that readSettingInt() (via watcher.ts startWatcher path consuming
// autoScan.stabilityThreshold) gracefully degrades when manual SQL editing
// leaves invalid values in the settings table:
//   - empty string → fallback + log.warn auto_scan_setting_malformed
//   - non-numeric → fallback + warn
//   - whitespace-padded numeric → parseInt native-strip → valid value (no warn)
//   - valid numeric → no warn, returns parsed value

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ShareRow } from '@/src/lib/db/schema';

vi.mock('@/src/lib/watch/mount-detect', () => ({
  detectMountMode: vi.fn(() => 'inotify' as const),
  readMaxUserWatches: vi.fn(() => 524288),
  countCurrentInotifyWatches: vi.fn(() => 0),
}));

import {
  startWatcher,
  stopWatcher,
  resetWatcherState,
  __setWatcherFactoryForTests,
  __resetWatcherFactoryForTests,
  type WatcherFactory,
} from '@/src/lib/watch/watcher';

class FakeFSWatcher extends EventEmitter {
  watched = new Set<string>();
  opts: Record<string, unknown> = {};
  constructor(paths: string | readonly string[], opts: Record<string, unknown>) {
    super();
    this.opts = opts;
    const arr = Array.isArray(paths) ? paths : [paths as string];
    for (const p of arr) this.watched.add(p);
  }
  add() {
    return this;
  }
  unwatch() {
    return this;
  }
  close() {
    return Promise.resolve();
  }
}

let lastOpts: Record<string, unknown> = {};
function makeFactory(): WatcherFactory {
  return {
    watch: (paths: string | readonly string[], opts: Record<string, unknown>) => {
      lastOpts = opts;
      return new FakeFSWatcher(paths, opts) as never;
    },
  };
}

function makeShare(id: number, name: string, p: string): ShareRow {
  return {
    id,
    name,
    path: p,
    min_size_mb: 0,
    extensions_csv: 'mkv',
    max_depth: null,
    created_at: 0,
    updated_at: 0,
  } as ShareRow;
}

function makeDeps(settings: Record<string, string>) {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => log,
  };
  return {
    deps: {
      shareRepo: () => ({ listAll: () => [makeShare(1, 'a', '/mnt/a')] }),
      settingRepo: () => ({ get: (k: string) => settings[k] }),
      fileRepo: () => ({}),
      jobRepo: () => ({}),
      ingestSingleFile: vi.fn(),
      runReconcile: vi.fn(),
      emitQueueUpdated: vi.fn(),
      log: log as never,
    } as never,
    log,
  };
}

beforeEach(() => {
  __setWatcherFactoryForTests(makeFactory());
  lastOpts = {};
});

afterEach(async () => {
  await stopWatcher();
  resetWatcherState();
  __resetWatcherFactoryForTests();
});

describe('readSettingInt defensive fallback (16-02 audit M8)', () => {
  it('empty string → fallback to default 10000 + warn emitted', async () => {
    const { deps, log } = makeDeps({ 'autoScan.stabilityThreshold': '' });
    await startWatcher(deps);
    const awf = (lastOpts.awaitWriteFinish ?? {}) as { stabilityThreshold?: number };
    expect(awf.stabilityThreshold).toBe(10_000);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auto_scan_setting_malformed',
        key: 'autoScan.stabilityThreshold',
      }),
      expect.any(String),
    );
  });

  it('non-numeric "abc" → fallback to default + warn', async () => {
    const { deps, log } = makeDeps({ 'autoScan.stabilityThreshold': 'abc' });
    await startWatcher(deps);
    const awf = (lastOpts.awaitWriteFinish ?? {}) as { stabilityThreshold?: number };
    expect(awf.stabilityThreshold).toBe(10_000);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auto_scan_setting_malformed' }),
      expect.any(String),
    );
  });

  it('whitespace-padded "  12000  " → parsed via parseInt native-strip (no warn)', async () => {
    const { deps, log } = makeDeps({ 'autoScan.stabilityThreshold': '  12000  ' });
    await startWatcher(deps);
    const awf = (lastOpts.awaitWriteFinish ?? {}) as { stabilityThreshold?: number };
    expect(awf.stabilityThreshold).toBe(12_000);
    const malformedWarns = log.warn.mock.calls.filter((c) => {
      const payload = c[0] as { action?: string } | undefined;
      return payload?.action === 'auto_scan_setting_malformed';
    });
    expect(malformedWarns).toHaveLength(0);
  });

  it('valid "15000" → parsed, no warn', async () => {
    const { deps, log } = makeDeps({ 'autoScan.stabilityThreshold': '15000' });
    await startWatcher(deps);
    const awf = (lastOpts.awaitWriteFinish ?? {}) as { stabilityThreshold?: number };
    expect(awf.stabilityThreshold).toBe(15_000);
    const malformedWarns = log.warn.mock.calls.filter((c) => {
      const payload = c[0] as { action?: string } | undefined;
      return payload?.action === 'auto_scan_setting_malformed';
    });
    expect(malformedWarns).toHaveLength(0);
  });
});
