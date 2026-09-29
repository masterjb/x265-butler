// 50-02 Task 3 — the cover-attach wiring inside the orchestrator.
//
// Covers AC-5 (a failed extraction drops the cover and the job runs on), AC-7
// (the kill-switch produces Opt B — dropped, never copied back), AC-17 (the
// 50-01 frame gate still picks the REAL video stream on a 50-02 output), AC-25
// (the mp4→mkv fallback carries cover descriptors from the SAME probe) and
// AC-29 (the pure mp4 path starts no extraction at all).
//
// Deliberately a NEW file: no legacy orchestrator fixture is touched (E8) — the
// extraction rides an OPTIONAL EngineDeps entry, so the twelve existing
// orchestrator-*.test.ts dep literals stay byte-identical.

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
import { __forTests_resetCoverAttachCache } from '@/src/lib/encode/cover-extract';
import type { CoverAttachment } from '@/src/lib/encode/cover-extract';
import type { CoverStream } from '@/src/lib/encode/attached-pic';
import { __forTests_resetFrameGateCache } from '@/src/lib/encode/frame-gate';
import type { EncodeOptions, EncodeResult } from '@/src/lib/encode/ffmpeg';
import type { ProbeResult, ProbeStream } from '@/src/lib/scan/ffprobe';
import type { DetectionResult } from '@/src/lib/encode/detection';
import * as realStaging from '@/src/lib/encode/staging';
import { __forTests_resetCachePoolCooldowns } from '@/src/lib/encode/staging';
import { logger } from '@/src/lib/logger';

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
let extractSpy: ReturnType<typeof vi.fn>;
let countSpy: ReturnType<typeof vi.fn>;
let encodeOpts: EncodeOptions | null;

const NOW_SECONDS = 1_800_000_000;
const SOURCE_SIZE = 1_000_000;

const DETECTION: DetectionResult = {
  detected: ['libx265'],
  activeFromAuto: 'libx265',
  warnings: [],
  outcome: { nvenc: 'missing', qsv: 'missing', vaapi: 'missing', libx265: 'functional' },
  brokenExcerpts: {},
  forcedIdrSupported: {},
  probeEncodeDisabled: false,
};

const REAL_VIDEO: ProbeStream = {
  index: 0,
  codec_type: 'video',
  codec_name: 'h264',
  attachedPic: false,
  avgFrameRate: 24,
};
const COVER: ProbeStream = {
  index: 1,
  codec_type: 'video',
  codec_name: 'mjpeg',
  attachedPic: true,
  tags: { FILENAME: 'cover.jpg', MIMETYPE: 'image/jpeg' },
};
const AUDIO: ProbeStream = { index: 2, codec_type: 'audio', codec_name: 'aac', attachedPic: false };
const FONT = (index: number): ProbeStream => ({
  index,
  codec_type: 'attachment',
  codec_name: 'ttf',
  attachedPic: false,
  tags: { MIMETYPE: 'application/x-truetype-font', FILENAME: `f${index}.ttf` },
});

/** The output probe: exactly the 50-02 shape — real video 0, cover 1 (AC-17). */
const OUTPUT_STREAMS: ProbeStream[] = [
  { index: 0, codec_type: 'video', codec_name: 'hevc', attachedPic: false, avgFrameRate: 24 },
  {
    index: 1,
    codec_type: 'video',
    codec_name: 'mjpeg',
    attachedPic: true,
    tags: { FILENAME: 'cover.jpg', MIMETYPE: 'image/jpeg' },
    avgFrameRate: 1000,
  },
  AUDIO,
];

function probeWith(
  streams: ProbeStream[],
  container: string,
  durationSeconds: number | null = 60,
): ProbeResult {
  return {
    codec: 'h264',
    bitrate: 5_000_000,
    durationSeconds,
    width: 1920,
    height: 1080,
    container,
    tags: {},
    color: { space: null, primaries: null, transfer: null, range: null },
    hdr10: { masterDisplay: null, maxCll: null },
    streams,
  };
}

type SetupOpts = {
  /** 'mkv' (default) or 'mp4' — drives the source extension AND match-source. */
  sourceContainer?: 'mkv' | 'mp4';
  /** Streams the SOURCE probe reports. */
  sourceStreams?: ProbeStream[];
  /** Streams the OUTPUT probe reports. */
  outputStreams?: ProbeStream[];
  /** What the injected extractCovers returns (default: one attachment). */
  extracted?: CoverAttachment[];
  /** Force the output container regardless of the source. */
  forceContainer?: 'mkv' | 'mp4';
  /** Source audio codec — 'opus' trips the 05-15 mp4→mkv fallback (AC-25). */
  audioCodec?: string;
};

