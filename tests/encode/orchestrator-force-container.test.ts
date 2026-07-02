// 10-03 E-D5: orchestrator force_container dispatch override.
// Mirrors orchestrator-match-source.test.ts pattern (setupDispatch helper + __forTests_setDeps).

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
  loopOnce,
} from '@/src/lib/encode/orchestrator';
import type { EncodeOptions, EncodeResult } from '@/src/lib/encode/ffmpeg';
import type { ProbeResult } from '@/src/lib/scan/ffprobe';
import * as realStaging from '@/src/lib/encode/staging';
import { __forTests_resetCachePoolCooldowns } from '@/src/lib/encode/staging';

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
let errorSpy: ReturnType<typeof vi.fn>;
let debugSpy: ReturnType<typeof vi.fn>;
let runEncodeSpy: ReturnType<typeof vi.fn>;
let writeSidecarSpy: ReturnType<typeof vi.fn>;
let unlinkSidecarTmpSpy: ReturnType<typeof vi.fn>;

const NOW_SECONDS = 1_800_000_000;

function seedFile(p: string): { id: number; path: string } {
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
  return { id: row.id, path: row.path };
}

const cleanAacProbe = (): ProbeResult => ({
  codec: 'h264',
  bitrate: 5_000_000,
  durationSeconds: 60,
  width: 1920,
  height: 1080,
  container: 'matroska',
  tags: {},
  color: { space: null, primaries: null, transfer: null, range: null },
  hdr10: { masterDisplay: null, maxCll: null },
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264' },
    { index: 1, codec_type: 'audio', codec_name: 'aac' },
  ],
});

type SetupOpts = {
  globalSetting?: 'mkv' | 'mp4' | 'match-source';
  filename?: string;
  forceContainer?: 'mp4' | 'mkv' | null;
  containerOverride?: 'mkv' | 'mp4' | 'match-source' | null;
  outputSize?: number;
  // 16-05: optional suffix override. Default '.x265.mkv' preserves pre-16-05
  // expectations byte-identical via LEGACY-default branch.
  outputSuffix?: string;
};

function setupDispatch({
  globalSetting = 'mkv',
  filename = 'movie.mp4',
  forceContainer = null,
  containerOverride = null,
  outputSize = 600_000,
  outputSuffix = '.x265.mkv',
}: SetupOpts = {}): { fileId: number; jobId: number } {
  const sourcePath = path.join(mediaRoot, filename);
  fs.writeFileSync(sourcePath, Buffer.alloc(1_000_000, 'x'));
  const file = seedFile(sourcePath);

  if (containerOverride !== null) {
    fileRepo.setContainerOverride(file.id, containerOverride);
  }

  const job = jobRepo.create({
    file_id: file.id,
    encoder: 'libx265',
    crf: null,
    ...(forceContainer !== null ? { force_container: forceContainer } : {}),
  });
  if (!job) throw new Error('failed to create job');

  settingRepo.set('cache_pool_path', stageRoot);
  settingRepo.set('default_crf', '23');
  settingRepo.set('min_savings_percent', '5');
  settingRepo.set('trash_retention_days', '30');
  settingRepo.set('output_container', globalSetting);
  settingRepo.set('output_suffix', outputSuffix);

  __forTests_setDeps({
    runEncode: runEncodeSpy.mockImplementation(async ({ output }) => {
      fs.writeFileSync(output, Buffer.alloc(outputSize, 'y'));
      return { exitCode: 0, durationMs: 30_000, logTail: '' } satisfies EncodeResult;
    }) as unknown as (opts: EncodeOptions) => Promise<EncodeResult>,
    ffprobe: (async () => cleanAacProbe()) as never,
    writeSidecar: writeSidecarSpy as never,
    fs: {
      statSync: fs.statSync as never,
      statfsSync: (() => ({ bavail: BigInt(100_000_000), bsize: BigInt(1) }) as never) as never,
      accessSync: fs.accessSync,
      existsSync: ((p: fs.PathLike) => fs.existsSync(String(p))) as never,
      unlinkSync: (() => undefined) as unknown as typeof fs.unlinkSync,
    },
    fileRepo: () => fileRepo,
    jobRepo: () => jobRepo,
    settingRepo: () => settingRepo,
    trashRepo: () => trashRepo,
    logger: {
      info: logSpy,
      warn: warnSpy,
      error: errorSpy,
      debug: debugSpy,
    } as never,
    now: () => NOW_SECONDS,
    staging: {
      ...realStaging,
      unlinkSidecarTmpAt: unlinkSidecarTmpSpy as never,
    } as never,
  });

  return { fileId: file.id, jobId: job.id };
}

