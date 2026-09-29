// 22-02 T2.2 (audit-revised): PUT /api/settings cache_pool_path writability
// validation. Verifies AC-4 (HTTP 400 + fieldErrors), AC-11 (settings_change_rejected
// audit-trail across all 3 rejection branches), and audit-M1 idempotency
// invariant (NO side-effect mkdir on PUT path).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { mockGetAll, mockGet, mockSet, mockTransaction, mockShareListAll, warnSpy, infoSpy } =
  vi.hoisted(() => ({
    mockGetAll: vi.fn<() => Record<string, string>>(),
    mockGet: vi.fn<(key: string) => string | undefined>(),
    mockSet: vi.fn<(key: string, value: string) => void>(),
    mockTransaction: vi.fn(<T extends unknown[]>(fn: (...args: T) => unknown) => {
      return (...args: T) => fn(...args);
    }),
    mockShareListAll: vi.fn<
      () => Array<{
        id: number;
        name: string;
        path: string;
        min_size_mb: number;
        extensions_csv: string;
        max_depth: number | null;
        created_at: number;
        updated_at: number;
      }>
    >(),
    warnSpy: vi.fn(),
    infoSpy: vi.fn(),
  }));

vi.mock('@/src/lib/db', () => ({
  getDb: () => ({ transaction: mockTransaction }),
  settingRepo: () => ({ getAll: mockGetAll, get: mockGet, set: mockSet }),
  shareRepo: () => ({ listAll: mockShareListAll }),
  default: {},
}));

vi.mock('@/src/lib/logger', () => {
  const child = () => ({
    info: infoSpy,
    warn: warnSpy,
    error: vi.fn(),
  });
  return {
    logger: { child, info: infoSpy, warn: warnSpy, error: vi.fn() },
    default: { logger: { child } },
  };
});

// NOTE: this test exercises the REAL probeCachePoolWritable against real fs.
// We use chmod 0o500 + mkdtemp to drive deterministic EACCES / writable cases.
// Other failure modes (EROFS) are unit-tested in
// tests/encode/staging-probe-cache-pool-writable.test.ts.

import { PUT } from '@/app/api/settings/route';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function jsonReq(body: unknown): Request {
  return new Request('http://localhost/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const seedDefaults = {
  language: 'en',
  output_container: 'mkv',
};

const createdTmpDirs: string[] = [];

function makeTmpDir(label: string, mode = 0o755): string {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), `x265-22-02-${label}-`));
  if (mode !== 0o755) {
    fs.chmodSync(p, mode);
  }
  createdTmpDirs.push(p);
  return p;
}

