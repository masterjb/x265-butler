// 05-03 T1.J: GET /api/logs/[jobId] tests.
// Phase 5 Plan 05-03 — AC-2 + AC-10 + audit M1.

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

const mockJob = {
  findById: vi.fn((_id: number): { status: string } | undefined => undefined),
};

const mocks = vi.hoisted(() => ({
  authMode: { value: 'disabled' as 'disabled' | 'authenticated' | 'denied' },
}));

vi.mock('@/src/lib/db', () => ({
  settingRepo: () => mockSetting,
  jobRepo: () => mockJob,
  shareRepo: () => ({ listAll: () => [] }),
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

import { GET } from '@/app/api/logs/[jobId]/route';

let tmpDir: string;

function makeReq(jobId: string, query: string = ''): Request {
  return new Request(`http://localhost/api/logs/${jobId}${query}`);
}

function ctx(jobId: string): { params: Promise<{ jobId: string }> } {
  return { params: Promise.resolve({ jobId }) };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'x265-logs-jobid-test-'));
  mockSetting.store.clear();
  mockSetting.store.set('cache_pool_path', tmpDir);
  mocks.authMode.value = 'disabled';
  mockJob.findById.mockReset();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('GET /api/logs/[jobId] — auth gate', () => {
  it('returns 401 when auth_required (auth gate before fs.* — AC-10)', async () => {
    mocks.authMode.value = 'denied';
    const res = await GET(makeReq('42'), ctx('42'));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error_code: string };
    expect(body.error_code).toBe('auth_required');
  });

  it('passes through when auth disabled', async () => {
    await fs.mkdir(path.join(tmpDir, 'logs'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'logs', '42.log'), 'hi\n');
    const res = await GET(makeReq('42'), ctx('42'));
    expect(res.status).toBe(200);
  });
});

describe('GET /api/logs/[jobId] — validation', () => {
  it('rejects invalid jobId format with 400 invalid_job_id', async () => {
    const res = await GET(makeReq('../etc/passwd'), ctx('../etc/passwd'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error_code: string };
    expect(body.error_code).toBe('invalid_job_id');
  });

  it('rejects too-long jobId with 400 invalid_job_id', async () => {
    const long = 'x'.repeat(100);
    const res = await GET(makeReq(long), ctx(long));
    expect(res.status).toBe(400);
  });

  it('returns 404 log_not_found when file missing', async () => {
    const res = await GET(makeReq('999'), ctx('999'));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error_code: string };
    expect(body.error_code).toBe('log_not_found');
  });

  it('returns 404 log_not_found when cache_pool_path empty', async () => {
    mockSetting.store.delete('cache_pool_path');
    const res = await GET(makeReq('42'), ctx('42'));
    expect(res.status).toBe(404);
  });
});

describe('GET /api/logs/[jobId] — happy read', () => {
  it('returns 200 JSON with lines + totalLines + status', async () => {
    await fs.mkdir(path.join(tmpDir, 'logs'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'logs', '7.log'), 'one\ntwo\nthree\n');
    mockJob.findById.mockReturnValueOnce({ status: 'done-smaller' });
    const res = await GET(makeReq('7'), ctx('7'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jobId: string;
      lines: string[];
      totalLines: number;
      status: string | null;
      requestId: string;
    };
    expect(body.jobId).toBe('7');
    expect(body.lines).toEqual(['one', 'two', 'three']);
    expect(body.totalLines).toBe(3);
    expect(body.status).toBe('done-smaller');
    expect(typeof body.requestId).toBe('string');
  });

  it('emits truncated:true when file >5MB', async () => {
    await fs.mkdir(path.join(tmpDir, 'logs'), { recursive: true });
    const big = Buffer.alloc(6 * 1024 * 1024, 'x'); // no newlines
    await fs.writeFile(path.join(tmpDir, 'logs', '8.log'), big);
    const res = await GET(makeReq('8'), ctx('8'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { truncated: boolean };
    expect(body.truncated).toBe(true);
  });

  it('?since=N reads from byte offset', async () => {
    await fs.mkdir(path.join(tmpDir, 'logs'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'logs', '9.log'), 'AAAA\nBBBB\nCCCC\n');
    const res = await GET(makeReq('9', '?since=5'), ctx('9'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lines: string[] };
    expect(body.lines).toEqual(['BBBB', 'CCCC']);
  });

  it('?order=desc reverses output', async () => {
    await fs.mkdir(path.join(tmpDir, 'logs'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'logs', '10.log'), 'a\nb\nc\n');
    const res = await GET(makeReq('10', '?order=desc'), ctx('10'));
    const body = (await res.json()) as { lines: string[] };
    expect(body.lines).toEqual(['c', 'b', 'a']);
  });
});

describe('GET /api/logs/[jobId] — audit M1 path containment', () => {
  it('regex pre-empts a basic traversal attempt before path-resolve check', async () => {
    // jobId regex itself rejects '../etc' — defense-in-depth gates beyond the regex.
    const res = await GET(makeReq('a/b'), ctx('a/b'));
    expect(res.status).toBe(400);
  });
});
