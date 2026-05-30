// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { renderDiagnosticsMarkdown } from '@/src/lib/diagnostics/markdown-template';
import type { DiagnosticsPayload } from '@/src/lib/diagnostics/types';
import {
  EMPTY_BLOCKLIST_BLOCK_22_00,
  EMPTY_SLOW_REQUESTS_BLOCK_22_01,
  EMPTY_SLOW_QUERIES_BLOCK_22_01,
  EMPTY_WEB_VITALS_BLOCK_22_01,
  NULL_CONTAINER_IMAGE_BLOCK_22_00,
  NULL_CPU_BLOCK_23_05,
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
    cpu: NULL_CPU_BLOCK_23_05,
    blocklist: EMPTY_BLOCKLIST_BLOCK_22_00,
    containerImage: NULL_CONTAINER_IMAGE_BLOCK_22_00,
    slowRequests: EMPTY_SLOW_REQUESTS_BLOCK_22_01,
    slowQueries: EMPTY_SLOW_QUERIES_BLOCK_22_01,
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
            { encoder: 'nvenc', outcome: 'missing' },
            {
              encoder: 'qsv',
              outcome: 'compiled-in-broken',
              detail: 'Error creating a MFX session: -9',
            },
            { encoder: 'vaapi', outcome: 'missing' },
            { encoder: 'libx265', outcome: 'functional' },
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
          outcome: [{ encoder: 'nvenc', outcome: 'probe-inconclusive' }],
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
});
