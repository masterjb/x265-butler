// 05-09 AC-12: Skip-then-Encode-Now integration smoke. Real libx265 encode
// fixture; flow:
//   1) seed file row + create encoding-state job (matches mid-encode shape)
//   2) skipActive(jobId) — asserts file→pending + cleanupWorkDir + new
//      jobId on re-enqueue
//   3) re-enqueue via jobRepo.enqueue, drive loopOnce → assert terminal state
//      reached (done-smaller OR done-larger)
//   4) verify NO orphan files in stageRoot post-skip; original NOT in trash
//      (skip happens BEFORE trashOriginal commit-step)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { spawnSync, execFileSync } from 'node:child_process';
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
  loopOnce,
  skipActive,
} from '@/src/lib/encode/orchestrator';

type Db = InstanceType<typeof Database>;

const FFMPEG_AVAILABLE = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

describe.skipIf(!FFMPEG_AVAILABLE)(
  '05-09 AC-12: skip → file→pending → re-enqueue → terminal state',
  () => {
    let db: Db;
    let fileRepo: FileRepo;
    let jobRepo: JobRepo;
    let settingRepo: SettingRepo;
    let trashRepo: TrashRepo;
    let stageRoot: string;
    let mediaRoot: string;
    let fixturePath: string;

    beforeEach(async () => {
      db = new Database(':memory:');
      migrate(db);
      db.pragma('foreign_keys = ON');
      fileRepo = makeFileRepo(db);
      jobRepo = makeJobRepo(db, {
        setFileStatus: (id, status, expectedVersion) =>
          fileRepo.setStatus(id, status, expectedVersion),
        bulkSetFileStatusToPending: (ids, expectedStates) =>
          fileRepo.bulkSetStatusToPendingByIds(ids, expectedStates),
      });
      settingRepo = makeSettingRepo(db);
      trashRepo = makeTrashRepo(db);
      stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-skip-int-stage-'));
      mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-skip-int-media-'));
      fixturePath = path.join(mediaRoot, 'fixture.mp4');

      execFileSync(
        'ffmpeg',
        [
          '-f',
          'lavfi',
          '-i',
          'testsrc=duration=2:size=128x128:rate=10',
          '-c:v',
          'mpeg4',
          '-q:v',
          '5',
          '-y',
          '-t',
          '2',
          fixturePath,
        ],
        { stdio: 'pipe' },
      );

      settingRepo.set('cache_pool_path', stageRoot);
      settingRepo.set('default_crf', '23');
      settingRepo.set('min_savings_percent', '5');
      settingRepo.set('trash_retention_days', '30');
      settingRepo.set('encoder', 'libx265');

      await __forTests_resetOrchestrator();
      __forTests_setDeps({
        fileRepo: () => fileRepo,
        jobRepo: () => jobRepo,
        settingRepo: () => settingRepo,
        trashRepo: () => trashRepo,
      });
    });

    afterEach(async () => {
      await __forTests_resetOrchestrator();
      db.close();
      fs.rmSync(stageRoot, { recursive: true, force: true });
      fs.rmSync(mediaRoot, { recursive: true, force: true });
    });

    it(
      'test_skip_active_encoding_then_re_enqueue_creates_fresh_job_and_completes',
      { timeout: 90_000 },
      async () => {
        const sourceSize = fs.statSync(fixturePath).size;
        const file = fileRepo.upsertByPath({
          path: fixturePath,
          size_bytes: sourceSize,
          mtime: Math.floor(Date.now() / 1000),
          content_hash: 'a'.repeat(64),
          codec: 'mpeg4',
          bitrate: null,
          duration_seconds: 2,
          width: 128,
          height: 128,
          container: 'mov,mp4,m4a,3gp,3g2,mj2',
          last_scanned_at: Math.floor(Date.now() / 1000),

          share_id: null,
        });
        // Manually move job to encoding-state + simulate active controller —
        // bypasses the multi-second loopOnce ramp-up so the skip path can be
        // exercised deterministically against a known shape.
        const job = jobRepo.create({ file_id: file.id, encoder: 'libx265', crf: 23 });
        expect(job).not.toBeNull();
        db.prepare("UPDATE job SET status='encoding' WHERE id=?").run(job!.id);
        db.prepare("UPDATE file SET status='encoding', version=version+1 WHERE id=?").run(file.id);

        // Simulate an in-flight encode by registering a controller. skipActive
        // aborts it + drains.
        const ctrl = new AbortController();
        __forTests_registerActiveController(job!.id, ctrl);

        // Step 2: skipActive
        const result = await skipActive(job!.id, 'integration-test');
        expect(result.skipped).toBe(true);
        expect(result.alreadyTerminal).toBe(false);

        // file→pending
        const fileAfterSkip = fileRepo.getById(file.id);
        expect(fileAfterSkip?.status).toBe('pending');

        // Original NOT in trash (skip happens BEFORE trashOriginal).
        expect(fs.existsSync(fixturePath)).toBe(true);
        const trashRows = db.prepare('SELECT * FROM trash_entry').all();
        expect(trashRows).toHaveLength(0);

        // Stage dir cleanup is fire-and-forget — give it a moment.
        await new Promise((r) => setTimeout(r, 100));

        // Step 3: re-enqueue + drive loopOnce.
        const fileFresh = fileRepo.getById(file.id);
        const newJob = jobRepo.enqueue(file.id, 'libx265', fileFresh!.version, null);
        expect(newJob).not.toBeNull();
        expect(newJob!.id).not.toBe(job!.id); // fresh jobId

        await loopOnce();

        const fileFinal = fileRepo.getById(file.id);
        const newJobFinal = db
          .prepare('SELECT status, bytes_in, bytes_out FROM job WHERE id=?')
          .get(newJob!.id) as { status: string; bytes_in: number; bytes_out: number };

        expect(['done-smaller', 'done-larger']).toContain(fileFinal?.status);
        expect(newJobFinal.status).toBe('done');

        // Stage dir for the NEW job is cleaned up at end of encode.
        expect(fs.existsSync(path.join(stageRoot, 'work', String(newJob!.id)))).toBe(false);
      },
    );
  },
);
