// PUT /api/settings — auto_encode master switch.
//
// OFF → ON triggers the immediate sweep of waiting files; every other
// transition (ON → ON, ON → OFF, unrelated keys) must not.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockGet, mockSet, mockTransaction, loggerInfoSpy, sweepSpy } = vi.hoisted(() => ({
  mockGet: vi.fn<(key: string) => string | undefined>(),
  mockSet: vi.fn<(key: string, value: string) => void>(),
  mockTransaction: vi.fn(<T extends unknown[]>(fn: (...args: T) => unknown) => {
    return (...args: T) => fn(...args);
  }),
  loggerInfoSpy: vi.fn(),
  sweepSpy: vi.fn(),
}));

vi.mock('@/src/lib/db', () => ({
  getDb: () => ({ transaction: mockTransaction }),
  settingRepo: () => ({ getAll: () => ({}), get: mockGet, set: mockSet }),
  shareRepo: () => ({ listAll: () => [] }),
  default: {},
}));

vi.mock('@/src/lib/logger', () => {
  const child = () => ({
    info: loggerInfoSpy,
    warn: vi.fn(),
    error: vi.fn(),
    telemetry: vi.fn(),
  });
  return {
    logger: { child, info: loggerInfoSpy, warn: vi.fn(), error: vi.fn(), telemetry: vi.fn() },
    default: { logger: { child } },
  };
});

vi.mock('@/src/lib/watch', () => ({
  restartWatcherService: vi.fn(async () => {}),
  triggerAutoEncodeSweep: sweepSpy,
}));

import { PUT } from '@/app/api/settings/route';

function put(settings: Record<string, string>): Promise<Response> {
  return PUT(
    new Request('http://localhost/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings }),
    }),
  );
}

function withStored(value: string | undefined): void {
  mockGet.mockImplementation((k: string) => (k === 'auto_encode' ? value : undefined));
}

beforeEach(() => {
  mockGet.mockReset();
  mockSet.mockReset();
  loggerInfoSpy.mockReset();
  sweepSpy.mockReset();
  mockTransaction.mockImplementation(<T extends unknown[]>(fn: (...args: T) => unknown) => {
    return (...args: T) => fn(...args);
  });
});

describe('PUT /api/settings — auto_encode', () => {
  it('test_put_when_auto_encode_true_then_persisted', async () => {
    withStored('false');
    await put({ auto_encode: 'true' });
    expect(mockSet).toHaveBeenCalledWith('auto_encode', 'true');
  });

  it('test_put_when_auto_encode_off_to_on_then_sweep_triggered_once', async () => {
    withStored('false');
    await put({ auto_encode: 'true' });
    expect(sweepSpy).toHaveBeenCalledTimes(1);
  });

  it('test_put_when_auto_encode_missing_row_to_on_then_sweep_triggered', async () => {
    withStored(undefined);
    await put({ auto_encode: 'true' });
    expect(sweepSpy).toHaveBeenCalledTimes(1);
  });

  it('test_put_when_auto_encode_on_to_on_then_no_sweep', async () => {
    withStored('true');
    await put({ auto_encode: 'true' });
    expect(sweepSpy).not.toHaveBeenCalled();
  });

  it('test_put_when_auto_encode_on_to_off_then_no_sweep', async () => {
    withStored('true');
    await put({ auto_encode: 'false' });
    expect(sweepSpy).not.toHaveBeenCalled();
  });

  it('test_put_when_unrelated_key_then_no_sweep', async () => {
    withStored('false');
    await put({ language: 'de' });
    expect(sweepSpy).not.toHaveBeenCalled();
  });

  it('test_put_when_auto_encode_invalid_value_then_400', async () => {
    const res = await put({ auto_encode: 'yes' });
    expect(res.status).toBe(400);
  });

  it('test_put_when_legacy_auto_enqueue_after_scan_then_still_200', async () => {
    withStored('false');
    const res = await put({ auto_enqueue_after_scan: 'true' });
    expect(res.status).toBe(200);
  });

  it('test_put_when_auto_encode_changed_then_settings_change_logged_with_old_and_new', async () => {
    withStored('false');
    await put({ auto_encode: 'true' });
    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'settings_change',
        key: 'auto_encode',
        oldValue: 'false',
        newValue: 'true',
      }),
      'settings_change',
    );
  });
});
