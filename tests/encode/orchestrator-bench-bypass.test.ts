/*
 * 10-01: bench-channel bypass tests.
 *
 * Jobs flagged via __forTests_markJobAsBenchSample skip all commit-step side
 * effects (writeSidecar, setStatus, markCompleted). P11 will wire the real
 * dispatch path; this test validates the bypass behaviour and the SOC-2
 * pino-payload contract.
 */

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
  __forTests_markJobAsBenchSample,
  __forTests_resetOrchestrator,
  __forTests_setDeps,
  loopOnce,
} from '@/src/lib/encode/orchestrator';
import type { EncodeOptions, EncodeResult } from '@/src/lib/encode/ffmpeg';
import type { ProbeResult } from '@/src/lib/scan/ffprobe';

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
let writeSidecarSpy: ReturnType<typeof vi.fn>;

const NOW_SECONDS = 1_800_000_000;

function makeMockProbe(): ProbeResult {
  return {
    codec: 'hevc',
    bitrate: 2_000_000,
    durationSeconds: 60,
    width: 1920,
    height: 1080,
    container: 'matroska',
    tags: {},
  };
}

function setupBenchOrchestrator({
  sourceSize = 1_000_000,
  outputSize,
}: {
  sourceSize?: number;
  outputSize?: number;
} = {}): { fileId: number; jobId: number; sourcePath: string } {
  const sourcePath = path.join(mediaRoot, 'bench.mp4');
  fs.writeFileSync(sourcePath, Buffer.alloc(sourceSize, 'x'));

  const file = fileRepo.upsertByPath({
    path: sourcePath,
    size_bytes: sourceSize,
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
  const job = jobRepo.create({ file_id: file.id, encoder: 'libx265', crf: null });
  if (!job) throw new Error('failed to create bench job');

  settingRepo.set('cache_pool_path', stageRoot);
  settingRepo.set('default_crf', '23');
  settingRepo.set('min_savings_percent', '5');
  settingRepo.set('trash_retention_days', '30');

  const stagedBytes = outputSize ?? Math.floor(sourceSize * 0.6);

  __forTests_setDeps({
    runEncode: async ({ output }: EncodeOptions): Promise<EncodeResult> => {
      fs.writeFileSync(output, Buffer.alloc(stagedBytes, 'y'));
      return { exitCode: 0, durationMs: 5_000, logTail: '' };
    },
    ffprobe: (async () => makeMockProbe()) as never,
    fs: {
      statSync: fs.statSync as never,
      statfsSync: (() => ({ bavail: BigInt(100_000_000), bsize: BigInt(1) }) as never) as never,
      accessSync: fs.accessSync,
      existsSync: fs.existsSync as never,
      unlinkSync: (() => undefined) as unknown as typeof fs.unlinkSync,
    },
    fileRepo: () => fileRepo,
    jobRepo: () => jobRepo,
    settingRepo: () => settingRepo,
    trashRepo: () => trashRepo,
    writeSidecar: writeSidecarSpy,
    hashFile: async () => 'b'.repeat(64),
    logger: { info: logSpy, warn: warnSpy, error: errorSpy, debug: vi.fn() } as never,
    now: () => NOW_SECONDS,
  });

  return { fileId: file.id, jobId: job.id, sourcePath };
}

beforeEach(async () => {
  await __forTests_resetOrchestrator();
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
  stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-bench-stage-'));
  mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-bench-media-'));
  logSpy = vi.fn();
  warnSpy = vi.fn();
  errorSpy = vi.fn();
  writeSidecarSpy = vi.fn();
});

afterEach(async () => {
  await __forTests_resetOrchestrator();
  db.close();
  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.rmSync(mediaRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('orchestrator — bench-channel bypass (10-01)', () => {
  it('test_bench_bypass_loopOnce_completes_without_error_when_job_marked', async () => {
    const { jobId } = setupBenchOrchestrator({ sourceSize: 1_000_000 });
    __forTests_markJobAsBenchSample(jobId);
    await expect(loopOnce()).resolves.toBeUndefined();
  });

  it('test_bench_bypass_file_status_not_set_to_done_star_after_bypass', async () => {
    const { fileId, jobId } = setupBenchOrchestrator({ sourceSize: 1_000_000 });
    __forTests_markJobAsBenchSample(jobId);
    await loopOnce();
    const file = fileRepo.getById(fileId);
    // Bypass skips setStatus — file never reaches done-* via commit-step.
    expect(file?.status).not.toBe('done-smaller');
    expect(file?.status).not.toBe('done-larger');
    expect(file?.status).not.toBe('done-not-worth');
  });

  it('test_bench_bypass_pino_bench_sample_bypass_action_logged_with_soc2_fields', async () => {
    const { jobId } = setupBenchOrchestrator({ sourceSize: 1_000_000, outputSize: 600_000 });
    __forTests_markJobAsBenchSample(jobId);
    await loopOnce();

    const bypassCall = (logSpy.mock.calls as [Record<string, unknown>, string][]).find(
      ([obj]) => obj['action'] === 'bench_sample_bypass',
    );
    expect(bypassCall).toBeDefined();
    const [payload] = bypassCall!;
    expect(payload['jobId']).toBe(jobId);
    expect(typeof payload['filePath']).toBe('string');
    expect(typeof payload['sourceSizeBytes']).toBe('number');
    expect(typeof payload['outputSizeBytes']).toBe('number');
    expect(typeof payload['encoder']).toBe('string');
    expect(typeof payload['preset']).toBe('string');
    expect(typeof payload['durationSec']).toBe('number');
    expect(typeof payload['savingsBytes']).toBe('number');
    expect(typeof payload['savingsRatio']).toBe('number');
  });

  it('test_bench_bypass_writeSidecar_not_called', async () => {
    const { jobId } = setupBenchOrchestrator({ sourceSize: 1_000_000 });
    __forTests_markJobAsBenchSample(jobId);
    await loopOnce();
    expect(writeSidecarSpy).not.toHaveBeenCalled();
  });
});
