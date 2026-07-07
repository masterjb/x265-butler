// @vitest-environment node
// 22-00 T4 IMP-14: markdown-template auto-append for Container Image + Blocklist
// Evaluation sections. AC-5 + AC-9 contract.

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
  DEFAULT_CACHE_BLOCK_24_03,
} from '@/tests/diagnostics/fixtures/empty-blocks-22-00';

function fixture(overrides: Partial<DiagnosticsPayload> = {}): DiagnosticsPayload {
  return {
    app: { version: '2.18.0', gitHash: 'dev', committedAt: null, committedAtCET: null },
    runtime: { nodeVersion: 'v20', platform: 'linux', arch: 'x64', uptimeSec: 1, pid: 1 },
    mounts: [],
    devices: { dri: [], nvidia: [], renderDevices: [] },
    encoders: { detected: ['libx265'], warnings: [], outcome: [] },
    warnings: [],
    recentErrors: [],
    onboarding: { completed: true, hasShare: true },
    cache: DEFAULT_CACHE_BLOCK_24_03,
    cpu: NULL_CPU_BLOCK_23_05,
    blocklist: EMPTY_BLOCKLIST_BLOCK_22_00,
    containerImage: NULL_CONTAINER_IMAGE_BLOCK_22_00,
    slowRequests: EMPTY_SLOW_REQUESTS_BLOCK_22_01,
    slowQueries: EMPTY_SLOW_QUERIES_BLOCK_22_01,
    cpuAttribution: EMPTY_CPU_ATTRIBUTION_BLOCK_40_01,
    pollingShares: [],
    webVitals: EMPTY_WEB_VITALS_BLOCK_22_01,
    generatedAt: '2026-05-23T00:00:00.000Z',
    ...overrides,
  };
}

describe('22-00 T4: renderDiagnosticsMarkdown — new sections', () => {
  it('both-sections-present-in-output: render contains `## Container Image` AND `## Blocklist Evaluation` exactly once', () => {
    const md = renderDiagnosticsMarkdown(fixture());
    const ciLines = md.split('\n').filter((l) => l === '## Container Image');
    const beLines = md.split('\n').filter((l) => l === '## Blocklist Evaluation');
    expect(ciLines).toHaveLength(1);
    expect(beLines).toHaveLength(1);
  });

  it('section-order: container-image-heading idx < blocklist-heading idx; both AFTER existing `### Recent errors`', () => {
    const md = renderDiagnosticsMarkdown(fixture());
    const ciIdx = md.indexOf('## Container Image');
    const beIdx = md.indexOf('## Blocklist Evaluation');
    const recentIdx = md.indexOf('### Recent errors');
    expect(recentIdx).toBeGreaterThan(0);
    expect(ciIdx).toBeGreaterThan(recentIdx);
    expect(beIdx).toBeGreaterThan(ciIdx);
  });

  it('null-fields-render-em-dash: all containerImage subfields null → output contains `OS: —` etc., NEVER `null`/`undefined`', () => {
    const md = renderDiagnosticsMarkdown(fixture());
    expect(md).toContain('- OS: —');
    expect(md).toContain('- GLIBC: —');
    expect(md).toContain('- Intel Media Driver: — (—)');
    expect(md).toContain('- libva: —');
    expect(md).toContain('- libdrm: —');
    // 23-00 (B2 / SR-b): oneVPL presence lines + presence≠functional note.
    expect(md).toContain('- oneVPL MFX runtime (libmfx-gen1.2): —');
    expect(md).toContain('- oneVPL dispatcher (libvpl2): —');
    expect(md).toContain('- libigfxcmrt7: —');
    expect(md).toContain(
      'runtime QSV-functionality is verified separately by the probe-encode — 23-04',
    );
    expect(md).toContain('- ffmpeg version: —');
    expect(md).not.toMatch(/\bnull\b/);
    expect(md).not.toMatch(/\bundefined\b/);
  });

  it('23-00: populated oneVPL versions render after libdrm + before ffmpeg version (SR-c raw passthrough)', () => {
    const md = renderDiagnosticsMarkdown(
      fixture({
        containerImage: {
          ...NULL_CONTAINER_IMAGE_BLOCK_22_00,
          drivers: {
            ...NULL_CONTAINER_IMAGE_BLOCK_22_00.drivers,
            oneVpl: {
              libmfxGen1: { version: '25.1.4-1' },
              libvpl: { version: '1:2.14.0-1+b1' },
              libigfxcmrt: { version: '25.2.3+dfsg1-1' },
            },
          },
        },
      }),
    );
    expect(md).toContain('- oneVPL MFX runtime (libmfx-gen1.2): 25.1.4-1');
    expect(md).toContain('- oneVPL dispatcher (libvpl2): 1:2.14.0-1+b1');
    expect(md).toContain('- libigfxcmrt7: 25.2.3+dfsg1-1');
    const libdrmIdx = md.indexOf('- libdrm:');
    const oneVplIdx = md.indexOf('- oneVPL MFX runtime');
    const ffmpegIdx = md.indexOf('- ffmpeg version:');
    expect(libdrmIdx).toBeGreaterThan(0);
    expect(oneVplIdx).toBeGreaterThan(libdrmIdx);
    expect(ffmpegIdx).toBeGreaterThan(oneVplIdx);
  });

  it('empty-blocklist-renders-empty-state: recentEvaluations=[] → output contains `_No recent evaluations._`', () => {
    const md = renderDiagnosticsMarkdown(fixture());
    expect(md).toContain('_No recent evaluations._');
  });

  it('table-render: 3 evaluations → markdown table with header + separator + 3 rows', () => {
    const md = renderDiagnosticsMarkdown(
      fixture({
        blocklist: {
          totalEntries: 3,
          patternCachedAt: '2026-05-23T10:00:00.000Z',
          recentEvaluations: [
            {
              path: '/m/a.mkv',
              matchedEntry: { id: 1, kind: 'path_pattern', pattern: '*.srt' },
              matchedAt: '2026-05-23T08:12:33.000Z',
            },
            { path: '/m/b.mkv', matchedEntry: null, matchedAt: '2026-05-23T08:12:34.000Z' },
            {
              path: '/m/c.mkv',
              matchedEntry: { id: 5, kind: 'file_id' },
              matchedAt: '2026-05-23T08:12:35.000Z',
            },
          ],
        },
      }),
    );
    const tableLines = md.split('\n').filter((l) => l.startsWith('|'));
    expect(tableLines).toHaveLength(5); // header + separator + 3 rows
    expect(tableLines[0]).toContain('Path');
    expect(tableLines[2]).toContain('/m/a.mkv');
    expect(tableLines[2]).toContain('*.srt');
    expect(tableLines[3]).toContain('PASS');
    expect(tableLines[4]).toContain('id:5');
  });

  it('AC-9 regression-sentinel: `## Blocklist Evaluation` first non-blank body line is the disclosure-comment', () => {
    const md = renderDiagnosticsMarkdown(fixture());
    const lines = md.split('\n');
    const heading = lines.findIndex((l) => l === '## Blocklist Evaluation');
    expect(heading).toBeGreaterThan(0);
    // Find first non-blank line after heading
    let firstBody = -1;
    for (let i = heading + 1; i < lines.length; i++) {
      if (lines[i].trim().length > 0) {
        firstBody = i;
        break;
      }
    }
    expect(firstBody).toBeGreaterThan(heading);
    expect(lines[firstBody]).toBe(
      '<!-- Operator: paths below are verbatim. Redact mount/user prefixes before posting if sensitive. -->',
    );
  });
});
