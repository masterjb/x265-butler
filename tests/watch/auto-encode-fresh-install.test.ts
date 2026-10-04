/*
 * Plan 52-04 AC-1 (audit MH-1): a fresh install must not encode on its own.
 *
 * Befund 2026-09-29: the boot reconcile's orphan sweep enqueued every
 * `pending` file without a job, so a brand-new container started encoding the
 * whole library before the operator had looked at encoder, CRF or a benchmark.
 *
 * Deliberately NOT mock-based: real migration chain on an in-memory DB, real
 * file/job/setting/share repos, the real runBootReconcile. Only the disk walk
 * (runScan) is stubbed, because the files are seeded straight into the DB.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@/src/lib/db/migrate';
import { makeFileRepo, type FileRepo } from '@/src/lib/db/repos/file';
import { makeJobRepo } from '@/src/lib/db/repos/job';
import { makeSettingRepo } from '@/src/lib/db/repos/setting';
import { makeShareRepo } from '@/src/lib/db/repos/share';
import { runBootReconcile, type ReconcileDeps } from '@/src/lib/watch/reconcile';

type Db = InstanceType<typeof Database>;

// Mirrors ORPHAN_QUERY in src/lib/watch/service.ts (the production wiring of
// findOrphanFileIds, minus the media-extension gate that does not apply to .mkv).
const ORPHAN_SQL = `
  SELECT file.id AS id
    FROM file
    LEFT JOIN job
      ON file.id = job.file_id
     AND job.status IN ('queued', 'encoding')
   WHERE file.status = 'pending'
     AND job.id IS NULL
`;

function seedPending(fileRepo: FileRepo, shareId: number, n: number): void {
  for (let i = 0; i < n; i++) {
    fileRepo.upsertByPath({
      path: `/media/movies/film-${i}.mkv`,
      size_bytes: 1_000_000_000,
      mtime: 1_700_000_000 + i,
      content_hash: String(i).repeat(64).slice(0, 64),
      codec: 'h264',
      bitrate: 8_000_000,
      duration_seconds: 5400,
      width: 1920,
      height: 1080,
      container: 'mkv',
      last_scanned_at: 1_700_000_500,
      share_id: shareId,
    });
  }
}

function jobCount(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM job').get() as { n: number }).n;
}

describe('fresh install boot reconcile (52-04 AC-1)', () => {
  let db: Db;
  let deps: ReconcileDeps;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    const fileRepo = makeFileRepo(db);
    const jobRepo = makeJobRepo(db, {
      setFileStatus: (id, status, expectedVersion) =>
        fileRepo.setStatus(id, status, expectedVersion),
      bulkSetFileStatusToPending: (ids, expectedStates) =>
        fileRepo.bulkSetStatusToPendingByIds(ids, expectedStates),
    });
    const settingRepo = makeSettingRepo(db);
    const shareRepo = makeShareRepo(db);
    // Fresh DB already carries the placeholder share at /media (0026 seed).
    const shareId = shareRepo.listAll()[0].id;
    seedPending(fileRepo, shareId, 3);

    deps = {
      shareRepo: () => shareRepo,
      fileRepo: () => fileRepo,
      jobRepo: () => jobRepo,
      settingRepo: () => settingRepo,
      runScan: vi.fn(async () => ({
        rootPath: '/media',
        filesScanned: 3,
        filesAdded: 3,
        filesUpdated: 0,
        filesUnchanged: 0,
        filesFailed: 0,
        filesVanished: 0,
        dirsVisited: 1,
        dirsSkippedCycle: 0,
        dirsSkippedUnreadable: 0,
        dirsSkippedMaxDepth: 0,
        dirsSkippedSystemPrefix: 0,
        durationMs: 1,
        startedAt: 0,
        finishedAt: 1,
      })),
      findOrphanFileIds: () => (db.prepare(ORPHAN_SQL).all() as { id: number }[]).map((r) => r.id),
      encoderResolver: () => 'libx265',
      emitQueueUpdated: vi.fn(),
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        telemetry: vi.fn(),
      } as unknown as ReconcileDeps['log'],
    };
  });

  afterEach(() => {
    db.close();
  });

  it('test_boot_reconcile_when_fresh_install_then_creates_no_job', async () => {
    await runBootReconcile(deps);
    expect(jobCount(db)).toBe(0);
  });

  it('test_boot_reconcile_when_fresh_install_then_files_stay_pending', async () => {
    await runBootReconcile(deps);
    const statuses = (db.prepare('SELECT status FROM file').all() as { status: string }[]).map(
      (r) => r.status,
    );
    expect(statuses).toEqual(['pending', 'pending', 'pending']);
  });

  it('test_fresh_install_when_migrated_then_auto_encode_is_off', () => {
    expect(deps.settingRepo().get('auto_encode')).toBe('false');
  });

  it('test_boot_reconcile_when_operator_enabled_auto_encode_then_enqueues_pending', async () => {
    deps.settingRepo().set('auto_encode', 'true');
    await runBootReconcile(deps);
    expect(jobCount(db)).toBe(3);
  });

  // E7: switching OFF withholds new jobs only; queued work is left alone.
  it('test_boot_reconcile_when_switched_off_after_enqueue_then_queued_jobs_untouched', async () => {
    deps.settingRepo().set('auto_encode', 'true');
    await runBootReconcile(deps);
    deps.settingRepo().set('auto_encode', 'false');
    await runBootReconcile(deps);
    const statuses = (db.prepare('SELECT status FROM job').all() as { status: string }[]).map(
      (r) => r.status,
    );
    expect(statuses).toEqual(['queued', 'queued', 'queued']);
  });
});
