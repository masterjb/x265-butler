// PUT /api/settings: trash_retention_days accepts whole days from 1 to 3650.
// Anything else is a 400 and nothing is written. A real change is logged as
// setting_changed with old and new value, because it decides when originals
// are deleted for good.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockSet, mockGet, mockTransaction, mockInfo } = vi.hoisted(() => ({
  mockSet: vi.fn<(key: string, value: string) => void>(),
  mockGet: vi.fn<(key: string) => string | undefined>(),
  mockTransaction: vi.fn(<T extends unknown[]>(fn: (...args: T) => unknown) => {
    return (...args: T) => fn(...args);
  }),
  mockInfo: vi.fn(),
}));

vi.mock('@/src/lib/db', () => ({
  getDb: () => ({ transaction: mockTransaction }),
  settingRepo: () => ({ getAll: () => ({}), get: mockGet, set: mockSet }),
  shareRepo: () => ({ listAll: () => [] }),
  default: {},
}));

vi.mock('@/src/lib/logger', () => {
  const child = () => ({ info: mockInfo, warn: vi.fn(), error: vi.fn(), telemetry: vi.fn() });
  return {
    logger: { child, info: mockInfo, warn: vi.fn(), error: vi.fn(), telemetry: vi.fn() },
    default: { logger: { child } },
  };
});

vi.mock('@/src/lib/watch', () => ({
  restartWatcherService: vi.fn(async () => {}),
  triggerAutoEncodeSweep: vi.fn(),
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

const settingChanged = () =>
  mockInfo.mock.calls
    .map((c) => c[0] as { action?: string; key?: string })
    .filter((o) => o?.action === 'setting_changed' && o.key === 'trash_retention_days');

beforeEach(() => {
  mockSet.mockReset();
  mockGet.mockReset();
  mockInfo.mockReset();
});

describe('PUT /api/settings: trash_retention_days', () => {
  it.each(['1', '30', '3650'])('accepts %s and stores it as given', async (v) => {
    const res = await put({ trash_retention_days: v });
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith('trash_retention_days', v);
  });

  it.each(['0', '3651', '-1', '1.5', 'abc', '', ' 30'])(
    'rejects %j with 400 and writes nothing',
    async (v) => {
      const res = await put({ trash_retention_days: v });
      expect(res.status).toBe(400);
      expect(mockSet).not.toHaveBeenCalled();
    },
  );

  it('logs setting_changed with old and new value', async () => {
    mockGet.mockImplementation((k) => (k === 'trash_retention_days' ? '30' : undefined));
    await put({ trash_retention_days: '90' });
    expect(settingChanged()).toEqual([expect.objectContaining({ oldValue: '30', newValue: '90' })]);
  });

  it('does not log a save without change', async () => {
    mockGet.mockImplementation((k) => (k === 'trash_retention_days' ? '90' : undefined));
    await put({ trash_retention_days: '90' });
    expect(settingChanged()).toEqual([]);
  });
});
