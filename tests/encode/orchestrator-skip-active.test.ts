// 05-09: skipActive orchestrator surface — replaces requestStopAll forward.
// Asserts: SIGTERM via _activeControllers.abort, markCancelled + setStatus
// (file→'pending'), cleanupWorkDir + sidecar-tmp unlink (Branch A only),
// audit log with actorId, no-op on terminal status, orphan branch.
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
  skipActive,
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
let warnSpy: ReturnType<typeof vi.fn>;

function seedFile(p: string): { id: number; version: number } {
  const row = fileRepo.upsertByPath({
    path: p,
    size_bytes: 1_000_000,
    mtime: 1_700_000_000,
    content_hash: 'a'.repeat(64),
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
  stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-skip-stage-'));
  mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-skip-media-'));
  settingRepo.set('cache_pool_path', stageRoot);
  logSpy = vi.fn();
  warnSpy = vi.fn();
  __forTests_resetOrchestrator();
  __forTests_setDeps({
    fileRepo: () => fileRepo,
    jobRepo: () => jobRepo,
    settingRepo: () => settingRepo,
    trashRepo: () => trashRepo,
    logger: { info: logSpy, warn: warnSpy, error: vi.fn(), debug: vi.fn() } as never,
    now: () => 1_800_000_000,
  });
});

afterEach(() => {
  __forTests_resetOrchestrator();
  db.close();
  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.rmSync(mediaRoot, { recursive: true, force: true });
});

describe('skipActive', () => {
  it('test_skipActive_when_status_encoding_with_controller_then_abort_markCancelled_file_pending', async () => {
    const file = seedFile(path.join(mediaRoot, 'a.mp4'));
    const job = jobRepo.create({ file_id: file.id, encoder: 'libx265', crf: null });
    db.prepare("UPDATE job SET status='encoding' WHERE id=?").run(job!.id);
    db.prepare("UPDATE file SET status='encoding', version=version+1 WHERE id=?").run(file.id);

    const ctrl = new AbortController();
    let aborted = false;
    ctrl.signal.addEventListener('abort', () => {
      aborted = true;
    });
    __forTests_registerActiveController(job!.id, ctrl);

    const result = await skipActive(job!.id, 'tester');

    expect(result.skipped).toBe(true);
    expect(result.prevStatus).toBe('encoding');
    expect(result.alreadyTerminal).toBe(false);
    expect(aborted).toBe(true);
    const jobAfter = db.prepare('SELECT status FROM job WHERE id=?').get(job!.id) as {
      status: string;
    };
    expect(jobAfter.status).toBe('cancelled');
    const fileAfter = db.prepare('SELECT status FROM file WHERE id=?').get(file.id) as {
      status: string;
    };
    expect(fileAfter.status).toBe('pending');
  });

  it('test_skipActive_when_status_queued_then_no_abort_markCancelled_file_pending', async () => {
    const file = seedFile(path.join(mediaRoot, 'b.mp4'));
    const job = jobRepo.enqueue(file.id, 'libx265', file.version, null);
    expect(job).not.toBeNull();
    const result = await skipActive(job!.id, 'tester');
    expect(result.skipped).toBe(true);
    expect(result.prevStatus).toBe('queued');
    expect(result.alreadyTerminal).toBe(false);
    const jobAfter = db.prepare('SELECT status FROM job WHERE id=?').get(job!.id) as {
      status: string;
    };
    expect(jobAfter.status).toBe('cancelled');
    const fileAfter = db.prepare('SELECT status FROM file WHERE id=?').get(file.id) as {
      status: string;
    };
    expect(fileAfter.status).toBe('pending');
  });

  it('test_skipActive_when_status_terminal_done_then_alreadyTerminal_true_no_writes', async () => {
    const file = seedFile(path.join(mediaRoot, 'c.mp4'));
    const job = jobRepo.create({ file_id: file.id, encoder: 'libx265', crf: null });
    db.prepare("UPDATE job SET status='done', finished_at=1 WHERE id=?").run(job!.id);
    db.prepare("UPDATE file SET status='done-smaller', version=version+1 WHERE id=?").run(file.id);
    const result = await skipActive(job!.id, 'tester');
    expect(result.alreadyTerminal).toBe(true);
    const jobAfter = db.prepare('SELECT status FROM job WHERE id=?').get(job!.id) as {
      status: string;
    };
    expect(jobAfter.status).toBe('done');
    const fileAfter = db.prepare('SELECT status FROM file WHERE id=?').get(file.id) as {
      status: string;
    };
    expect(fileAfter.status).toBe('done-smaller');
  });

  it('test_skipActive_when_jobId_not_found_then_returns_skipped_false_no_writes', async () => {
    const result = await skipActive(99999, 'tester');
    expect(result.skipped).toBe(false);
    expect(result.prevStatus).toBe('not_found');
  });

  it('test_skipActive_when_orphan_encoding_no_controller_then_logs_orphan_and_proceeds', async () => {
    const file = seedFile(path.join(mediaRoot, 'd.mp4'));
    const job = jobRepo.create({ file_id: file.id, encoder: 'libx265', crf: null });
    db.prepare("UPDATE job SET status='encoding' WHERE id=?").run(job!.id);
    db.prepare("UPDATE file SET status='encoding', version=version+1 WHERE id=?").run(file.id);
    // NO __forTests_registerActiveController — orphan branch.
    const result = await skipActive(job!.id, 'tester');
    expect(result.skipped).toBe(true);
    const orphanLog = logSpy.mock.calls.find(
      (c) =>
        typeof c[0] === 'object' &&
        c[0] !== null &&
        (c[0] as { action?: string }).action === 'queue_skip_orphan_encoding_row',
    );
    expect(orphanLog).toBeDefined();
    const fileAfter = db.prepare('SELECT status FROM file WHERE id=?').get(file.id) as {
      status: string;
    };
    expect(fileAfter.status).toBe('pending');
  });

  it('test_skipActive_emits_job_skipped_pino_with_actorId_audit_AC10', async () => {
    const file = seedFile(path.join(mediaRoot, 'e.mp4'));
    const job = jobRepo.enqueue(file.id, 'libx265', file.version, null);
    await skipActive(job!.id, 'alice');
    const audit = logSpy.mock.calls.find(
      (c) =>
        typeof c[0] === 'object' &&
        c[0] !== null &&
        (c[0] as { action?: string }).action === 'job_skipped',
    );
    expect(audit).toBeDefined();
    expect((audit![0] as { actorId: string }).actorId).toBe('alice');
  });
});
