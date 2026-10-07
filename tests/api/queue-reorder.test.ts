// @vitest-environment node
// /api/queue/reorder against a real in-memory database: PATCH moves one job
// before another (small body whatever the queue length), DELETE clears the
// manual order. Covers validation, 409 on a race, idempotent replay via
// clientNonce, auth, the queue.updated emit and the log fields.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@/src/lib/db/migrate';
import { makeFileRepo, type FileRepo } from '@/src/lib/db/repos/file';
import { makeJobRepo, type JobRepo } from '@/src/lib/db/repos/job';
import { makeSettingRepo, type SettingRepo } from '@/src/lib/db/repos/setting';

type Db = InstanceType<typeof Database>;

const state = vi.hoisted(() => ({
  db: null as unknown as InstanceType<typeof import('better-sqlite3')>,
  jobRepo: null as unknown as import('@/src/lib/db/repos/job').JobRepo,
  settingRepo: null as unknown as import('@/src/lib/db/repos/setting').SettingRepo,
}));

const { mockEmit, mockGateAuth, mockLoggerInfo, mockLoggerWarn, mockLoggerError } = vi.hoisted(
  () => ({
    mockEmit: vi.fn(),
    mockGateAuth: vi.fn(),
    mockLoggerInfo: vi.fn(),
    mockLoggerWarn: vi.fn(),
    mockLoggerError: vi.fn(),
  }),
);

vi.mock('@/src/lib/db', () => ({
  jobRepo: () => state.jobRepo,
  settingRepo: () => state.settingRepo,
  default: {},
}));

vi.mock('@/src/lib/api/auth-gate', () => ({ gateAuth: mockGateAuth }));

vi.mock('@/src/lib/encode/events', () => ({
  engineEvents: { emit: mockEmit, subscribe: vi.fn(), getLastProgress: vi.fn() },
  default: {},
}));

vi.mock('@/src/lib/server-init', () => ({ ensureServerInit: vi.fn(), default: {} }));

vi.mock('@/src/lib/logger', () => {
  const log = {
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: mockLoggerError,
    debug: vi.fn(),
    telemetry: vi.fn(),
  };
  return { logger: { ...log, child: vi.fn(() => log) }, default: {} };
});

import { PATCH, DELETE, runtime, __resetNonceCacheForTests } from '@/app/api/queue/reorder/route';

let fileRepo: FileRepo;
let seq = 0;

function seedQueued(n: number): number[] {
  const out: number[] = [];
  state.db.transaction(() => {
    for (let i = 0; i < n; i++) {
      seq += 1;
      const fileId = fileRepo.upsertByPath({
        path: `/media/f${seq}.mkv`,
        size_bytes: 1000 + i,
        mtime: 1_700_000_000,
        content_hash: 'a'.repeat(64),
        codec: 'h264',
        bitrate: 1,
        duration_seconds: 60,
        width: 1920,
        height: 1080,
        container: 'mkv',
        last_scanned_at: 1_700_000_000,
        share_id: null,
      }).id;
      out.push(state.jobRepo.create({ file_id: fileId, encoder: 'libx265', crf: null })!.id);
    }
  })();
  return out;
}

function patchReq(
  body: unknown,
  headers: Record<string, string> = { 'content-type': 'application/json' },
): Request {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request('http://localhost/api/queue/reorder', {
    method: 'PATCH',
    headers,
    body: text,
  });
}

const deleteReq = () => new Request('http://localhost/api/queue/reorder', { method: 'DELETE' });

const queuedIds = (order: 'oldest' | 'largest' = 'oldest') =>
  state.jobRepo.peekQueued(1000, order).map((r) => r.id);

const pinned = (id: number) =>
  (
    state.db.prepare('SELECT queue_pinned FROM job WHERE id = ?').get(id) as {
      queue_pinned: number;
    }
  ).queue_pinned;

const loggedActions = (fn: ReturnType<typeof vi.fn>) =>
  fn.mock.calls.map((c) => (c[0] as { action?: string })?.action).filter(Boolean);

beforeEach(() => {
  seq = 0;
  state.db = new Database(':memory:') as Db;
  migrate(state.db);
  state.db.pragma('foreign_keys = ON');
  fileRepo = makeFileRepo(state.db);
  state.jobRepo = makeJobRepo(state.db, {
    setFileStatus: (id, status, v) => fileRepo.setStatus(id, status, v),
    bulkSetFileStatusToPending: (ids, s) => fileRepo.bulkSetStatusToPendingByIds(ids, s),
  }) as JobRepo;
  state.settingRepo = makeSettingRepo(state.db) as SettingRepo;
  mockEmit.mockReset();
  mockLoggerInfo.mockReset();
  mockLoggerWarn.mockReset();
  mockLoggerError.mockReset();
  mockGateAuth.mockReset();
  mockGateAuth.mockResolvedValue({
    denied: null,
    auth: { ok: true, mode: 'authenticated', username: 'operator' },
  });
  __resetNonceCacheForTests();
});

