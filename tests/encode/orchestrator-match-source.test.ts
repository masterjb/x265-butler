// 05-15: orchestrator dispatch — match-source DWIM resolver + auto-fallback
// to MKV on MP4-incompat. Mirrors the dispatch-test pattern from
// orchestrator.test.ts (setupOrchestrator helper + __forTests_setDeps wiring).

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
  cancelAllQueued,
  loopOnce,
  skipActive,
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

function seedFile(p: string, sizeBytes = 1_000_000): { id: number; path: string } {
  const row = fileRepo.upsertByPath({
    path: p,
    size_bytes: sizeBytes,
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

function probeWithStreams(streams: ProbeResult['streams']): ProbeResult {
  return {
    codec: 'h264',
    bitrate: 5_000_000,
    durationSeconds: 60,
    width: 1920,
    height: 1080,
    container: 'matroska',
    tags: {},
    streams,
  };
}

const cleanAacProbe = (): ProbeResult =>
  probeWithStreams([
    { index: 0, codec_type: 'video', codec_name: 'h264' },
    { index: 1, codec_type: 'audio', codec_name: 'aac' },
  ]);

const truehdProbe = (): ProbeResult =>
  probeWithStreams([
    { index: 0, codec_type: 'video', codec_name: 'h264' },
    { index: 1, codec_type: 'audio', codec_name: 'truehd' },
  ]);

const aacWithSubripProbe = (): ProbeResult =>
  probeWithStreams([
    { index: 0, codec_type: 'video', codec_name: 'h264' },
    { index: 1, codec_type: 'audio', codec_name: 'aac' },
    { index: 2, codec_type: 'subtitle', codec_name: 'subrip' },
    { index: 3, codec_type: 'subtitle', codec_name: 'subrip' },
  ]);

type SetupOpts = {
  setting?: 'mkv' | 'mp4' | 'match-source';
  filename?: string;
  ffprobeImpl?: () => Promise<ProbeResult | null>;
  outputSize?: number;
  // 16-05: optional suffix override. Default '.x265.mkv' keeps all
  // pre-existing assertions byte-identical (LEGACY-default branch in
  // resolveOutputSuffix yields extensionFor(container) = .x265.{mkv|mp4}).
  // Override to '-x265' to exercise the NEW-default path → -x265.{mkv|mp4}.
  outputSuffix?: string;
};

function setupDispatch({
  setting = 'match-source',
  filename = 'movie.mp4',
  ffprobeImpl,
  outputSize = 600_000,
  outputSuffix = '.x265.mkv',
}: SetupOpts = {}): { fileId: number; jobId: number; sourcePath: string } {
  // setupDispatch is sync — staging deps imported eagerly at module scope.
  const sourcePath = path.join(mediaRoot, filename);
  fs.writeFileSync(sourcePath, Buffer.alloc(1_000_000, 'x'));
  const file = seedFile(sourcePath, 1_000_000);
  const job = jobRepo.create({ file_id: file.id, encoder: 'libx265', crf: null });
  if (!job) throw new Error('failed to create job');

  settingRepo.set('cache_pool_path', stageRoot);
  settingRepo.set('default_crf', '23');
  settingRepo.set('min_savings_percent', '5');
  settingRepo.set('trash_retention_days', '30');
  settingRepo.set('output_container', setting);
  settingRepo.set('output_suffix', outputSuffix);

  __forTests_setDeps({
    runEncode: runEncodeSpy.mockImplementation(async ({ output }) => {
      fs.writeFileSync(output, Buffer.alloc(outputSize, 'y'));
      return { exitCode: 0, durationMs: 30_000, logTail: '' } satisfies EncodeResult;
    }) as unknown as (opts: EncodeOptions) => Promise<EncodeResult>,
    ffprobe: (ffprobeImpl ?? (async () => cleanAacProbe())) as never,
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

  return { fileId: file.id, jobId: job.id, sourcePath };
}

beforeEach(async () => {
  await __forTests_resetOrchestrator();
  __forTests_resetCachePoolCooldowns();
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
  stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-orch-ms-stage-'));
  mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-orch-ms-media-'));
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

describe('orchestrator — 05-15 match-source dispatch (AC-3 .. AC-6 + AC-12)', () => {
  it('test_match_source_when_mkv_source_then_runEncode_outputContainer_mkv_no_fallback_no_source_ffprobe', async () => {
    const ffprobeMock: (p: string) => Promise<ProbeResult | null> = vi.fn(async () =>
      cleanAacProbe(),
    );
    const { sourcePath } = await setupDispatch({
      setting: 'match-source',
      filename: 'movie.mkv',
      ffprobeImpl: ffprobeMock as () => Promise<ProbeResult | null>,
    });
    await loopOnce();

    expect(runEncodeSpy).toHaveBeenCalledTimes(1);
    expect(runEncodeSpy.mock.calls[0]?.[0]?.outputContainer).toBe('mkv');
    // AC-3: ZERO source ffprobe runs for compat analysis (MKV path skips
    // pre-flight). Verify-stage may probe the staged OUTPUT — that is allowed.
    const probeCalls = (ffprobeMock as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const sourceProbeCalls = probeCalls.filter((call) => String(call[0]) === sourcePath);
    expect(sourceProbeCalls).toHaveLength(0);
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'mp4_fallback_to_mkv' }),
      expect.any(String),
    );
  });

  it('test_match_source_when_clean_mp4_source_then_runEncode_outputContainer_mp4_no_fallback', async () => {
    await setupDispatch({
      setting: 'match-source',
      filename: 'movie.mp4',
      ffprobeImpl: async () => cleanAacProbe(),
    });
    await loopOnce();

    expect(runEncodeSpy).toHaveBeenCalledTimes(1);
    expect(runEncodeSpy.mock.calls[0]?.[0]?.outputContainer).toBe('mp4');
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'mp4_fallback_to_mkv' }),
      expect.any(String),
    );
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'mp4_audio_codec_incompatible' }),
      expect.any(String),
    );
  });

  it('test_match_source_when_mp4_truehd_audio_then_fallback_to_mkv_no_failJob', async () => {
    const { jobId } = await setupDispatch({
      setting: 'match-source',
      filename: 'bluray.mp4',
      ffprobeImpl: async () => truehdProbe(),
    });
    await loopOnce();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'mp4_fallback_to_mkv',
        fallbackReason: 'audio',
        from: 'mp4',
        to: 'mkv',
        allIncompatibleCodecs: ['truehd'],
      }),
      expect.any(String),
    );
    expect(runEncodeSpy.mock.calls[0]?.[0]?.outputContainer).toBe('mkv');
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'mp4_audio_codec_incompatible' }),
      expect.any(String),
    );
    const job = jobRepo.findById(jobId);
    expect(job?.status).not.toBe('failed');
  });

  it('test_match_source_when_mp4_subrip_subs_then_fallback_to_mkv_no_drop', async () => {
    await setupDispatch({
      setting: 'match-source',
      filename: 'with-subs.mp4',
      ffprobeImpl: async () => aacWithSubripProbe(),
    });
    await loopOnce();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'mp4_fallback_to_mkv',
        fallbackReason: 'subtitle',
        from: 'mp4',
        to: 'mkv',
      }),
      expect.any(String),
    );
    const callArgs = runEncodeSpy.mock.calls[0]?.[0];
    expect(callArgs?.outputContainer).toBe('mkv');
    expect(callArgs?.dropIncompatibleSubtitles).not.toBe(true);
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'subtitle_streams_dropped_for_mp4' }),
      expect.any(String),
    );
  });

  it('test_match_source_when_ffprobe_null_on_mp4_then_fallback_to_mkv_preflight_unavailable', async () => {
    await setupDispatch({
      setting: 'match-source',
      filename: 'probe-fails.mp4',
      ffprobeImpl: async () => null,
    });
    await loopOnce();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'mp4_fallback_to_mkv',
        fallbackReason: 'preflight_unavailable',
        from: 'mp4',
        to: 'mkv',
        allIncompatibleCodecs: [],
      }),
      expect.any(String),
    );
    expect(runEncodeSpy.mock.calls[0]?.[0]?.outputContainer).toBe('mkv');
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'mp4_preflight_ffprobe_unavailable' }),
      expect.any(String),
    );
  });

  it('test_match_source_when_audio_AND_subs_incompat_then_only_one_fallback_event_audio_path_wins', async () => {
    await setupDispatch({
      setting: 'match-source',
      filename: 'all-bad.mp4',
      ffprobeImpl: async () =>
        probeWithStreams([
          { index: 0, codec_type: 'video', codec_name: 'h264' },
          { index: 1, codec_type: 'audio', codec_name: 'truehd' },
          { index: 2, codec_type: 'subtitle', codec_name: 'subrip' },
        ]),
    });
    await loopOnce();

    const fallbackCalls = warnSpy.mock.calls.filter(
      ([arg]) =>
        typeof arg === 'object' &&
        arg !== null &&
        (arg as { action?: string }).action === 'mp4_fallback_to_mkv',
    );
    expect(fallbackCalls).toHaveLength(1);
    expect(fallbackCalls[0]?.[0]).toMatchObject({ fallbackReason: 'audio' });
  });

  it('test_match_source_when_uppercase_MP4_extension_then_resolves_to_mp4', async () => {
    await setupDispatch({
      setting: 'match-source',
      filename: 'movie.MP4',
      ffprobeImpl: async () => cleanAacProbe(),
    });
    await loopOnce();
    expect(runEncodeSpy.mock.calls[0]?.[0]?.outputContainer).toBe('mp4');
  });
});

