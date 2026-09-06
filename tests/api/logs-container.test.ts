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

  it('49-04 AC-11: renders the telemetry tier (level 25) as TELE, not L25', async () => {
    pushLine('{"time":1700000000000,"level":25,"msg":"cpu_attribution","activeEncodes":2}');
    pushLine('{"time":1700000000000,"level":30,"msg":"other"}');
    const res = await GET(makeReq('?format=raw'));
    const body = (await res.json()) as { lines: string[] };
    expect(body.lines[0]).toContain('TELE');
    expect(body.lines[0]).not.toContain('L25');
    expect(body.lines[0]).toContain('cpu_attribution');
    // The viewer reads the RING, so the tier move changes the LABEL only — the
    // number of lines served is unchanged.
    expect(body.lines).toHaveLength(2);
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

// 50-05: the `meta` sidecar. The viewer's "hide telemetry" switch filters on
// level 25, and it cannot get that from the rendered string — `prettifyLine`
// ends with `.trim()`, so a line without a `time` field shifts the level token
// from position 2 to position 1 and any client-side "second word = level"
// parser is wrong on exactly those lines. The route already parses; it just
// stopped throwing the result away.
describe('GET /api/logs/container — meta sidecar (50-05)', () => {
  // AC-2
  it('50-05 AC-2: meta carries level and action', async () => {
    pushLine(
      '{"time":1700000000000,"level":25,"msg":"cpu_attribution","action":"cpu_attribution"}',
    );
    const res = await GET(makeReq());
    const body = (await res.json()) as {
      meta: Array<{ level: number | null; action: string | null } | null>;
    };
    expect(body.meta[0]).toEqual({ level: 25, action: 'cpu_attribution' });
  });

  // AC-2, second half: no action field → null, level still carried.
  it('50-05 AC-2: a line without action yields action null but keeps level', async () => {
    pushLine('{"time":1700000000000,"level":30,"msg":"plain"}');
    const res = await GET(makeReq());
    const body = (await res.json()) as {
      meta: Array<{ level: number | null; action: string | null } | null>;
    };
    expect(body.meta[0]).toEqual({ level: 30, action: null });
  });

  // AC-3: nothing is guessed for a line that is not a JSON object.
  it('50-05 AC-3: non-JSON line yields meta null AND passes through verbatim', async () => {
    pushLine('this is not json at all');
    const res = await GET(makeReq());
    const body = (await res.json()) as { lines: string[]; meta: unknown[] };
    expect(body.meta[0]).toBeNull();
    expect(body.lines[0]).toBe('this is not json at all');
  });

  it('50-05 AC-3: a JSON array line is not an object → meta null', async () => {
    pushLine('[1,2,3]');
    const res = await GET(makeReq());
    const body = (await res.json()) as { meta: unknown[] };
    expect(body.meta[0]).toBeNull();
  });

  // AC-19 support: nothing is guessed when level has the wrong type.
  it('50-05: a non-numeric level yields level null, never a guess', async () => {
    pushLine('{"time":1700000000000,"level":"warn","msg":"odd","action":42}');
    const res = await GET(makeReq());
    const body = (await res.json()) as {
      meta: Array<{ level: number | null; action: string | null } | null>;
    };
    expect(body.meta[0]).toEqual({ level: null, action: null });
  });

  // AC-1: index alignment, and identical meta in BOTH formats — the switch must
  // behave the same whether the operator looks at raw or json.
  it('50-05 AC-1: meta is index-aligned with lines and identical for raw and json', async () => {
    pushLine('{"time":1700000000000,"level":25,"msg":"tele","action":"a"}');
    pushLine('not json');
    pushLine('{"time":1700000000000,"level":40,"msg":"warn","action":"b"}');

    const raw = (await (await GET(makeReq('?format=raw'))).json()) as {
      lines: string[];
      meta: unknown[];
    };
    const json = (await (await GET(makeReq('?format=json'))).json()) as {
      lines: string[];
      meta: unknown[];
    };

    expect(raw.meta).toHaveLength(raw.lines.length);
    expect(json.meta).toHaveLength(json.lines.length);
    expect(raw.meta).toEqual(json.meta);
    expect(raw.meta).toEqual([{ level: 25, action: 'a' }, null, { level: 40, action: 'b' }]);
  });

  // AC-4: the prettifyLine refactor must not have moved a single byte. The
  // download link serves exactly this array.
  it('50-05 AC-4: lines are byte-identical to the pre-50-05 output', async () => {
    pushLine('{"time":1700000000000,"level":30,"msg":"hello"}');
    pushLine('{"time":1700000000000,"level":25,"msg":"cpu_attribution","activeEncodes":2}');
    pushLine('{"level":40,"msg":"no time field"}');
    pushLine('raw passthrough');

    const body = (await (await GET(makeReq('?format=raw'))).json()) as {
      lines: string[];
      totalLines: number;
      format: string;
    };

    expect(body.lines).toEqual([
      '2023-11-14T22:13:20.000Z INFO hello',
      '2023-11-14T22:13:20.000Z TELE cpu_attribution {"activeEncodes":2}',
      // no `time` → the leading space is trimmed away and WARN lands first.
      // This is the shape that makes a client-side token parser unsafe.
      'WARN no time field',
      'raw passthrough',
    ]);
    expect(body.totalLines).toBe(4);
    expect(body.format).toBe('raw');
  });

  // AC-4, second half — review R-1: the AC freezes `totalBytes` and `requestId`
  // too, and the APPLY test asserted neither. `meta` is additive, which means
  // exactly one new key and nothing else moved: the key SET is the assertion,
  // not a spot-check of the fields that happened to come to mind.
  it('50-05 AC-4: the response gains `meta` and NOTHING else', async () => {
    pushLine('{"time":1700000000000,"level":30,"msg":"hello"}');
    const res = await GET(makeReq());
    const body = (await res.json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(
      ['format', 'lines', 'meta', 'requestId', 'totalBytes', 'totalLines'].sort(),
    );
    // The two fields AC-4 names that the APPLY test skipped.
    expect(typeof body.totalBytes).toBe('number');
    expect(body.totalBytes).toBeGreaterThan(0);
    expect(typeof body.requestId).toBe('string');
    expect((body.requestId as string).length).toBeGreaterThan(0);
  });
});
