// 24-05 F7 T2: DELETE /api/logs tests — AC-2 + AC-3 + AC-4.
// Seeds the ring via pushLine, asserts cleared counts reflect pre-clear state,
// the seeded lines are gone afterward, the audit line lands (isolated test —
// no other emitters per AC-3 note), and the 401 path leaves the ring untouched.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { _resetForTesting, pushLine, tail } from '@/src/lib/log/ring-buffer';

const mocks = vi.hoisted(() => ({
  authMode: { value: 'disabled' as 'disabled' | 'authenticated' | 'denied' },
  emitted: [] as Array<{ payload: Record<string, unknown>; msg: string }>,
}));

vi.mock('@/src/lib/logger', () => ({
  logger: {
    child: () => ({
      info: (payload: Record<string, unknown>, msg: string) => {
        mocks.emitted.push({ payload, msg });
        // Mirror the real pino multistream → ring wiring so AC-3's
        // "ring afterward holds the logs_cleared line" assertion is exercised.
        pushLine(JSON.stringify({ level: 30, msg, ...payload }));
      },
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

vi.mock('@/src/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(async () => {
    if (mocks.authMode.value === 'denied') {
      return { ok: false, status: 401, body: { error_code: 'auth_required' } };
    }
    if (mocks.authMode.value === 'authenticated') {
      return { ok: true, mode: 'authenticated', username: 'admin' };
    }
    return { ok: true, mode: 'disabled', username: null };
  }),
  authGuard: (decision: { ok: boolean; status?: number; body?: unknown }) => {
    if (decision.ok) return null;
    return new Response(JSON.stringify(decision.body), {
      status: decision.status,
      headers: { 'Content-Type': 'application/json' },
    });
  },
  withRenewCookie: (res: Response) => res,
}));

import { DELETE } from '@/app/api/logs/route';

function makeReq(): Request {
  return new Request('http://localhost/api/logs', { method: 'DELETE' });
}

beforeEach(() => {
  _resetForTesting();
  mocks.authMode.value = 'disabled';
  mocks.emitted.length = 0;
});

describe('DELETE /api/logs (AC-2/AC-3/AC-4)', () => {
  it('clears the ring and reports pre-clear counts', async () => {
    pushLine('seed-one');
    pushLine('seed-two');
    const seeded = tail(10);
    const expectedBytes = seeded.totalBytes;

    const res = await DELETE(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      cleared: number;
      bytesCleared: number;
      requestId: string;
    };
    expect(body.cleared).toBe(2);
    expect(body.bytesCleared).toBe(expectedBytes);
    expect(typeof body.requestId).toBe('string');
  });

  it('emits logs_cleared AFTER wipe; seeded lines gone, only audit line remains (AC-3)', async () => {
    pushLine('seed-one');
    pushLine('seed-two');

    await DELETE(makeReq());

    // Audit emit happened with the pre-clear counts.
    expect(mocks.emitted).toHaveLength(1);
    expect(mocks.emitted[0]!.msg).toBe('logs_cleared');
    expect(mocks.emitted[0]!.payload.clearedLines).toBe(2);

    // Isolated test (no other emitters): seeds gone, only the audit line left.
    const after = tail(10);
    expect(after.totalLines).toBe(1);
    expect(after.lines.some((l) => l.includes('seed-one'))).toBe(false);
    expect(after.lines.some((l) => l.includes('seed-two'))).toBe(false);
    expect(after.lines[0]).toContain('logs_cleared');
  });

  it('401 path leaves the ring untouched (AC-4)', async () => {
    mocks.authMode.value = 'denied';
    pushLine('keep-me');

    const res = await DELETE(makeReq());
    expect(res.status).toBe(401);

    const after = tail(10);
    expect(after.totalLines).toBe(1);
    expect(after.lines[0]).toBe('keep-me');
    expect(mocks.emitted).toHaveLength(0);
  });
});