describe('orchestrator — 05-15 explicit-mp4 contract preserved (AC-7 + AC-12 explicit)', () => {
  it('test_explicit_mp4_when_truehd_then_failJob_no_fallback', async () => {
    settingRepo.set('audio_auto_transcode_mp4', 'false');
    const { jobId } = await setupDispatch({
      setting: 'mp4',
      filename: 'movie.mkv',
      ffprobeImpl: async () => truehdProbe(),
    });
    await loopOnce();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'mp4_audio_codec_incompatible' }),
      expect.any(String),
    );
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'mp4_fallback_to_mkv' }),
      expect.any(String),
    );
    const job = jobRepo.findById(jobId);
    expect(job?.status).toBe('failed');
    expect(job?.error_msg).toContain('mp4_audio_codec_incompatible');
  });

  it('test_explicit_mp4_when_subrip_subs_then_dropIncompatibleSubtitles_true_no_fallback', async () => {
    await setupDispatch({
      setting: 'mp4',
      filename: 'movie.mkv',
      ffprobeImpl: async () => aacWithSubripProbe(),
    });
    await loopOnce();

    const callArgs = runEncodeSpy.mock.calls[0]?.[0];
    expect(callArgs?.outputContainer).toBe('mp4');
    expect(callArgs?.dropIncompatibleSubtitles).toBe(true);
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'mp4_fallback_to_mkv' }),
      expect.any(String),
    );
  });

  it('test_explicit_mp4_when_ffprobe_null_then_preflight_unavailable_no_fallback', async () => {
    await setupDispatch({
      setting: 'mp4',
      filename: 'movie.mkv',
      ffprobeImpl: async () => null,
    });
    await loopOnce();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'mp4_preflight_ffprobe_unavailable' }),
      expect.any(String),
    );
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'mp4_fallback_to_mkv' }),
      expect.any(String),
    );
    expect(runEncodeSpy.mock.calls[0]?.[0]?.outputContainer).toBe('mp4');
  });
});