afterEach(() => {
  vi.useRealTimers();
  state.db.close();
});

describe('PATCH /api/queue/reorder', () => {
  it('runs on the node runtime', () => {
    expect(runtime).toBe('nodejs');
  });

  it('moves one job in a queue of 6500 without 413', async () => {
    const all = seedQueued(6500);
    const body = { jobId: all[6000], beforeJobId: all[0], clientNonce: crypto.randomUUID() };
    expect(JSON.stringify(body).length).toBeLessThan(200);
    const res = await PATCH(patchReq(body));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; pinnedCount: number; requestId: string };
    expect(json).toMatchObject({ ok: true, pinnedCount: 1 });
    expect(queuedIds()[0]).toBe(all[6000]);
  });

  it('logs queue_reordered with indexes and no id lists', async () => {
    const all = seedQueued(6500);
    await PATCH(
      patchReq({ jobId: all[6000], beforeJobId: all[0], clientNonce: crypto.randomUUID() }),
    );
    const line = mockLoggerInfo.mock.calls.find(
      (c) => (c[0] as { action?: string }).action === 'queue_reordered',
    )![0] as Record<string, unknown>;
    expect(line).toMatchObject({
      actorId: 'operator',
      jobId: all[6000],
      beforeJobId: all[0],
      fromIndex: 6000,
      toIndex: 0,
      pinnedCount: 1,
      queueLength: 6500,
      order: 'oldest',
    });
    expect(JSON.stringify(line).length).toBeLessThan(500);
    for (const v of Object.values(line)) expect(Array.isArray(v)).toBe(false);
  });

  it('drop lands where dropped, jobs beyond the first 1000 do not move up', async () => {
    const all = seedQueued(1500);
    const res = await PATCH(
      patchReq({ jobId: all[1200], beforeJobId: all[10], clientNonce: crypto.randomUUID() }),
    );
    expect(res.status).toBe(200);
    const expected = [
      ...all.slice(0, 10),
      all[1200],
      ...all.slice(10).filter((id) => id !== all[1200]),
    ];
    expect(queuedIds()).toEqual(expected.slice(0, 1000));
  });

  it('follows the stored processing order', async () => {
    const all = seedQueued(3); // sizes 1000, 1001, 1002 → largest: all[2], all[1], all[0]
    state.settingRepo.set('queue_order', 'largest');
    const res = await PATCH(
      patchReq({ jobId: all[0], beforeJobId: all[1], clientNonce: crypto.randomUUID() }),
    );
    expect(await res.json()).toMatchObject({ ok: true, pinnedCount: 2 });
    expect(queuedIds('largest')).toEqual([all[2], all[0], all[1]]);
  });

  it('null moves to the end', async () => {
    const [a, b, c] = seedQueued(3);
    const res = await PATCH(
      patchReq({ jobId: a, beforeJobId: null, clientNonce: crypto.randomUUID() }),
    );
    expect(res.status).toBe(200);
    expect(queuedIds()).toEqual([b, c, a]);
  });

  it('emits exactly one queue.updated', async () => {
    const [a, b] = seedQueued(2);
    await PATCH(patchReq({ jobId: b, beforeJobId: a, clientNonce: crypto.randomUUID() }));
    const emits = mockEmit.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === 'queue.updated',
    );
    expect(emits).toHaveLength(1);
    expect(emits[0][0]).toMatchObject({ pendingJobs: 2 });
  });

  it('unknown ids give 400 reorder_unknown_jobids', async () => {
    const [a] = seedQueued(1);
    const res = await PATCH(
      patchReq({ jobId: a, beforeJobId: 999_999, clientNonce: crypto.randomUUID() }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: 'reorder_unknown_jobids',
      unknownJobIds: [999_999],
    });
  });

  it('the same id twice gives 400 invalid_body', async () => {
    const [a] = seedQueued(1);
    const res = await PATCH(
      patchReq({ jobId: a, beforeJobId: a, clientNonce: crypto.randomUUID() }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_body' });
  });

  it('a job that is no longer queued gives 409 and nothing is written', async () => {
    const [a, b] = seedQueued(2);
    state.db.prepare("UPDATE job SET status = 'encoding' WHERE id = ?").run(a);
    const res = await PATCH(
      patchReq({ jobId: b, beforeJobId: a, clientNonce: crypto.randomUUID() }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: 'reorder_race_status_changed',
      conflictingJobIds: [a],
    });
    expect(pinned(b)).toBe(0);
    expect(loggedActions(mockLoggerWarn)).toContain('queue_reorder_race_status_changed');
  });

  it('the old body with orderedJobIds gives 400 invalid_body', async () => {
    const [a, b] = seedQueued(2);
    const res = await PATCH(patchReq({ orderedJobIds: [b, a], clientNonce: crypto.randomUUID() }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_body' });
    expect(queuedIds()).toEqual([a, b]);
  });

  it('missing or malformed clientNonce gives 400 reorder_invalid_nonce', async () => {
    const [a, b] = seedQueued(2);
    for (const nonce of [undefined, 'not-a-uuid']) {
      const res = await PATCH(patchReq({ jobId: b, beforeJobId: a, clientNonce: nonce }));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'reorder_invalid_nonce' });
    }
  });

  it('wrong content type gives 415', async () => {
    const res = await PATCH(patchReq('{}', { 'content-type': 'text/plain' }));
    expect(res.status).toBe(415);
  });

  it('a body over 16 KB gives 413', async () => {
    const res = await PATCH(
      patchReq('{}', { 'content-type': 'application/json', 'content-length': '20000' }),
    );
    expect(res.status).toBe(413);
  });

  it('a replay with the same nonce returns the cached answer without moving again', async () => {
    const [a, b, c] = seedQueued(3);
    const nonce = crypto.randomUUID();
    const first = await PATCH(patchReq({ jobId: c, beforeJobId: a, clientNonce: nonce }));
    const firstBody = await first.text();
    // Move something else in between; a replay must not undo it.
    await PATCH(patchReq({ jobId: b, beforeJobId: c, clientNonce: crypto.randomUUID() }));
    const order = queuedIds();
    const replay = await PATCH(patchReq({ jobId: c, beforeJobId: a, clientNonce: nonce }));
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe(firstBody);
    expect(queuedIds()).toEqual(order);
    expect(loggedActions(mockLoggerInfo)).toContain('queue_reorder_idempotent_replay');
  });

  it('a replay of a 409 returns the same 409', async () => {
    const [a, b] = seedQueued(2);
    state.db.prepare("UPDATE job SET status = 'encoding' WHERE id = ?").run(a);
    const nonce = crypto.randomUUID();
    const first = await PATCH(patchReq({ jobId: b, beforeJobId: a, clientNonce: nonce }));
    const replay = await PATCH(patchReq({ jobId: b, beforeJobId: a, clientNonce: nonce }));
    expect(replay.status).toBe(409);
    expect(await replay.text()).toBe(await first.text());
  });

  it('after 61 seconds the same nonce runs again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const [a, b] = seedQueued(2);
    const nonce = crypto.randomUUID();
    await PATCH(patchReq({ jobId: b, beforeJobId: a, clientNonce: nonce }));
    await PATCH(patchReq({ jobId: a, beforeJobId: b, clientNonce: crypto.randomUUID() }));
    vi.setSystemTime(Date.now() + 61_000);
    await PATCH(patchReq({ jobId: b, beforeJobId: a, clientNonce: nonce }));
    expect(queuedIds()).toEqual([b, a]);
  });

  it('unauthenticated PATCH gives 401 and writes nothing', async () => {
    const [a, b] = seedQueued(2);
    mockGateAuth.mockResolvedValueOnce({
      denied: new Response('unauthorized', { status: 401 }),
      auth: null,
    });
    const res = await PATCH(
      patchReq({ jobId: b, beforeJobId: a, clientNonce: crypto.randomUUID() }),
    );
    expect(res.status).toBe(401);
    expect(queuedIds()).toEqual([a, b]);
  });
});

