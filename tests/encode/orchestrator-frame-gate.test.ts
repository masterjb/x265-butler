// 50-01 Task 3 — the output frame-count integrity gate wired into verifyOutput.
//
// Covers AC-1 (the reporter case fails the job), AC-2 (all three verdict buckets),
// AC-3 (a complete encode is untouched + one telemetry line), AC-5/6/7 (the three
// fail-OPEN skips, each proving NO count spawn where none is due), AC-8
// (durationSource), AC-9 (kill-switch = the v2.46.0 path), AC-19/AC-20 (expected
// and actual provably come from the same, non-cover stream) and AC-21/AC-22 (the
// FAIL path leaves a full warn line and a job carrying log_tail + exit_code).
//
// Deliberately a NEW file: no legacy orchestrator fixture is touched (E7).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// 50-01 (audit MH-1): the argv line must be proven on the FILE level, not on the
// onLogChunk channel — a channel-only assertion is exactly the test that would
// have let the defect through. The seam is openJobLogStream, whose real
// implementation stays the default for every other test in this file.
const { openJobLogStreamMock, realOpenRef } = vi.hoisted(() => ({
  openJobLogStreamMock: vi.fn(),
  realOpenRef: {
    current: null as null | ((jobId: string, cachePoolPath: string) => Promise<unknown>),
  },
}));
vi.mock('@/src/lib/encode/log-capture', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/src/lib/encode/log-capture')>();
  realOpenRef.current = actual.openJobLogStream as never;
  return {
    ...actual,
    openJobLogStream: (jobId: string, cachePoolPath: string) =>
      openJobLogStreamMock(jobId, cachePoolPath),
  };
});
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
import { __forTests_resetFrameGateCache } from '@/src/lib/encode/frame-gate';
import type { EncodeOptions, EncodeResult } from '@/src/lib/encode/ffmpeg';
import type { ProbeResult, ProbeStream } from '@/src/lib/scan/ffprobe';
import type { DetectionResult } from '@/src/lib/encode/detection';
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
let infoSpy: ReturnType<typeof vi.fn>;
let warnSpy: ReturnType<typeof vi.fn>;
let errorSpy: ReturnType<typeof vi.fn>;
let debugSpy: ReturnType<typeof vi.fn>;
let telemetrySpy: ReturnType<typeof vi.fn>;
let countSpy: ReturnType<typeof vi.fn>;
let commitSpy: ReturnType<typeof vi.fn>;
let trashSpy: ReturnType<typeof vi.fn>;

const NOW_SECONDS = 1_800_000_000;
const SOURCE_SIZE = 1_000_000;
const ARGV_LINE = 'ffmpeg argv: ffmpeg -hide_banner -i /in.mkv -c:v libx265 /out.mkv\n';

const DETECTION: DetectionResult = {
  detected: ['libx265'],
  activeFromAuto: 'libx265',
  warnings: [],
  outcome: { nvenc: 'missing', qsv: 'missing', vaapi: 'missing', libx265: 'functional' },
  brokenExcerpts: {},
  forcedIdrSupported: {},
  probeEncodeDisabled: false,
};

// The real video track: 24 fps. With duration 60 s that is 1440 expected packets
// and a 0.98 threshold of 1411.2.
const REAL_VIDEO: ProbeStream = {
  index: 0,
  codec_type: 'video',
  codec_name: 'hevc',
  attachedPic: false,
  avgFrameRate: 24,
};
const AUDIO: ProbeStream = {
  index: 1,
  codec_type: 'audio',
  codec_name: 'aac',
  attachedPic: false,
  // ffprobe writes the '0/0' sentinel here; parseFrameRate maps it to undefined.
};
// AC-20: a cover in the shape OUR OWN mkv output carries — the matroska muxer
// drops the attached_pic disposition, so only MIMETYPE + an image codec identify
// it (49-01 branch (b)). Its avg_frame_rate is the bogus 1000/1 ffprobe reports.
const COVER_OUR_OUTPUT: ProbeStream = {
  index: 0,
  codec_type: 'video',
  codec_name: 'mjpeg',
  attachedPic: false,
  tags: { FILENAME: 'cover.jpg', MIMETYPE: 'image/jpeg' },
  avgFrameRate: 1000,
};