describe('22-02 T2.2: PUT /api/settings cache_pool_path writability validation', () => {
  beforeEach(() => {
    mockGetAll.mockReset();
    mockGet.mockReset();
    mockSet.mockReset();
    mockTransaction.mockReset();
    mockShareListAll.mockReset();
    warnSpy.mockReset();
    infoSpy.mockReset();
    mockGetAll.mockReturnValue({ ...seedDefaults });
    mockGet.mockImplementation((k: string) => seedDefaults[k as keyof typeof seedDefaults]);
    mockTransaction.mockImplementation(<T extends unknown[]>(fn: (...args: T) => unknown) => {
      return (...args: T) => fn(...args);
    });
    mockShareListAll.mockReturnValue([]);
  });

  afterEach(() => {
    for (const p of createdTmpDirs) {
      try {
        fs.chmodSync(p, 0o755);
      } catch {
        /* may not exist */
      }
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    createdTmpDirs.length = 0;
  });

  it('happy: existing writable dir → 200, persisted, probe-only (NO side-effect mkdir)', async () => {
    const dir = makeTmpDir('happy');
    expect(fs.existsSync(dir)).toBe(true);
    mockGetAll
      .mockReset()
      .mockReturnValueOnce({ ...seedDefaults, cache_pool_path: '/mnt/cache' })
      .mockReturnValueOnce({ ...seedDefaults, cache_pool_path: dir });
    const res = await PUT(jsonReq({ settings: { cache_pool_path: dir } }));
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith('cache_pool_path', dir);
    // probe-file artifacts are auto-cleaned; directory must still exist.
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('AC-4 + audit M1: ENOENT (path does not exist) → 400 + code=ENOENT; NO mkdir side-effect', async () => {
    const nonexistent = path.join(
      os.tmpdir(),
      `x265-22-02-nonexistent-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    expect(fs.existsSync(nonexistent)).toBe(false);
    const res = await PUT(jsonReq({ settings: { cache_pool_path: nonexistent } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('validation_failed');
    expect(body.fieldErrors.cache_pool_path).toBe('cache_pool_path_not_writable');
    expect(body.code).toBe('ENOENT');
    expect(body.requestId).toMatch(UUID_V4);
    expect(fs.existsSync(nonexistent)).toBe(false); // AUDIT M1 invariant: validation never creates FS state
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('AC-4: existing-dir-not-writable (chmod 0o500) → 400 + code ∈ {EACCES,EROFS}', async () => {
    if (process.getuid?.() === 0) {
      // root bypasses W_OK perms — skip this case under root (CI sometimes runs as root).
      return;
    }
    const dir = makeTmpDir('eacces', 0o500);
    const res = await PUT(jsonReq({ settings: { cache_pool_path: dir } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('validation_failed');
    expect(body.fieldErrors.cache_pool_path).toBe('cache_pool_path_not_writable');
    expect(['EACCES', 'EROFS']).toContain(body.code);
  });

  it('AC-11 audit-trail: ENOENT rejection emits settings_change_rejected with requestId + cachePath', async () => {
    const nonexistent = path.join(os.tmpdir(), `x265-22-02-audit-${Date.now()}`);
    const res = await PUT(jsonReq({ settings: { cache_pool_path: nonexistent } }));
    expect(res.status).toBe(400);
    const warns = warnSpy.mock.calls.filter(
      (c) => c[0]?.action === 'settings_change_rejected' && c[0]?.code === 'ENOENT',
    );
    expect(warns).toHaveLength(1);
    expect(warns[0][0]).toMatchObject({
      action: 'settings_change_rejected',
      field: 'cache_pool_path',
      code: 'ENOENT',
      cachePath: nonexistent,
    });
    expect(warns[0][0].requestId).toMatch(UUID_V4);
  });

  it('AC-11 precedence (1) — share-collision wins over not-writable; emits code=nested_under_share', async () => {
    // chmod 0o500 the path AND make it nested-under-share — share-check fires first.
    const dir = makeTmpDir('precedence-share', 0o500);
    mockShareListAll.mockReturnValue([
      {
        id: 1,
        name: 'Library',
        path: dir, // share-path == cache-path → share-collision
        min_size_mb: 50,
        extensions_csv: 'mkv',
        max_depth: null,
        created_at: 1,
        updated_at: 1,
      },
    ]);
    const res = await PUT(jsonReq({ settings: { cache_pool_path: dir } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('validation_failed');
    expect(body.fieldErrors.cache_pool_path).toBe('cache_pool_path_nested_under_share');
    // audit-trail: code is the rejection-reason string, NOT an errno
    const warns = warnSpy.mock.calls.filter((c) => c[0]?.action === 'settings_change_rejected');
    expect(warns).toHaveLength(1);
    expect(warns[0][0]).toMatchObject({
      action: 'settings_change_rejected',
      field: 'cache_pool_path',
      code: 'nested_under_share',
      cachePath: dir,
    });
  });

  it('AC-11 precedence (2) — forbidden-prefix wins over not-writable; emits code=forbidden_prefix', async () => {
    const res = await PUT(jsonReq({ settings: { cache_pool_path: '/proc/x265-butler' } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('forbidden_cache_path'); // distinct response shape preserved
    const warns = warnSpy.mock.calls.filter((c) => c[0]?.action === 'settings_change_rejected');
    expect(warns).toHaveLength(1);
    expect(warns[0][0]).toMatchObject({
      action: 'settings_change_rejected',
      field: 'cache_pool_path',
      code: 'forbidden_prefix',
      cachePath: '/proc/x265-butler',
    });
  });
});
