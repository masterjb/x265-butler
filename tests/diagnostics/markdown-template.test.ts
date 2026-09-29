// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { renderDiagnosticsMarkdown } from '@/src/lib/diagnostics/markdown-template';
import type { DiagnosticsPayload } from '@/src/lib/diagnostics/types';
import {
  EMPTY_BLOCKLIST_BLOCK_22_00,
  EMPTY_SLOW_REQUESTS_BLOCK_22_01,
  EMPTY_SLOW_QUERIES_BLOCK_22_01,
  EMPTY_CPU_ATTRIBUTION_BLOCK_40_01,
  EMPTY_WEB_VITALS_BLOCK_22_01,
  NULL_CONTAINER_IMAGE_BLOCK_22_00,
  NULL_CPU_BLOCK_23_05,
  EMPTY_NVIDIA_GPU_BLOCK_46_02,
  DEFAULT_CACHE_BLOCK_24_03,
  EMPTY_SCAN_INTEGRITY_48_01,
} from '@/tests/diagnostics/fixtures/empty-blocks-22-00';

function fixturePayload(overrides: Partial<DiagnosticsPayload> = {}): DiagnosticsPayload {
  return {
    app: {
      version: '2.17.2',
      gitHash: 'd5e68bc',
      committedAt: 0,
      committedAtCET: null,
    },
    runtime: {
      nodeVersion: 'v20.10.0',
      platform: 'linux',
      arch: 'x64',
      uptimeSec: 123,
      pid: 42,
    },
    mounts: [
      { path: '/media', readable: true, writable: true },
      { path: '/cache', readable: false, writable: false, error: 'ENOENT' },
    ],
    devices: { dri: ['/dev/dri/renderD128'], nvidia: [], renderDevices: [] },
    encoders: {
      detected: ['libx265'],
      warnings: [{ code: 'vainfo_binary_missing', message: 'vainfo not installed' }],
      outcome: [],
    },
    warnings: [
      {
        severity: 'error',
        source: 'mount',
        code: 'ENOENT',
        message: '/cache readable=false writable=false error=ENOENT',
      },
    ],
    recentErrors: [{ ts: 1700000000000, level: 50, msg: 'sample error', source: 'test' }],
    onboarding: { completed: true, hasShare: true },
    cache: DEFAULT_CACHE_BLOCK_24_03,
    cpu: NULL_CPU_BLOCK_23_05,
    nvidiaGpu: EMPTY_NVIDIA_GPU_BLOCK_46_02,
    blocklist: EMPTY_BLOCKLIST_BLOCK_22_00,
    containerImage: NULL_CONTAINER_IMAGE_BLOCK_22_00,
    slowRequests: EMPTY_SLOW_REQUESTS_BLOCK_22_01,
    slowQueries: EMPTY_SLOW_QUERIES_BLOCK_22_01,
    cpuAttribution: EMPTY_CPU_ATTRIBUTION_BLOCK_40_01,
    pollingShares: [],
    scanIntegrity: EMPTY_SCAN_INTEGRITY_48_01,
    webVitals: EMPTY_WEB_VITALS_BLOCK_22_01,
    generatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('renderDiagnosticsMarkdown', () => {
  it('matches snapshot for fixture payload', () => {
    const md = renderDiagnosticsMarkdown(fixturePayload());
    expect(md).toMatchInlineSnapshot(`
      "## x265-butler diagnostics report

      ### App
      - version: \`2.17.2\`
      - gitHash: \`d5e68bc\`
      - committedAt: \`0\`
      - committedAtCET: _unset_

      ### Runtime
      - nodeVersion: \`v20.10.0\`
      - platform: \`linux\`
      - arch: \`x64\`
      - uptimeSec: 123
      - pid: 42

      ### Mounts
      | path | readable | writable | error |
      |---|---|---|---|
      | \`/media\` | ✓ | ✓ |  |
      | \`/cache\` | ✗ | ✗ | ENOENT |

      ### Cache
      - effectivePath: \`/mnt/cache/x265-butler\`
      - resolution: \`mnt-cache\`
      - settingValue: (auto)
      - writable: ✓

      ### Devices
      - DRI: \`/dev/dri/renderD128\`
      - NVIDIA: _none_

      ### Encoders
      - detected: \`libx265\`
      - detection warnings:
        - \`vainfo_binary_missing\` — vainfo not installed

      ### Active warnings
      - **ERROR** \`mount:ENOENT\` — /cache readable=false writable=false error=ENOENT

      ### Recent errors (in-memory, last ≤25)
      \`\`\`
      2023-11-14T22:13:20.000Z L50 [test] sample error
      \`\`\`

      ### Onboarding
      - completed: ✓
      - hasShare: ✓

      ## Container Image
      - OS: —
      - GLIBC: —
      - Intel Media Driver: — (—)
      - libva: —
      - libdrm: —
      - oneVPL MFX runtime (libmfx-gen1.2): —
      - oneVPL dispatcher (libvpl2): —
      - libigfxcmrt7: —
      - _(oneVPL versions report installed-package presence; runtime QSV-functionality is verified separately by the probe-encode — 23-04)_
      - ffmpeg version: —

      <details>
      <summary>ffmpeg configuration flags</summary>

      \`\`\`
      —
      \`\`\`

      </details>

      ## CPU
      - Vendor: —
      - Model name: —
      - CPUID family/model: — / —
      - Microarch: —
      - Graphics gen: —
      - HEVC-QSV (hardware): unknown
      - _(HEVC-QSV reflects iGPU HARDWARE capability by the embedded gen-table; runtime QSV functionality is verified separately by the probe-encode — 23-04)_

      ## NVIDIA GPU
      _nvidia-smi not present (no NVIDIA toolkit)._

      ## Blocklist Evaluation
      <!-- Operator: paths below are verbatim. Redact mount/user prefixes before posting if sensitive. -->

      - Total entries: 0
      - Pattern cache: —

      _No recent evaluations._

      ## Slow Requests

      _No slow requests recorded (threshold: 1s)._

      ## Slow Queries

      _No slow queries recorded (threshold: 100ms)._

      ## Web Vitals

      _No web vitals recorded._

      ## DRI Render Devices

      _No render devices found (no /dev/dri)._

      ## CPU Attribution

      _No CPU attribution samples recorded._

      ## Forced-polling shares

      _No forced-polling shares (all inotify) — stat-storm not applicable._

      ## Scan Integrity

      _No scan has completed in this process yet._
      "
    `);
  });

  it('output size < 32 KB even with full ring-buffer + 50 warnings', () => {
    const recentErrors = Array.from({ length: 25 }, (_, i) => ({
      ts: 1700000000000 + i,
      level: 50,
      msg: 'x'.repeat(500),
      source: 'test-source',
    }));
    const warnings = Array.from({ length: 50 }, (_, i) => ({
      severity: 'warn' as const,
      source: 'encoder' as const,
      code: `code-${i}`,
      message: 'm'.repeat(200),
    }));
    const md = renderDiagnosticsMarkdown(fixturePayload({ recentErrors, warnings }));
    expect(md.length).toBeLessThan(32 * 1024);
  });

  it('no operator-secret tokens present', () => {
    const md = renderDiagnosticsMarkdown(fixturePayload());
    expect(md).not.toMatch(/password/i);
    expect(md).not.toMatch(/session_secret/i);
    expect(md).not.toMatch(/\btoken\b/i);
    expect(md).not.toMatch(/\bcookie\b/i);
  });

  it('handles empty mounts gracefully', () => {
    const md = renderDiagnosticsMarkdown(fixturePayload({ mounts: [] }));
    expect(md).toContain('_no mounts probed_');
  });

  it('handles empty recentErrors and warnings', () => {
    const md = renderDiagnosticsMarkdown(fixturePayload({ recentErrors: [], warnings: [] }));
    expect(md).toContain('_no warnings_');
    expect(md).toContain('_no recent errors_');
  });

  // 23-04: per-encoder probe outcome rendering.
  it('renders per-encoder probe outcomes with broken excerpt', () => {
    const md = renderDiagnosticsMarkdown(
      fixturePayload({
        encoders: {
          detected: ['libx265'],
          warnings: [],
          outcome: [
            {
              encoder: 'nvenc',
              outcome: 'missing',
              forcedIdr: 'not-probed',
              rateControl: 'not-applicable',
            },
            {
              encoder: 'qsv',
              outcome: 'compiled-in-broken',
              detail: 'Error creating a MFX session: -9',
              forcedIdr: 'not-probed',
              rateControl: 'unresolved',
            },
            {
              encoder: 'vaapi',
              outcome: 'missing',
              forcedIdr: 'not-probed',
              rateControl: 'not-applicable',
            },
            {
              encoder: 'libx265',
              outcome: 'functional',
              forcedIdr: 'not-probed',
              rateControl: 'not-applicable',
            },
          ],
        },
      }),
    );
    expect(md).toContain('- probe outcomes:');
    expect(md).toContain('`qsv`: compiled-in-broken — `Error creating a MFX session: -9`');
    expect(md).toContain('`libx265`: functional');
  });

  // 23-04 (audit SR2/AC-12): kill-switch must be visible in the report.
  it('flags the probe-encode gate as DISABLED when probeEncodeDisabled', () => {
    const md = renderDiagnosticsMarkdown(
      fixturePayload({
        encoders: {
          detected: ['nvenc', 'libx265'],
          warnings: [],
          outcome: [
            {
              encoder: 'nvenc',
              outcome: 'probe-inconclusive',
              forcedIdr: 'not-probed',
              rateControl: 'not-applicable',
            },
          ],
          probeEncodeDisabled: true,
        },
      }),
    );
    expect(md).toContain('probe-encode gate DISABLED');
    expect(md).toContain('NOT runtime-verified');
  });

  it('null committedAt rendered as _unset_', () => {
    const md = renderDiagnosticsMarkdown(
      fixturePayload({
        app: { version: '2.17.2', gitHash: 'dev', committedAt: null, committedAtCET: null },
      }),
    );
    expect(md).toContain('committedAt: _unset_');
  });

  // 24-03 (F2, AC-4): cache section is an H3 sub-section (### Cache, NOT ## Cache)
  // placed between Mounts and Devices; `(auto)` when settingValue is null.
  it('renders `### Cache` (H3, mount-adjacent) with auto settingValue', () => {
    const md = renderDiagnosticsMarkdown(fixturePayload());
    expect(md).toContain('### Cache');
    expect(md).not.toMatch(/^## Cache$/m); // must NOT be a top-level H2
    expect(md).toContain('- effectivePath: `/mnt/cache/x265-butler`');
    expect(md).toContain('- resolution: `mnt-cache`');
    expect(md).toContain('- settingValue: (auto)');
    expect(md.indexOf('### Cache')).toBeLessThan(md.indexOf('### Devices'));
    expect(md.indexOf('### Mounts')).toBeLessThan(md.indexOf('### Cache'));
  });

  it('AC-6: config-fallback renders the amber space advisory', () => {
    const md = renderDiagnosticsMarkdown(
      fixturePayload({
        cache: {
          effectivePath: '/config/cache',
          resolution: 'config-fallback',
          settingValue: null,
          writable: true,
          advisory: 'config-fallback-space',
        },
      }),
    );
    expect(md).toContain('- resolution: `config-fallback`');
    expect(md).toContain('config-fallback: no dedicated cache mount detected');
    expect(md).toContain('DB corruption');
  });

  // 46-02 (D2, AC-5): NVIDIA GPU section renders each GPU name + driver.
  it('renders `## NVIDIA GPU` with one line per GPU, positioned after `## CPU`', () => {
    const md = renderDiagnosticsMarkdown(
      fixturePayload({
        nvidiaGpu: {
          source: 'present',
          gpus: [
            { name: 'Tesla P4', driverVersion: '580.159.04' },
            { name: 'NVIDIA GeForce GT 730', driverVersion: '470.256.02' },
          ],
        },
      }),
    );
    expect(md).toContain('## NVIDIA GPU');
    expect(md).toContain('- Tesla P4 — driver 580.159.04');
    expect(md).toContain('- NVIDIA GeForce GT 730 — driver 470.256.02');
    // positioned immediately after ## CPU (before ## Blocklist Evaluation).
    expect(md.indexOf('## CPU')).toBeLessThan(md.indexOf('## NVIDIA GPU'));
    expect(md.indexOf('## NVIDIA GPU')).toBeLessThan(md.indexOf('## Blocklist Evaluation'));
  });

  // 46-02 (D2, AC-8, SR-2): every NvidiaGpuSource empty case → a distinct
  // non-empty fallback (never a raw dotted key), no GPU rows.
  it('renders a distinct fallback line for each empty NvidiaGpuSource', () => {
    const cases: Array<[import('@/src/lib/diagnostics/types').NvidiaGpuSource, string]> = [
      ['binary_missing', '_nvidia-smi not present (no NVIDIA toolkit)._'],
      ['no_gpu', '_No NVIDIA GPU detected._'],
      ['timeout', '_nvidia-smi probe timed out._'],
      ['error', '_nvidia-smi probe failed._'],
      ['present', '_No NVIDIA GPU detected._'], // present-but-zero reuses no_gpu copy
    ];
    for (const [source, expected] of cases) {
      const md = renderDiagnosticsMarkdown(fixturePayload({ nvidiaGpu: { source, gpus: [] } }));
      expect(md).toContain('## NVIDIA GPU');
      expect(md).toContain(expected);
      expect(md).not.toMatch(/nvidiaGpu\.source/); // no raw dotted key
    }
  });

  it('user-override renders settingValue verbatim and NO advisory', () => {
    const md = renderDiagnosticsMarkdown(
      fixturePayload({
        cache: {
          effectivePath: '/mnt/disks/nvme/cache',
          resolution: 'user-override',
          settingValue: '/mnt/disks/nvme/cache',
          writable: true,
          advisory: null,
        },
      }),
    );
    expect(md).toContain('- settingValue: `/mnt/disks/nvme/cache`');
    expect(md).not.toContain('config-fallback: no dedicated cache mount');
  });
});

// ── 48-01: Scan Integrity section ───────────────────────────────────────────
describe('markdown — 48-01 Scan Integrity', () => {
  const CLEAN_SCAN = {
    startedAtIso: '2026-08-12T09:00:00.000Z',
    finishedAtIso: '2026-08-12T09:00:42.000Z',
    outcome: 'complete' as const,
    rootPath: '/mnt/user/Movies',
    dirsVisited: 546,
    dirsSkippedCycle: 0,
    dirsSkippedUnreadable: 0,
    dirsSkippedMaxDepth: 0,
    dirsSkippedSystemPrefix: 0,
    cycleSamples: [],
    unreadableSamples: [],
    systemPrefixSamples: [],
    sharesFailed: 0,
    byShare: [],
  };

  it('renders an explicit line when no scan has run yet', () => {
    // AC-13: a MISSING section is indistinguishable from an old container build
    // and therefore worthless as evidence — both states render.
    const md = renderDiagnosticsMarkdown(fixturePayload({ scanIntegrity: { lastScan: null } }));
    expect(md).toContain('## Scan Integrity');
    expect(md).toContain('_No scan has completed in this process yet._');
  });

  it('renders a positive confirmation when the scan skipped nothing', () => {
    const md = renderDiagnosticsMarkdown(
      fixturePayload({ scanIntegrity: { lastScan: CLEAN_SCAN } }),
    );
    expect(md).toContain(
      '- directories visited: 546 · skipped: cycle 0, unreadable 0, max-depth 0, system-prefix 0',
    );
    expect(md).toContain('- no directories were skipped');
    // audit-added S6: the max-depth semantics must not read as "3 missing".
    expect(md).toContain('max-depth counts TRUNCATED ROOTS');
  });

  it('renders counters and samples when directories were skipped', () => {
    const md = renderDiagnosticsMarkdown(
      fixturePayload({
        scanIntegrity: {
          lastScan: {
            ...CLEAN_SCAN,
            dirsSkippedCycle: 3,
            dirsSkippedUnreadable: 2,
            dirsSkippedMaxDepth: 1,
            cycleSamples: ['/mnt/user/Movies/dupe'],
            unreadableSamples: ['/mnt/user/Movies/locked'],
          },
        },
      }),
    );
    expect(md).toContain(
      '- directories visited: 546 · skipped: cycle 3, unreadable 2, max-depth 1, system-prefix 0',
    );
    expect(md).toContain('  - `/mnt/user/Movies/dupe`');
    expect(md).toContain('  - `/mnt/user/Movies/locked`');
    expect(md).not.toContain('- no directories were skipped');
    // audit-added S5: raw filesystem paths in a forum-paste surface carry the
    // SAME redaction notice as the blocklist path table.
    expect(md).toContain(
      '<!-- Operator: paths below are verbatim. Redact mount/user prefixes before posting if sensitive. -->',
    );
  });

  it('flags a FAILED scan explicitly', () => {
    // audit-added M1: an aborted run must never read like a clean one.
    const md = renderDiagnosticsMarkdown(
      fixturePayload({
        scanIntegrity: {
          lastScan: { ...CLEAN_SCAN, outcome: 'failed', dirsVisited: 0, sharesFailed: 1 },
        },
      }),
    );
    expect(md).toContain('the last scan FAILED');
    expect(md).toContain('1 share(s) threw during this scan');
  });

  it('renders the per-share table and marks a multi-share root as such', () => {
    // audit-added M4: top-level rootPath is null in multi-share mode.
    const md = renderDiagnosticsMarkdown(
      fixturePayload({
        scanIntegrity: {
          lastScan: {
            ...CLEAN_SCAN,
            rootPath: null,
            sharesFailed: 1,
            byShare: [
              {
                shareId: 1,
                name: 'Movies',
                rootPath: '/mnt/user/Movies',
                failed: false,
                dirsVisited: 546,
                dirsSkippedCycle: 0,
                dirsSkippedUnreadable: 0,
                dirsSkippedMaxDepth: 0,
                dirsSkippedSystemPrefix: 0,
              },
              {
                shareId: 2,
                name: 'Series',
                rootPath: '/mnt/user/Series',
                failed: true,
                dirsVisited: 0,
                dirsSkippedCycle: 0,
                dirsSkippedUnreadable: 0,
                dirsSkippedMaxDepth: 0,
                dirsSkippedSystemPrefix: 0,
              },
            ],
          },
        },
      }),
    );
    expect(md).toContain('root: _multi-share_');
    expect(md).toContain('| Movies | `/mnt/user/Movies` | no | 546 | 0 | 0 | 0 | 0 |');
    expect(md).toContain('| Series | `/mnt/user/Series` | ⚠️ yes | 0 | 0 | 0 | 0 | 0 |');
  });
});

// ── 48-02 (D1=C): the prune counter must be READABLE, not just present ───────
describe('markdown — 48-02 system-prefix prune counter', () => {
  const CLEAN_SCAN = {
    startedAtIso: '2026-08-14T09:00:00.000Z',
    finishedAtIso: '2026-08-14T09:00:42.000Z',
    outcome: 'complete' as const,
    rootPath: '/',
    dirsVisited: 546,
    dirsSkippedCycle: 0,
    dirsSkippedUnreadable: 0,
    dirsSkippedMaxDepth: 0,
    dirsSkippedSystemPrefix: 0,
    cycleSamples: [],
    unreadableSamples: [],
    systemPrefixSamples: [],
    sharesFailed: 0,
    byShare: [],
  };

  it('renders the system-prefix count in the skipped-counters line', () => {
    const md = renderDiagnosticsMarkdown(
      fixturePayload({
        scanIntegrity: { lastScan: { ...CLEAN_SCAN, dirsSkippedSystemPrefix: 4 } },
      }),
    );
    expect(md).toContain(
      '- directories visited: 546 · skipped: cycle 0, unreadable 0, max-depth 0, system-prefix 4',
    );
  });

  it('keeps the 48-01 loss signal intact when ONLY system prefixes were pruned', () => {
    // AC-18: a DELIBERATE prune is not integrity loss. Folding it into
    // `anySkips` would make every scan of a '/'-rooted install read as
    // "directories were skipped" forever and retrain the reader to ignore it.
    const md = renderDiagnosticsMarkdown(
      fixturePayload({
        scanIntegrity: { lastScan: { ...CLEAN_SCAN, dirsSkippedSystemPrefix: 4 } },
      }),
    );
    expect(md).toContain('- no directories were skipped');
    expect(md).toContain('system-prefix 4');
  });

  it('renders 0 explicitly — an absent field is indistinguishable from an old build', () => {
    const md = renderDiagnosticsMarkdown(
      fixturePayload({ scanIntegrity: { lastScan: CLEAN_SCAN } }),
    );
    expect(md).toContain('system-prefix 0');
  });

  it('renders a System-prefix COLUMN in the per-share table', () => {
    // AC-9 (audit M5): a per-share counter that reaches the payload but never
    // renders is not evidence.
    const md = renderDiagnosticsMarkdown(
      fixturePayload({
        scanIntegrity: {
          lastScan: {
            ...CLEAN_SCAN,
            rootPath: null,
            dirsSkippedSystemPrefix: 4,
            byShare: [
              {
                shareId: 1,
                name: 'Everything',
                rootPath: '/',
                failed: false,
                dirsVisited: 546,
                dirsSkippedCycle: 0,
                dirsSkippedUnreadable: 0,
                dirsSkippedMaxDepth: 0,
                dirsSkippedSystemPrefix: 4,
              },
            ],
          },
        },
      }),
    );
    expect(md).toContain(
      '| Share | Root | Failed | Visited | Cycle | Unreadable | Max-depth | System-prefix |',
    );
    expect(md).toContain('|---|---|---|---|---|---|---|---|');
    expect(md).toContain('| Everything | `/` | no | 546 | 0 | 0 | 0 | 4 |');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 49-03 AC-14: the copy-report carries the forced-IDR verdict — the evidence the
// NEXT forum report will be judged on. Only rows where something was actually
// established are printed; a 'not-probed' line per encoder would be noise on
// every single report.
// ─────────────────────────────────────────────────────────────────────────────
describe('renderDiagnosticsMarkdown — 49-03 forced-IDR verdict', () => {
  const rows = (
    forced: Record<string, 'supported' | 'unsupported' | 'not-probed'>,
  ): ReturnType<typeof fixturePayload> =>
    fixturePayload({
      encoders: {
        detected: ['qsv', 'libx265'],
        warnings: [],
        outcome: Object.entries(forced).map(([encoder, forcedIdr]) => ({
          encoder,
          outcome: 'functional' as const,
          forcedIdr,
          // 49-05: this block is about forcedIdr only — pin the neighbouring
          // field to the neutral value so it prints nothing here.
          rateControl: 'not-applicable' as const,
        })),
      },
    });

  it('prints nothing when every row is not-probed', () => {
    const md = renderDiagnosticsMarkdown(rows({ qsv: 'not-probed', libx265: 'not-probed' }));
    expect(md).not.toContain('closed-GOP (forced-IDR) support');
  });

  it('prints an accepted row plainly', () => {
    const md = renderDiagnosticsMarkdown(rows({ qsv: 'supported', libx265: 'not-probed' }));
    expect(md).toContain('- closed-GOP (forced-IDR) support:');
    expect(md).toContain('`qsv`: runtime accepted the forced-IDR option');
    expect(md).not.toContain('`libx265`: runtime');
  });

  it('a rejected row carries a warning sign AND the consequence', () => {
    const md = renderDiagnosticsMarkdown(rows({ qsv: 'unsupported', libx265: 'not-probed' }));
    expect(md).toContain('⚠️ `qsv`: runtime REJECTED the forced-IDR option');
    expect(md).toContain('auto-degraded to open GOPs');
    expect(md).toContain('does NOT apply on this host');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 49-05 AC-4 + AC-4b: the copy-report carries the QSV ratecontrol tier.
// Two print rules, both deliberate:
//   - 'not-applicable' rows never print (libx265/nvenc/vaapi have no tier).
//   - an 'unresolved' row whose own outcome is 'missing' never prints either:
//     that host has no QSV at all, and an alarming line about absent hardware
//     would be new noise in the very artefact 49-05 exists to make analysable.
// The 'unresolved' line that DOES print carries the consequence, not the label:
// the encode still falls back to -global_quality, so the stored crf_qsv value is
// being read on the ICQ scale.
// ─────────────────────────────────────────────────────────────────────────────
describe('renderDiagnosticsMarkdown — 49-05 QSV ratecontrol tier', () => {
  type Rc = 'icq-full' | 'cqp' | 'unresolved' | 'not-applicable';
  type Oc = 'functional' | 'compiled-in-broken' | 'probe-inconclusive' | 'missing';

  const withQsv = (rateControl: Rc, outcome: Oc) =>
    fixturePayload({
      encoders: {
        detected: ['libx265'],
        warnings: [],
        outcome: [
          { encoder: 'qsv', outcome, forcedIdr: 'not-probed', rateControl },
          {
            encoder: 'libx265',
            outcome: 'functional',
            forcedIdr: 'not-probed',
            rateControl: 'not-applicable',
          },
        ],
      },
    });

  it('prints nothing when every row is not-applicable', () => {
    const md = renderDiagnosticsMarkdown(withQsv('not-applicable', 'missing'));
    expect(md).not.toContain('QSV ratecontrol tier');
  });

  it('icq-full names the flag it emits', () => {
    const md = renderDiagnosticsMarkdown(withQsv('icq-full', 'functional'));
    expect(md).toContain('- QSV ratecontrol tier:');
    expect(md).toContain('`icq-full`');
    expect(md).toContain('-global_quality');
    expect(md).not.toContain('-q:v');
  });

  it('cqp names the flag it emits', () => {
    const md = renderDiagnosticsMarkdown(withQsv('cqp', 'functional'));
    expect(md).toContain('`cqp`');
    expect(md).toContain('-q:v');
  });

  // AC-4: unresolved must be readable AS unresolved — not disguised as a default
  // — and must carry the consequence, including the fallback that really ships.
  it.each(['functional', 'probe-inconclusive'] as const)(
    "unresolved on a '%s' qsv row prints the consequence AND the fallback",
    (outcome) => {
      const md = renderDiagnosticsMarkdown(withQsv('unresolved', outcome));
      expect(md).toContain('- QSV ratecontrol tier:');
      expect(md).toContain('UNRESOLVED');
      expect(md).toContain('-global_quality');
      expect(md).toContain('ICQ scale');
    },
  );

  // AC-4b: an AMD / NVIDIA host must not carry an alarming QSV line.
  it("unresolved on a 'missing' qsv row prints NOTHING", () => {
    const md = renderDiagnosticsMarkdown(withQsv('unresolved', 'missing'));
    expect(md).not.toContain('QSV ratecontrol tier');
    expect(md).not.toContain('UNRESOLVED');
  });

  it('the suppression is a print decision only — the payload still says unresolved', () => {
    const payload = withQsv('unresolved', 'missing');
    expect(payload.encoders.outcome.find((o) => o.encoder === 'qsv')?.rateControl).toBe(
      'unresolved',
    );
  });
});
