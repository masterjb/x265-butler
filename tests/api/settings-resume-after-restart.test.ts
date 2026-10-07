// PUT /api/settings: resume_after_restart takes '0' or '1' only. queue_paused is
// written by the orchestrator and is not a key the API accepts. Anything else
// is a 400 and nothing is written.

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
import { resolveResumeAfterRestart } from '@/src/lib/encode/restart-resume';

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

describe('PUT /api/settings: resume_after_restart', () => {
  it.each(['0', '1'])('accepts %s and stores it as given', async (v) => {
    const res = await put({ resume_after_restart: v });
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith('resume_after_restart', v);
  });

  it.each(['true', 'false', '2', '', ' 1'])('rejects %j with 400 and writes nothing', async (v) => {
    const res = await put({ resume_after_restart: v });
    expect(res.status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('is on when nothing is stored', () => {
    expect(resolveResumeAfterRestart(undefined)).toBe(true);
  });
});

describe('PUT /api/settings: queue_paused', () => {
  it.each(['0', '1'])('rejects %s with 400 and writes nothing', async (v) => {
    const res = await put({ queue_paused: v });
    expect(res.status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });
});