function probeWith(streams: ProbeStream[], durationSeconds: number | null = 60): ProbeResult {
  return {
    codec: 'hevc',
    bitrate: 2_000_000,
    durationSeconds,
    width: 1920,
    height: 1080,
    container: 'matroska',
    tags: {},
    color: { space: null, primaries: null, transfer: null, range: null },
    hdr10: { masterDisplay: null, maxCll: null },
    streams,
  };
}

type SetupOpts = {
  /** Output size in bytes — picks the verdict bucket the gate must override. */
  outputSize?: number;
  /** What the injected countVideoPackets returns. */
  packets?: number | null;
  /** Streams the OUTPUT probe reports. */
  streams?: ProbeStream[];
  /** duration_seconds on the file row (null exercises the output-fallback). */
  fileDuration?: number | null;
  /** durationSeconds the OUTPUT probe reports. */
  probeDuration?: number | null;
  /** Mark the job cancelled from the outside while "encoding" (E4). */
  externalCancel?: boolean;
  /** ffmpeg log tail the injected runEncode reports (AC-22). */
  logTail?: string;
  /**
   * Chunks the injected runEncode pushes through onLogChunk SYNCHRONOUSLY,
   * reproducing the production timing: runEncode is synchronous from buildArgs to
   * spawn, so its argv line fires in the same tick as deps.runEncode(...) — long
   * before the fire-and-forget openJobLogStream promise can have resolved.
   */
  emitChunks?: string[];
};

function setup({
  outputSize = 600_000,
  packets = 1440,
  streams = [REAL_VIDEO, AUDIO],
  fileDuration = 60,
  probeDuration = 60,
  externalCancel = false,
  logTail = 'frame=   17 fps=0.3 q=28.0 size=  4300000kB',
  emitChunks = [ARGV_LINE],
}: SetupOpts = {}): { fileId: number; jobId: number; sourcePath: string } {
  const sourcePath = path.join(mediaRoot, 'movie.mkv');
  fs.writeFileSync(sourcePath, Buffer.alloc(SOURCE_SIZE, 'x'));
  const row = fileRepo.upsertByPath({
    path: sourcePath,
    size_bytes: SOURCE_SIZE,
    mtime: 1_700_000_000,
    content_hash: 'a'.repeat(64),
    codec: 'h264',
    bitrate: 5_000_000,
    duration_seconds: fileDuration,
    width: 1920,
    height: 1080,
    container: 'mkv',
    last_scanned_at: 1_700_000_500,
    share_id: null,
  });
  const job = jobRepo.create({ file_id: row.id, encoder: 'libx265', crf: null });
  if (!job) throw new Error('failed to create job');

  settingRepo.set('cache_pool_path', stageRoot);
  settingRepo.set('default_crf', '23');
  settingRepo.set('min_savings_percent', '5');
  settingRepo.set('trash_retention_days', '30');

  countSpy = vi.fn(async () => packets);
  commitSpy = vi.fn((a: string, b: string) => realStaging.commitOutput(a, b));
  trashSpy = vi.fn((a: string, b: string) => realStaging.trashOriginal(a, b));

  __forTests_setDeps({
    runEncode: (async (opts: EncodeOptions) => {
      // SYNCHRONOUS, before any await — the production timing (ffmpeg.ts:537-545).
      for (const c of emitChunks) opts.onLogChunk?.(c);
      fs.writeFileSync(opts.output, Buffer.alloc(outputSize, 'y'));
      if (externalCancel) jobRepo.markCancelled(job.id);
      return { exitCode: 0, durationMs: 30_000, logTail } satisfies EncodeResult;
    }) as unknown as (opts: EncodeOptions) => Promise<EncodeResult>,
    ffprobe: (async (p: string) =>
      probeWith(streams, p === sourcePath ? 60 : probeDuration)) as never,
    countVideoPackets: countSpy as never,
    detectEncoders: (async () => DETECTION) as never,
    fs: {
      statSync: fs.statSync,
      statfsSync: (() => ({ bavail: BigInt(1_000_000_000), bsize: BigInt(1) }) as never) as never,
      existsSync: fs.existsSync,
      unlinkSync: (() => undefined) as never,
      accessSync: fs.accessSync,
    },
    fileRepo: () => fileRepo,
    jobRepo: () => jobRepo,
    settingRepo: () => settingRepo,
    trashRepo: () => trashRepo,
    logger: {
      info: infoSpy,
      warn: warnSpy,
      error: errorSpy,
      debug: debugSpy,
      telemetry: telemetrySpy,
    } as never,
    now: () => NOW_SECONDS,
    staging: {
      ...realStaging,
      commitOutput: commitSpy as never,
      trashOriginal: trashSpy as never,
      unlinkSidecarTmpAt: (async () => undefined) as never,
    } as never,
  });

  return { fileId: row.id, jobId: job.id, sourcePath };
}

