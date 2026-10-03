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
  loopOnce,
  startEncoderLoop,
  stopEncoderLoop,
} from '@/src/lib/encode/orchestrator';

type Db = InstanceType<typeof Database>;

// audit S7: skip on cpuCount<2 — single-core runners can't actually parallelize
// regardless of settings.concurrency; OS scheduler serializes 2 ffmpeg processes
// onto 1 core → multiTotalMs ≈ 2× singleEncodeMs → wall-clock floor false-negative.
const FFMPEG_AVAILABLE = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const HAS_PARALLELISM = os.cpus().length >= 2;

describe.skipIf(!FFMPEG_AVAILABLE || !HAS_PARALLELISM)(
  'orchestrator — real-ffmpeg multi-slot integration (03-02 audit AC-6)',
  () => {
    let db: Db;
    let fileRepo: FileRepo;
    let jobRepo: JobRepo;
    let settingRepo: SettingRepo;
    let trashRepo: TrashRepo;
    let stageRoot: string;
    let mediaRoot: string;

    function makeFixture(name: string): { path: string; size: number } {
      const fixturePath = path.join(mediaRoot, name);
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
      return { path: fixturePath, size: fs.statSync(fixturePath).size };
    }

    function freshDeps(): void {
      __forTests_setDeps({
        fileRepo: () => fileRepo,
        jobRepo: () => jobRepo,
        settingRepo: () => settingRepo,
        trashRepo: () => trashRepo,
      });
    }

    async function freshDb(): Promise<void> {
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
      settingRepo.set('cache_pool_path', stageRoot);
      settingRepo.set('default_crf', '23');
      settingRepo.set('min_savings_percent', '5');
      settingRepo.set('trash_retention_days', '30');
      // host-independence (same as 02-02 integration test): pin libx265 so
      // dev hosts with NVENC don't resolve auto → nvenc and fail without GPU.
      settingRepo.set('encoder', 'libx265');
      await __forTests_resetOrchestrator();
      freshDeps();
    }

    function enqueueOne(fixturePath: string, fixtureSize: number): number {
      const file = fileRepo.upsertByPath({
        path: fixturePath,
        size_bytes: fixtureSize,
        mtime: Math.floor(Date.now() / 1000),
        content_hash: fixturePath.padStart(64, '0').slice(-64),
        codec: 'mpeg4',
        bitrate: null,
        duration_seconds: 2,
        width: 128,
        height: 128,
        container: 'mov,mp4,m4a,3gp,3g2,mj2',
        last_scanned_at: Math.floor(Date.now() / 1000),

        share_id: null,
      });
      const job = jobRepo.create({ file_id: file.id, encoder: 'libx265', crf: null });
      return job!.id;
    }

    async function drain(timeoutMs: number): Promise<void> {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const queued = jobRepo.countByStatus('queued');
        const encoding = jobRepo.countByStatus('encoding');
        if (queued === 0 && encoding === 0) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(
        `drain timeout: queued=${jobRepo.countByStatus('queued')} encoding=${jobRepo.countByStatus(
          'encoding',
        )}`,
      );
    }

    beforeEach(async () => {
      stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-int-multi-stage-'));
      mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-int-multi-media-'));
      await freshDb();
    });

    afterEach(async () => {
      await stopEncoderLoop().catch(() => {});
      await __forTests_resetOrchestrator();
      db.close();
      fs.rmSync(stageRoot, { recursive: true, force: true });
      fs.rmSync(mediaRoot, { recursive: true, force: true });
    });

    it(
      'test_integration_when_2_real_libx265_encodes_concurrent_then_wall_clock_proves_parallelism',
      { timeout: 120_000 },
      async () => {
        // ─── Pass 1: warmup (discarded) ───
        const warmFix = makeFixture('warm.mp4');
        settingRepo.set('concurrency', '1');
        const warmId = enqueueOne(warmFix.path, warmFix.size);
        await loopOnce();
        const warmJob = jobRepo.findByFileId(
          (db.prepare('SELECT file_id FROM job WHERE id=?').get(warmId) as { file_id: number })
            .file_id,
        );
        expect(warmJob?.status).toBe('done');

        // ─── Pass 2: single-encode baseline ───
        // Reset DB + tmpdirs to isolate the baseline timing.
        db.close();
        fs.rmSync(stageRoot, { recursive: true, force: true });
        fs.rmSync(mediaRoot, { recursive: true, force: true });
        stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-int-multi-stage-'));
        mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-int-multi-media-'));
        await freshDb();

        const singleFix = makeFixture('single.mp4');
        settingRepo.set('concurrency', '1');
        enqueueOne(singleFix.path, singleFix.size);

        const singleStart = Date.now();
        await loopOnce();
        const singleEncodeMs = Date.now() - singleStart;

        // ─── Pass 3: multi-slot 2-job concurrent run ───
        db.close();
        fs.rmSync(stageRoot, { recursive: true, force: true });
        fs.rmSync(mediaRoot, { recursive: true, force: true });
        stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-int-multi-stage-'));
        mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-int-multi-media-'));
        await freshDb();

        const fix1 = makeFixture('multi-1.mp4');
        const fix2 = makeFixture('multi-2.mp4');
        settingRepo.set('concurrency', '2');
        const job1 = enqueueOne(fix1.path, fix1.size);
        const job2 = enqueueOne(fix2.path, fix2.size);

        const multiStart = Date.now();
        startEncoderLoop();
        await drain(60_000);
        const multiTotalMs = Date.now() - multiStart;

        const parallelismFactor = (singleEncodeMs * 2) / multiTotalMs;
        console.log(
          `multi-slot integration: singleEncodeMs=${singleEncodeMs} multiTotalMs=${multiTotalMs} ` +
            `parallelismFactor=${parallelismFactor.toFixed(2)}x`,
        );

        // ── Assertions ──
        const j1 = db.prepare('SELECT * FROM job WHERE id=?').get(job1) as { status: string };
        const j2 = db.prepare('SELECT * FROM job WHERE id=?').get(job2) as { status: string };
        expect(j1.status).toBe('done');
        expect(j2.status).toBe('done');

        const f1 = (
          db
            .prepare('SELECT * FROM file WHERE id=(SELECT file_id FROM job WHERE id=?)')
            .get(job1) as { status: string }
        ).status;
        const f2 = (
          db
            .prepare('SELECT * FROM file WHERE id=(SELECT file_id FROM job WHERE id=?)')
            .get(job2) as { status: string }
        ).status;
        expect(['done-smaller', 'done-larger']).toContain(f1);
        expect(['done-smaller', 'done-larger']).toContain(f2);

        // Per-job stage workDirs cleaned up.
        expect(fs.existsSync(path.join(stageRoot, 'work', String(job1)))).toBe(false);
        expect(fs.existsSync(path.join(stageRoot, 'work', String(job2)))).toBe(false);

        // The parallelism gate. Without M1+M2 capacity guards or with silent
        // serialization, multiTotalMs ≈ 2× singleEncodeMs → fails this check.
        expect(multiTotalMs).toBeLessThan(singleEncodeMs * 1.7);
      },
    );
  },
);
