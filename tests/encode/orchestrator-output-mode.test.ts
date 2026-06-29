// 26-02 (F5): orchestrator output_mode=replace — trash-original-first →
// atomic-rename, hardlink guard (dispatch + commit TOCTOU), AC-11 no-unlink
// invariant, AC-12 commit-failure-after-trash, S2 default-dep guard. Mirrors
// the match-source dispatch-test harness (real staging spread + spies).

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
let unlinkSyncSpy: ReturnType<typeof vi.fn>;
let callOrder: string[];
// 35-01: capture the opts the production runEncode received (to assert opts.crop).
let lastEncodeOpts: EncodeOptions | null;

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
    container: 'mkv',
    last_scanned_at: 1_700_000_500,
    share_id: null,
  });
  return { id: row.id, path: row.path };
}

const cleanProbe = (): ProbeResult => ({
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
  filename?: string;
  outputMode?: 'suffix' | 'replace';
  deleteOriginal?: boolean;
  outputSize?: number;
  // nlink sequence for deps.fs.statSync(file.path). One value per call (dispatch,
  // then commit re-probe). Last value sticks. Default [1,1] = normal replace.
  nlinkSeq?: number[];
  // override commitOutput to throw (AC-12).
  commitThrows?: boolean;
  // 33-02: operator-configurable trash root (sets the trash_path setting).
  trashPath?: string;
  // 33-02 (AC-9): force trashOriginal to throw a non-EXDEV error.
  trashThrows?: boolean;
  // 35-01: auto-crop settings + injected detectCrop.
  autoCrop?: boolean;
  cropOverride?: string;
  detectCrop?: (input: string, deps?: unknown) => Promise<string | null>;
  // 43-01: force-10bit setting (force_10bit). undefined → unset = byte-identical pre-43.
  force10bit?: boolean;
  // 43-03: color-passthrough setting (color_passthrough). undefined → unset = byte-identical.
  colorPassthrough?: boolean;
  // 43-03: when set, the injected source ffprobe reports these HDR VUI color tags
  // (exercises the pure-MKV passthrough seam AC-7).
  withSourceColor?: boolean;
  // 43-04: when set, the injected source ffprobe reports HDR10 static metadata
  // (exercises the pure-MKV HDR10 passthrough seam AC-7 + hdr10Present AC-9).
  withSourceHdr10?: boolean;
};

function setupReplace({
  filename = 'movie.mkv',
  outputMode = 'replace',
  deleteOriginal = false,
  outputSize = 600_000,
  nlinkSeq = [1, 1],
  commitThrows = false,
  trashPath,
  trashThrows = false,
  autoCrop,
  cropOverride,
  detectCrop,
  force10bit,
  colorPassthrough,
  withSourceColor,
  withSourceHdr10,
}: SetupOpts = {}): { fileId: number; jobId: number; sourcePath: string } {
  const sourcePath = path.join(mediaRoot, filename);
  fs.writeFileSync(sourcePath, Buffer.alloc(1_000_000, 'x'));
  const file = seedFile(sourcePath, 1_000_000);
  const job = jobRepo.create({ file_id: file.id, encoder: 'libx265', crf: null });
  if (!job) throw new Error('failed to create job');

  settingRepo.set('cache_pool_path', stageRoot);
  settingRepo.set('default_crf', '23');
  settingRepo.set('min_savings_percent', '5');
  settingRepo.set('trash_retention_days', '30');
  settingRepo.set('output_mode', outputMode);
  settingRepo.set('delete_original_after_encode', deleteOriginal ? 'true' : 'false');
  if (trashPath !== undefined) settingRepo.set('trash_path', trashPath);
  if (autoCrop !== undefined) settingRepo.set('auto_crop', autoCrop ? 'true' : 'false');
  if (cropOverride !== undefined) settingRepo.set('crop_override', cropOverride);
  if (force10bit !== undefined) settingRepo.set('force_10bit', force10bit ? 'true' : 'false');
  if (colorPassthrough !== undefined)
    settingRepo.set('color_passthrough', colorPassthrough ? 'true' : 'false');

  // Per-call nlink sequence — file.path stats return the scripted nlink; any
  // other path (stage output verify-stat) delegates to the real fs.statSync.
  let statCall = 0;
  const statSyncStub = ((p: fs.PathLike) => {
    if (String(p) === sourcePath) {
      const n = nlinkSeq[Math.min(statCall, nlinkSeq.length - 1)];
      statCall += 1;
      const real = fs.statSync(sourcePath);
      return { ...real, nlink: n } as fs.Stats;
    }
    return fs.statSync(p);
  }) as typeof fs.statSync;

  const commitOutputSpy = vi.fn((a: string, b: string) => {
    callOrder.push('commit');
    if (commitThrows) throw new Error('ENOSPC simulated commit failure');
    return realStaging.commitOutput(a, b);
  });
  const trashOriginalSpy = vi.fn((a: string, b: string) => {
    callOrder.push('trash');
    if (trashThrows) throw new Error('EACCES simulated trash move failure');
    return realStaging.trashOriginal(a, b);
  });

  __forTests_setDeps({
    runEncode: (async (opts: EncodeOptions) => {
      lastEncodeOpts = opts;
      fs.writeFileSync(opts.output, Buffer.alloc(outputSize, 'y'));
      return { exitCode: 0, durationMs: 30_000, logTail: '' } satisfies EncodeResult;
    }) as unknown as (opts: EncodeOptions) => Promise<EncodeResult>,
    ...(detectCrop ? { detectCrop: detectCrop as never } : {}),
    ffprobe: (async () => ({
      ...cleanProbe(),
      ...(withSourceColor
        ? {
            color: {
              space: 'bt2020nc',
              primaries: 'bt2020',
              transfer: 'smpte2084',
              range: 'tv',
            },
          }
        : {}),
      ...(withSourceHdr10
        ? {
            hdr10: {
              masterDisplay:
                'G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50)',
              maxCll: '1000,400',
            },
          }
        : {}),
    })) as never,
    fs: {
      statSync: statSyncStub as never,
      statfsSync: (() => ({ bavail: BigInt(100_000_000), bsize: BigInt(1) }) as never) as never,
      accessSync: fs.accessSync,
      existsSync: ((p: fs.PathLike) => fs.existsSync(String(p))) as never,
      unlinkSync: unlinkSyncSpy as never,
    },
    fileRepo: () => fileRepo,
    jobRepo: () => jobRepo,
    settingRepo: () => settingRepo,
    trashRepo: () => trashRepo,
    logger: { info: logSpy, warn: warnSpy, error: errorSpy, debug: debugSpy } as never,
    now: () => NOW_SECONDS,
    staging: {
      ...realStaging,
      commitOutput: commitOutputSpy as never,
      trashOriginal: trashOriginalSpy as never,
      unlinkSidecarTmpAt: (async () => undefined) as never,
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
  stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-orch-om-stage-'));
  mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-orch-om-media-'));
  logSpy = vi.fn();
  warnSpy = vi.fn();
  errorSpy = vi.fn();
  debugSpy = vi.fn();
  unlinkSyncSpy = vi.fn();
  callOrder = [];
  lastEncodeOpts = null;
});

afterEach(async () => {
  await __forTests_resetOrchestrator();
  db.close();
  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.rmSync(mediaRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('orchestrator — output_mode=replace (26-02 F5)', () => {
  // AC-3 + AC-6: same-ext true overwrite, trash-FIRST then rename, ordering safe.
  it('test_replace_same_ext_trashes_original_first_then_commits_into_original_path', async () => {
    const { fileId, jobId, sourcePath } = setupReplace({ filename: 'movie.mkv' });
    await loopOnce();

    // AC-6 ordering invariant: trash BEFORE commit (never a both-gone window).
    expect(callOrder).toEqual(['trash', 'commit']);

    // Output committed at the EXACT original path (same-ext replace), no -x265.
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(sourcePath.endsWith('movie.mkv')).toBe(true);
    expect(fs.readFileSync(sourcePath).length).toBe(600_000); // the encoded output

    // Original recoverable via a trash row.
    const trash = db.prepare('SELECT * FROM trash_entry').all() as { trash_path: string }[];
    expect(trash).toHaveLength(1);
    expect(fs.existsSync(trash[0].trash_path)).toBe(true);

    expect(fileRepo.getById(fileId)?.status).toBe('done-smaller');
    const job = db.prepare('SELECT status FROM job WHERE id = ?').get(jobId) as { status: string };
    expect(job.status).toBe('done');
  });

  // AC-4: extension-change avi→mkv writes the bare-ext basename, no -x265.
  it('test_replace_diff_ext_writes_bare_basename_no_suffix', async () => {
    const { sourcePath } = setupReplace({ filename: 'movie.avi' });
    await loopOnce();

    const mkvPath = path.join(mediaRoot, 'movie.mkv');
    expect(fs.existsSync(mkvPath)).toBe(true);
    expect(fs.existsSync(sourcePath)).toBe(false); // original avi trashed
    expect(fs.existsSync(path.join(mediaRoot, 'movie-x265.mkv'))).toBe(false);
    const trash = db.prepare('SELECT * FROM trash_entry').all();
    expect(trash).toHaveLength(1);
  });

  // AC-5: hardlinked source (nlink>1 at dispatch) → suffix fallback, ORIGINAL
  // LEFT INTACT (not trashed, not renamed-over), single warn, zero data-loss.
  it('test_replace_hardlinked_source_falls_back_to_suffix_and_keeps_original', async () => {
    const { sourcePath } = setupReplace({ filename: 'movie.mkv', nlinkSeq: [2, 2] });
    await loopOnce();

    // Output at the -x265 sibling; original untouched.
    expect(fs.existsSync(path.join(mediaRoot, 'movie-x265.mkv'))).toBe(true);
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.readFileSync(sourcePath).length).toBe(1_000_000); // still the original bytes

    // No trash row; never unlinked.
    expect(db.prepare('SELECT * FROM trash_entry').all()).toHaveLength(0);
    expect(callOrder).not.toContain('trash');
    expect(unlinkSyncSpy).not.toHaveBeenCalled();

    // Single replace_skipped_hardlink warn (reason: dispatch).
    const warns = warnSpy.mock.calls.filter(
      (c) => c[0]?.action === 'replace_skipped_hardlink' && c[0]?.reason === 'dispatch',
    );
    expect(warns).toHaveLength(1);
  });

  // S1: hardlink created DURING encode (nlink=1 at dispatch, 2 at commit) →
  // commit-step TOCTOU re-probe degrades to suffix + leaves original intact.
  it('test_replace_toctou_hardlink_at_commit_degrades_to_suffix_keeps_original', async () => {
    // statSync(file.path) call sequence: [0]=source-size, [1]=dispatch nlink
    // probe (1 → replace proceeds), [2]=commit re-probe (2 → TOCTOU degrade).
    const { sourcePath } = setupReplace({ filename: 'movie.mkv', nlinkSeq: [1, 1, 2] });
    await loopOnce();

    expect(fs.existsSync(path.join(mediaRoot, 'movie-x265.mkv'))).toBe(true);
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(callOrder).toEqual(['commit']); // committed to suffix, never trashed
    expect(unlinkSyncSpy).not.toHaveBeenCalled();
    const warns = warnSpy.mock.calls.filter(
      (c) => c[0]?.action === 'replace_skipped_hardlink' && c[0]?.reason === 'commit_toctou',
    );
    expect(warns).toHaveLength(1);
  });

  // AC-11: replace IGNORES delete_original_after_encode — trashes, NEVER unlinks.
  it('test_replace_with_delete_original_true_trashes_and_never_unlinks_file_path', async () => {
    const { sourcePath } = setupReplace({ filename: 'movie.mkv', deleteOriginal: true });
    await loopOnce();

    // Trash row exists (recoverable) and unlinkSync was NEVER called on file.path.
    expect(db.prepare('SELECT * FROM trash_entry').all()).toHaveLength(1);
    const unlinkedPaths = unlinkSyncSpy.mock.calls.map((c) => String(c[0]));
    expect(unlinkedPaths).not.toContain(sourcePath);
    expect(callOrder).toEqual(['trash', 'commit']);
  });

  // AC-12: commit throws AFTER trash → dedicated error log + failJob + trash row
  // intact (recoverable). No fragile rollback; generic terminal not the only signal.
  it('test_replace_commit_failure_after_trash_logs_dedicated_error_and_keeps_trash_row', async () => {
    const { fileId, jobId, sourcePath } = setupReplace({
      filename: 'movie.mkv',
      commitThrows: true,
    });
    await loopOnce();

    // Trash-first happened, commit threw.
    expect(callOrder).toEqual(['trash', 'commit']);
    // Original is in trash (recoverable), original path now empty.
    expect(fs.existsSync(sourcePath)).toBe(false);
    const trash = db.prepare('SELECT * FROM trash_entry').all() as { trash_path: string }[];
    expect(trash).toHaveLength(1);
    expect(fs.existsSync(trash[0].trash_path)).toBe(true);

    // Dedicated forensic error BEFORE failJob.
    const errs = errorSpy.mock.calls.filter(
      (c) => c[0]?.action === 'replace_commit_failed_original_trashed',
    );
    expect(errs).toHaveLength(1);
    expect(errs[0][0].originalPath).toBe(sourcePath);
    expect(errs[0][0].trashId).toBeTruthy();

    // Job failed; never unlinked anything.
    const job = db.prepare('SELECT status FROM job WHERE id = ?').get(jobId) as { status: string };
    expect(job.status).toBe('failed');
    expect(fileRepo.getById(fileId)?.status).toBe('failed');
    expect(unlinkSyncSpy).not.toHaveBeenCalled();
  });

  // AC-1 sentinel (in this harness): suffix mode (default) is unaffected —
  // sibling at -x265, original trashed, no replace ordering.
  it('test_suffix_mode_unchanged_sibling_and_trash', async () => {
    const { sourcePath } = setupReplace({ filename: 'movie.mkv', outputMode: 'suffix' });
    await loopOnce();

    expect(fs.existsSync(path.join(mediaRoot, 'movie-x265.mkv'))).toBe(true);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(callOrder).toEqual(['commit', 'trash']); // suffix: commit FIRST, then trash
    expect(db.prepare('SELECT * FROM trash_entry').all()).toHaveLength(1);
  });

  // 33-02 AC-7: a configured trash_path routes the trash subtree under THAT
  // root (settings.trashPath threaded into trashPathFor), not the cache
  // stageRoot — covered for BOTH the replace and suffix branches.
  it('test_replace_routes_trash_under_configured_trash_path_33_02', async () => {
    const trashRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-trash-array-'));
    try {
      setupReplace({ filename: 'movie.mkv', trashPath: trashRoot });
      await loopOnce();
      const trash = db.prepare('SELECT * FROM trash_entry').all() as { trash_path: string }[];
      expect(trash).toHaveLength(1);
      expect(trash[0].trash_path.startsWith(path.join(trashRoot, 'trash'))).toBe(true);
      expect(fs.existsSync(trash[0].trash_path)).toBe(true);
    } finally {
      fs.rmSync(trashRoot, { recursive: true, force: true });
    }
  });

  it('test_suffix_routes_trash_under_configured_trash_path_33_02', async () => {
    const trashRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-trash-array-'));
    try {
      setupReplace({ filename: 'movie.mkv', outputMode: 'suffix', trashPath: trashRoot });
      await loopOnce();
      const trash = db.prepare('SELECT * FROM trash_entry').all() as { trash_path: string }[];
      expect(trash).toHaveLength(1);
      expect(trash[0].trash_path.startsWith(path.join(trashRoot, 'trash'))).toBe(true);
    } finally {
      fs.rmSync(trashRoot, { recursive: true, force: true });
    }
  });

  // 33-02 AC-9 (SR-1): a non-EXDEV trashOriginal failure emits a DEDICATED
  // trash_move_failed diagnostic naming the resolved trashPath, the job fails,
  // and in replace-mode the original is left intact (trash-FIRST ordering).
  it('test_replace_trash_move_failure_logs_dedicated_error_and_keeps_original', async () => {
    const { fileId, jobId, sourcePath } = setupReplace({
      filename: 'movie.mkv',
      trashThrows: true,
    });
    await loopOnce();

    // Trash attempted, threw BEFORE commit → commit never reached.
    expect(callOrder).toEqual(['trash']);
    // Replace-mode trash-FIRST: original untouched, no trash row persisted.
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(db.prepare('SELECT * FROM trash_entry').all()).toHaveLength(0);

    // Dedicated forensic error naming the resolved trashPath.
    const errs = errorSpy.mock.calls.filter((c) => c[0]?.action === 'trash_move_failed');
    expect(errs).toHaveLength(1);
    expect(errs[0][0].originalPath).toBe(sourcePath);
    expect(typeof errs[0][0].trashPath).toBe('string');
    expect(errs[0][0].err).toContain('EACCES');

    // Job failed; never unlinked anything.
    const job = db.prepare('SELECT status FROM job WHERE id = ?').get(jobId) as { status: string };
    expect(job.status).toBe('failed');
    expect(fileRepo.getById(fileId)?.status).toBe('failed');
    expect(unlinkSyncSpy).not.toHaveBeenCalled();
  });
});

// S2: the default deps.staging must expose replaceOutputPathFor (else processOne
// throws "is not a function" — the exact 26-01 widening failure mode).
describe('orchestrator — replace dep wiring (26-02 S2)', () => {
  it('test_default_staging_exposes_replaceOutputPathFor', () => {
    expect(typeof realStaging.replaceOutputPathFor).toBe('function');
  });
});

// 36-01: the source-keyed central sidecar write (done-smaller) is guarded
// effectiveMode==='suffix'. replace mode must NOT trigger it; the hardlink
// degrade (replace→suffix, replaceHardlinkFallback=true) MUST keep triggering it
// even with delete_original_after_encode=true (override precedence :2047>:2058).
describe('orchestrator — 36-01 source-keyed central sidecar guard (output mode)', () => {
  function centralFor(centralRoot: string, absPath: string): string {
    return `${path.join(centralRoot, absPath.replace(/^\/+/, ''))}.x265-butler.json`;
  }
  function sourceKeyedWrittenLog() {
    return logSpy.mock.calls.find((c) => c[0]?.action === 'source_sidecar_written');
  }

  // AC-3: central + done-smaller + effectiveMode='replace' (diff-ext true replace,
  // distinct source/output paths) → ONLY the output-keyed central sidecar; NO
  // source-keyed write, NO breadcrumb.
  it('replace (diff-ext) writes ONLY the output-keyed central sidecar, no source-keyed (AC-3)', async () => {
    const centralRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-central-om-'));
    try {
      const { sourcePath } = setupReplace({ filename: 'movie.avi', outputMode: 'replace' });
      settingRepo.set('sidecar_mode', 'central');
      settingRepo.set('sidecar_central_path', centralRoot);
      await loopOnce();

      const outputPath = path.join(mediaRoot, 'movie.mkv'); // diff-ext replace target
      expect(fs.existsSync(centralFor(centralRoot, outputPath))).toBe(true); // output-keyed
      expect(fs.existsSync(centralFor(centralRoot, sourcePath))).toBe(false); // NO source-keyed
      expect(sourceKeyedWrittenLog()).toBeUndefined();
    } finally {
      fs.rmSync(centralRoot, { recursive: true, force: true });
    }
  });

  // AC-7 companion: delete_original_after_encode=true BUT a hardlinked source
  // degrades replace→suffix with replaceHardlinkFallback=true → the source is KEPT
  // (override precedence) → the source-keyed write STILL fires (AC-1 path).
  it('hardlink-degrade keeps source despite delete_original → source-keyed sidecar STILL written (AC-7 companion)', async () => {
    const centralRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-central-om-'));
    try {
      const { sourcePath } = setupReplace({
        filename: 'movie.mkv',
        outputMode: 'replace',
        nlinkSeq: [2, 2], // hardlinked → replace degrades to suffix, source kept
        deleteOriginal: true, // overridden by the hardlink fallback (:2047 > :2058)
      });
      settingRepo.set('sidecar_mode', 'central');
      settingRepo.set('sidecar_central_path', centralRoot);
      await loopOnce();

      // Degrade output sits at the -x265 sibling; source kept at its original path.
      expect(fs.existsSync(centralFor(centralRoot, sourcePath))).toBe(true); // source-keyed fired
      const log = sourceKeyedWrittenLog();
      expect(log).toBeTruthy();
      expect(log?.[0].sourcePath).toBe(sourcePath);
    } finally {
      fs.rmSync(centralRoot, { recursive: true, force: true });
    }
  });
});

describe('orchestrator — 35-01 auto-crop dispatch resolve', () => {
  function infoActions(): string[] {
    return logSpy.mock.calls
      .map((c) => (c[0] as { action?: string })?.action)
      .filter(Boolean) as string[];
  }
  function warnActions(): string[] {
    return warnSpy.mock.calls
      .map((c) => (c[0] as { action?: string })?.action)
      .filter(Boolean) as string[];
  }

  it('AC-1: auto_crop off + override empty → opts.crop undefined (byte-identical)', async () => {
    setupReplace({ autoCrop: false, cropOverride: '' });
    await loopOnce();
    expect(lastEncodeOpts?.crop).toBeUndefined();
    expect(infoActions()).not.toContain('crop_applied');
  });

  it('AC-2 + AC-8: auto_crop on + detectCrop geometry → opts.crop set + crop_applied logged', async () => {
    const detectCrop = vi.fn(async () => '1920:800:0:140');
    setupReplace({ autoCrop: true, detectCrop });
    await loopOnce();
    expect(detectCrop).toHaveBeenCalledOnce();
    expect(lastEncodeOpts?.crop).toBe('1920:800:0:140');
    expect(infoActions()).toContain('crop_applied');
  });

  it('AC-4: cropdetect full-frame result (== source dims) → opts.crop undefined, NO -vf', async () => {
    // seedFile is 1920x1080; a no-bars source makes cropdetect print the full frame.
    const detectCrop = vi.fn(async () => '1920:1080:0:0');
    setupReplace({ autoCrop: true, detectCrop });
    await loopOnce();
    expect(detectCrop).toHaveBeenCalledOnce();
    expect(lastEncodeOpts?.crop).toBeUndefined();
    expect(infoActions()).not.toContain('crop_applied');
  });

  it('AC-3: valid crop_override wins → detectCrop NOT called + opts.crop = override', async () => {
    const detectCrop = vi.fn(async () => '1920:800:0:140');
    setupReplace({ autoCrop: true, cropOverride: '1280:536:0:92', detectCrop });
    await loopOnce();
    expect(detectCrop).not.toHaveBeenCalled();
    expect(lastEncodeOpts?.crop).toBe('1280:536:0:92');
    expect(infoActions()).toContain('crop_applied');
  });

  it('AC-5: invalid odd-dim override → warn crop_override_invalid + uncropped', async () => {
    const detectCrop = vi.fn(async () => null);
    setupReplace({ autoCrop: false, cropOverride: '1921:800:0:0', detectCrop });
    await loopOnce();
    expect(warnActions()).toContain('crop_override_invalid');
    expect(lastEncodeOpts?.crop).toBeUndefined();
  });
});

describe('orchestrator — 43-01 force-10bit dispatch + audit-trail (AC-6/AC-9)', () => {
  // The dispatch_preset_resolved log is keyed by MESSAGE (c[1]), not action.
  function dispatchPresetResolvedPayload(): { force10bit?: boolean } | undefined {
    const call = logSpy.mock.calls.find((c) => c[1] === 'dispatch_preset_resolved');
    return call?.[0] as { force10bit?: boolean } | undefined;
  }

  it('AC-6: force_10bit unset → opts.force10bit false (byte-identical pre-43)', async () => {
    setupReplace({});
    await loopOnce();
    expect(lastEncodeOpts?.force10bit).toBe(false);
    expect(dispatchPresetResolvedPayload()?.force10bit).toBe(false);
  });

  it('AC-6: force_10bit=false → opts.force10bit false', async () => {
    setupReplace({ force10bit: false });
    await loopOnce();
    expect(lastEncodeOpts?.force10bit).toBe(false);
    expect(dispatchPresetResolvedPayload()?.force10bit).toBe(false);
  });

  it('AC-9: force_10bit=true → opts.force10bit true + dispatch log carries force10bit:true', async () => {
    setupReplace({ force10bit: true });
    await loopOnce();
    expect(lastEncodeOpts?.force10bit).toBe(true);
    expect(dispatchPresetResolvedPayload()?.force10bit).toBe(true);
  });
});

describe('orchestrator — 43-03 color-passthrough dispatch + audit-trail (AC-7/AC-9)', () => {
  function dispatchPresetResolvedPayload(): { colorPassthrough?: boolean } | undefined {
    const call = logSpy.mock.calls.find((c) => c[1] === 'dispatch_preset_resolved');
    return call?.[0] as { colorPassthrough?: boolean } | undefined;
  }

  it('AC-7: color_passthrough OFF → opts.color undefined (byte-identical, pure-MKV)', async () => {
    setupReplace({ withSourceColor: true });
    await loopOnce();
    expect(lastEncodeOpts?.color).toBeUndefined();
    expect(dispatchPresetResolvedPayload()?.colorPassthrough).toBe(false);
  });

  it('AC-7: color_passthrough ON + pure-MKV source → opts.color from mkvSourceProbe (NOT preflightSourceProbe-null)', async () => {
    setupReplace({ colorPassthrough: true, withSourceColor: true });
    await loopOnce();
    // movie.mkv is the pure-MKV path where preflightSourceProbe stays null (MH-2).
    // Color must still reach EncodeOptions via the separate sourceColor field.
    expect(lastEncodeOpts?.color).toEqual({
      space: 'bt2020nc',
      primaries: 'bt2020',
      transfer: 'smpte2084',
      range: 'tv',
    });
  });

  it('AC-9: color_passthrough ON → dispatch log carries colorPassthrough:true', async () => {
    setupReplace({ colorPassthrough: true, withSourceColor: true });
    await loopOnce();
    expect(dispatchPresetResolvedPayload()?.colorPassthrough).toBe(true);
  });
});

describe('orchestrator — 43-04 HDR10 dual-path dispatch + audit-trail (AC-7/AC-9)', () => {
  const FULL_HDR10 = {
    masterDisplay: 'G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50)',
    maxCll: '1000,400',
  };
  // AC-9: hdr10Present lives on the EXISTING preflight_statfs_probe log (inside
  // runEncodeStage where sourceHdr10 is in scope) — NOT dispatch_preset_resolved.
  function preflightStatfsPayload(): { hdr10Present?: boolean } | undefined {
    const call = logSpy.mock.calls.find((c) => c[1] === 'preflight_statfs_probe');
    return call?.[0] as { hdr10Present?: boolean } | undefined;
  }

  it('AC-7: color_passthrough OFF → opts.hdr10 undefined + hdr10Present:false (byte-identical)', async () => {
    setupReplace({ withSourceHdr10: true });
    await loopOnce();
    expect(lastEncodeOpts?.hdr10).toBeUndefined();
    expect(preflightStatfsPayload()?.hdr10Present).toBe(false);
  });

  it('AC-7: color_passthrough ON + pure-MKV source → opts.hdr10 from mkvSourceProbe (NOT preflightSourceProbe-null)', async () => {
    setupReplace({ colorPassthrough: true, withSourceHdr10: true });
    await loopOnce();
    // movie.mkv is the pure-MKV path where preflightSourceProbe stays null (MH-2);
    // HDR10 must still reach EncodeOptions via the separate sourceHdr10 field.
    expect(lastEncodeOpts?.hdr10).toEqual(FULL_HDR10);
  });

  it('AC-9: color_passthrough ON + HDR10 source → preflight log carries hdr10Present:true', async () => {
    setupReplace({ colorPassthrough: true, withSourceHdr10: true });
    await loopOnce();
    expect(preflightStatfsPayload()?.hdr10Present).toBe(true);
  });

  it('AC-9: color_passthrough ON + SDR source (no HDR10) → hdr10Present:false', async () => {
    setupReplace({ colorPassthrough: true });
    await loopOnce();
    // sourceHdr10 is both-null (cleanProbe) → hdr10Present false even with gate ON.
    expect(lastEncodeOpts?.hdr10).toEqual({ masterDisplay: null, maxCll: null });
    expect(preflightStatfsPayload()?.hdr10Present).toBe(false);
  });
});

describe('orchestrator — 37-02 crop_no_op observability', () => {
  // crop_no_op surfaces the auto-crop "ran but applied no crop" outcome that
  // 35-01 dropped silently. Reason-tagged, exactly-one-per-job, parallel to
  // crop_applied. Pure observability ADD — resolve behavior unchanged.
  function cropNoOpEntries(): Array<{ reason?: string; detected?: string | null }> {
    return logSpy.mock.calls
      .map((c) => c[0] as { action?: string; reason?: string; detected?: string | null })
      .filter((o) => o?.action === 'crop_no_op')
      .map((o) => ({ reason: o.reason, detected: o.detected }));
  }
  function infoActions(): string[] {
    return logSpy.mock.calls
      .map((c) => (c[0] as { action?: string })?.action)
      .filter(Boolean) as string[];
  }
  function warnActions(): string[] {
    return warnSpy.mock.calls
      .map((c) => (c[0] as { action?: string })?.action)
      .filter(Boolean) as string[];
  }

  // 37-02 AC-1 + AC-7: no-bars full frame → exactly one crop_no_op reason:'full_frame'.
  it('AC-1: auto_crop on + cropdetect full frame → one crop_no_op reason full_frame, no crop_applied', async () => {
    // seedFile is 1920x1080; a no-bars source makes cropdetect print the full frame.
    const detectCrop = vi.fn(async () => '1920:1080:0:0');
    setupReplace({ autoCrop: true, cropOverride: '', detectCrop });
    await loopOnce();
    expect(detectCrop).toHaveBeenCalledOnce();
    expect(lastEncodeOpts?.crop).toBeUndefined();
    const entries = cropNoOpEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].reason).toBe('full_frame');
    expect(entries[0].detected).toBe('1920:1080:0:0');
    expect(infoActions()).not.toContain('crop_applied');
  });

  // 37-02 AC-2 + AC-7: detect null → exactly one crop_no_op reason:'inconclusive'.
  it('AC-2: auto_crop on + detectCrop null → one crop_no_op reason inconclusive', async () => {
    const detectCrop = vi.fn(async () => null);
    setupReplace({ autoCrop: true, cropOverride: '', detectCrop });
    await loopOnce();
    expect(detectCrop).toHaveBeenCalledOnce();
    expect(lastEncodeOpts?.crop).toBeUndefined();
    const entries = cropNoOpEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].reason).toBe('inconclusive');
    expect(entries[0].detected).toBeNull();
  });

  // 37-02 AC-3 + AC-7: real crop → crop_applied, ZERO crop_no_op (auto + override).
  it('AC-3: real sub-frame crop (auto) → crop_applied fires, crop_no_op count 0', async () => {
    const detectCrop = vi.fn(async () => '1920:800:0:140');
    setupReplace({ autoCrop: true, cropOverride: '', detectCrop });
    await loopOnce();
    expect(lastEncodeOpts?.crop).toBe('1920:800:0:140');
    expect(infoActions()).toContain('crop_applied');
    expect(cropNoOpEntries()).toHaveLength(0);
  });

  it('AC-3: valid crop_override wins → crop_applied, crop_no_op count 0', async () => {
    const detectCrop = vi.fn(async () => '1920:1080:0:0');
    setupReplace({ autoCrop: true, cropOverride: '1280:536:0:92', detectCrop });
    await loopOnce();
    expect(lastEncodeOpts?.crop).toBe('1280:536:0:92');
    expect(infoActions()).toContain('crop_applied');
    expect(cropNoOpEntries()).toHaveLength(0);
  });

  // 37-02 AC-4 + AC-7: auto_crop off + empty override → fully silent, detect not called.
  it('AC-4: auto_crop off + empty override → no crop_no_op, no crop_applied, detect not called', async () => {
    const detectCrop = vi.fn(async () => '1920:1080:0:0');
    setupReplace({ autoCrop: false, cropOverride: '', detectCrop });
    await loopOnce();
    expect(detectCrop).not.toHaveBeenCalled();
    expect(cropNoOpEntries()).toHaveLength(0);
    expect(infoActions()).not.toContain('crop_applied');
  });

  // 37-02 AC-6 + AC-7: malformed override + auto_crop ON → warn AND one crop_no_op co-fire.
  it('AC-6: malformed override + auto_crop on + full frame → crop_override_invalid warn AND one crop_no_op', async () => {
    const detectCrop = vi.fn(async () => '1920:1080:0:0');
    setupReplace({ autoCrop: true, cropOverride: 'garbage', detectCrop });
    await loopOnce();
    expect(detectCrop).toHaveBeenCalledOnce();
    expect(warnActions()).toContain('crop_override_invalid');
    const entries = cropNoOpEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].reason).toBe('full_frame');
    expect(lastEncodeOpts?.crop).toBeUndefined();
  });
});