function warnLines(action: string): Array<Record<string, unknown>> {
  return warnSpy.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((o) => o?.action === action);
}

function telemetryLines(action: string): Array<Record<string, unknown>> {
  return telemetrySpy.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((o) => o?.action === action);
}

function jobRow(jobId: number): {
  status: string;
  error_msg: string | null;
  exit_code: number | null;
  log_tail: string | null;
} {
  return db
    .prepare('SELECT status, error_msg, exit_code, log_tail FROM job WHERE id = ?')
    .get(jobId) as {
    status: string;
    error_msg: string | null;
    exit_code: number | null;
    log_tail: string | null;
  };
}

beforeEach(async () => {
  await __forTests_resetOrchestrator();
  __forTests_resetCachePoolCooldowns();
  __forTests_resetFrameGateCache();
  delete process.env.ENCODE_FRAME_GATE_DISABLED;
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
  stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-fg-stage-'));
  mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-fg-media-'));
  openJobLogStreamMock.mockReset();
  openJobLogStreamMock.mockImplementation((jobId: string, cachePoolPath: string) =>
    realOpenRef.current!(jobId, cachePoolPath),
  );
  infoSpy = vi.fn();
  warnSpy = vi.fn();
  errorSpy = vi.fn();
  debugSpy = vi.fn();
  telemetrySpy = vi.fn();
});

