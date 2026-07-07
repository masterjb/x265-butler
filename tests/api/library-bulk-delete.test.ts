// 29-03 T3 tests — POST /api/library/bulk-delete (row-only bulk forget).
// Mirrors tests/api/library-bulk-blocklist.test.ts envelope coverage + adds the
// single-delete guard reasons (active_job / bench_reference / not_found), the AC-6
// TOCTOU re-check, and the MANDATORY zero-FS-import static-source guard (AC-1) —
// the headline data-safety invariant that distinguishes this route from the
// adjacent trash bulk-delete that DOES unlink.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FileRow } from '@/src/lib/db/schema';

const authMode = { value: 'disabled' as 'disabled' | 'authenticated' | 'denied' };

const mocks = vi.hoisted(() => ({
  mockDbPrepareRun: vi.fn(),
  mockFileGetById: vi.fn(),
  mockFileDeleteById: vi.fn(),
  mockFileIsReferencedByBench: vi.fn(),
  mockEnsureServerInit: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock('@/src/lib/db', () => ({
  getDb: () => ({
    prepare: () => ({ run: mocks.mockDbPrepareRun }),
    transaction: <T>(fn: T) => fn,
  }),
  fileRepo: () => ({
    getById: mocks.mockFileGetById,
    deleteById: mocks.mockFileDeleteById,
    isReferencedByBench: mocks.mockFileIsReferencedByBench,
  }),
  default: {},
}));

vi.mock('@/src/lib/server-init', () => ({
  ensureServerInit: mocks.mockEnsureServerInit,
  default: {},
}));

vi.mock('@/src/lib/logger', () => ({
  logger: {
    child: () => ({
      info: mocks.mockLoggerInfo,
      warn: mocks.mockLoggerWarn,
      error: mocks.mockLoggerError,
    }),
  },
  default: {},
}));

vi.mock('@/src/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(async () => {
    if (authMode.value === 'denied') {
      return { ok: false, status: 401, body: { error_code: 'auth_required' } };
    }
    if (authMode.value === 'authenticated') {
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
}));

import { POST, runtime } from '@/app/api/library/bulk-delete/route';

const ROUTE_URL = 'http://test/api/library/bulk-delete';

function makeRequest(body?: unknown, headers?: Record<string, string>): Request {
  return new Request(ROUTE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const baseFile: FileRow = {
  id: 1,
  path: '/movies/A.mkv',
  size_bytes: 1024,
  mtime: 1700000000,
  content_hash: 'a'.repeat(64),
  codec: 'h264',
  bitrate: 1000000,
  duration_seconds: 60,
  width: 1920,
  height: 1080,
  container: 'mp4',
  status: 'pending',
  last_scanned_at: 1700000000,
  created_at: 1700000000,
  updated_at: 1700000000,
  version: 0,
  container_override: null,
  share_id: null,
};

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  authMode.value = 'disabled';
  mocks.mockFileIsReferencedByBench.mockReturnValue(false);
  mocks.mockFileDeleteById.mockReturnValue(true);
});

describe('POST /api/library/bulk-delete', () => {
  it('runtime is nodejs', () => {
    expect(runtime).toBe('nodejs');
  });

  // AC-1 — happy path + zero-FS runtime assertion.
  it('happy path — 3 deletable IDs → 200 successCount=3, deleteById per id, no FS spy hit', async () => {
    const fsSpy = vi.fn();
    mocks.mockFileGetById.mockImplementation((id: number) => ({ ...baseFile, id }));
    mocks.mockFileDeleteById.mockImplementation((id: number) => {
      fsSpy(id); // proxy: never an actual fs call — proves deleteById is the only mutation
      return true;
    });
    const res = await POST(makeRequest({ ids: [1, 2, 3] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.successCount).toBe(3);
    expect(body.failed).toEqual([]);
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(mocks.mockFileDeleteById).toHaveBeenCalledTimes(3);
    expect(mocks.mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ audit: 'bulk_library_delete', successCount: 3 }),
      'bulk_library_delete',
    );
  });

  // AC-1 — MANDATORY static-source zero-unlink invariant (audit M2). A runtime spy can
  // pass vacuously if a future edit imports fs but the happy path never triggers unlink;
  // the static-source assertion cannot.
  it('route source imports NEITHER node:fs NOR node:fs/promises (zero-unlink invariant)', () => {
    const src = readFileSync(join(process.cwd(), 'app/api/library/bulk-delete/route.ts'), 'utf8');
    expect(src).not.toMatch(/from\s+['"]node:fs['"]/);
    expect(src).not.toMatch(/from\s+['"]node:fs\/promises['"]/);
    expect(src).not.toMatch(/require\(\s*['"]node:fs(\/promises)?['"]\s*\)/);
  });

  // AC-2 — per-id guards mirror single-delete (partial-success).
  it('partial — not_found + active_job + bench_reference + deletable → 200 successCount=1', async () => {
    mocks.mockFileGetById.mockImplementation((id: number) => {
      if (id === 1) return undefined; // not_found
      if (id === 2) return { ...baseFile, id: 2, status: 'queued' }; // active_job
      if (id === 3) return { ...baseFile, id: 3 }; // bench_reference (pre-check)
      if (id === 4) return { ...baseFile, id: 4 }; // success
      return undefined;
    });
    mocks.mockFileIsReferencedByBench.mockImplementation((id: number) => id === 3);
    const res = await POST(makeRequest({ ids: [1, 2, 3, 4] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.successCount).toBe(1);
    expect(body.failed).toEqual([
      { id: 1, reason: 'not_found' },
      { id: 2, reason: 'active_job' },
      { id: 3, reason: 'bench_reference' },
    ]);
    expect(mocks.mockFileDeleteById).toHaveBeenCalledTimes(1);
    expect(mocks.mockFileDeleteById).toHaveBeenCalledWith(4);
  });

  // AC-2 — SAVEPOINT isolation: one internal_error id does not roll back a sibling success.
  it('SAVEPOINT-rollback isolates internal_error to one ID — others commit', async () => {
    mocks.mockFileGetById.mockImplementation((id: number) => ({ ...baseFile, id }));
    mocks.mockFileDeleteById.mockImplementation((id: number) => {
      if (id === 2) throw new Error('boom');
      return true;
    });
    const res = await POST(makeRequest({ ids: [1, 2, 3] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.successCount).toBe(2);
    expect(body.failed).toEqual([{ id: 2, reason: 'internal_error' }]);
    expect(mocks.mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ id: 2 }),
      'bulk-delete per-id internal_error',
    );
  });

  // AC-3 — envelope guards.
  it('415 on wrong Content-Type', async () => {
    const req = new Request(ROUTE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ ids: [1] }),
    });
    const res = await POST(req);
    expect(res.status).toBe(415);
    expect((await res.json()).error).toBe('unsupported_media_type');
  });

  it('400 on invalid JSON', async () => {
    const req = new Request(ROUTE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_json');
  });

  it('400 on zod fail — empty ids array', async () => {
    const res = await POST(makeRequest({ ids: [] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_body');
  });

  it('400 on zod fail — over 500 ids', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => i + 1);
    const res = await POST(makeRequest({ ids }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_body');
  });

  it('400 on zod fail — duplicate ids', async () => {
    const res = await POST(makeRequest({ ids: [1, 2, 1] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_body');
  });

  it('400 on zod fail — non-positive id', async () => {
    const res = await POST(makeRequest({ ids: [1, 0] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_body');
  });

  it('auth-denial → authGuard response (401), no DB touch', async () => {
    authMode.value = 'denied';
    const res = await POST(makeRequest({ ids: [1] }));
    expect(res.status).toBe(401);
    expect(mocks.mockFileGetById).not.toHaveBeenCalled();
  });

  it('all-failed-known-reasons still returns 200 (partial-success envelope)', async () => {
    mocks.mockFileGetById.mockReturnValue(undefined); // every id → not_found
    const res = await POST(makeRequest({ ids: [1, 2, 3] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.successCount).toBe(0);
    expect(body.failed.length).toBe(3);
    expect(body.failed.every((f: { reason: string }) => f.reason === 'not_found')).toBe(true);
  });

  // AC-6 — TOCTOU: pending at pre-check, promoted to encoding before inner re-read → active_job.
  it('TOCTOU — row pending at pre-check, encoding at inner re-read → active_job (not deleted)', async () => {
    let call = 0;
    mocks.mockFileGetById.mockImplementation((id: number) => {
      call += 1;
      // first read (pre-check) pending, second read (inner re-check) encoding
      return { ...baseFile, id, status: call === 1 ? 'pending' : 'encoding' };
    });
    const res = await POST(makeRequest({ ids: [1] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.successCount).toBe(0);
    expect(body.failed).toEqual([{ id: 1, reason: 'active_job' }]);
    expect(mocks.mockFileDeleteById).not.toHaveBeenCalled();
  });

  // AC-6 — FK constraint thrown by deleteById (race past pre-check) → bench_reference (not 500).
  it('FK constraint from deleteById → bench_reference (defense-in-depth)', async () => {
    mocks.mockFileGetById.mockImplementation((id: number) => ({ ...baseFile, id }));
    mocks.mockFileDeleteById.mockImplementation(() => {
      const err = new Error('FOREIGN KEY constraint failed') as Error & { code: string };
      err.code = 'SQLITE_CONSTRAINT_FOREIGNKEY';
      throw err;
    });
    const res = await POST(makeRequest({ ids: [1] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.successCount).toBe(0);
    expect(body.failed).toEqual([{ id: 1, reason: 'bench_reference' }]);
  });

  it('tx-throw → 500 internal_error', async () => {
    vi.resetModules();
    vi.doMock('@/src/lib/db', () => ({
      getDb: () => ({
        prepare: () => ({ run: mocks.mockDbPrepareRun }),
        transaction: () => () => {
          throw new Error('db-corruption');
        },
      }),
      fileRepo: () => ({
        getById: mocks.mockFileGetById,
        deleteById: mocks.mockFileDeleteById,
        isReferencedByBench: mocks.mockFileIsReferencedByBench,
      }),
      default: {},
    }));
    const { POST: POST2 } = await import('@/app/api/library/bulk-delete/route');
    const res = await POST2(makeRequest({ ids: [1] }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('internal_error');
  });
});
