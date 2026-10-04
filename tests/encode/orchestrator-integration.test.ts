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
} from '@/src/lib/encode/orchestrator';

type Db = InstanceType<typeof Database>;

// Synchronous detection at module-load — describe.skipIf is evaluated at
// collect time, BEFORE beforeAll runs.
const FFMPEG_AVAILABLE = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

describe.skipIf(!FFMPEG_AVAILABLE)('orchestrator — real-ffmpeg integration (01-03 D5)', () => {
  let db: Db;
  let fileRepo: FileRepo;
  let jobRepo: JobRepo;
  let settingRepo: SettingRepo;
  let trashRepo: TrashRepo;
  let stageRoot: string;
  let mediaRoot: string;
  let fixturePath: string;

  // audit-added S4: explicit cleanup discipline. tmpdirs + db tmp ALL removed
  // afterEach to prevent CI disk-fill across runs.
  beforeEach(() => {
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
    stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-int-stage-'));
    mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-int-media-'));
    fixturePath = path.join(mediaRoot, 'fixture.mp4');

    // audit-added S6: mpeg4 codec is universally present in ALL ffmpeg builds.
    // Do NOT use libx264 (optional dependency, missing on stripped distro builds).
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
    // 03-01: pin encoder='libx265' so the test is host-independent. Without
    // this, dev hosts with an NVIDIA GPU resolve 'auto' → 'nvenc' and the
    // encode fails when the test process has no GPU passthrough. Dispatch
    // path through ffmpeg.ts buildArgs is byte-identical regardless of
    // whether the encoder was pinned or auto-resolved to libx265 (audit M1).
    settingRepo.set('encoder', 'libx265');

    __forTests_resetOrchestrator();
    __forTests_setDeps({
      fileRepo: () => fileRepo,
      jobRepo: () => jobRepo,
      settingRepo: () => settingRepo,
      trashRepo: () => trashRepo,
    });
  });

  afterEach(() => {
    __forTests_resetOrchestrator();
    db.close();
    fs.rmSync(stageRoot, { recursive: true, force: true });
    fs.rmSync(mediaRoot, { recursive: true, force: true });
  });

  it(
    'test_integration_when_real_libx265_encode_then_terminal_state_reached',
    { timeout: 60_000 },
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
      const job = jobRepo.create({ file_id: file.id, encoder: 'libx265', crf: null });
      expect(job).not.toBeNull();

      await loopOnce();

      const refreshed = fileRepo.getById(file.id);
      const finishedJob = db.prepare('SELECT * FROM job WHERE id=?').get(job!.id) as {
        status: string;
        bytes_in: number;
        bytes_out: number;
        duration_ms: number;
      };

      // Print observed numbers for debugging across ffmpeg/libx265 versions.
      const savingsPercent =
        finishedJob.bytes_out && finishedJob.bytes_in
          ? ((finishedJob.bytes_in - finishedJob.bytes_out) / finishedJob.bytes_in) * 100
          : null;

      console.log(
        `integration: bytes_in=${finishedJob.bytes_in} bytes_out=${finishedJob.bytes_out} ` +
          `duration_ms=${finishedJob.duration_ms} savings_percent=${savingsPercent?.toFixed(2)}`,
      );

      expect(['done-smaller', 'done-larger']).toContain(refreshed?.status);
      expect(finishedJob.status).toBe('done');

      // Stage dir cleaned up.
      expect(fs.existsSync(path.join(stageRoot, 'work', String(job!.id)))).toBe(false);

      const finalOut = path.join(mediaRoot, 'fixture-x265.mkv');
      const trashRows = db.prepare('SELECT * FROM trash_entry').all() as {
        original_path: string;
        trash_path: string;
      }[];

      if (refreshed?.status === 'done-smaller') {
        expect(fs.existsSync(finalOut)).toBe(true);
        expect(fs.existsSync(fixturePath)).toBe(false);
        expect(trashRows).toHaveLength(1);
        expect(fs.existsSync(trashRows[0].trash_path)).toBe(true);
      } else {
        // done-larger: original kept, no output, no trash row
        expect(fs.existsSync(finalOut)).toBe(false);
        expect(fs.existsSync(fixturePath)).toBe(true);
        expect(trashRows).toHaveLength(0);
      }
    },
  );
});
