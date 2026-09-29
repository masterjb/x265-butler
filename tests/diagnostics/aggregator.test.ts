// @vitest-environment node
//
// 23-04: assembleDiagnostics maps DetectionResult.outcome + brokenExcerpts +
// probeEncodeDisabled into the EncoderBlock. Excerpt is keyed BY ENCODER
// (audit M2 — multiple broken encoders share the identical warning code).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DetectionResult } from '@/src/lib/encode/detection';

const { mockDetect, mockGetScanIntegrity } = vi.hoisted(() => ({
  mockDetect: vi.fn(),
  // 48-01: the store is a plain process-local getter; mocking it is the only
  // way to exercise the throw branch (AC-12 double-guard).
  mockGetScanIntegrity: vi.fn(),
}));

vi.mock('@/src/lib/scan/scan-integrity-store', () => ({
  getScanIntegrity: mockGetScanIntegrity,
}));

vi.mock('@/src/lib/encode', () => ({
  detectEncoders: mockDetect,
  ENCODER_IDS: ['nvenc', 'qsv', 'vaapi', 'libx265'],
  // 24-03: cache block read-surface resolver. Stub a healthy mnt-cache host.
  resolveEffectiveCachePathCached: () => ({
    effectivePath: '/mnt/cache/x265-butler',
    resolution: 'mnt-cache',
  }),
}));

// 24-03: stub the write-probe so the cache block does NOT touch the real fs of
// the test host (probeEffectiveWritable would otherwise probe /mnt/cache).
vi.mock('@/src/lib/encode/staging', async (importActual) => {
  const actual = await importActual<typeof import('@/src/lib/encode/staging')>();
  return { ...actual, probeCachePoolWritable: () => undefined };
});

vi.mock('@/src/lib/db', () => ({
  settingRepo: () => ({ get: () => 'true' }),
  shareRepo: () => ({ listAll: () => [] }),
}));

