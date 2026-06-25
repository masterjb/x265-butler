import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DetectionResult } from '@/src/lib/encode/detection';

const {
  mockDetectEncoders,
  mockInvalidateEncoderCache,
  mockInvalidateOrchestratorDetectionCache,
  mockRecomputePerEncoderLimits,
  mockSettingGet,
  mockEnsureServerInit,
  mockLoggerInfo,
  mockLoggerWarn,
  mockLoggerError,
} = vi.hoisted(() => ({
  mockDetectEncoders: vi.fn<(opts?: { force?: boolean }) => Promise<DetectionResult>>(),
  mockInvalidateEncoderCache: vi.fn(),
  mockInvalidateOrchestratorDetectionCache: vi.fn(),
  mockRecomputePerEncoderLimits: vi.fn(),
  mockSettingGet: vi.fn<(key: string) => string | undefined>(),
  mockEnsureServerInit: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock('@/src/lib/db', () => ({
  settingRepo: () => ({ get: mockSettingGet }),
  default: {},
  shareRepo: () => ({ listAll: () => [] }),
}));

vi.mock('@/src/lib/encode', () => ({
  detectEncoders: mockDetectEncoders,
  invalidateEncoderCache: mockInvalidateEncoderCache,
  invalidateOrchestratorDetectionCache: mockInvalidateOrchestratorDetectionCache,
  recomputePerEncoderLimits: mockRecomputePerEncoderLimits,
  ENCODER_IDS: ['nvenc', 'qsv', 'vaapi', 'libx265'] as const,
  default: {},
}));

vi.mock('@/src/lib/server-init', () => ({
  ensureServerInit: mockEnsureServerInit,
  default: {},
}));

vi.mock('@/src/lib/logger', () => ({
  logger: {
    child: () => ({
      info: mockLoggerInfo,
      warn: mockLoggerWarn,
      error: mockLoggerError,
    }),
  },
  default: {},
}));

import { POST, runtime } from '@/app/api/encoders/refresh/route';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('POST /api/encoders/refresh', () => {
  beforeEach(() => {
    mockDetectEncoders.mockReset();
    mockInvalidateEncoderCache.mockReset();
    mockInvalidateOrchestratorDetectionCache.mockReset();
    mockRecomputePerEncoderLimits.mockReset();
    mockSettingGet.mockReset();
    mockEnsureServerInit.mockReset();
    mockLoggerInfo.mockReset();
    mockLoggerWarn.mockReset();
    mockLoggerError.mockReset();
    delete process.env.NEXT_PHASE;
    mockDetectEncoders.mockResolvedValue({
      detected: ['libx265'],
      activeFromAuto: 'libx265',
      warnings: [],
      outcome: { nvenc: 'missing', qsv: 'missing', vaapi: 'missing', libx265: 'functional' },
      brokenExcerpts: {},
      probeEncodeDisabled: false,
    });
    mockSettingGet.mockReturnValue('auto');
  });

  it('test_route_runtime_export_is_nodejs', () => {
    expect(runtime).toBe('nodejs');
  });

  it('test_POST_when_called_then_returns_200_with_refreshed_true_and_resolution', async () => {
    const res = await POST(new Request('http://test', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.refreshed).toBe(true);
    expect(body.detected).toEqual(['libx265']);
    expect(body.active).toBe('libx265');
    expect(body.resolution).toBe('auto');
    expect(body.requestId).toMatch(UUID_V4);
  });

  it('test_POST_when_called_then_invalidateEncoderCache_then_invalidateOrchestratorDetectionCache_then_detectEncoders_force_then_recomputePerEncoderLimits_in_order', async () => {
    const callOrder: string[] = [];
    mockInvalidateEncoderCache.mockImplementation(() => callOrder.push('invalidateEncoderCache'));
    mockInvalidateOrchestratorDetectionCache.mockImplementation(() =>
      callOrder.push('invalidateOrchestratorDetectionCache'),
    );
    mockDetectEncoders.mockImplementation(async (opts) => {
      callOrder.push(`detectEncoders:${opts?.force ? 'force' : 'cached'}`);
      return {
        detected: ['libx265'],
        activeFromAuto: 'libx265',
        warnings: [],
        outcome: { nvenc: 'missing', qsv: 'missing', vaapi: 'missing', libx265: 'functional' },
        brokenExcerpts: {},
        probeEncodeDisabled: false,
      };
    });
    mockRecomputePerEncoderLimits.mockImplementation(() =>
      callOrder.push('recomputePerEncoderLimits'),
    );

    await POST(new Request('http://test', { method: 'POST' }));

    expect(callOrder).toEqual([
      'invalidateEncoderCache',
      'invalidateOrchestratorDetectionCache',
      'detectEncoders:force',
      'recomputePerEncoderLimits',
    ]);
  });

  it('test_POST_when_setting_qsv_but_detected_only_libx265_then_resolution_fallback_with_requestedButUnavailable_qsv', async () => {
    mockSettingGet.mockReturnValue('qsv');
    mockDetectEncoders.mockResolvedValue({
      detected: ['libx265'],
      activeFromAuto: 'libx265',
      warnings: [],
      outcome: { nvenc: 'missing', qsv: 'missing', vaapi: 'missing', libx265: 'functional' },
      brokenExcerpts: {},
      probeEncodeDisabled: false,
    });
    const res = await POST(new Request('http://test', { method: 'POST' }));
    const body = await res.json();
    expect(body.active).toBe('libx265');
    expect(body.resolution).toBe('fallback');
    expect(body.requestedButUnavailable).toBe('qsv');
  });

  it('test_POST_when_NEXT_PHASE_phase_production_build_then_short_circuits', async () => {
    process.env.NEXT_PHASE = 'phase-production-build';
    const res = await POST(new Request('http://test', { method: 'POST' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.refreshed).toBe(false);
    expect(body.reason).toBe('build-time-skip');
    expect(mockInvalidateEncoderCache).not.toHaveBeenCalled();
    expect(mockDetectEncoders).not.toHaveBeenCalled();
    expect(mockEnsureServerInit).not.toHaveBeenCalled();
  });

  it('test_POST_when_detection_throws_then_returns_500_with_requestId', async () => {
    mockDetectEncoders.mockRejectedValue(new Error('probe blew up'));
    const res = await POST(new Request('http://test', { method: 'POST' }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('internal_error');
    expect(body.requestId).toMatch(UUID_V4);
  });

  it('test_POST_when_response_then_cache_control_no_store', async () => {
    const res = await POST(new Request('http://test', { method: 'POST' }));
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('test_POST_when_active_changes_then_emits_encoders_active_changed_log', async () => {
    // previousActive='auto' (settings.encoder); after refresh resolution
    // resolves to 'libx265' (only detected). previousActive 'auto' !== active
    // 'libx265' → active_changed log fires.
    mockSettingGet.mockReturnValue('auto');
    mockDetectEncoders.mockResolvedValue({
      detected: ['libx265'],
      activeFromAuto: 'libx265',
      warnings: [],
      outcome: { nvenc: 'missing', qsv: 'missing', vaapi: 'missing', libx265: 'functional' },
      brokenExcerpts: {},
      probeEncodeDisabled: false,
    });
    await POST(new Request('http://test', { method: 'POST' }));
    const activeChanged = mockLoggerInfo.mock.calls
      .map((c) => c[0])
      .find((c) => (c as { action?: string }).action === 'encoders_active_changed');
    expect(activeChanged).toBeDefined();
    expect((activeChanged as { from: string; to: string }).from).toBe('auto');
    expect((activeChanged as { from: string; to: string }).to).toBe('libx265');
  });

  it('test_POST_when_active_unchanged_then_does_NOT_emit_encoders_active_changed', async () => {
    mockSettingGet.mockReturnValue('libx265');
    mockDetectEncoders.mockResolvedValue({
      detected: ['libx265'],
      activeFromAuto: 'libx265',
      warnings: [],
      outcome: { nvenc: 'missing', qsv: 'missing', vaapi: 'missing', libx265: 'functional' },
      brokenExcerpts: {},
      probeEncodeDisabled: false,
    });
    await POST(new Request('http://test', { method: 'POST' }));
    const activeChanged = mockLoggerInfo.mock.calls
      .map((c) => c[0])
      .find((c) => (c as { action?: string }).action === 'encoders_active_changed');
    expect(activeChanged).toBeUndefined();
  });

  it('test_POST_when_called_then_emits_encoders_refreshed_log_with_previousActive', async () => {
    mockSettingGet.mockReturnValue('auto');
    await POST(new Request('http://test', { method: 'POST' }));
    const refreshLog = mockLoggerInfo.mock.calls
      .map((c) => c[0])
      .find((c) => (c as { action?: string }).action === 'encoders_refreshed');
    expect(refreshLog).toBeDefined();
    expect((refreshLog as { previousActive: string }).previousActive).toBe('auto');
  });

  it('test_POST_when_setting_invalid_then_warns_and_treats_as_auto', async () => {
    mockSettingGet.mockReturnValue('gibberish');
    const res = await POST(new Request('http://test', { method: 'POST' }));
    expect(res.status).toBe(200);
    const invalidWarn = mockLoggerWarn.mock.calls
      .map((c) => c[0])
      .find((c) => (c as { action?: string }).action === 'encoder_setting_invalid');
    expect(invalidWarn).toBeDefined();
  });
});