describe('orchestrator — 05-15 cleanup paths under match-source (AC-11)', () => {
  it('test_skipActive_under_match_source_default_suffix_unlinks_BOTH_mkv_AND_mp4', async () => {
    const { jobId, sourcePath } = await setupDispatch({
      setting: 'match-source',
      filename: 'movie.mp4',
      ffprobeImpl: async () => cleanAacProbe(),
    });
    // Force-set job to 'encoding' status so skipActive cleanup branch runs
    // (mirrors orchestrator-skip-active.test.ts pattern).
    db.prepare("UPDATE job SET status='encoding' WHERE id=?").run(jobId);
    db.prepare("UPDATE file SET status='encoding', version=version+1 WHERE id=?").run(
      (jobRepo.findById(jobId) as { file_id: number }).file_id,
    );

    await skipActive(jobId, 'test-actor');

    const dir = path.dirname(sourcePath);
    const base = path.basename(sourcePath, path.extname(sourcePath));
    const expectedMkv = path.join(dir, `${base}.x265.mkv`);
    const expectedMp4 = path.join(dir, `${base}.x265.mp4`);
    const calledPaths = unlinkSidecarTmpSpy.mock.calls.map((c) => String(c[0]));
    expect(calledPaths).toContain(expectedMkv);
    expect(calledPaths).toContain(expectedMp4);
  });

  it('test_skipActive_under_match_source_legacy_custom_suffix_short_circuits_to_single', async () => {
    settingRepo.set('output_suffix', '.encoded.mkv');
    const { jobId, sourcePath } = await setupDispatch({
      setting: 'match-source',
      filename: 'movie.mp4',
      ffprobeImpl: async () => cleanAacProbe(),
    });
    settingRepo.set('output_suffix', '.encoded.mkv');
    db.prepare("UPDATE job SET status='encoding' WHERE id=?").run(jobId);
    db.prepare("UPDATE file SET status='encoding', version=version+1 WHERE id=?").run(
      (jobRepo.findById(jobId) as { file_id: number }).file_id,
    );

    await skipActive(jobId, 'test-actor');

    const dir = path.dirname(sourcePath);
    const base = path.basename(sourcePath, path.extname(sourcePath));
    const expectedCustom = path.join(dir, `${base}.encoded.mkv`);
    const calledPaths = unlinkSidecarTmpSpy.mock.calls.map((c) => String(c[0]));
    expect(calledPaths).toEqual([expectedCustom]);
    expect(calledPaths).not.toContain(path.join(dir, `${base}.x265.mkv`));
    expect(calledPaths).not.toContain(path.join(dir, `${base}.x265.mp4`));
  });

  it('test_skipActive_under_explicit_mp4_default_suffix_single_mp4_only', async () => {
    const { jobId, sourcePath } = await setupDispatch({
      setting: 'mp4',
      filename: 'movie.mkv',
      ffprobeImpl: async () => cleanAacProbe(),
    });
    db.prepare("UPDATE job SET status='encoding' WHERE id=?").run(jobId);
    db.prepare("UPDATE file SET status='encoding', version=version+1 WHERE id=?").run(
      (jobRepo.findById(jobId) as { file_id: number }).file_id,
    );

    await skipActive(jobId, 'test-actor');

    const dir = path.dirname(sourcePath);
    const base = path.basename(sourcePath, path.extname(sourcePath));
    // 16-05 audit M4: explicit container × default suffix now cleans BOTH
    // default-styles for THAT container ('-x265.mp4' NEW + '.x265.mp4'
    // LEGACY). Sibling '.x265.mkv' / '-x265.mkv' for the other container
    // is correctly NOT swept (cross-container leakage would be a bug).
    const expectedNewMp4 = path.join(dir, `${base}-x265.mp4`);
    const expectedLegacyMp4 = path.join(dir, `${base}.x265.mp4`);
    const calledPaths = unlinkSidecarTmpSpy.mock.calls.map((c) => String(c[0]));
    expect(calledPaths).toEqual([expectedNewMp4, expectedLegacyMp4]);
    expect(calledPaths).not.toContain(path.join(dir, `${base}.x265.mkv`));
    expect(calledPaths).not.toContain(path.join(dir, `${base}-x265.mkv`));
  });

  it('test_cancelAllQueued_under_match_source_cleanup_calls_BOTH_suffixes_per_encoding_job', async () => {
    const { jobId, sourcePath } = await setupDispatch({
      setting: 'match-source',
      filename: 'movie.mp4',
      ffprobeImpl: async () => cleanAacProbe(),
    });
    db.prepare("UPDATE job SET status='encoding' WHERE id=?").run(jobId);
    db.prepare("UPDATE file SET status='encoding', version=version+1 WHERE id=?").run(
      (jobRepo.findById(jobId) as { file_id: number }).file_id,
    );

    await cancelAllQueued('test-actor');

    const dir = path.dirname(sourcePath);
    const base = path.basename(sourcePath, path.extname(sourcePath));
    const calledPaths = unlinkSidecarTmpSpy.mock.calls.map((c) => String(c[0]));
    expect(calledPaths).toContain(path.join(dir, `${base}.x265.mkv`));
    expect(calledPaths).toContain(path.join(dir, `${base}.x265.mp4`));
  });
});