vi.mock('@/src/lib/version', () => ({
  getVersionInfo: () => ({
    version: '2.19.4',
    gitHash: 'dev',
    committedAt: null,
    committedAtCET: null,
  }),
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

function detResult(over: Partial<DetectionResult> = {}): DetectionResult {
  return {
    detected: ['libx265'],
    activeFromAuto: 'libx265',
    warnings: [],
    outcome: { nvenc: 'missing', qsv: 'missing', vaapi: 'missing', libx265: 'functional' },
    brokenExcerpts: {},
    forcedIdrSupported: {},
    probeEncodeDisabled: false,
    ...over,
  };
}

beforeEach(() => {
  mockDetect.mockReset();
  mockGetScanIntegrity.mockReset();
  mockGetScanIntegrity.mockReturnValue(null);
});

describe('aggregator — 23-04 outcome mapping', () => {
  it('test_encoders_outcome_when_functional_then_all_four_entries_present', async () => {
    mockDetect.mockResolvedValue(
      detResult({
        detected: ['nvenc', 'libx265'],
        outcome: { nvenc: 'functional', qsv: 'missing', vaapi: 'missing', libx265: 'functional' },
      }),
    );
    const p = await assembleDiagnostics();
    expect(p.encoders.outcome).toHaveLength(4);
    const byEnc = Object.fromEntries(p.encoders.outcome.map((o) => [o.encoder, o.outcome]));
    expect(byEnc).toEqual({
      nvenc: 'functional',
      qsv: 'missing',
      vaapi: 'missing',
      libx265: 'functional',
    });
    expect(p.encoders.probeEncodeDisabled).toBe(false);
  });

  it('test_encoders_outcome_when_broken_then_detail_excerpt_keyed_by_encoder', async () => {
    mockDetect.mockResolvedValue(
      detResult({
        detected: ['libx265'],
        warnings: [
          { code: 'encoder_runtime_broken', severity: 'warn', detail: 'qsv: MFX session: -9' },
        ],
        outcome: {
          nvenc: 'missing',
          qsv: 'compiled-in-broken',
          vaapi: 'missing',
          libx265: 'functional',
        },
        brokenExcerpts: { qsv: 'Error creating a MFX session: -9' },
        forcedIdrSupported: {},
      }),
    );
    const p = await assembleDiagnostics();
    const qsv = p.encoders.outcome.find((o) => o.encoder === 'qsv')!;
    expect(qsv.outcome).toBe('compiled-in-broken');
    expect(qsv.detail).toBe('Error creating a MFX session: -9');
    // non-broken encoders carry no detail
    expect(p.encoders.outcome.find((o) => o.encoder === 'libx265')!.detail).toBeUndefined();
  });

  it('test_encoders_outcome_when_two_broken_then_each_keeps_own_excerpt', async () => {
    mockDetect.mockResolvedValue(
      detResult({
        detected: ['libx265'],
        warnings: [
          {
            code: 'encoder_runtime_broken',
            severity: 'warn',
            detail: 'nvenc: OpenEncodeSessionEx failed',
          },
          { code: 'encoder_runtime_broken', severity: 'warn', detail: 'qsv: MFX session: -9' },
        ],
        outcome: {
          nvenc: 'compiled-in-broken',
          qsv: 'compiled-in-broken',
          vaapi: 'missing',
          libx265: 'functional',
        },
        brokenExcerpts: { nvenc: 'OpenEncodeSessionEx failed', qsv: 'MFX session: -9' },
        forcedIdrSupported: {},
      }),
    );
    const p = await assembleDiagnostics();
    const byEnc = Object.fromEntries(p.encoders.outcome.map((o) => [o.encoder, o.detail]));
    expect(byEnc.nvenc).toBe('OpenEncodeSessionEx failed');
    expect(byEnc.qsv).toBe('MFX session: -9');
  });

  it('test_encoders_when_kill_switch_then_probeEncodeDisabled_true', async () => {
    mockDetect.mockResolvedValue(
      detResult({
        detected: ['nvenc', 'libx265'],
        outcome: {
          nvenc: 'probe-inconclusive',
          qsv: 'missing',
          vaapi: 'missing',
          libx265: 'functional',
        },
        probeEncodeDisabled: true,
      }),
    );
    const p = await assembleDiagnostics();
    expect(p.encoders.probeEncodeDisabled).toBe(true);
    expect(p.encoders.outcome.find((o) => o.encoder === 'nvenc')!.outcome).toBe(
      'probe-inconclusive',
    );
  });

  it('test_encoders_when_detection_throws_then_outcome_empty_array', async () => {
    mockDetect.mockRejectedValue(new Error('probe blew up'));
    const p = await assembleDiagnostics();
    expect(p.encoders).toEqual({ detected: [], warnings: [], outcome: [] });
    // GET still 200-shaped: aggregator surfaces the failure as a warning.
    expect(p.warnings.some((w) => w.code === 'aggregator_source_failed')).toBe(true);
  });
});

// ── 48-01: scanIntegrity block ───────────────────────────────────────────────
describe('aggregator — 48-01 scanIntegrity block', () => {
  const SNAP = {
    startedAtIso: '2026-08-12T09:00:00.000Z',
    finishedAtIso: '2026-08-12T09:00:42.000Z',
    outcome: 'complete' as const,
    rootPath: '/mnt/user/Movies',
    dirsVisited: 546,
    dirsSkippedCycle: 3,
    dirsSkippedUnreadable: 1,
    dirsSkippedMaxDepth: 0,
    cycleSamples: ['/mnt/user/Movies/dupe'],
    unreadableSamples: ['/mnt/user/Movies/locked'],
    sharesFailed: 0,
    byShare: [],
  };

  it('test_scanIntegrity_before_first_scan_then_empty_block', async () => {
    // AC-12: nested lastScan:null — "never scanned" ≠ "scanned, 0 skips".
    mockDetect.mockResolvedValue(detResult());
    mockGetScanIntegrity.mockReturnValue(null);
    const p = await assembleDiagnostics();
    expect(p.scanIntegrity).toEqual({ lastScan: null });
  });

  it('test_scanIntegrity_after_scan_then_carries_store_snapshot', async () => {
    mockDetect.mockResolvedValue(detResult());
    mockGetScanIntegrity.mockReturnValue(SNAP);
    const p = await assembleDiagnostics();
    expect(p.scanIntegrity.lastScan).toEqual(SNAP);
  });

  it('test_scanIntegrity_when_store_throws_then_empty_block_and_payload_still_assembles', async () => {
    // AC-12 double-guard (pattern: renderDevices / pollingShares) — GET
    // /api/diagnostics must stay 200 even if this source blows up.
    mockDetect.mockResolvedValue(detResult());
    mockGetScanIntegrity.mockImplementation(() => {
      throw new Error('store exploded');
    });
    const p = await assembleDiagnostics();
    expect(p.scanIntegrity).toEqual({ lastScan: null });
    expect(p.generatedAt).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 49-03 AC-14: the forced-IDR tri-state. NON-OPTIONAL on every outcome row, so a
// future encoder cannot silently inherit an unstated value.
//
// 'not-probed' is the honest label for every fail-open path. Reporting those as
// 'supported' would claim a runtime confirmation that never happened — the same
// too-optimistic diagnosis this plan exists to remove.
// ─────────────────────────────────────────────────────────────────────────────
describe('aggregator — 49-03 forcedIdr tri-state (AC-14)', () => {
  it('every row carries the field, and an empty verdict maps to not-probed', async () => {
    mockDetect.mockResolvedValue(detResult({ forcedIdrSupported: {} }));
    const p = await assembleDiagnostics();
    expect(p.encoders.outcome).toHaveLength(4);
    for (const row of p.encoders.outcome) expect(row.forcedIdr).toBe('not-probed');
  });

  it('true → supported, false → unsupported, absent → not-probed, per encoder', async () => {
    mockDetect.mockResolvedValue(
      detResult({
        detected: ['nvenc', 'qsv', 'libx265'],
        outcome: {
          nvenc: 'functional',
          qsv: 'functional',
          vaapi: 'missing',
          libx265: 'functional',
        },
        forcedIdrSupported: { nvenc: true, qsv: false },
      }),
    );
    const p = await assembleDiagnostics();
    const byEnc = Object.fromEntries(p.encoders.outcome.map((o) => [o.encoder, o.forcedIdr]));
    expect(byEnc).toEqual({
      nvenc: 'supported',
      qsv: 'unsupported',
      vaapi: 'not-probed',
      libx265: 'not-probed',
    });
  });

  it('a compiled-in-broken row keeps its excerpt AND carries the tri-state', async () => {
    mockDetect.mockResolvedValue(
      detResult({
        outcome: {
          nvenc: 'missing',
          qsv: 'compiled-in-broken',
          vaapi: 'missing',
          libx265: 'functional',
        },
        brokenExcerpts: { qsv: 'Error creating a MFX session: -9' },
        forcedIdrSupported: {},
      }),
    );
    const p = await assembleDiagnostics();
    const qsv = p.encoders.outcome.find((o) => o.encoder === 'qsv')!;
    expect(qsv.detail).toContain('MFX session: -9');
    expect(qsv.forcedIdr).toBe('not-probed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 49-05 AC-4: the QSV ratecontrol tier reaches /api/diagnostics. Same additive
// NON-OPTIONAL shape as forcedIdr above, for the same reason: an optional field
// carries no compile-time obligation and drifts silently. Until now
// `qsvRateControl` was resolved at boot and then visible NOWHERE, which is what
// made "QSV produces 1.1 GB at 22" an unanalysable sentence.
// ─────────────────────────────────────────────────────────────────────────────
describe('aggregator — 49-05 rateControl four-state (AC-4)', () => {
  it('every row carries the field; non-qsv rows are not-applicable', async () => {
    mockDetect.mockResolvedValue(detResult({ qsvRateControl: undefined }));
    const p = await assembleDiagnostics();
    expect(p.encoders.outcome).toHaveLength(4);
    const byEnc = Object.fromEntries(p.encoders.outcome.map((o) => [o.encoder, o.rateControl]));
    expect(byEnc).toEqual({
      nvenc: 'not-applicable',
      qsv: 'unresolved',
      vaapi: 'not-applicable',
      libx265: 'not-applicable',
    });
  });

  it.each(['icq-full', 'cqp'] as const)('a resolved tier (%s) lands on the qsv row', async (rc) => {
    mockDetect.mockResolvedValue(
      detResult({
        detected: ['qsv', 'libx265'],
        outcome: { nvenc: 'missing', qsv: 'functional', vaapi: 'missing', libx265: 'functional' },
        qsvRateControl: rc,
      }),
    );
    const p = await assembleDiagnostics();
    const qsv = p.encoders.outcome.find((o) => o.encoder === 'qsv')!;
    expect(qsv.rateControl).toBe(rc);
    // The tier belongs to qsv alone — no neighbour may borrow it.
    for (const row of p.encoders.outcome.filter((o) => o.encoder !== 'qsv')) {
      expect(row.rateControl).toBe('not-applicable');
    }
  });

  it('a compiled-in-broken qsv row keeps excerpt, forcedIdr AND rateControl', async () => {
    mockDetect.mockResolvedValue(
      detResult({
        outcome: {
          nvenc: 'missing',
          qsv: 'compiled-in-broken',
          vaapi: 'missing',
          libx265: 'functional',
        },
        brokenExcerpts: { qsv: 'Error creating a MFX session: -9' },
        qsvRateControl: undefined,
      }),
    );
    const p = await assembleDiagnostics();
    const qsv = p.encoders.outcome.find((o) => o.encoder === 'qsv')!;
    expect(qsv.detail).toContain('MFX session: -9');
    expect(qsv.rateControl).toBe('unresolved');
  });

  // The field stays 'unresolved' even on a host with no QSV at all — the JSON
  // does not lie about it; markdown-template.ts is where the print is suppressed
  // (AC-4b), so the two decisions stay separable.
  it("a 'missing' qsv row still reports 'unresolved' in the JSON", async () => {
    mockDetect.mockResolvedValue(detResult({ qsvRateControl: undefined }));
    const p = await assembleDiagnostics();
    const qsv = p.encoders.outcome.find((o) => o.encoder === 'qsv')!;
    expect(qsv.outcome).toBe('missing');
    expect(qsv.rateControl).toBe('unresolved');
  });
});
