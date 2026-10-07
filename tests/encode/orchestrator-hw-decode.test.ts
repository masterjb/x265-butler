// @vitest-environment node
// The orchestrator decides the VAAPI decode path per job from the setting, the
// active encoder, the codecs of the encoded video streams and the crop, hands
// the mode to runEncode and says in the job log which path it planned.
// Repositories are the real ones on an in-memory database.

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
import { __forTests_resetCachePoolCooldowns } from '@/src/lib/encode/staging';
import type { DetectionResult } from '@/src/lib/encode/detection';
import type { EncodeOptions, EncodeResult } from '@/src/lib/encode/ffmpeg';
import type { ProbeResult, ProbeStream } from '@/src/lib/scan/ffprobe';

type Db = InstanceType<typeof Database>;

let db: Db;
let fileRepo: FileRepo;
let jobRepo: JobRepo;
let settingRepo: SettingRepo;
let trashRepo: TrashRepo;
let stageRoot: string;
let mediaRoot: string;
let info: ReturnType<typeof vi.fn>;
let calls: EncodeOptions[];

const FALLBACK =
  '[hevc @ 0x5] Failed setup for format vaapi: hwaccel initialisation returned error.\n';

function detection(encoder: 'vaapi' | 'libx265'): DetectionResult {
  return {
    detected: encoder === 'vaapi' ? ['vaapi', 'libx265'] : ['libx265'],
    activeFromAuto: encoder,
    vaapiDevice: '/dev/dri/renderD129',
    warnings: [],
    outcome: {
      nvenc: 'missing',
      qsv: 'missing',
      vaapi: encoder === 'vaapi' ? 'functional' : 'missing',
      libx265: 'functional',
    },
    brokenExcerpts: {},
    forcedIdrSupported: {},
    probeEncodeDisabled: false,
  } as DetectionResult;
}

function video(index: number, codec: string, attachedPic = false): ProbeStream {
  return { index, codec_type: 'video', codec_name: codec, attachedPic };
}

function probeOf(streams: ProbeStream[]): ProbeResult {
  return {
    codec: streams[0]?.codec_name ?? 'hevc',
    bitrate: 1,
    durationSeconds: 60,
    width: 1920,
    height: 1080,
    container: 'matroska',
    tags: {},
    color: { space: null, primaries: null, transfer: null, range: null },
    hdr10: { masterDisplay: null, maxCll: null },
    streams,
  };
}

function seedFile(name: string, codec: string | null = 'hevc'): { id: number; path: string } {
  const p = path.join(mediaRoot, name);
  fs.writeFileSync(p, Buffer.alloc(1000, 'x'));
  const row = fileRepo.upsertByPath({
    path: p,
    size_bytes: 1000,
    mtime: 1_700_000_000,
    content_hash: 'a'.repeat(64),
    codec,
    bitrate: 1,
    duration_seconds: 60,
    width: 1920,
    height: 1080,
    container: 'matroska',
    last_scanned_at: 1_700_000_000,
    share_id: null,
  });
  return { id: row.id, path: row.path };
}

function wire(opts: {
  encoder?: 'vaapi' | 'libx265';
  sourceProbe?: ProbeResult | null;
  stderr?: string[];
}): void {
  const encoder = opts.encoder ?? 'vaapi';
  const sourceProbe =
    opts.sourceProbe === undefined ? probeOf([video(0, 'hevc')]) : opts.sourceProbe;
  __forTests_setDeps({
    runEncode: async (o: EncodeOptions): Promise<EncodeResult> => {
      calls.push(o);
      for (const chunk of opts.stderr ?? []) o.onLogChunk?.(chunk);
      fs.writeFileSync(o.output, Buffer.alloc(600, 'y'));
      return { exitCode: 0, durationMs: 1, logTail: '' };
    },
    // The source path answers with the scenario probe, the encoded output
    // always with a plain probe so verification can run.
    ffprobe: (async (p: string) =>
      p.startsWith(mediaRoot) ? sourceProbe : probeOf([video(0, 'hevc')])) as never,
    fs: {
      statSync: fs.statSync,
      statfsSync: (() => ({ bavail: BigInt(1e12), bsize: BigInt(1) }) as never) as never,
      accessSync: fs.accessSync,
      existsSync: fs.existsSync,
      unlinkSync: (() => undefined) as never,
    },
    fileRepo: () => fileRepo,
    jobRepo: () => jobRepo,
    settingRepo: () => settingRepo,
    trashRepo: () => trashRepo,
    detectEncoders: async () => detection(encoder),
    extractCovers: (async () => []) as never,
    logger: { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn(), telemetry: vi.fn() } as never,
    now: () => 1_800_000_000,
  });
  settingRepo.set('encoder', encoder);
}

function jobLog(jobId: number): string {
  const logFile = fs
    .readdirSync(stageRoot, { recursive: true })
    .map(String)
    .find((f) => f.endsWith(`${jobId}.log`));
  expect(logFile).toBeDefined();
  return fs.readFileSync(path.join(stageRoot, logFile!), 'utf8');
}

const actions = (action: string) =>
  info.mock.calls.filter((c) => (c[0] as { action?: string })?.action === action);

async function runOne(fileName = 'movie.mkv', codec: string | null = 'hevc'): Promise<number> {
  const f = seedFile(fileName, codec);
  const job = jobRepo.create({ file_id: f.id, encoder: 'vaapi', crf: null })!;
  await loopOnce();
  return job.id;
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
    bulkSetFileStatusToPending: (ids, s) => fileRepo.bulkSetStatusToPendingByIds(ids, s),
  });
  settingRepo = makeSettingRepo(db);
  trashRepo = makeTrashRepo(db);
  stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-hwdec-stage-'));
  mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-hwdec-media-'));
  settingRepo.set('cache_pool_path', stageRoot);
  settingRepo.set('default_crf', '23');
  info = vi.fn();
  calls = [];
});

