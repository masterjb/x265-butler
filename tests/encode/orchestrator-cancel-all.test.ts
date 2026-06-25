// 05-09: cancelAllQueued orchestrator surface — mass-skip every active+queued
// row in one click. Asserts: bulk markCancelled in single TX, bulk file→
// pending, M+N counts, all encoding controllers aborted, audit-trail.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from '@/src/lib/db/migrate';
import { makeFileRepo, type FileRepo } from '@/src/lib/db/repos/file';
import { makeJobRepo, type JobRepo } from '@/src/lib/db/repos/job';
import { makeSettingRepo, type SettingRepo } from '@/src/lib/db/repos/setting';
import { makeTrashRepo, type TrashRepo } from '@/src/lib/db/repos/trash';
import {
  __forTests_resetOrchestrator,
  __forTests_setDeps,
  __forTests_registerActiveController,
  cancelAllQueued,
} from '@/src/lib/encode/orchestrator';

type Db = InstanceType<typeof Database>;

let db: Db;
let fileRepo: FileRepo;
let jobRepo: JobRepo;
let settingRepo: SettingRepo;
let trashRepo: TrashRepo;
let stageRoot: string;
let mediaRoot: string;
let logSpy: ReturnType<typeof vi.fn>;

function seedFile(p: string): { id: number; version: number } {
  const row = fileRepo.upsertByPath({
    path: p,
    size_bytes: 1_000_000,
    mtime: 1_700_000_000,
    content_hash: ('a'.repeat(64) + path.basename(p)).slice(0, 64),
    codec: 'h264',
    bitrate: 5_000_000,
    duration_seconds: 60,
    width: 1920,
    height: 1080,
    container: 'mp4',
    last_scanned_at: 1_700_000_500,

    share_id: null,
  });
  return { id: row.id, version: row.version };
}

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  db.pragma('foreign_keys = ON');
  fileRepo = makeFileRepo(db);
  jobRepo = makeJobRepo(db, {
    setFileStatus: (id, status, expectedVersion) => fileRepo.setStatus(id, status, expectedVersion),
    bulkSetFileStatusToPending: (ids, expectedStates) =>
      fileRepo.bulkSetStatusToPendingByIds(ids, expectedStates),
  });
  settingRepo = makeSettingRepo(db);
  trashRepo = makeTrashRepo(db);
  stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-cancelall-stage-'));
  mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-cancelall-media-'));
  settingRepo.set('cache_pool_path', stageRoot);
  logSpy = vi.fn();
  __forTests_resetOrchestrator();
  __forTests_setDeps({
    fileRepo: () => fileRepo,
    jobRepo: () => jobRepo,
    settingRepo: () => settingRepo,
    trashRepo: () => trashRepo,
    logger: { info: logSpy, warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    now: () => 1_800_000_000,
  });
});

afterEach(() => {
  __forTests_resetOrchestrator();
  db.close();
  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.rmSync(mediaRoot, { recursive: true, force: true });
});

