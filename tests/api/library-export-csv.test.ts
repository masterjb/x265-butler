// 05-04 T1.E: GET /api/library/export.csv contract tests.
// Phase 5 Plan 05-04 — AC-1..AC-7 + audit M1, M2, M3, M4 + S1.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@/src/lib/db/migrate';
import { makeFileRepo, type FileRepo } from '@/src/lib/db/repos/file';
import type { FileRow, FileUpsertInput } from '@/src/lib/db/schema';
import { CSV_HEADERS } from '@/src/lib/api/library-csv';

type Db = InstanceType<typeof Database>;

const mocks = vi.hoisted(() => ({
  authMode: { value: 'disabled' as 'disabled' | 'authenticated' | 'denied' },
  loggerInfoMock: vi.fn(),
  trustXff: { value: 'false' },
  // populated in beforeEach
  repoRef: { current: null as FileRepo | null },
  iteratorOverride: { fn: null as null | (() => IterableIterator<FileRow>) },
}));

vi.mock('@/src/lib/db', () => ({
  fileRepo: () => {
    const real = mocks.repoRef.current;
    if (!real) throw new Error('fileRepo not initialized in test');
    if (mocks.iteratorOverride.fn) {
      const override = mocks.iteratorOverride.fn;
      return {
        ...real,
        iterateAll: () => override(),
      };
    }
    return real;
  },
  settingRepo: () => ({
    get: () => undefined,
  }),
  shareRepo: () => ({ listAll: () => [] }),
}));

