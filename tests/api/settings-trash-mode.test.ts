// PUT /api/settings: trash_enabled ('true'/'false') and trash_location
// ('share'/'cache'). Anything else is a 400 and nothing is written. A real
// change is logged as setting_changed with old and new value, because turning
// the trash off or moving it decides whether and where originals can be
// restored.

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

const settingChanged = (key: string) =>
  mockInfo.mock.calls
    .map((c) => c[0] as { action?: string; key?: string })
    .filter((o) => o?.action === 'setting_changed' && o.key === key);

beforeEach(() => {
  mockSet.mockReset();
  mockGet.mockReset();
  mockInfo.mockReset();
});

describe('PUT /api/settings: trash_enabled', () => {
  it.each(['true', 'false'])('accepts %s', async (v) => {
    const res = await put({ trash_enabled: v });
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith('trash_enabled', v);
  });

  it.each(['yes', '', 'TRUE', '0', 'off'])('rejects %j with 400 and writes nothing', async (v) => {
    const res = await put({ trash_enabled: v });
    expect(res.status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('logs setting_changed with old and new value', async () => {
    mockGet.mockImplementation((k) => (k === 'trash_enabled' ? 'true' : undefined));
    await put({ trash_enabled: 'false' });
    expect(settingChanged('trash_enabled')).toEqual([
      expect.objectContaining({ oldValue: 'true', newValue: 'false' }),
    ]);
  });
});

describe('PUT /api/settings: trash_location', () => {
  it.each(['share', 'cache'])('accepts %s', async (v) => {
    const res = await put({ trash_location: v });
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith('trash_location', v);
  });

  it.each(['array', '', 'Share', '/media'])('rejects %j with 400 and writes nothing', async (v) => {
    const res = await put({ trash_location: v });
    expect(res.status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('logs setting_changed with old and new value', async () => {
    mockGet.mockImplementation((k) => (k === 'trash_location' ? 'cache' : undefined));
    await put({ trash_location: 'share' });
    expect(settingChanged('trash_location')).toEqual([
      expect.objectContaining({ oldValue: 'cache', newValue: 'share' }),
    ]);
  });
});