afterEach(async () => {
  await __forTests_resetOrchestrator();
  __forTests_resetFrameGateCache();
  delete process.env.ENCODE_FRAME_GATE_DISABLED;
  db.close();
  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.rmSync(mediaRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('50-01 frame gate — the reporter case (AC-1)', () => {
  it('AC-1: 17 of 1440 expected packets → failJob, no commit, no trash', async () => {
    const { fileId, jobId, sourcePath } = setup({ packets: 17, outputSize: 600_000 });
    await loopOnce();

    const job = jobRow(jobId);
    expect(job.status).toBe('failed');
    // The error_msg carries BOTH numbers — queue + library render it verbatim.
    expect(job.error_msg).toBe('output_frame_gate:17/1440');
    expect(fileRepo.getById(fileId)?.status).toBe('failed');

    // The data-safe direction: original untouched, output discarded.
    expect(commitSpy).not.toHaveBeenCalled();
    expect(trashSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.readFileSync(sourcePath).length).toBe(SOURCE_SIZE);
    expect(db.prepare('SELECT * FROM trash_entry').all()).toHaveLength(0);
  });

  it('AC-21: the FAIL warn line carries all nine fields, before failJob', async () => {
    const { fileId, jobId } = setup({ packets: 17 });
    await loopOnce();

    const lines = warnLines('output_frame_gate_failed');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      jobId,
      fileId,
      expected: 1440,
      threshold: 1440 * 0.98,
      actual: 17,
      durationSeconds: 60,
      durationSource: 'file-row',
      avgFrameRate: 24,
      videoOrdinal: 0,
    });

    // …and it was emitted BEFORE the failJob transition line.
    const warnAt =
      warnSpy.mock.invocationCallOrder[
        warnSpy.mock.calls.findIndex(
          (c) => (c[0] as { action?: string }).action === 'output_frame_gate_failed',
        )
      ];
    const failAt =
      infoSpy.mock.invocationCallOrder[
        infoSpy.mock.calls.findIndex(
          (c) =>
            (c[0] as { action?: string }).action === 'job_transition' &&
            (c[0] as { transition?: string }).transition === 'encoding→failed',
        )
      ];
    expect(warnAt).toBeLessThan(failAt);
  });

  it('AC-22: the gate-failed job carries the ffmpeg log tail and the real exit code', async () => {
    const { jobId } = setup({ packets: 17, logTail: 'frame=   17 fps=0.3 q=28.0' });
    await loopOnce();

    const job = jobRow(jobId);
    expect(job.log_tail).toBe('frame=   17 fps=0.3 q=28.0');
    expect(job.exit_code).toBe(0);
  });
});

describe('50-01 frame gate — all three verdict buckets (AC-2)', () => {
  it.each([
    ['done-smaller', 600_000],
    ['done-not-worth', 980_000],
    ['done-larger', 1_200_000],
  ])('AC-2: a %s-sized output still fails when the gate rips', async (_label, outputSize) => {
    const { jobId, fileId } = setup({ packets: 17, outputSize: outputSize as number });
    await loopOnce();
    expect(jobRow(jobId).status).toBe('failed');
    expect(fileRepo.getById(fileId)?.status).toBe('failed');
    expect(commitSpy).not.toHaveBeenCalled();
  });
});

describe('50-01 frame gate — a complete encode is untouched (AC-3)', () => {
  it('AC-3: >= threshold passes, the verdict bucket is formed as before, one telemetry line', async () => {
    const { fileId, jobId } = setup({ packets: 1440, outputSize: 600_000 });
    await loopOnce();

    expect(jobRow(jobId).status).toBe('done');
    expect(fileRepo.getById(fileId)?.status).toBe('done-smaller');
    expect(commitSpy).toHaveBeenCalledTimes(1);

    const lines = telemetryLines('output_frame_gate_passed');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      jobId,
      fileId,
      expected: 1440,
      threshold: 1440 * 0.98,
      actual: 1440,
      durationSource: 'file-row',
    });
    // A passing gate is NOT a warn.
    expect(warnLines('output_frame_gate_failed')).toHaveLength(0);
    expect(warnLines('output_frame_gate_skipped')).toHaveLength(0);
  });

  it('AC-4 at the wire: 1412 packets pass, 1411 fail (threshold 1411.2)', async () => {
    const a = setup({ packets: 1412 });
    await loopOnce();
    expect(jobRow(a.jobId).status).toBe('done');

    // fresh DB per test — rebuild for the second half
    await __forTests_resetOrchestrator();
    db.prepare('DELETE FROM job').run();
    db.prepare('DELETE FROM file').run();
    const b = setup({ packets: 1411 });
    await loopOnce();
    expect(jobRow(b.jobId).status).toBe('failed');
  });
});

describe('50-01 frame gate — fail-OPEN skips (AC-5 / AC-6 / AC-7 / AC-8)', () => {
  it('AC-5: no duration anywhere → skip with reason no_duration and NO count spawn', async () => {
    const { jobId, fileId } = setup({ fileDuration: null, probeDuration: null });
    await loopOnce();

    expect(countSpy).not.toHaveBeenCalled();
    const lines = warnLines('output_frame_gate_skipped');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ reason: 'no_duration', jobId, fileId });
    expect(jobRow(jobId).status).toBe('done');
    expect(fileRepo.getById(fileId)?.status).toBe('done-smaller');
  });

  it('AC-6: the output carries no avgFrameRate → skip no_frame_rate, NO count spawn', async () => {
    const noFps: ProbeStream = { ...REAL_VIDEO, avgFrameRate: undefined };
    const { jobId } = setup({ streams: [noFps, AUDIO] });
    await loopOnce();

    expect(countSpy).not.toHaveBeenCalled();
    expect(warnLines('output_frame_gate_skipped')[0]).toMatchObject({ reason: 'no_frame_rate' });
    expect(jobRow(jobId).status).toBe('done');
  });

  it('AC-6: a probe without a streams array skips instead of throwing', async () => {
    const { jobId } = setup({ streams: [] });
    await loopOnce();
    expect(countSpy).not.toHaveBeenCalled();
    expect(warnLines('output_frame_gate_skipped')[0]).toMatchObject({ reason: 'no_frame_rate' });
    expect(jobRow(jobId).status).toBe('done');
  });

  it('AC-7: the count run fails → skip count_failed, job continues, NEVER failJob', async () => {
    const { jobId, fileId } = setup({ packets: null });
    await loopOnce();

    expect(countSpy).toHaveBeenCalledTimes(1);
    expect(warnLines('output_frame_gate_skipped')[0]).toMatchObject({ reason: 'count_failed' });
    expect(warnLines('output_frame_gate_failed')).toHaveLength(0);
    expect(jobRow(jobId).status).toBe('done');
    expect(fileRepo.getById(fileId)?.status).toBe('done-smaller');
  });

  it('AC-8: durationSource is file-row when the DB row carries a duration', async () => {
    setup({ packets: 1440 });
    await loopOnce();
    expect(telemetryLines('output_frame_gate_passed')[0]).toMatchObject({
      durationSource: 'file-row',
    });
  });

  it('AC-8: durationSource is output-fallback when only the probe has a duration', async () => {
    const { jobId } = setup({ fileDuration: null, probeDuration: 60, packets: 1440 });
    await loopOnce();
    expect(jobRow(jobId).status).toBe('done');
    expect(telemetryLines('output_frame_gate_passed')[0]).toMatchObject({
      durationSource: 'output-fallback',
      expected: 1440,
    });
  });
});