describe('orchestrator — 05-15 sidecar V2 outcome.path mirrors effective container (AC-13)', () => {
  it('test_match_source_clean_mp4_then_writeSidecar_called_with_x265_mp4_path', async () => {
    const { sourcePath } = await setupDispatch({
      setting: 'match-source',
      filename: 'clean.mp4',
      ffprobeImpl: async () => cleanAacProbe(),
    });
    await loopOnce();

    expect(writeSidecarSpy).toHaveBeenCalled();
    const sidecarCall = writeSidecarSpy.mock.calls[0];
    const sidecarPath = String(sidecarCall?.[0] ?? '');
    expect(sidecarPath).toContain('.x265.mp4');
    expect(sidecarPath.endsWith('.x265.mp4')).toBe(true);
    const payload = sidecarCall?.[1] as { output?: { filename?: string } } | undefined;
    expect(payload?.output?.filename).toMatch(/\.x265\.mp4$/);
    expect(sidecarPath).toContain(path.basename(sourcePath, '.mp4'));
  });

  it('test_match_source_audio_fallback_then_writeSidecar_called_with_x265_mkv_path', async () => {
    await setupDispatch({
      setting: 'match-source',
      filename: 'fallback.mp4',
      ffprobeImpl: async () => truehdProbe(),
    });
    await loopOnce();

    expect(writeSidecarSpy).toHaveBeenCalled();
    const sidecarCall = writeSidecarSpy.mock.calls[0];
    const sidecarPath = String(sidecarCall?.[0] ?? '');
    expect(sidecarPath.endsWith('.x265.mkv')).toBe(true);
    const payload = sidecarCall?.[1] as { output?: { filename?: string } } | undefined;
    expect(payload?.output?.filename).toMatch(/\.x265\.mkv$/);
  });
});

