// 05-03 T1.J: GET /api/logs/container tests.
// Phase 5 Plan 05-03 — AC-5 + audit S1.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { _resetForTesting, pushLine } from '@/src/lib/log/ring-buffer';

const mocks = vi.hoisted(() => ({
  authMode: { value: 'disabled' as 'disabled' | 'authenticated' | 'denied' },
}));

vi.mock('@/src/lib/logger', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
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

import { GET } from '@/app/api/logs/container/route';

function makeReq(query: string = ''): Request {
  return new Request(`http://localhost/api/logs/container${query}`);
}

beforeEach(() => {
  _resetForTesting();
  mocks.authMode.value = 'disabled';
});

describe('GET /api/logs/container', () => {
  it('returns 401 when auth_required', async () => {
    mocks.authMode.value = 'denied';
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
  });

  it('returns empty buffer state when ring is empty', async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lines: string[]; totalLines: number; format: string };
    expect(body.lines).toEqual([]);
    expect(body.totalLines).toBe(0);
    expect(body.format).toBe('raw');
  });

  it('format=json returns raw JSON-line strings', async () => {
    pushLine('{"time":1700000000000,"level":30,"msg":"hi","extra":"v"}');
    const res = await GET(makeReq('?format=json'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lines: string[]; format: string };
    expect(body.format).toBe('json');
    expect(body.lines.length).toBe(1);
    expect(body.lines[0]).toBe('{"time":1700000000000,"level":30,"msg":"hi","extra":"v"}');
  });

  it('format=raw prettifies JSON pino lines', async () => {
    pushLine('{"time":1700000000000,"level":30,"msg":"hello"}');
    const res = await GET(makeReq('?format=raw'));
    const body = (await res.json()) as { lines: string[] };
    expect(body.lines[0]).toContain('INFO');
    expect(body.lines[0]).toContain('hello');
  });

  it('clamps lines to MAX_LINES (1000) and rejects non-numeric', async () => {
    for (let i = 0; i < 5; i++) pushLine(`line-${i}`);
    const res = await GET(makeReq('?lines=2'));
    const body = (await res.json()) as { lines: string[]; totalLines: number };
    expect(body.lines.length).toBe(2);
    expect(body.lines).toEqual(['line-3', 'line-4']);
    expect(body.totalLines).toBe(5);

    const bad = await GET(makeReq('?lines=abc'));
    expect(bad.status).toBe(400);
  });
});
