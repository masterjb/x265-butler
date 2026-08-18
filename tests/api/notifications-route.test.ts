// Phase 18 Plan 18-01 Task 7 — /api/notifications route tests.
//
// Mirrors tests/api/encoders.test.ts mock pattern (vi.hoisted + vi.mock for
// db / encode / server-init). The route's data source is notificationStore()
// which pulls from detectEncoders() — mock that surface.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DetectionResult } from '@/src/lib/encode/detection';

const { mockDetectEncoders, mockEnsureServerInit } = vi.hoisted(() => ({
  mockDetectEncoders: vi.fn<() => Promise<DetectionResult>>(),
  mockEnsureServerInit: vi.fn(),
}));

vi.mock('@/src/lib/db', () => ({
  settingRepo: () => ({ get: () => undefined }),
  default: {},
}));

vi.mock('@/src/lib/encode/detection', () => ({
  detectEncoders: mockDetectEncoders,
  default: {},
}));

vi.mock('@/src/lib/server-init', () => ({
  ensureServerInit: mockEnsureServerInit,
  default: {},
}));

import { GET, runtime } from '@/app/api/notifications/route';

beforeEach(() => {
  mockDetectEncoders.mockReset();
  mockEnsureServerInit.mockReset();
  delete process.env.NEXT_PHASE;
  mockDetectEncoders.mockResolvedValue({
    detected: ['libx265'],
    activeFromAuto: 'libx265',
    warnings: [],
    outcome: { nvenc: 'missing', qsv: 'missing', vaapi: 'missing', libx265: 'functional' },
    brokenExcerpts: {},
    probeEncodeDisabled: false,
  });
});

describe('GET /api/notifications', () => {
  it('test_route_runtime_export_is_nodejs', () => {
    expect(runtime).toBe('nodejs');
  });

  it('test_GET_when_no_warnings_then_returns_empty_count_zero', async () => {
    const res = await GET(new Request('http://test'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.notifications).toEqual([]);
    expect(body.count).toBe(0);
    expect(body.severityCounts).toEqual({ info: 0, warn: 0 });
  });

  it('test_GET_when_one_warn_then_count_one_and_warn_count_one', async () => {
    mockDetectEncoders.mockResolvedValue({
      detected: ['libx265'],
      activeFromAuto: 'libx265',
      warnings: [{ code: 'vainfo_binary_missing', severity: 'warn' }],
      outcome: { nvenc: 'missing', qsv: 'missing', vaapi: 'missing', libx265: 'functional' },
      brokenExcerpts: {},
      probeEncodeDisabled: false,
    });
    const res = await GET(new Request('http://test'));
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.severityCounts.warn).toBe(1);
    expect(body.severityCounts.info).toBe(0);
  });

  it('test_GET_when_mix_info_and_warn_then_severityCounts_split_correctly', async () => {
    mockDetectEncoders.mockResolvedValue({
      detected: ['libx265'],
      activeFromAuto: 'libx265',
      warnings: [
        { code: 'qsv_only_legacy_intel', severity: 'info' },
        { code: 'nvenc_no_runtime', severity: 'warn' },
        { code: 'vainfo_binary_missing', severity: 'warn' },
      ],
      outcome: { nvenc: 'missing', qsv: 'missing', vaapi: 'missing', libx265: 'functional' },
      brokenExcerpts: {},
      probeEncodeDisabled: false,
    });
    const res = await GET(new Request('http://test'));
    const body = await res.json();
    expect(body.count).toBe(3);
    expect(body.severityCounts).toEqual({ info: 1, warn: 2 });
  });

  it('test_GET_when_notifications_then_each_has_stable_id_with_notif_prefix', async () => {
    mockDetectEncoders.mockResolvedValue({
      detected: ['libx265'],
      activeFromAuto: 'libx265',
      warnings: [{ code: 'nvenc_no_runtime', severity: 'warn' }],
      outcome: { nvenc: 'missing', qsv: 'missing', vaapi: 'missing', libx265: 'functional' },
      brokenExcerpts: {},
      probeEncodeDisabled: false,
    });
    const res = await GET(new Request('http://test'));
    const body = await res.json();
    expect(body.notifications[0].id).toBe('notif_nvenc_no_runtime');
  });

  it('test_GET_when_called_then_cache_control_no_store', async () => {
    const res = await GET(new Request('http://test'));
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('test_GET_when_NEXT_PHASE_phase_production_build_then_short_circuits_no_detection', async () => {
    process.env.NEXT_PHASE = 'phase-production-build';
    const res = await GET(new Request('http://test'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(0);
    expect(mockDetectEncoders).not.toHaveBeenCalled();
  });

  it('test_GET_when_detection_throws_then_returns_500_with_requestId', async () => {
    mockDetectEncoders.mockRejectedValue(new Error('probe blew up'));
    const res = await GET(new Request('http://test'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('internal_error');
    expect(body.requestId).toBeTruthy();
  });
});