beforeEach(async () => {
  await __forTests_resetOrchestrator();
  __forTests_resetCachePoolCooldowns();
  db = new Database(':memory:');
  migrate(db);
  db.pragma('foreign_keys = ON');
  fileRepo = makeFileRepo(db);
  jobRepo = makeJobRepo(db, {
    setFileStatus: (id, status, v) => fileRepo.setStatus(id, status, v),
    bulkSetFileStatusToPending: (ids, states) => fileRepo.bulkSetStatusToPendingByIds(ids, states),
  });
  settingRepo = makeSettingRepo(db);
  trashRepo = makeTrashRepo(db);
  stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-orch-fc-stage-'));
  mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-orch-fc-media-'));
  logSpy = vi.fn();
  warnSpy = vi.fn();
  errorSpy = vi.fn();
  debugSpy = vi.fn();
  runEncodeSpy = vi.fn();
  writeSidecarSpy = vi.fn(async () => undefined);
  unlinkSidecarTmpSpy = vi.fn(async () => undefined);
});

afterEach(async () => {
  await __forTests_resetOrchestrator();
  db.close();
  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.rmSync(mediaRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('orchestrator — 10-03 E-D5 force_container dispatch override', () => {
  it('test_force_container_when_mp4_force_and_global_mkv_then_runEncode_outputContainer_is_mp4', async () => {
    setupDispatch({ globalSetting: 'mkv', filename: 'movie.mp4', forceContainer: 'mp4' });
    await loopOnce();

    expect(runEncodeSpy).toHaveBeenCalledTimes(1);
    expect(runEncodeSpy.mock.calls[0]?.[0]?.outputContainer).toBe('mp4');
  });

  it('test_force_container_when_mkv_force_and_file_override_mp4_then_runEncode_outputContainer_is_mkv', async () => {
    setupDispatch({
      globalSetting: 'mp4',
      filename: 'movie.mp4',
      forceContainer: 'mkv',
      containerOverride: 'mp4',
    });
    await loopOnce();

    expect(runEncodeSpy).toHaveBeenCalledTimes(1);
    expect(runEncodeSpy.mock.calls[0]?.[0]?.outputContainer).toBe('mkv');
  });

  it('test_force_container_when_null_force_then_global_setting_used_for_container', async () => {
    setupDispatch({ globalSetting: 'mp4', filename: 'movie.mp4', forceContainer: null });
    await loopOnce();

    expect(runEncodeSpy).toHaveBeenCalledTimes(1);
    expect(runEncodeSpy.mock.calls[0]?.[0]?.outputContainer).toBe('mp4');
  });

  it('test_force_container_when_force_set_then_pino_info_action_job_retry_force_container_logged', async () => {
    const { fileId, jobId } = setupDispatch({ forceContainer: 'mkv', filename: 'movie.mkv' });
    await loopOnce();

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'job_retry_force_container',
        jobId,
        fileId,
        forceContainer: 'mkv',
      }),
      expect.any(String),
    );
  });

  it('test_force_container_when_mp4_force_clean_audio_then_writeSidecar_payload_has_no_containerFallback', async () => {
    setupDispatch({ globalSetting: 'mkv', filename: 'movie.mp4', forceContainer: 'mp4' });
    await loopOnce();

    expect(runEncodeSpy).toHaveBeenCalledTimes(1);
    // writeSidecar may be called for V3 upgrade — if called, containerFallback must be absent.
    for (const call of writeSidecarSpy.mock.calls as unknown[][]) {
      const payload = call[1] as { containerFallback?: unknown };
      expect(payload?.containerFallback).toBeUndefined();
    }
  });

  // 16-05: forced-mp4 override × NEW-default '-x265' → output endsWith
  // -x265.mp4 (force_container threads through resolveOutputSuffix's
  // NEW-default branch with the FORCED container, not the global setting).
  it('test_force_container_mp4_x_new_default_x265_output_endsWith_dash_x265_mp4', async () => {
    setupDispatch({
      globalSetting: 'mkv',
      filename: 'movie.mp4',
      forceContainer: 'mp4',
      outputSuffix: '-x265',
    });
    await loopOnce();

    expect(writeSidecarSpy).toHaveBeenCalled();
    const sidecarPath = String(writeSidecarSpy.mock.calls[0]?.[0] ?? '');
    const finalOutput = sidecarPath.replace(/\.x265-butler\.json$/, '');
    expect(finalOutput.endsWith('-x265.mp4')).toBe(true);
  });
});
