// @vitest-environment node
//
// 24-03 (F2) AC-4 + AC-6 (diag half) + AC-9: assembleDiagnostics cache block.
//   AC-4  cache block present in payload (effectivePath/resolution/settingValue/
//         writable/advisory); endpoint stays assembled even if the probe throws.
//   AC-6  advisory === 'config-fallback-space' iff resolution === 'config-fallback'.
//   AC-9  writable is writable-OR-creatable: the effective subdir does not exist
//         until first dispatch, so probeCachePoolWritable throws ENOENT on it;
//         the aggregator falls back to the nearest existing ANCESTOR. A writable
//         ancestor → writable:true (no fresh-install false-negative). A
//         non-writable ancestor (EACCES/EROFS) → writable:false.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DetectionResult } from '@/src/lib/encode/detection';
import { CachePoolUnavailableError } from '@/src/lib/encode/staging';

const { mockDetect, mockResolveCached, mockProbe } = vi.hoisted(() => ({
  mockDetect: vi.fn(),
  mockResolveCached: vi.fn(),
  mockProbe: vi.fn(),
}));

vi.mock('@/src/lib/encode', () => ({
  detectEncoders: mockDetect,
  ENCODER_IDS: ['nvenc', 'qsv', 'vaapi', 'libx265'],
  resolveEffectiveCachePathCached: mockResolveCached,
}));

// Override ONLY probeCachePoolWritable; keep the real CachePoolUnavailableError
// so the aggregator's `instanceof` ENOENT-ancestor branch resolves correctly.
vi.mock('@/src/lib/encode/staging', async (importActual) => {
  const actual = await importActual<typeof import('@/src/lib/encode/staging')>();
  return { ...actual, probeCachePoolWritable: mockProbe };
});

vi.mock('@/src/lib/db', () => ({
  settingRepo: () => ({ get: () => null }),
  shareRepo: () => ({ listAll: () => [] }),
}));
vi.mock('@/src/lib/version', () => ({
  getVersionInfo: () => ({ version: 't', gitHash: 'dev', committedAt: null, committedAtCET: null }),
}));
vi.mock('@/src/lib/diagnostics/warnings-aggregator', () => ({ aggregateWarnings: () => [] }));
vi.mock('@/src/lib/diagnostics/recent-errors', () => ({ getRecentErrors: () => [] }));
vi.mock('@/src/lib/diagnostics/mount-probe', () => ({ probeMounts: async () => [] }));
vi.mock('@/src/lib/diagnostics/render-device-probe', () => ({
  probeRenderDevices: async () => [],
}));
vi.mock('@/src/lib/diagnostics/blocklist-evaluation', () => ({
  assembleBlocklistEvaluation: () => ({
    totalEntries: 0,
    recentEvaluations: [],
    patternCachedAt: null,
  }),
}));
vi.mock('@/src/lib/diagnostics/container-image-probe', () => ({
  probeContainerImage: async () => ({
    os: { id: null, version: null, prettyName: null },
    glibc: { version: null },
    drivers: {
      intelMediaDriver: { version: null, source: null },
      libva: { version: null },
      libdrm: { version: null },
      oneVpl: {
        libmfxGen1: { version: null },
        libvpl: { version: null },
        libigfxcmrt: { version: null },
      },
    },
    ffmpeg: { configurationFlags: null, version: null },
  }),
}));
vi.mock('@/src/lib/diagnostics/cpu-capability', () => ({
  getCpuCapability: async () => ({
    isIntel: false,
    vendorId: null,
    modelName: null,
    family: null,
    model: null,
    microarch: null,
    graphicsGen: null,
    hevcQsv: 'unknown',
  }),
}));
vi.mock('@/src/lib/diagnostics/slow-requests', () => ({
  assembleSlowRequests: () => ({ topN: [], tailLimit: 200, maxOut: 20 }),
}));
vi.mock('@/src/lib/diagnostics/slow-queries', () => ({
  assembleSlowQueries: () => ({ topN: [], tailLimit: 500, maxOut: 20 }),
}));
vi.mock('@/src/lib/diagnostics/web-vitals', () => ({
  assembleWebVitals: () => ({ byRoute: {}, tailLimit: 500, sampleCapPerRoute: 50 }),
}));
vi.mock('node:fs/promises', () => ({ readdir: async () => [] }));