describe('cancelAllQueued', () => {
  it('test_cancelAll_when_mixed_M1_N3_then_skipped_1_cancelled_3_all_files_pending', async () => {
    const f1 = seedFile(path.join(mediaRoot, '1.mp4'));
    const f2 = seedFile(path.join(mediaRoot, '2.mp4'));
    const f3 = seedFile(path.join(mediaRoot, '3.mp4'));
    const f4 = seedFile(path.join(mediaRoot, '4.mp4'));
    const j1 = jobRepo.create({ file_id: f1.id, encoder: 'libx265', crf: null });
    const j2 = jobRepo.enqueue(f2.id, 'libx265', f2.version, null);
    const j3 = jobRepo.enqueue(f3.id, 'libx265', f3.version, null);
    const j4 = jobRepo.enqueue(f4.id, 'libx265', f4.version, null);
    db.prepare("UPDATE job SET status='encoding' WHERE id=?").run(j1!.id);
    db.prepare("UPDATE file SET status='encoding', version=version+1 WHERE id=?").run(f1.id);

    const ctrl = new AbortController();
    let aborted = false;
    ctrl.signal.addEventListener('abort', () => {
      aborted = true;
    });
    __forTests_registerActiveController(j1!.id, ctrl);

    const result = await cancelAllQueued('alice');
    expect(result.skipped).toBe(1);
    expect(result.cancelled).toBe(3);
    expect(aborted).toBe(true);

    const jobStatuses = db.prepare('SELECT status FROM job ORDER BY id').all() as {
      status: string;
    }[];
    expect(jobStatuses.every((r) => r.status === 'cancelled')).toBe(true);
    const fileStatuses = db.prepare('SELECT id, status FROM file ORDER BY id').all() as {
      id: number;
      status: string;
    }[];
    expect(fileStatuses.every((r) => r.status === 'pending')).toBe(true);
    expect(fileStatuses.length).toBe(4);
    void j2;
    void j3;
    void j4;
  });

  it('test_cancelAll_when_only_queued_M0_then_skipped_zero', async () => {
    const f1 = seedFile(path.join(mediaRoot, '1.mp4'));
    jobRepo.enqueue(f1.id, 'libx265', f1.version, null);
    const result = await cancelAllQueued('bob');
    expect(result.skipped).toBe(0);
    expect(result.cancelled).toBe(1);
  });

  it('test_cancelAll_when_only_encoding_N0_then_cancelled_zero', async () => {
    const f1 = seedFile(path.join(mediaRoot, '1.mp4'));
    const j1 = jobRepo.create({ file_id: f1.id, encoder: 'libx265', crf: null });
    db.prepare("UPDATE job SET status='encoding' WHERE id=?").run(j1!.id);
    db.prepare("UPDATE file SET status='encoding', version=version+1 WHERE id=?").run(f1.id);
    const ctrl = new AbortController();
    __forTests_registerActiveController(j1!.id, ctrl);
    const result = await cancelAllQueued('carol');
    expect(result.skipped).toBe(1);
    expect(result.cancelled).toBe(0);
  });

  it('test_cancelAll_when_M0_N0_empty_then_no_state_mutation_emits_audit_S2_log', async () => {
    const result = await cancelAllQueued('dave');
    expect(result.skipped).toBe(0);
    expect(result.cancelled).toBe(0);
    const audit = logSpy.mock.calls.find(
      (c) =>
        typeof c[0] === 'object' &&
        c[0] !== null &&
        (c[0] as { action?: string }).action === 'queue_cancel_all_empty',
    );
    expect(audit).toBeDefined();
    expect((audit![0] as { actorId: string }).actorId).toBe('dave');
  });

  it('test_cancelAll_emits_per_job_job_skipped_plus_summary_queue_cancelled_all', async () => {
    const f1 = seedFile(path.join(mediaRoot, '1.mp4'));
    const f2 = seedFile(path.join(mediaRoot, '2.mp4'));
    jobRepo.enqueue(f1.id, 'libx265', f1.version, null);
    jobRepo.enqueue(f2.id, 'libx265', f2.version, null);
    await cancelAllQueued('alice');
    const perJobSkipped = logSpy.mock.calls.filter(
      (c) =>
        typeof c[0] === 'object' &&
        c[0] !== null &&
        (c[0] as { action?: string }).action === 'job_skipped',
    );
    expect(perJobSkipped.length).toBe(2);
    const summary = logSpy.mock.calls.find(
      (c) =>
        typeof c[0] === 'object' &&
        c[0] !== null &&
        (c[0] as { action?: string }).action === 'queue_cancelled_all',
    );
    expect(summary).toBeDefined();
    expect((summary![0] as { skipped?: number }).skipped).toBe(0);
    expect((summary![0] as { cancelled?: number }).cancelled).toBe(2);
  });
});