// 16-05 AC-5 + AC-7: NEW-default '-x265' path through resolveOutputSuffix.
// Asserts that an install on the post-migration default produces filenames
// in the infix-label style (movie-x265.{mkv|mp4}) for each container
// resolution path: match-source mp4 source, match-source other source,
// explicit mp4 container. The LEGACY-default branch is covered byte-
// identically by the pre-existing describes above (setup default
// `.x265.mkv`).
describe('orchestrator — 16-05 NEW-default output_suffix=-x265 (AC-5 + AC-7)', () => {
  it('match-source × mp4 source × -x265 default → output endsWith -x265.mp4', async () => {
    await setupDispatch({
      setting: 'match-source',
      filename: 'movie.mp4',
      outputSuffix: '-x265',
    });
    await loopOnce();
    expect(writeSidecarSpy).toHaveBeenCalled();
    const sidecarPath = String(writeSidecarSpy.mock.calls[0]?.[0] ?? '');
    // sidecar path is <output>.x265-butler.json; strip the suffix to get
    // the resolved final-output path.
    const finalOutput = sidecarPath.replace(/\.x265-butler\.json$/, '');
    expect(finalOutput.endsWith('-x265.mp4')).toBe(true);
  });

  it('match-source × mkv source × -x265 default → output endsWith -x265.mkv', async () => {
    await setupDispatch({
      setting: 'match-source',
      filename: 'movie.mkv',
      outputSuffix: '-x265',
    });
    await loopOnce();
    expect(writeSidecarSpy).toHaveBeenCalled();
    const sidecarPath = String(writeSidecarSpy.mock.calls[0]?.[0] ?? '');
    const finalOutput = sidecarPath.replace(/\.x265-butler\.json$/, '');
    expect(finalOutput.endsWith('-x265.mkv')).toBe(true);
  });

  it('explicit mp4 × -x265 default → output endsWith -x265.mp4', async () => {
    await setupDispatch({
      setting: 'mp4',
      filename: 'movie.mp4',
      outputSuffix: '-x265',
    });
    await loopOnce();
    expect(writeSidecarSpy).toHaveBeenCalled();
    const sidecarPath = String(writeSidecarSpy.mock.calls[0]?.[0] ?? '');
    const finalOutput = sidecarPath.replace(/\.x265-butler\.json$/, '');
    expect(finalOutput.endsWith('-x265.mp4')).toBe(true);
  });

  // AC-7: operator-customized × container-aware composition. Pre-16-05 latent
  // bug — label-style ALWAYS appended .mkv regardless of container. 16-05
  // fix: container-aware bare extension for label-style customs.
  it('operator-customized _h265 × mp4 → output endsWith _h265.mp4 (closes pre-16-05 latent bug)', async () => {
    await setupDispatch({
      setting: 'mp4',
      filename: 'movie.mp4',
      outputSuffix: '_h265',
    });
    await loopOnce();
    expect(writeSidecarSpy).toHaveBeenCalled();
    const sidecarPath = String(writeSidecarSpy.mock.calls[0]?.[0] ?? '');
    const finalOutput = sidecarPath.replace(/\.x265-butler\.json$/, '');
    expect(finalOutput.endsWith('_h265.mp4')).toBe(true);
  });
});