import { assembleDiagnostics } from '@/src/lib/diagnostics/aggregator';

const DET: DetectionResult = {
  detected: ['libx265'],
  activeFromAuto: 'libx265',
  warnings: [],
  outcome: { nvenc: 'missing', qsv: 'missing', vaapi: 'missing', libx265: 'functional' },
  brokenExcerpts: {},
  probeEncodeDisabled: false,
};

function enoent(): CachePoolUnavailableError {
  return new CachePoolUnavailableError('ENOENT', 'cache_pool_unavailable:ENOENT');
}
function eacces(): CachePoolUnavailableError {
  return new CachePoolUnavailableError('EACCES', 'cache_pool_unavailable:EACCES');
}

beforeEach(() => {
  mockDetect.mockReset();
  mockResolveCached.mockReset();
  mockProbe.mockReset();
  mockDetect.mockResolvedValue(DET);
});

describe('aggregator cache block (24-03)', () => {
  it('AC-9: fresh install — effective subdir ENOENT but ancestor writable → writable:true (mnt-cache)', async () => {
    mockResolveCached.mockReturnValue({
      effectivePath: '/mnt/cache/x265-butler',
      resolution: 'mnt-cache',
    });
    // subdir probe throws ENOENT; ancestor (/mnt/cache) probe succeeds.
    mockProbe.mockImplementation((p: string) => {
      if (p === '/mnt/cache/x265-butler') throw enoent();
      return undefined; // /mnt/cache writable
    });
    const p = await assembleDiagnostics();
    expect(p.cache).toEqual({
      effectivePath: '/mnt/cache/x265-butler',
      resolution: 'mnt-cache',
      settingValue: null,
      writable: true,
      advisory: null,
    });
  });

  it('AC-9: config-fallback — subdir ENOENT but /config writable → writable:true + advisory', async () => {
    mockResolveCached.mockReturnValue({
      effectivePath: '/config/cache',
      resolution: 'config-fallback',
    });
    mockProbe.mockImplementation((p: string) => {
      if (p === '/config/cache') throw enoent();
      return undefined; // /config writable
    });
    const p = await assembleDiagnostics();
    expect(p.cache.writable).toBe(true);
    expect(p.cache.resolution).toBe('config-fallback');
    expect(p.cache.advisory).toBe('config-fallback-space'); // AC-6
  });

  it('AC-9: effective + ancestor both non-writable (EACCES) → writable:false', async () => {
    mockResolveCached.mockReturnValue({
      effectivePath: '/mnt/cache/x265-butler',
      resolution: 'mnt-cache',
    });
    mockProbe.mockImplementation(() => {
      throw eacces(); // not ENOENT → no ancestor fallback
    });
    const p = await assembleDiagnostics();
    expect(p.cache.writable).toBe(false);
  });

  it('AC-9: dir exists + writable (post-first-encode) → writable:true with no ancestor probe', async () => {
    mockResolveCached.mockReturnValue({
      effectivePath: '/mnt/cache/x265-butler',
      resolution: 'mnt-cache',
    });
    mockProbe.mockReturnValue(undefined); // direct probe succeeds
    const p = await assembleDiagnostics();
    expect(p.cache.writable).toBe(true);
    expect(mockProbe).toHaveBeenCalledTimes(1); // no ancestor fallback needed
  });

  it('AC-6: user-override → no advisory', async () => {
    mockResolveCached.mockReturnValue({
      effectivePath: '/mnt/disks/nvme/cache',
      resolution: 'user-override',
    });
    mockProbe.mockReturnValue(undefined);
    const p = await assembleDiagnostics();
    expect(p.cache.resolution).toBe('user-override');
    expect(p.cache.advisory).toBeNull();
  });

  it('AC-4: whole-block throw → null/false-filled fallback, payload still assembled', async () => {
    mockResolveCached.mockImplementation(() => {
      throw new Error('boom');
    });
    const p = await assembleDiagnostics();
    expect(p.cache).toEqual({
      effectivePath: '',
      resolution: 'config-fallback',
      settingValue: null,
      writable: false,
      advisory: null,
    });
    // rest of payload intact
    expect(p.encoders.detected).toContain('libx265');
  });
});