function setup({
  sourceContainer = 'mkv',
  sourceStreams = [REAL_VIDEO, COVER, AUDIO, FONT(3), FONT(4)],
  outputStreams = OUTPUT_STREAMS,
  extracted = [{ path: '/stage/cover0.jpg', mimetype: 'image/jpeg', filename: 'cover.jpg' }],
  forceContainer,
  audioCodec,
}: SetupOpts = {}): { fileId: number; jobId: number; sourcePath: string } {
  const sourcePath = path.join(mediaRoot, `movie.${sourceContainer}`);
  fs.writeFileSync(sourcePath, Buffer.alloc(SOURCE_SIZE, 'x'));
  const row = fileRepo.upsertByPath({
    path: sourcePath,
    size_bytes: SOURCE_SIZE,
    mtime: 1_700_000_000,
    content_hash: 'a'.repeat(64),
    codec: 'h264',
    bitrate: 5_000_000,
    duration_seconds: 60,
    width: 1920,
    height: 1080,
    container: sourceContainer,
    last_scanned_at: 1_700_000_500,
    share_id: null,
  });
  const job = jobRepo.create({ file_id: row.id, encoder: 'libx265', crf: null });
  if (!job) throw new Error('failed to create job');

  settingRepo.set('cache_pool_path', stageRoot);
  settingRepo.set('default_crf', '23');
  settingRepo.set('min_savings_percent', '5');
  settingRepo.set('trash_retention_days', '30');
  // match-source so an .mp4 source really produces an mp4 output (AC-29).
  settingRepo.set('output_container', forceContainer ?? 'match-source');

  const audio: ProbeStream =
    audioCodec === undefined ? AUDIO : { ...AUDIO, codec_name: audioCodec };
  const srcStreams = sourceStreams.map((s) => (s.codec_type === 'audio' ? audio : s));

  extractSpy = vi.fn(async () => extracted);
  countSpy = vi.fn(async () => 1440);

  __forTests_setDeps({
    runEncode: (async (opts: EncodeOptions) => {
      encodeOpts = opts;
      fs.writeFileSync(opts.output, Buffer.alloc(600_000, 'y'));
      return { exitCode: 0, durationMs: 1000, logTail: '' } satisfies EncodeResult;
    }) as unknown as (opts: EncodeOptions) => Promise<EncodeResult>,
    ffprobe: (async (p: string) =>
      p === sourcePath
        ? probeWith(srcStreams, sourceContainer === 'mkv' ? 'matroska,webm' : 'mov,mp4')
        : probeWith(outputStreams, 'matroska,webm')) as never,
    countVideoPackets: countSpy as never,
    extractCovers: extractSpy as never,
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
      commitOutput: ((a: string, b: string) => realStaging.commitOutput(a, b)) as never,
      trashOriginal: ((a: string, b: string) => realStaging.trashOriginal(a, b)) as never,
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

beforeEach(async () => {
  await __forTests_resetOrchestrator();
  __forTests_resetCachePoolCooldowns();
  __forTests_resetCoverAttachCache();
  __forTests_resetFrameGateCache();
  delete process.env.ENCODE_COVER_ATTACH_DISABLED;
  delete process.env.ENCODE_FRAME_GATE_DISABLED;
  encodeOpts = null;
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
  stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-ca-stage-'));
  mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-ca-media-'));
  infoSpy = vi.fn();
  warnSpy = vi.fn();
  errorSpy = vi.fn();
  debugSpy = vi.fn();
  telemetrySpy = vi.fn();
});

afterEach(async () => {
  await __forTests_resetOrchestrator();
  __forTests_resetCoverAttachCache();
  __forTests_resetFrameGateCache();
  delete process.env.ENCODE_COVER_ATTACH_DISABLED;
  db.close();
  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.rmSync(mediaRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('50-02 orchestrator — the happy MKV path', () => {
  it('extracts from workDir/input and threads attachments + base index into runEncode', async () => {
    setup();
    await loopOnce();

    expect(extractSpy).toHaveBeenCalledTimes(1);
    const [input, workDir, covers, deps] = extractSpy.mock.calls[0] as [
      string,
      string,
      CoverStream[],
      { signal?: AbortSignal; jobId?: number },
    ];
    // The staging symlink, NEVER file.path — the staging indirection is the
    // contract of the encode path.
    expect(input).toBe(path.join(workDir, 'input'));
    expect(input.endsWith(path.join('input'))).toBe(true);
    expect(covers).toEqual([
      {
        videoOrdinal: 1,
        codecName: 'mjpeg',
        media: { ext: 'jpg', mimetype: 'image/jpeg' },
        sourceFilename: 'cover.jpg',
      },
    ]);
    expect(deps.signal).toBeInstanceOf(AbortSignal);
    expect(deps.jobId).toBeDefined();

    expect(encodeOpts?.coverAttachments).toEqual([
      { path: '/stage/cover0.jpg', mimetype: 'image/jpeg', filename: 'cover.jpg' },
    ]);
    // TWO fonts in the source ⇒ the attach base index is 2 (the cover itself
    // does NOT count — it demuxes as a video stream, M-J).
    expect(encodeOpts?.sourceAttachmentCount).toBe(2);
    expect(encodeOpts?.attachedPicVideoOrdinals).toEqual([1]);
    expect(warnLines('cover_attach_partial')).toHaveLength(0);
  });

  it('a source WITHOUT a cover starts no extraction and threads nothing (byte-identical)', async () => {
    setup({ sourceStreams: [REAL_VIDEO, AUDIO], outputStreams: [OUTPUT_STREAMS[0], AUDIO] });
    await loopOnce();

    expect(extractSpy).not.toHaveBeenCalled();
    expect(encodeOpts?.coverAttachments).toBeUndefined();
    expect(encodeOpts?.attachedPicVideoOrdinals).toBeUndefined();
    // The count itself IS resolved (a probe ran) — 0 is a valid base index and
    // must stay distinguishable from "no probe ran" (E9).
    expect(encodeOpts?.sourceAttachmentCount).toBe(0);
  });

  it('sourceAttachmentCount is 0 — not undefined — on a cover source without fonts', async () => {
    setup({ sourceStreams: [REAL_VIDEO, COVER, AUDIO] });
    await loopOnce();
    expect(encodeOpts?.sourceAttachmentCount).toBe(0);
    expect(encodeOpts?.coverAttachments).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('50-02 AC-5 — a failed extraction drops the cover, the job runs on', () => {
  it('zero attachments back ⇒ one cover_attach_partial warn, job completes', async () => {
    const { jobId } = setup({ extracted: [] });
    await loopOnce();

    const lines = warnLines('cover_attach_partial');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ jobId, coverCount: 1, attachedCount: 0 });

    // The encode still ran, with NO attachments — and the cover ordinals are
    // still passed, so buildArgs keeps it out of the video mapping (D4/Opt B).
    expect(encodeOpts?.coverAttachments).toEqual([]);
    expect(encodeOpts?.attachedPicVideoOrdinals).toEqual([1]);
    const job = db.prepare('SELECT status FROM job WHERE id = ?').get(jobId) as {
      status: string;
    };
    expect(job.status).toBe('done');
  });

  it('one of two covers back ⇒ partial warn carries both numbers', async () => {
    const twoCovers: ProbeStream[] = [
      REAL_VIDEO,
      COVER,
      { ...COVER, index: 2, codec_name: 'png', tags: { FILENAME: 'small.png' } },
      AUDIO,
    ];
    setup({
      sourceStreams: twoCovers,
      extracted: [{ path: '/stage/cover0.jpg', mimetype: 'image/jpeg', filename: 'cover.jpg' }],
    });
    await loopOnce();
    expect(warnLines('cover_attach_partial')[0]).toMatchObject({
      coverCount: 2,
      attachedCount: 1,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('50-02 AC-7 — the kill-switch produces Opt B', () => {
  it('ENCODE_COVER_ATTACH_DISABLED=1 ⇒ NO extraction child, one kill_switch warn', async () => {
    process.env.ENCODE_COVER_ATTACH_DISABLED = '1';
    __forTests_resetCoverAttachCache();
    const { jobId } = setup();
    await loopOnce();

    expect(extractSpy).not.toHaveBeenCalled();
    const lines = warnLines('cover_attach_skipped');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ reason: 'kill_switch', jobId, coverCount: 1 });

    // No attachments ⇒ no `-attach` in the argv, and the cover ordinals still
    // travel ⇒ the cover leaves the mapping. NEVER back to the 49-01 copy.
    expect(encodeOpts?.coverAttachments).toBeUndefined();
    expect(encodeOpts?.attachedPicVideoOrdinals).toEqual([1]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('50-02 AC-29 — the MP4 path never starts an extraction', () => {
  it('an mp4 output does not extract and does not even read the kill-switch', async () => {
    const infoLogSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger as never);
    // A real mp4 probe reports NO attachment streams — mp4 has no such element.
    setup({
      sourceContainer: 'mp4',
      sourceStreams: [REAL_VIDEO, COVER, AUDIO],
      outputStreams: [OUTPUT_STREAMS[0], AUDIO],
    });
    await loopOnce();

    expect(encodeOpts?.outputContainer).toBe('mp4');
    expect(extractSpy).not.toHaveBeenCalled();
    expect(encodeOpts?.coverAttachments).toBeUndefined();
    // The 49-01 copy contract still holds on this path — that is AC-9's half.
    expect(encodeOpts?.attachedPicVideoOrdinals).toEqual([1]);
    expect(encodeOpts?.encodedVideoOrdinals).toEqual([0]);
    // coverAttachEnabled() logs `cover_attach_resolved` on its FIRST read; the
    // absence of that line proves the switch was not even consulted.
    expect(
      infoLogSpy.mock.calls.filter(
        (c) => (c[0] as { action?: string }).action === 'cover_attach_resolved',
      ),
    ).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('50-02 AC-25 — the mp4→mkv fallback carries the cover descriptors', () => {
  it('an opus-audio mp4 source falls back to mkv and STILL attaches its cover', async () => {
    // 05-15: opus is mp4-incompatible → effectiveContainer flips to mkv INSIDE
    // resolveContainerAndCompat, AFTER the mp4 block already ran. That is the
    // whole reason both seams set the fields.
    setup({
      sourceContainer: 'mp4',
      sourceStreams: [REAL_VIDEO, COVER, AUDIO],
      audioCodec: 'opus',
    });
    await loopOnce();

    expect(encodeOpts?.outputContainer).toBe('mkv');
    expect(extractSpy).toHaveBeenCalledTimes(1);
    expect(encodeOpts?.coverAttachments).toHaveLength(1);
    // MP4 knows no attachment streams, so the base index is 0 — a VALID value,
    // and the one buildArgs must not confuse with "unknown" (E9).
    expect(encodeOpts?.sourceAttachmentCount).toBe(0);
    // ONE ffprobe on the source: the mkv block reuses the mp4 block's probe, so
    // descriptors and ordinals provably describe the same file state.
    expect(encodeOpts?.attachedPicVideoOrdinals).toEqual([1]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('50-02 AC-17 — the 50-01 frame gate stays correct on a 50-02 output', () => {
  it('the gate counts video ordinal 0 (the real track), not the cover, and passes', async () => {
    const { jobId } = setup();
    await loopOnce();

    // resolveGateVideoStream skips the cover and picks the real stream.
    expect(countSpy).toHaveBeenCalledTimes(1);
    const [, opts] = countSpy.mock.calls[0] as [string, { videoOrdinal?: number }];
    expect(opts.videoOrdinal).toBe(0);

    // duration 60 × 24 fps = 1440 expected, 1440 counted ⇒ no failure.
    expect(warnLines('output_frame_gate_failed')).toHaveLength(0);
    const job = db.prepare('SELECT status FROM job WHERE id = ?').get(jobId) as {
      status: string;
    };
    expect(job.status).toBe('done');
  });

  it('a cover at OUTPUT ordinal 0 still resolves the real track (ordinal 1)', async () => {
    setup({
      outputStreams: [
        {
          index: 0,
          codec_type: 'video',
          codec_name: 'mjpeg',
          attachedPic: true,
          tags: { FILENAME: 'cover.jpg', MIMETYPE: 'image/jpeg' },
          avgFrameRate: 1000,
        },
        { index: 1, codec_type: 'video', codec_name: 'hevc', attachedPic: false, avgFrameRate: 24 },
        AUDIO,
      ],
    });
    await loopOnce();
    const [, opts] = countSpy.mock.calls[0] as [string, { videoOrdinal?: number }];
    expect(opts.videoOrdinal).toBe(1);
    expect(warnLines('output_frame_gate_failed')).toHaveLength(0);
  });
});