describe('DELETE /api/queue/reorder', () => {
  it('unpins queued jobs only and is idempotent', async () => {
    const [a, b, c, d, e] = seedQueued(5);
    state.db.prepare('UPDATE job SET queue_pinned = 1 WHERE id IN (?, ?, ?, ?)').run(a, b, c, e);
    state.db.prepare("UPDATE job SET status = 'encoding' WHERE id = ?").run(e);
    const res = await DELETE(deleteReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, unpinned: 3 });
    expect([a, b, c, d].map(pinned)).toEqual([0, 0, 0, 0]);
    expect(pinned(e)).toBe(1);
    const line = mockLoggerInfo.mock.calls.find(
      (c) => (c[0] as { action?: string }).action === 'queue_manual_order_cleared',
    )![0];
    expect(line).toMatchObject({ actorId: 'operator', unpinned: 3 });
    expect(
      mockEmit.mock.calls.filter((c) => (c[0] as { type: string }).type === 'queue.updated'),
    ).toHaveLength(1);

    const again = await DELETE(deleteReq());
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, unpinned: 0 });
  });

  it('unauthenticated DELETE gives 401 and changes nothing', async () => {
    const [a] = seedQueued(1);
    state.db.prepare('UPDATE job SET queue_pinned = 1 WHERE id = ?').run(a);
    mockGateAuth.mockResolvedValueOnce({
      denied: new Response('unauthorized', { status: 401 }),
      auth: null,
    });
    const res = await DELETE(deleteReq());
    expect(res.status).toBe(401);
    expect(pinned(a)).toBe(1);
  });
});