afterEach(async () => {
  await __forTests_resetOrchestrator();
  db.close();
  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.rmSync(mediaRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('passes the resolved decode mode to runEncode', () => {
  it('setting on, vaapi, hevc source, no crop: zero-copy', async () => {
    settingRepo.set('vaapi_hw_decode', 'true');
    wire({});
    await runOne();
    expect(calls).toHaveLength(1);
    expect(calls[0].vaapiHwDecode).toBe('zero-copy');
    expect(calls[0].vaapiDevice).toBe('/dev/dri/renderD129');
  });

  it('a crop switches to download', async () => {
    settingRepo.set('vaapi_hw_decode', 'true');
    settingRepo.set('crop_override', '1920:800:0:140');
    wire({});
    await runOne();
    expect(calls[0].crop).toBe('1920:800:0:140');
    expect(calls[0].vaapiHwDecode).toBe('download');
  });

  it('libx265 never gets a decode mode', async () => {
    settingRepo.set('vaapi_hw_decode', 'true');
    wire({ encoder: 'libx265' });
    await runOne();
    expect(calls[0].encoder).toBe('libx265');
    expect(calls[0].vaapiHwDecode).toBeUndefined();
  });

  it('setting off: no decode mode', async () => {
    wire({});
    await runOne();
    expect(calls[0].encoder).toBe('vaapi');
    expect(calls[0].vaapiHwDecode).toBeUndefined();
  });

  it('ignores cover art streams', async () => {
    settingRepo.set('vaapi_hw_decode', 'true');
    wire({ sourceProbe: probeOf([video(0, 'mjpeg', true), video(1, 'h264')]) });
    await runOne();
    expect(calls[0].vaapiHwDecode).toBe('zero-copy');
  });

  it('falls back to CPU when any encoded video stream is not listed', async () => {
    settingRepo.set('vaapi_hw_decode', 'true');
    wire({ sourceProbe: probeOf([video(0, 'h264'), video(1, 'prores')]) });
    const jobId = await runOne();
    expect(calls[0].vaapiHwDecode).toBeUndefined();
    expect(jobLog(jobId)).toContain('video decode: CPU, hardware decode not used for codec prores');
  });

  it('uses file.codec only without a source probe', async () => {
    settingRepo.set('vaapi_hw_decode', 'true');
    wire({ sourceProbe: null });
    await runOne('a.mkv', 'hevc');
    expect(calls[0].vaapiHwDecode).toBe('zero-copy');

    calls = [];
    await runOne('b.mkv', null);
    expect(calls[0].vaapiHwDecode).toBeUndefined();
  });

  it('bench sample jobs never use hardware decode', async () => {
    settingRepo.set('vaapi_hw_decode', 'true');
    wire({});
    const f = seedFile('bench.mkv');
    const job = jobRepo.create({ file_id: f.id, encoder: 'vaapi', crf: null })!;
    __forTests_markJobAsBenchSample(job.id);
    await loopOnce();
    expect(calls).toHaveLength(1);
    expect(calls[0].vaapiHwDecode).toBeUndefined();
    expect(actions('hw_decode_resolved')).toHaveLength(0);
  });
});

describe('writes one decode path line to the job log', () => {
  it('zero-copy line plus hw_decode_resolved without paths', async () => {
    settingRepo.set('vaapi_hw_decode', 'true');
    wire({});
    const jobId = await runOne();
    const text = jobLog(jobId);
    expect(text.match(/video decode: /g)).toHaveLength(1);
    expect(text).toContain('video decode: GPU (VAAPI), frames stay on the GPU');
    const resolved = actions('hw_decode_resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0][0]).toMatchObject({ jobId, encoder: 'vaapi', mode: 'zero-copy' });
    expect(JSON.stringify(resolved[0][0])).not.toContain(mediaRoot);
  });

  it('download line when cropping', async () => {
    settingRepo.set('vaapi_hw_decode', 'true');
    settingRepo.set('crop_override', '1920:800:0:140');
    wire({});
    const jobId = await runOne();
    expect(jobLog(jobId)).toContain('video decode: GPU (VAAPI), frames copied to RAM for cropping');
  });

  it('no line and no resolved log when the setting is off', async () => {
    wire({});
    const jobId = await runOne();
    expect(jobLog(jobId)).not.toContain('video decode:');
    expect(actions('hw_decode_resolved')).toHaveLength(0);
  });
});

describe('fallback line appears once', () => {
  it('a fallback message split over two chunks, repeated, gives one line', async () => {
    settingRepo.set('vaapi_hw_decode', 'true');
    const cut = FALLBACK.indexOf('format va') + 4;
    wire({ stderr: [FALLBACK.slice(0, cut), FALLBACK.slice(cut), FALLBACK] });
    const jobId = await runOne();
    const text = jobLog(jobId);
    expect(
      text.match(/GPU could not decode this source, ffmpeg decodes it on the CPU/g),
    ).toHaveLength(1);
    expect(actions('hw_decode_fallback')).toHaveLength(1);
    expect(actions('hw_decode_fallback')[0][0]).toEqual({ action: 'hw_decode_fallback', jobId });
  });

  it('the same message without hardware decode adds nothing', async () => {
    wire({ stderr: [FALLBACK] });
    const jobId = await runOne();
    expect(jobLog(jobId)).not.toContain('GPU could not decode');
    expect(actions('hw_decode_fallback')).toHaveLength(0);
  });
});