describe('50-01 frame gate — kill-switch (AC-9)', () => {
  it('AC-9: ENCODE_FRAME_GATE_DISABLED=1 → no spawn, no gate log at all, v2.46.0 path', async () => {
    process.env.ENCODE_FRAME_GATE_DISABLED = '1';
    __forTests_resetFrameGateCache();
    // The very output that would rip the gate is booked as done-smaller again —
    // that IS the v2.46.0 behaviour this switch restores.
    const { jobId, fileId } = setup({ packets: 17, outputSize: 600_000 });
    await loopOnce();

    expect(countSpy).not.toHaveBeenCalled();
    expect(warnLines('output_frame_gate_skipped')).toHaveLength(0);
    expect(warnLines('output_frame_gate_failed')).toHaveLength(0);
    expect(telemetryLines('output_frame_gate_passed')).toHaveLength(0);
    expect(jobRow(jobId).status).toBe('done');
    expect(fileRepo.getById(fileId)?.status).toBe('done-smaller');
    expect(commitSpy).toHaveBeenCalledTimes(1);
  });
});

describe('50-01 frame gate — expected and actual come from the SAME stream (AC-19 / AC-20)', () => {
  it('AC-19/AC-20: a cover at video ordinal 0 → fps AND selector point at ordinal 1', async () => {
    const realAtOne: ProbeStream = { ...REAL_VIDEO, index: 1 };
    const { jobId } = setup({
      streams: [COVER_OUR_OUTPUT, realAtOne, { ...AUDIO, index: 2 }],
      packets: 1440,
    });
    await loopOnce();

    // The count ran against v:1, NOT v:0 (which holds the single cover packet).
    expect(countSpy).toHaveBeenCalledTimes(1);
    expect(countSpy.mock.calls[0][1]).toMatchObject({ videoOrdinal: 1 });
    // The expectation used 24 fps (the real track), NOT the cover's bogus 1000.
    expect(telemetryLines('output_frame_gate_passed')[0]).toMatchObject({ expected: 1440 });
    expect(jobRow(jobId).status).toBe('done');
  });

  it('AC-19: the same ordering with a 17-packet collapse in the real track fails', async () => {
    const realAtOne: ProbeStream = { ...REAL_VIDEO, index: 1 };
    const { jobId } = setup({
      streams: [COVER_OUR_OUTPUT, realAtOne, { ...AUDIO, index: 2 }],
      packets: 17,
    });
    await loopOnce();

    expect(jobRow(jobId).status).toBe('failed');
    expect(warnLines('output_frame_gate_failed')[0]).toMatchObject({
      videoOrdinal: 1,
      avgFrameRate: 24,
      expected: 1440,
      actual: 17,
    });
  });

  it('AC-20: a source-side attached_pic cover at ordinal 0 is excluded too', async () => {
    const sourceCover: ProbeStream = {
      index: 0,
      codec_type: 'video',
      codec_name: 'mjpeg',
      attachedPic: true,
      avgFrameRate: 1000,
    };
    const { jobId } = setup({
      streams: [sourceCover, { ...REAL_VIDEO, index: 1 }, { ...AUDIO, index: 2 }],
      packets: 1440,
    });
    await loopOnce();
    expect(countSpy.mock.calls[0][1]).toMatchObject({ videoOrdinal: 1 });
    expect(jobRow(jobId).status).toBe('done');
  });
});

