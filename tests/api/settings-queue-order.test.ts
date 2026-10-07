// PUT /api/settings: queue_order takes one of the four processing orders.
// Anything else is a 400 and nothing is written. A real change is logged as
// setting_changed with old and new value; nothing stored means oldest first.

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
import { resolveQueueOrder } from '@/src/lib/queue/queue-order';

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
    .filter((o) => o?.action === 'setting_changed' && o.key === 'queue_order');

beforeEach(() => {
  mockSet.mockReset();
  mockGet.mockReset();
  mockInfo.mockReset();
});

describe('PUT /api/settings: queue_order', () => {
  it.each(['oldest', 'newest', 'largest', 'smallest'])('accepts %s and stores it', async (v) => {
    const res = await put({ queue_order: v });
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith('queue_order', v);
  });

  it.each(['random', 'Largest', '', 'oldest '])(
    'rejects %j with 400 and writes nothing',
    async (v) => {
      const res = await put({ queue_order: v });
      expect(res.status).toBe(400);
      expect(mockSet).not.toHaveBeenCalled();
    },
  );

  it('logs a real change with old and new value', async () => {
    mockGet.mockImplementation((k) => (k === 'queue_order' ? 'oldest' : undefined));
    await put({ queue_order: 'largest' });
    expect(settingChanged()).toEqual([
      expect.objectContaining({ oldValue: 'oldest', newValue: 'largest' }),
    ]);
  });

  it('does not log a save without change', async () => {
    mockGet.mockImplementation((k) => (k === 'queue_order' ? 'largest' : undefined));
    await put({ queue_order: 'largest' });
    expect(settingChanged()).toEqual([]);
  });

  it('nothing stored means oldest first', () => {
    expect(resolveQueueOrder(undefined)).toBe('oldest');
  });
});