vi.mock('@/src/lib/logger', () => ({
  // Root logger needs its own top-level methods: the shared db timing helper
  // (src/lib/db/timing.ts) calls the ROOT logger.info/.warn directly (e.g. the
  // once-per-process slow_query_threshold_resolved audit emit on the first real
  // withQueryTiming call), while the route under test uses logger.child(). The
  // real pino logger exposes both; this mock must too. Top-level methods use
  // throwaway fns so loggerInfoMock stays scoped to child().info assertions.
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: () => ({
      info: mocks.loggerInfoMock,
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

vi.mock('@/src/lib/auth/rate-limit', () => ({
  hashIp: (ip: string) => `h:${ip}`,
  extractIp: () => '127.0.0.1',
}));

vi.mock('@/src/lib/auth/settings-cache', () => ({
  getCachedAuthSetting: (k: string) => {
    if (k === 'auth_trust_proxy_xff') return mocks.trustXff.value;
    return '';
  },
}));

import { GET } from '@/app/api/library/export.csv/route';

const baseInput = (overrides: Partial<FileUpsertInput> = {}): FileUpsertInput => ({
  path: '/media/movies/example.mp4',
  size_bytes: 100_000_000,
  mtime: 1_700_000_000,
  content_hash: 'a'.repeat(64),
  codec: 'h264',
  bitrate: 5_000_000,
  duration_seconds: 7200,
  width: 1920,
  height: 1080,
  container: 'mov',
  last_scanned_at: 1_700_000_500,
  share_id: null,
  ...overrides,
});

let db: Db;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  mocks.repoRef.current = makeFileRepo(db);
  mocks.authMode.value = 'disabled';
  mocks.trustXff.value = 'false';
  mocks.loggerInfoMock.mockReset();
  mocks.iteratorOverride.fn = null;
});

function getReq(query = '', init?: RequestInit): Request {
  return new Request(`http://localhost/api/library/export.csv${query}`, init);
}

async function readAllText(res: Response): Promise<string> {
  const ab = await res.arrayBuffer();
  return new TextDecoder('utf-8').decode(new Uint8Array(ab));
}

describe('GET /api/library/export.csv — auth gate (AC-3)', () => {
  it('returns 401 when auth_required', async () => {
    mocks.authMode.value = 'denied';
    const res = await GET(getReq());
    expect(res.status).toBe(401);
  });

  it('returns 200 streaming CSV when auth_enabled=false (anonymous)', async () => {
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    await res.arrayBuffer(); // drain
  });
});

describe('GET /api/library/export.csv — body shape (AC-1, AC-7)', () => {
  it('first 3 bytes of body are UTF-8 BOM EF BB BF', async () => {
    mocks.repoRef.current!.upsertByPath(baseInput({ path: '/a.mp4' }));
    const res = await GET(getReq());
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf[0]).toBe(0xef);
    expect(buf[1]).toBe(0xbb);
    expect(buf[2]).toBe(0xbf);
  });

  it('header row matches CSV_HEADERS joined by comma + CRLF', async () => {
    const res = await GET(getReq());
    const text = await readAllText(res);
    // Strip BOM (first character).
    const body = text.startsWith('﻿') ? text.slice(1) : text;
    const firstLine = body.split('\r\n')[0];
    expect(firstLine).toBe(CSV_HEADERS.join(','));
  });

  it('emits exactly N+1 CRLF lines for N matching rows', async () => {
    const repo = mocks.repoRef.current!;
    for (let i = 0; i < 7; i++) {
      repo.upsertByPath(baseInput({ path: `/row-${i}.mp4`, size_bytes: i + 1 }));
    }
    const res = await GET(getReq());
    const text = await readAllText(res);
    // Strip BOM.
    const body = text.startsWith('﻿') ? text.slice(1) : text;
    // Split on CRLF — trailing CRLF after last row creates an empty final
    // segment. Count non-empty segments.
    const lines = body.split('\r\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(8); // 1 header + 7 rows
  });

  it('escapes path containing comma + quote + emoji', async () => {
    mocks.repoRef.current!.upsertByPath(baseInput({ path: '/media/тест,"weird" 🎬.mp4' }));
    const res = await GET(getReq());
    const text = await readAllText(res);
    expect(text).toContain('"/media/тест,""weird"" 🎬.mp4"');
  });
});

describe('GET /api/library/export.csv — query parsing (AC-2)', () => {
  it('returns 400 invalid_query on status=bogus', async () => {
    const res = await GET(getReq('?status=bogus'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_query');
  });

  it('honors q + status + sort=bitrate + dir=asc — order matches listPaginated', async () => {
    const repo = mocks.repoRef.current!;
    const a = repo.upsertByPath(baseInput({ path: '/movies/a.mp4', bitrate: 5000 }));
    const b = repo.upsertByPath(baseInput({ path: '/movies/b.mp4', bitrate: 1000 }));
    const c = repo.upsertByPath(baseInput({ path: '/movies/c.mp4', bitrate: 3000 }));
    repo.setStatus(a.id, 'failed', a.version);
    repo.setStatus(b.id, 'failed', b.version);
    repo.setStatus(c.id, 'failed', c.version);
    repo.upsertByPath(baseInput({ path: '/shows/x.mp4', bitrate: 2000 }));

    const res = await GET(getReq('?q=movies&status=failed&sort=bitrate&dir=asc'));
    const text = await readAllText(res);
    const body = text.startsWith('﻿') ? text.slice(1) : text;
    const dataLines = body
      .split('\r\n')
      .filter((l) => l.length > 0)
      .slice(1);
    const orderedPaths = dataLines.map((l) => l.split(',')[1]);
    const control = repo
      .listPaginated({
        page: 1,
        size: 200,
        q: 'movies',
        status: 'failed',
        sort: 'bitrate',
        dir: 'asc',
      })
      .rows.map((r) => r.path);
    expect(orderedPaths).toEqual(control);
  });

  it('includeVanished=1 surfaces vanished rows; absent → hidden', async () => {
    const repo = mocks.repoRef.current!;
    const a = repo.upsertByPath(baseInput({ path: '/a.mp4' }));
    repo.upsertByPath(baseInput({ path: '/b.mp4' }));
    repo.setStatus(a.id, 'vanished', a.version);

    const hiddenRes = await GET(getReq());
    const hiddenText = await readAllText(hiddenRes);
    expect(hiddenText).not.toContain('/a.mp4');
    expect(hiddenText).toContain('/b.mp4');

    const shownRes = await GET(getReq('?includeVanished=1'));
    const shownText = await readAllText(shownRes);
    expect(shownText).toContain('/a.mp4');
    expect(shownText).toContain('/b.mp4');
  });
});

describe('GET /api/library/export.csv — headers (AC-4)', () => {
  it('sets X-Request-Id', async () => {
    const res = await GET(getReq());
    const id = res.headers.get('x-request-id');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await res.arrayBuffer();
  });

  it('Content-Disposition contains both filename= and filename*=UTF-8', async () => {
    const res = await GET(getReq());
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).toMatch(/filename="x265-butler-library-\d{8}-\d{6}\.csv"/);
    expect(cd).toMatch(/filename\*=UTF-8''x265-butler-library-\d{8}-\d{6}\.csv/);
    await res.arrayBuffer();
  });
});

describe('GET /api/library/export.csv — audit events (AC-6, M3)', () => {
  it('emits log_csv_export_attempt AFTER auth resolution and BEFORE body', async () => {
    mocks.authMode.value = 'authenticated';
    mocks.repoRef.current!.upsertByPath(baseInput({ path: '/a.mp4' }));
    const res = await GET(getReq('?q=foo'));
    const calls = mocks.loggerInfoMock.mock.calls;
    const attemptCall = calls.find((c) => c[0]?.event === 'log_csv_export_attempt');
    expect(attemptCall).toBeDefined();
    expect(attemptCall![0]).toMatchObject({
      event: 'log_csv_export_attempt',
      username: 'admin',
      ip_hash: 'h:127.0.0.1',
      query: { q: 'foo' },
    });
    expect(typeof attemptCall![0].projectedRowCount).toBe('number');
    await res.arrayBuffer();
  });

  it('audit M3: emits attempt with username:null when auth_enabled=false', async () => {
    mocks.authMode.value = 'disabled';
    mocks.repoRef.current!.upsertByPath(baseInput({ path: '/a.mp4' }));
    const res = await GET(getReq());
    const attemptCall = mocks.loggerInfoMock.mock.calls.find(
      (c) => c[0]?.event === 'log_csv_export_attempt',
    );
    expect(attemptCall).toBeDefined();
    expect(attemptCall![0].username).toBeNull();
    await res.arrayBuffer();
  });

  it('emits log_csv_export_complete with ok:true on success', async () => {
    const repo = mocks.repoRef.current!;
    repo.upsertByPath(baseInput({ path: '/a.mp4' }));
    repo.upsertByPath(baseInput({ path: '/b.mp4' }));
    const res = await GET(getReq());
    await res.arrayBuffer();
    const completeCalls = mocks.loggerInfoMock.mock.calls.filter(
      (c) => c[0]?.event === 'log_csv_export_complete',
    );
    expect(completeCalls).toHaveLength(1);
    expect(completeCalls[0][0]).toMatchObject({
      event: 'log_csv_export_complete',
      ok: true,
      rowsEmitted: 2,
    });
    const attemptCall = mocks.loggerInfoMock.mock.calls.find(
      (c) => c[0]?.event === 'log_csv_export_attempt',
    );
    expect(completeCalls[0][0].requestId).toBe(attemptCall![0].requestId);
  });

  it('audit M1+M2: emits complete with ok:false + errorReason on mid-stream throw', async () => {
    // Override iterateAll to throw on row 2.
    let count = 0;
    mocks.iteratorOverride.fn = (): IterableIterator<FileRow> => {
      const fakeIter: IterableIterator<FileRow> = {
        next(): IteratorResult<FileRow> {
          count++;
          if (count === 1) {
            return {
              done: false,
              value: {
                id: 1,
                path: '/a.mp4',
                size_bytes: 1,
                mtime: 0,
                content_hash: 'x'.repeat(64),
                codec: null,
                bitrate: null,
                duration_seconds: null,
                width: null,
                height: null,
                container: null,
                status: 'pending',
                last_scanned_at: 0,
                created_at: 0,
                updated_at: 0,
                version: 0,
                container_override: null,
                share_id: null,
              },
            };
          }
          throw new Error('synthetic mid-stream failure');
        },
        return: vi.fn(
          (): IteratorResult<FileRow> => ({ done: true, value: undefined as unknown as FileRow }),
        ),
        [Symbol.iterator](): IterableIterator<FileRow> {
          return this;
        },
      };
      return fakeIter;
    };

    const res = await GET(getReq());
    let threw = false;
    try {
      await res.arrayBuffer();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    const completeCall = mocks.loggerInfoMock.mock.calls.find(
      (c) => c[0]?.event === 'log_csv_export_complete',
    );
    expect(completeCall).toBeDefined();
    expect(completeCall![0]).toMatchObject({
      event: 'log_csv_export_complete',
      ok: false,
    });
    expect(completeCall![0].errorReason).toContain('synthetic mid-stream failure');
  });

  it('audit M2: emits complete with errorReason=client_cancelled when reader cancels', async () => {
    const repo = mocks.repoRef.current!;
    for (let i = 0; i < 5; i++) {
      repo.upsertByPath(baseInput({ path: `/row-${i}.mp4` }));
    }
    const res = await GET(getReq());
    const reader = res.body!.getReader();
    // Read BOM + header chunk.
    await reader.read();
    await reader.cancel();
    const completeCall = mocks.loggerInfoMock.mock.calls.find(
      (c) => c[0]?.event === 'log_csv_export_complete',
    );
    expect(completeCall).toBeDefined();
    expect(completeCall![0]).toMatchObject({
      event: 'log_csv_export_complete',
      ok: false,
      errorReason: 'client_cancelled',
    });
  });
});

describe('GET /api/library/export.csv — backpressure (audit M4)', () => {
  it('with 100 rows, after 4 consumer reads iterAdvances stays bounded — proves pull-based, not start() push', async () => {
    const repo = mocks.repoRef.current!;
    for (let i = 0; i < 100; i++) {
      repo.upsertByPath(
        baseInput({ path: `/row-${i.toString().padStart(3, '0')}.mp4`, size_bytes: 100_000 - i }),
      );
    }

    let iterAdvances = 0;
    const innerIter = repo.iterateAll({ page: 1, size: 100, sort: 'size', dir: 'desc' });
    mocks.iteratorOverride.fn = (): IterableIterator<FileRow> => ({
      next(): IteratorResult<FileRow> {
        iterAdvances++;
        return innerIter.next();
      },
      return: innerIter.return?.bind(innerIter),
      [Symbol.iterator](): IterableIterator<FileRow> {
        return this;
      },
    });

    const res = await GET(getReq());
    const reader = res.body!.getReader();

    // Read 4 chunks (BOM + header + ~2 rows). With pull-based backpressure,
    // iterAdvances is bounded near 4 (NOT 100). A start()-push pattern would
    // pre-buffer all 100 advances before the first read returned.
    for (let i = 0; i < 4; i++) {
      await reader.read();
    }
    expect(iterAdvances).toBeLessThan(10);
    expect(iterAdvances).toBeGreaterThan(0);

    // Drain so the test exits cleanly.
    while (true) {
      const r = await reader.read();
      if (r.done) break;
    }
    // After full drain, the iterator advanced exactly 100 times + 1 final
    // .next() that returned done — total 101.
    expect(iterAdvances).toBe(101);
  });
});

describe('GET /api/library/export.csv — request abort (audit S1)', () => {
  it('request.signal abort triggers cleanup and client_cancelled completion', async () => {
    const repo = mocks.repoRef.current!;
    for (let i = 0; i < 5; i++) {
      repo.upsertByPath(baseInput({ path: `/row-${i}.mp4` }));
    }
    // jsdom + undici Request rejects cross-realm AbortSignal in init.signal.
    // Inject the signal post-construction by overriding the property descriptor
    // so the route's request.signal.addEventListener('abort', ...) hooks our
    // controllable AbortSignal.
    const ctrl = new AbortController();
    const req = getReq();
    Object.defineProperty(req, 'signal', { value: ctrl.signal, configurable: true });
    const res = await GET(req);
    const reader = res.body!.getReader();
    await reader.read(); // BOM
    ctrl.abort();
    // Give the abort listener a tick to run.
    await new Promise((r) => setTimeout(r, 10));
    const completeCall = mocks.loggerInfoMock.mock.calls.find(
      (c) => c[0]?.event === 'log_csv_export_complete',
    );
    expect(completeCall).toBeDefined();
    expect(completeCall![0]).toMatchObject({
      event: 'log_csv_export_complete',
      ok: false,
      errorReason: 'client_cancelled',
    });
    try {
      await reader.cancel();
    } catch {
      // already errored
    }
  });
});

describe('GET /api/library/export.csv — 10k row scale (AC-7)', () => {
  it('streams exactly 10001 CRLF lines for 10k rows without OOM', async () => {
    const repo = mocks.repoRef.current!;
    db.exec('BEGIN');
    for (let i = 0; i < 10_000; i++) {
      repo.upsertByPath(
        baseInput({ path: `/row-${i.toString().padStart(5, '0')}.mp4`, size_bytes: i }),
      );
    }
    db.exec('COMMIT');

    const res = await GET(getReq());
    const reader = res.body!.getReader();
    const decoder = new TextDecoder('utf-8');
    let totalText = '';
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      totalText += decoder.decode(r.value as Uint8Array, { stream: true });
    }
    totalText += decoder.decode();

    const body = totalText.startsWith('﻿') ? totalText.slice(1) : totalText;
    const lines = body.split('\r\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(10_001); // header + 10k rows
    // Header invariant — confirms the streamed prefix is well-formed even at
    // the 10k-row scale.
    expect(lines[0]).toBe(CSV_HEADERS.join(','));
  });
});