describe('50-01 frame gate — placement relative to the external cancel (E4)', () => {
  it('E4: an externally cancelled job with a broken output stays cancelled, not failed', async () => {
    const { jobId, fileId } = setup({ packets: 17, externalCancel: true });
    await loopOnce();

    expect(jobRow(jobId).status).toBe('cancelled');
    expect(fileRepo.getById(fileId)?.status).toBe('interrupted');
    // The gate never even ran — the operator's intent wins.
    expect(countSpy).not.toHaveBeenCalled();
    expect(warnLines('output_frame_gate_failed')).toHaveLength(0);
  });
});

// ── 50-01 (audit MH-1): the argv line on the FILE level, not the channel ──────

type FakeStream = {
  write: (c: Buffer | string) => void;
  close: () => Promise<void>;
  filePath: string;
};

function makeFakeStream(writes: string[]): FakeStream {
  return {
    write: (c) => writes.push(typeof c === 'string' ? c : c.toString('utf8')),
    close: async () => {},
    filePath: '/tmp/fake.log',
  };
}

describe('50-01 argv job-log line — the pre-open buffer (AC-13b / AC-13c)', () => {
  it('AC-13b: a stream that opens AFTER runEncode still receives the argv line', async () => {
    const writes: string[] = [];
    openJobLogStreamMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          // Resolves a full macrotask later — long after runEncode fired its line.
          setTimeout(() => resolve(makeFakeStream(writes)), 20);
        }),
    );
    setup({ packets: 1440 });
    await loopOnce();

    // Without the pre-open buffer this array is EMPTY: the chunk arrived while
    // jobLogStream was still null and the old handler dropped it.
    expect(writes.length).toBeGreaterThan(0);
    expect(writes[0]).toBe(ARGV_LINE);
  });

  it('AC-13b: an already-open stream still gets the line first, unchanged', async () => {
    const writes: string[] = [];
    openJobLogStreamMock.mockImplementationOnce(async () => makeFakeStream(writes));
    setup({ packets: 1440, emitChunks: [ARGV_LINE, 'frame=1\n'] });
    await loopOnce();
    expect(writes).toEqual([ARGV_LINE, 'frame=1\n']);
  });

  it('AC-13c: the pre-open buffer is capped at 64 KiB — later chunks are dropped', async () => {
    const writes: string[] = [];
    openJobLogStreamMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(makeFakeStream(writes)), 20);
        }),
    );
    const kib = 'x'.repeat(1024);
    setup({ packets: 1440, emitChunks: [ARGV_LINE, ...Array.from({ length: 70 }, () => kib)] });
    await loopOnce();

    const flushed = writes.reduce((n, c) => n + Buffer.byteLength(c), 0);
    // Buffering happened (well past a single chunk) but never past the cap.
    expect(flushed).toBeLessThanOrEqual(64 * 1024);
    expect(flushed).toBeGreaterThan(60 * 1024);
    // The argv line is the FIRST thing buffered, so the cap never costs it.
    expect(writes[0]).toBe(ARGV_LINE);
  });

  it('AC-13c: a stream that never opens does not disturb the encode', async () => {
    openJobLogStreamMock.mockImplementationOnce(async () => {
      throw new Error('EACCES: cache pool not writable');
    });
    const kib = 'x'.repeat(1024);
    const { jobId, fileId } = setup({
      packets: 1440,
      emitChunks: [ARGV_LINE, ...Array.from({ length: 200 }, () => kib)],
    });
    await loopOnce();

    // No throw, no abort — the job completes exactly as it would without logging.
    expect(jobRow(jobId).status).toBe('done');
    expect(fileRepo.getById(fileId)?.status).toBe('done-smaller');
  });
});
