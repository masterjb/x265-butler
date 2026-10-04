// ISS-002 (2026-09-06): an UNSET `cache_pool_path` must serve job logs.
//
// The reported symptom: the log viewer showed nothing and the download link
// answered `{"error_code":"log_not_found"}`. Filesystem permissions were fine
// (99:100, then 0777) because the filesystem was never consulted — both routes
// read the setting RAW, found '' and returned 404 before any stat.
//
// '' is not a broken install. It is the DEFAULT since 24-03 (DC-B
// auto-resolution) and the state of every upgrader after the 36-03 legacy-row
// migration, while `openJobLogStream` writes to the RESOLVED root.
//
// This file stubs the accessor so the auto-resolved root is a real tmpdir: the
// setting stays unset, and the routes must still find the file. The resolution
// logic itself is covered in tests/encode/cache-path-access.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const mocks = vi.hoisted(() => ({
  // Stands in for whatever DC-B resolves to on the host (/mnt/cache/x265-butler
  // or /config/cache) — neither is writable in CI.
  resolvedRoot: { value: '' },
}));

// The setting store is EMPTY on purpose and stays that way for every test here.
const mockSetting = {
  store: new Map<string, string>(),
  get(k: string): string | undefined {
    return this.store.get(k);
  },
};

vi.mock('@/src/lib/db', () => ({
  settingRepo: () => mockSetting,
  jobRepo: () => ({ findById: () => undefined }),
  shareRepo: () => ({ listAll: () => [] }),
}));

vi.mock('@/src/lib/encode/cache-path-access', () => ({
  readEffectiveCachePathCached: () => ({
    effectivePath: mocks.resolvedRoot.value,
    resolution: 'config-fallback' as const,
  }),
  readEffectiveCachePathFresh: () => ({
    effectivePath: mocks.resolvedRoot.value,
    resolution: 'config-fallback' as const,
  }),
}));

vi.mock('@/src/lib/logger', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
  },
}));

vi.mock('@/src/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(async () => ({ ok: true, mode: 'disabled', username: null })),
  authGuard: () => null,
  withRenewCookie: (res: Response) => res,
}));

vi.mock('@/src/lib/auth/settings-cache', () => ({
  getCachedAuthSetting: () => undefined,
}));

import { GET as readLog } from '@/app/api/logs/[jobId]/route';
import { GET as downloadLog } from '@/app/api/logs/[jobId]/download/route';

let tmpDir: string;

function ctx(jobId: string): { params: Promise<{ jobId: string }> } {
  return { params: Promise.resolve({ jobId }) };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'x265-iss002-'));
  mocks.resolvedRoot.value = tmpDir;
  mockSetting.store.clear(); // cache_pool_path deliberately absent
  await fs.mkdir(path.join(tmpDir, 'logs'), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, 'logs', '42.log'),
    'ffmpeg argv: ffmpeg -i in.mkv\nframe=1\n',
  );
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('ISS-002 — unset cache_pool_path', () => {
  it('the setting really is unset (guards the premise of this file)', () => {
    expect(mockSetting.get('cache_pool_path')).toBeUndefined();
  });

  it('GET /api/logs/[jobId] serves the log from the resolved root', async () => {
    const res = await readLog(new Request('http://localhost/api/logs/42'), ctx('42'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lines: string[] };
    expect(body.lines).toEqual(['ffmpeg argv: ffmpeg -i in.mkv', 'frame=1']);
  });

  it('GET /api/logs/[jobId]/download streams the log from the resolved root', async () => {
    const res = await downloadLog(new Request('http://localhost/api/logs/42/download'), ctx('42'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(await res.text()).toContain('ffmpeg argv:');
  });

  it('still 404s on EVIDENCE when the log genuinely is not there', async () => {
    // The 404 must come from the stat, not from a guard that never looked.
    const res = await readLog(new Request('http://localhost/api/logs/777'), ctx('777'));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error_code: string };
    expect(body.error_code).toBe('log_not_found');
  });

  it('keeps the path-containment guard (05-03 audit M1)', async () => {
    const res = await readLog(
      new Request('http://localhost/api/logs/..%2Fescape'),
      ctx('../escape'),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error_code: string };
    expect(body.error_code).toBe('invalid_job_id');
  });
});
