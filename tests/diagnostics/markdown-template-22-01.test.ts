// @vitest-environment node
// 22-01 T4 IMP-4: heading-order regression-sentinel + section-presence.
// Pins H2-order:
//   ## Container Image < ## Blocklist Evaluation < ## Slow Requests
//   < ## Slow Queries < ## Web Vitals
// Future P22-02..P22-04 sections must APPEND; reordering any existing 6 = release-blocking.

import { describe, it, expect } from 'vitest';
import { renderDiagnosticsMarkdown } from '@/src/lib/diagnostics/markdown-template';
import {
  EMPTY_BLOCKLIST_BLOCK_22_00,
  EMPTY_SLOW_QUERIES_BLOCK_22_01,
  EMPTY_CPU_ATTRIBUTION_BLOCK_40_01,
  EMPTY_SLOW_REQUESTS_BLOCK_22_01,
  EMPTY_WEB_VITALS_BLOCK_22_01,
  NULL_CONTAINER_IMAGE_BLOCK_22_00,
  NULL_CPU_BLOCK_23_05,
  DEFAULT_CACHE_BLOCK_24_03,
} from '@/tests/diagnostics/fixtures/empty-blocks-22-00';
import type { DiagnosticsPayload } from '@/src/lib/diagnostics/types';

function fixture(): DiagnosticsPayload {
  return {
    app: { version: '2.18.1', gitHash: 'dev', committedAt: null, committedAtCET: null },
    runtime: { nodeVersion: 'v20', platform: 'linux', arch: 'x64', uptimeSec: 1, pid: 1 },
    mounts: [],
    devices: { dri: [], nvidia: [], renderDevices: [] },
    encoders: { detected: [], warnings: [], outcome: [] },
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
    generatedAt: '2026-05-24T10:00:00.000Z',
  };
}

// audit-SR8: semantic order assertion (NOT exact-equality with set of 6).
// Future P22-02..P22-04 section-appends preserve test passing while reordering
// any existing 6 = release-blocking-regression.
function assertSectionOrderContains(md: string, sections: string[]): void {
  let cursor = 0;
  for (const section of sections) {
    const idx = md.indexOf(`\n${section}\n`, cursor);
    expect(idx, `expected to find "${section}" after pos ${cursor}`).toBeGreaterThanOrEqual(0);
    cursor = idx + section.length;
  }
}

describe('22-01 T4: markdown heading-order regression-sentinel', () => {
  it('AC-9: H2 order = Container Image < Blocklist Evaluation < Slow Requests < Slow Queries < Web Vitals', () => {
    const md = renderDiagnosticsMarkdown(fixture());
    assertSectionOrderContains(md, [
      '## Container Image',
      '## Blocklist Evaluation',
      '## Slow Requests',
      '## Slow Queries',
      '## Web Vitals',
    ]);
  });

  it('all 3 new sections emit empty-state when topN/byRoute is empty', () => {
    const md = renderDiagnosticsMarkdown(fixture());
    expect(md).toContain('_No slow requests recorded (threshold: 1s)._');
    expect(md).toContain('_No slow queries recorded (threshold: 100ms)._');
    expect(md).toContain('_No web vitals recorded._');
  });

  it('renders Web Vitals table when byRoute populated', () => {
    const p = fixture();
    p.webVitals = {
      byRoute: {
        '/library': {
          ttfb: { p75: 320, sampleSize: 12 },
          lcp: { p75: 1200, sampleSize: 12 },
          inp: { p75: 50, sampleSize: 12 },
        },
      },
      tailLimit: 500,
      sampleCapPerRoute: 50,
    };
    const md = renderDiagnosticsMarkdown(p);
    expect(md).toContain('| Route | TTFB p75 (ms) | LCP p75 (ms) | INP p75 (ms) | Samples |');
    expect(md).toContain('| `/library` | 320 | 1200 | 50 | 12 |');
  });
});
