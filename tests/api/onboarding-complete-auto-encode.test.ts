// The wizard's auto-encode choice
// is written by POST /api/onboarding/complete, only after the share handling
// succeeded, with a settings_change audit line, and ON sweeps immediately.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ShareRow } from '@/src/lib/db/schema';

const { mockSettingGet, mockSettingSet, mockShareListAll, mockLoggerInfo, sweepSpy } = vi.hoisted(
  () => ({
    mockSettingGet: vi.fn<(key: string) => string | undefined>(),
    mockSettingSet: vi.fn<(key: string, value: string) => void>(),
    mockShareListAll: vi.fn<() => ShareRow[]>(),
    mockLoggerInfo: vi.fn(),
    sweepSpy: vi.fn(),
  }),
);

vi.mock('@/src/lib/db', () => ({
  settingRepo: () => ({ get: mockSettingGet, set: mockSettingSet }),
  shareRepo: () => ({
    listAll: mockShareListAll,
    create: vi.fn(),
    update: vi.fn(),
    getById: vi.fn(),
    assertNonNested: vi.fn(),
  }),
  default: {},
}));

vi.mock('@/src/lib/server-init', () => ({ ensureServerInit: vi.fn(), default: {} }));

vi.mock('@/src/lib/logger', () => ({
  logger: {
    child: () => ({ info: mockLoggerInfo, warn: vi.fn(), error: vi.fn(), telemetry: vi.fn() }),
  },
  default: {},
}));

vi.mock('@/src/lib/watch', () => ({ triggerAutoEncodeSweep: sweepSpy }));

import { POST } from '@/app/api/onboarding/complete/route';

function post(payload: unknown): Promise<Response> {
  return POST(
    new Request('http://test/api/onboarding/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );
}

function customizedShare(): ShareRow {
  return {
    id: 1,
    name: 'Custom Library',
    path: '/data/movies',
    min_size_mb: 50,
    extensions_csv: 'mkv',
    max_depth: 12,
    created_at: 1700000000,
    updated_at: 1700000200,
  } as ShareRow;
}

beforeEach(() => {
  mockSettingGet.mockReset();
  mockSettingSet.mockReset();
  mockShareListAll.mockReset();
  mockLoggerInfo.mockReset();
  sweepSpy.mockReset();
  mockShareListAll.mockReturnValue([]);
  mockSettingGet.mockImplementation((k) => (k === 'auto_encode' ? 'false' : undefined));
  delete process.env.NEXT_PHASE;
});

describe('POST /api/onboarding/complete — auto_encode', () => {
  it('test_complete_when_auto_encode_false_then_writes_false', async () => {
    await post({ auto_encode: false });
    expect(mockSettingSet).toHaveBeenCalledWith('auto_encode', 'false');
  });

  it('test_complete_when_auto_encode_true_then_writes_true', async () => {
    await post({ auto_encode: true });
    expect(mockSettingSet).toHaveBeenCalledWith('auto_encode', 'true');
  });

  it('test_complete_when_auto_encode_true_then_sweep_triggered', async () => {
    await post({ auto_encode: true });
    expect(sweepSpy).toHaveBeenCalledTimes(1);
  });

  it('test_complete_when_auto_encode_false_then_no_sweep', async () => {
    await post({ auto_encode: false });
    expect(sweepSpy).not.toHaveBeenCalled();
  });

  it('test_complete_when_auto_encode_true_and_already_on_then_no_sweep', async () => {
    mockSettingGet.mockImplementation((k) => (k === 'auto_encode' ? 'true' : undefined));
    await post({ auto_encode: true });
    expect(sweepSpy).not.toHaveBeenCalled();
  });

  it('test_complete_when_field_absent_then_auto_encode_untouched', async () => {
    await post({});
    expect(mockSettingSet).not.toHaveBeenCalledWith('auto_encode', expect.anything());
  });

  it('test_complete_when_auto_encode_written_then_before_onboarding_completed', async () => {
    await post({ auto_encode: true });
    const keys = mockSettingSet.mock.calls.map((c) => c[0]);
    expect(keys).toEqual(['auto_encode', 'onboarding_completed']);
  });

  it('test_complete_when_auto_encode_written_then_settings_change_logged', async () => {
    await post({ auto_encode: true });
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'settings_change',
        key: 'auto_encode',
        oldValue: 'false',
        newValue: 'true',
      }),
      'settings_change',
    );
  });

  it('test_complete_when_409_already_customized_then_auto_encode_not_written', async () => {
    mockShareListAll.mockReturnValue([customizedShare()]);
    const res = await post({ scan_root: '/media-array', min_size_mb: 75, auto_encode: true });
    expect(res.status).toBe(409);
    expect(mockSettingSet).not.toHaveBeenCalled();
  });

  it('test_complete_when_409_already_customized_then_no_sweep', async () => {
    mockShareListAll.mockReturnValue([customizedShare()]);
    await post({ scan_root: '/media-array', min_size_mb: 75, auto_encode: true });
    expect(sweepSpy).not.toHaveBeenCalled();
  });

  it('test_complete_when_auto_encode_not_boolean_then_400', async () => {
    const res = await post({ auto_encode: 'true' });
    expect(res.status).toBe(400);
  });
});
