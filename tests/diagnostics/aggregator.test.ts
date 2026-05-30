// @vitest-environment node
//
// 23-04: assembleDiagnostics maps DetectionResult.outcome + brokenExcerpts +
// probeEncodeDisabled into the EncoderBlock. Excerpt is keyed BY ENCODER
// (audit M2 — multiple broken encoders share the identical warning code).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DetectionResult } from '@/src/lib/encode/detection';

const { mockDetect } = vi.hoisted(() => ({ mockDetect: vi.fn() }));

vi.mock('@/src/lib/encode', () => ({
  detectEncoders: mockDetect,
  ENCODER_IDS: ['nvenc', 'qsv', 'vaapi', 'libx265'],
}));

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
    probeEncodeDisabled: false,
    ...over,
  };
}

beforeEach(() => {
  mockDetect.mockReset();
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
