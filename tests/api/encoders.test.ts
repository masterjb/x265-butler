import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DetectionResult } from '@/src/lib/encode/detection';

const { mockDetectEncoders, mockSettingGet, mockEnsureServerInit } = vi.hoisted(() => ({
  mockDetectEncoders: vi.fn<() => Promise<DetectionResult>>(),
  mockSettingGet: vi.fn<(key: string) => string | undefined>(),
  mockEnsureServerInit: vi.fn(),
}));

vi.mock('@/src/lib/db', () => ({
  settingRepo: () => ({ get: mockSettingGet }),
  default: {},
  shareRepo: () => ({ listAll: () => [] }),
}));

vi.mock('@/src/lib/encode', () => ({
  detectEncoders: mockDetectEncoders,
  ENCODER_IDS: ['nvenc', 'qsv', 'vaapi', 'libx265'] as const,
  default: {},
}));

vi.mock('@/src/lib/server-init', () => ({
  ensureServerInit: mockEnsureServerInit,
  default: {},
}));

import { GET, runtime } from '@/app/api/encoders/route';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('GET /api/encoders', () => {
  beforeEach(() => {
    mockDetectEncoders.mockReset();
    mockSettingGet.mockReset();
    mockEnsureServerInit.mockReset();
    delete process.env.NEXT_PHASE;
    // Default: no HW present (CI runner shape).
    mockDetectEncoders.mockResolvedValue({
      detected: ['libx265'],
      activeFromAuto: 'libx265',
      warnings: [],
      outcome: { nvenc: 'missing', qsv: 'missing', vaapi: 'missing', libx265: 'functional' },
      brokenExcerpts: {},
      probeEncodeDisabled: false,
    });
    mockSettingGet.mockReturnValue(undefined);
  });

  it('test_route_runtime_export_is_nodejs', () => {
    expect(runtime).toBe('nodejs');
  });

  it('test_GET_when_called_then_returns_200_with_detected_active_resolution_requestId', async () => {
    const res = await GET(new Request('http://test'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.detected).toEqual(['libx265']);
    expect(body.active).toBe('libx265');
    expect(body.resolution).toBe('auto');
    expect(body.requestId).toMatch(UUID_V4);
    expect(mockEnsureServerInit).toHaveBeenCalledOnce();
  });

  it('test_GET_when_setting_auto_then_active_is_first_detected_and_resolution_auto', async () => {
    mockDetectEncoders.mockResolvedValue({
      detected: ['nvenc', 'libx265'],
      activeFromAuto: 'nvenc',
      warnings: [],
      outcome: { nvenc: 'missing', qsv: 'missing', vaapi: 'missing', libx265: 'functional' },
      brokenExcerpts: {},
      probeEncodeDisabled: false,
    });
    mockSettingGet.mockReturnValue('auto');
    const res = await GET(new Request('http://test'));
    const body = await res.json();
    expect(body.active).toBe('nvenc');
    expect(body.resolution).toBe('auto');
    expect(body.requestedButUnavailable).toBeUndefined();
  });

  it('test_GET_when_setting_nvenc_and_detected_includes_nvenc_then_active_nvenc_resolution_override', async () => {
    mockDetectEncoders.mockResolvedValue({
      detected: ['nvenc', 'libx265'],
      activeFromAuto: 'nvenc',
      warnings: [],
      outcome: { nvenc: 'missing', qsv: 'missing', vaapi: 'missing', libx265: 'functional' },
      brokenExcerpts: {},
      probeEncodeDisabled: false,
    });
    mockSettingGet.mockReturnValue('nvenc');
    const res = await GET(new Request('http://test'));
    const body = await res.json();
    expect(body.active).toBe('nvenc');
    expect(body.resolution).toBe('override');
  });

  it('test_GET_when_setting_qsv_but_detected_only_libx265_then_active_libx265_resolution_fallback_with_requestedButUnavailable_qsv', async () => {
    mockDetectEncoders.mockResolvedValue({
      detected: ['libx265'],
      activeFromAuto: 'libx265',
      warnings: [],
      outcome: { nvenc: 'missing', qsv: 'missing', vaapi: 'missing', libx265: 'functional' },
      brokenExcerpts: {},
      probeEncodeDisabled: false,
    });
    mockSettingGet.mockReturnValue('qsv');
    const res = await GET(new Request('http://test'));
    const body = await res.json();
    expect(body.active).toBe('libx265');
    expect(body.resolution).toBe('fallback');
    expect(body.requestedButUnavailable).toBe('qsv');
  });

  it('test_GET_when_setting_invalid_string_then_resolution_auto_and_warn_emitted', async () => {
    mockSettingGet.mockReturnValue('gibberish');
    const res = await GET(new Request('http://test'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resolution).toBe('auto');
    expect(body.active).toBe('libx265');
  });

  it('test_GET_when_vaapi_in_detection_then_devicePath_present_in_response', async () => {
    mockDetectEncoders.mockResolvedValue({
      detected: ['vaapi', 'libx265'],
      activeFromAuto: 'vaapi',
      vaapiDevice: '/dev/dri/renderD129',
      warnings: [],
      outcome: { nvenc: 'missing', qsv: 'missing', vaapi: 'missing', libx265: 'functional' },
      brokenExcerpts: {},
      probeEncodeDisabled: false,
    });
    const res = await GET(new Request('http://test'));
    const body = await res.json();
    expect(body.devicePath).toBe('/dev/dri/renderD129');
  });

  it('test_GET_when_response_then_cache_control_no_store', async () => {
    const res = await GET(new Request('http://test'));
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('test_GET_when_detection_throws_then_returns_500_with_requestId', async () => {
    mockDetectEncoders.mockRejectedValue(new Error('probe blew up'));
    const res = await GET(new Request('http://test'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('internal_error');
    expect(body.requestId).toMatch(UUID_V4);
  });

  it('test_GET_when_called_then_ensureServerInit_called_first', async () => {
    let detectCalledAfterInit = false;
    mockEnsureServerInit.mockImplementation(() => {
      // detectEncoders should not have run yet at this point.
      detectCalledAfterInit = mockDetectEncoders.mock.calls.length === 0;
    });
    await GET(new Request('http://test'));
    expect(detectCalledAfterInit).toBe(true);
    expect(mockEnsureServerInit).toHaveBeenCalledOnce();
    expect(mockDetectEncoders).toHaveBeenCalledOnce();
  });

  it('test_GET_when_NEXT_PHASE_phase_production_build_then_short_circuits_no_detection_call', async () => {
    process.env.NEXT_PHASE = 'phase-production-build';
    const res = await GET(new Request('http://test'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.detected).toEqual(['libx265']);
    expect(body.active).toBe('libx265');
    expect(body.requestId).toBe('build');
    expect(mockDetectEncoders).not.toHaveBeenCalled();
    expect(mockEnsureServerInit).not.toHaveBeenCalled();
  });

  it('test_GET_when_setting_libx265_override_then_resolution_override_active_libx265', async () => {
    mockDetectEncoders.mockResolvedValue({
      detected: ['nvenc', 'libx265'],
      activeFromAuto: 'nvenc',
      warnings: [],
      outcome: { nvenc: 'missing', qsv: 'missing', vaapi: 'missing', libx265: 'functional' },
      brokenExcerpts: {},
      probeEncodeDisabled: false,
    });
    mockSettingGet.mockReturnValue('libx265');
    const res = await GET(new Request('http://test'));
    const body = await res.json();
    expect(body.active).toBe('libx265');
    expect(body.resolution).toBe('override');
  });

  // Phase 18 Plan 18-01 Task 4 — warnings passthrough (AC-4 stable shape).
  it('test_GET_when_detection_has_warnings_then_response_includes_warnings_array', async () => {
    mockDetectEncoders.mockResolvedValue({
      detected: ['libx265'],
      activeFromAuto: 'libx265',
      warnings: [{ code: 'vainfo_binary_missing', severity: 'warn', detail: 'missing' }],
      outcome: { nvenc: 'missing', qsv: 'missing', vaapi: 'missing', libx265: 'functional' },
      brokenExcerpts: {},
      probeEncodeDisabled: false,
    });
    const res = await GET(new Request('http://test'));
    const body = await res.json();
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0].code).toBe('vainfo_binary_missing');
  });

  it('test_GET_when_no_warnings_then_response_warnings_is_empty_array_not_omitted', async () => {
    mockDetectEncoders.mockResolvedValue({
      detected: ['libx265'],
      activeFromAuto: 'libx265',
      warnings: [],
      outcome: { nvenc: 'missing', qsv: 'missing', vaapi: 'missing', libx265: 'functional' },
      brokenExcerpts: {},
      probeEncodeDisabled: false,
    });
    const res = await GET(new Request('http://test'));
    const body = await res.json();
    expect(body).toHaveProperty('warnings');
    expect(body.warnings).toEqual([]);
  });
});
