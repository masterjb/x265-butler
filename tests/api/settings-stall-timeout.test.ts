// PUT /api/settings: stall_timeout_minutes accepts 0 (detection off) and whole
// minutes from 2 to 720. Anything else is a 400 and nothing is written.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockSet, mockTransaction } = vi.hoisted(() => ({
  mockSet: vi.fn<(key: string, value: string) => void>(),
  mockTransaction: vi.fn(<T extends unknown[]>(fn: (...args: T) => unknown) => {
    return (...args: T) => fn(...args);
  }),
}));

vi.mock('@/src/lib/db', () => ({
  getDb: () => ({ transaction: mockTransaction }),
  settingRepo: () => ({ getAll: () => ({}), get: () => undefined, set: mockSet }),
  shareRepo: () => ({ listAll: () => [] }),
  default: {},
}));

vi.mock('@/src/lib/logger', () => {
  const child = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), telemetry: vi.fn() });
  return {
    logger: { child, info: vi.fn(), warn: vi.fn(), error: vi.fn(), telemetry: vi.fn() },
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

beforeEach(() => {
  mockSet.mockReset();
});

describe('PUT /api/settings: stall_timeout_minutes', () => {
  it.each(['0', '2', '10', '720'])('accepts %s and stores it as given', async (v) => {
    const res = await put({ stall_timeout_minutes: v });
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith('stall_timeout_minutes', v);
  });

  it.each(['1', '721', '5.5', '-1', 'abc', '', ' 10'])(
    'rejects %j with 400 and writes nothing',
    async (v) => {
      const res = await put({ stall_timeout_minutes: v });
      expect(res.status).toBe(400);
      expect(mockSet).not.toHaveBeenCalled();
    },
  );
});
