// @vitest-environment node
// 23-02 T2 — `## DRI Render Devices` markdown sentinel (AC-6).
// Pins the section as the TRAILING H2 (after `## Web Vitals`) and asserts the
// full append-order chain. Future sections must APPEND after this one.

import { describe, it, expect } from 'vitest';
import { renderDiagnosticsMarkdown } from '@/src/lib/diagnostics/markdown-template';
import {
  EMPTY_BLOCKLIST_BLOCK_22_00,
  EMPTY_SLOW_QUERIES_BLOCK_22_01,
  EMPTY_SLOW_REQUESTS_BLOCK_22_01,
  EMPTY_WEB_VITALS_BLOCK_22_01,
  NULL_CONTAINER_IMAGE_BLOCK_22_00,
  NULL_CPU_BLOCK_23_05,
} from '@/tests/diagnostics/fixtures/empty-blocks-22-00';
import type { DiagnosticsPayload, RenderDeviceProbe } from '@/src/lib/diagnostics/types';

function fixture(renderDevices: RenderDeviceProbe[]): DiagnosticsPayload {
  return {
    app: { version: '2.19.2', gitHash: 'dev', committedAt: null, committedAtCET: null },
    runtime: { nodeVersion: 'v20', platform: 'linux', arch: 'x64', uptimeSec: 1, pid: 1 },
    mounts: [],
    devices: { dri: [], nvidia: [], renderDevices },
    encoders: { detected: [], warnings: [], outcome: [] },
    warnings: [],
    recentErrors: [],
    onboarding: { completed: true, hasShare: true },
    cpu: NULL_CPU_BLOCK_23_05,
    blocklist: EMPTY_BLOCKLIST_BLOCK_22_00,
    containerImage: NULL_CONTAINER_IMAGE_BLOCK_22_00,
    slowRequests: EMPTY_SLOW_REQUESTS_BLOCK_22_01,
    slowQueries: EMPTY_SLOW_QUERIES_BLOCK_22_01,
    webVitals: EMPTY_WEB_VITALS_BLOCK_22_01,
    generatedAt: '2026-05-30T10:00:00.000Z',
  };
}

const NODE_IN_GROUP: RenderDeviceProbe = {
  path: '/dev/dri/renderD128',
  exists: true,
  gid: 105,
  groupName: 'render',
  processGroups: [44, 105],
  processGid: 1000,
  inRenderGroup: true,
  readable: true,
  writable: true,
};

const NODE_MISMATCH: RenderDeviceProbe = {
  path: '/dev/dri/renderD129',
  exists: true,
  gid: 106,
  groupName: null,
  processGroups: [44, 105],
  processGid: 1000,
  inRenderGroup: false,
  readable: true,
  writable: false,
};

describe('23-02 T2: DRI Render Devices markdown sentinel', () => {
  it('AC-6: section present and ordered as the TRAILING H2 after Web Vitals', () => {
    const md = renderDiagnosticsMarkdown(fixture([]));
    expect(md).toContain('## DRI Render Devices');
    expect(md.indexOf('## DRI Render Devices')).toBeGreaterThan(md.indexOf('## Web Vitals'));
  });

  it('AC-6: full append-order chain is preserved (DRI Render Devices last)', () => {
    const md = renderDiagnosticsMarkdown(fixture([]));
    const order = [
      '## Container Image',
      '## Blocklist Evaluation',
      '## Slow Requests',
      '## Slow Queries',
      '## Web Vitals',
      '## DRI Render Devices',
    ];
    let cursor = 0;
    for (const section of order) {
      const idx = md.indexOf(`\n${section}\n`, cursor);
      expect(idx, `expected "${section}" after pos ${cursor}`).toBeGreaterThanOrEqual(0);
      cursor = idx + section.length;
    }
  });

  it('populated fixture → table renders gid/group/✓✗ rows + remediation note', () => {
    const md = renderDiagnosticsMarkdown(fixture([NODE_IN_GROUP, NODE_MISMATCH]));
    expect(md).toContain('| Device | GID | Group | In group | R | W | Error |');
    expect(md).toContain('`/dev/dri/renderD128`');
    expect(md).toContain('| 105 | render | ✓ | ✓ | ✓ |');
    // mismatch node: gid present, no group name (—), ✗ in-group, not writable
    expect(md).toContain('`/dev/dri/renderD129`');
    expect(md).toContain('| 106 | — | ✗ | ✓ | ✗ |');
    expect(md).toContain('PGID=<gid>');
    expect(md).toContain('--group-add <gid>');
  });

  it('empty fixture → neutral empty-state line, no table', () => {
    const md = renderDiagnosticsMarkdown(fixture([]));
    expect(md).toContain('_No render devices found (no /dev/dri)._');
    expect(md).not.toContain('| Device | GID | Group | In group | R | W | Error |');
  });
});
