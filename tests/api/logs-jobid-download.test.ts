// 05-03 T1.J: GET /api/logs/[jobId]/download tests.
// Phase 5 Plan 05-03 — AC-4 + audit S4 + S9.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const mockSetting = {
  store: new Map<string, string>(),
  get(k: string): string | undefined {
    return this.store.get(k);
  },
};

const mocks = vi.hoisted(() => ({
  authMode: { value: 'disabled' as 'disabled' | 'authenticated' | 'denied' },
  loggerInfoMock: vi.fn(),
}));

vi.mock('@/src/lib/db', () => ({
  settingRepo: () => mockSetting,
  shareRepo: () => ({ listAll: () => [] }),
}));

vi.mock('@/src/lib/logger', () => ({
  logger: {
    child: () => ({
      info: mocks.loggerInfoMock,
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

vi.mock('@/src/lib/auth/rate-limit', () => ({
  hashIp: (ip: string) => `h:${ip}`,
  extractIp: () => '127.0.0.1',
}));

vi.mock('@/src/lib/auth/settings-cache', () => ({
  getCachedAuthSetting: (k: string) => mockSetting.get(k) ?? '',
}));

import { GET } from '@/app/api/logs/[jobId]/download/route';

let tmpDir: string;

function makeReq(jobId: string): Request {
  return new Request(`http://localhost/api/logs/${jobId}/download`);
}

function ctx(jobId: string): { params: Promise<{ jobId: string }> } {
  return { params: Promise.resolve({ jobId }) };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'x265-logs-dl-test-'));
  mockSetting.store.clear();
  mockSetting.store.set('cache_pool_path', tmpDir);
  mocks.authMode.value = 'authenticated';
  mocks.loggerInfoMock.mockReset();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('GET /api/logs/[jobId]/download', () => {
  it('returns 401 when auth_required', async () => {
    mocks.authMode.value = 'denied';
    const res = await GET(makeReq('42'), ctx('42'));
    expect(res.status).toBe(401);
  });

  it('returns 400 invalid_job_id when regex fails', async () => {
    const res = await GET(makeReq('a/b'), ctx('a/b'));
    expect(res.status).toBe(400);
  });

  it('returns RFC 5987 Content-Disposition with both filename= and filename*=', async () => {
    await fs.mkdir(path.join(tmpDir, 'logs'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'logs', '42.log'), 'log content\n');
    const res = await GET(makeReq('42'), ctx('42'));
    expect(res.status).toBe(200);
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).toMatch(/filename="42\.log"/);
    expect(cd).toMatch(/filename\*=UTF-8''42\.log/);
    expect(res.headers.get('content-type')).toMatch(/text\/plain/);
  });

  it('emits log_download_attempt audit event before body', async () => {
    await fs.mkdir(path.join(tmpDir, 'logs'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'logs', '42.log'), 'data\n');
    const res = await GET(makeReq('42'), ctx('42'));
    expect(res.status).toBe(200);
    // Drain body so the test exits cleanly.
    await res.text();
    const events = mocks.loggerInfoMock.mock.calls.map((c) => c[0]?.event);
    expect(events).toContain('log_download_attempt');
    const downloadCall = mocks.loggerInfoMock.mock.calls.find(
      (c) => c[0]?.event === 'log_download_attempt',
    );
    expect(downloadCall?.[0]).toMatchObject({
      event: 'log_download_attempt',
      jobId: '42',
      ip_hash: 'h:127.0.0.1',
      username: 'admin',
    });
  });
});
