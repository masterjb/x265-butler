// @vitest-environment node
// Jobs that were running when the container went down come back at the front of
// the queue, whether the restart was a crash (rows still 'encoding' at boot) or
// an orderly stop (stopEncoderLoop). Repositories are the real ones on an
// in-memory database; the media files are real temp files so the source check
// compares against an actual stat.

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
import type { BlocklistRepo } from '@/src/lib/db/repos/blocklist';
import {
  __forTests_resetOrchestrator,
  __forTests_setDeps,
  loopOnce,
  startEncoderLoop,
  stopEncoderLoop,
} from '@/src/lib/encode/orchestrator';
import * as staging from '@/src/lib/encode/staging';
import { __forTests_resetCachePoolCooldowns } from '@/src/lib/encode/staging';
import { __forTests_resetStallDetectionCache } from '@/src/lib/encode/stall-watchdog';
import { isQueuePaused } from '@/src/lib/encode/pause-state';
import type { EncodeOptions, EncodeResult } from '@/src/lib/encode/ffmpeg';
import type { ProbeResult } from '@/src/lib/scan/ffprobe';
import type { DetectionResult } from '@/src/lib/encode/detection';
import { toScanMtime } from '@/src/lib/scan/walker';

type Db = InstanceType<typeof Database>;
type JobRowLite = {
  id: number;
  file_id: number;
  status: string;
  error_msg: string | null;
  queue_position: number;
};

let db: Db;
let fileRepo: FileRepo;
let jobRepo: JobRepo;
let settingRepo: SettingRepo;
let trashRepo: TrashRepo;
let stageRoot: string;
let mediaRoot: string;
let info: ReturnType<typeof vi.fn>;
let warn: ReturnType<typeof vi.fn>;
let blocked: Set<number>;
let encodeCalls: number;

function seedFile(name: string): { id: number; path: string } {
  const p = path.join(mediaRoot, name);
  fs.writeFileSync(p, Buffer.alloc(1000, 'x'));
  const st = fs.statSync(p);
  const row = fileRepo.upsertByPath({
    path: p,
    size_bytes: st.size,
    mtime: toScanMtime(st),
    content_hash: 'a'.repeat(64),
    codec: 'h264',
    bitrate: 1,
    duration_seconds: 60,
    width: 1920,
    height: 1080,
    container: 'mp4',
    last_scanned_at: 1_700_000_000,
    share_id: null,
  });
  return { id: row.id, path: row.path };
}

// A job that was running when the process died: claimed, file 'encoding'.
function runningJob(fileId: number, position: number): number {
  const j = jobRepo.create({ file_id: fileId, encoder: 'libx265', crf: null })!;
  db.prepare(
    "UPDATE job SET status='encoding', started_at=1700000000, queue_position=? WHERE id=?",
  ).run(position, j.id);
  const f = fileRepo.getById(fileId)!;
  fileRepo.setStatus(fileId, 'encoding', f.version);
  return j.id;
}

function queuedJob(fileId: number, position: number): number {
  const j = jobRepo.create({ file_id: fileId, encoder: 'libx265', crf: null })!;
  db.prepare('UPDATE job SET queue_position=? WHERE id=?').run(position, j.id);
  const f = fileRepo.getById(fileId)!;
  fileRepo.setStatus(fileId, 'queued', f.version);
  return j.id;
}

// An earlier run of the file that was put back after a restart.
function pastResumedRun(fileId: number): number {
  const j = jobRepo.create({ file_id: fileId, encoder: 'libx265', crf: null })!;
  db.prepare(
    "UPDATE job SET status='interrupted', finished_at=1, error_msg='resumed_after_restart' WHERE id=?",
  ).run(j.id);
  return j.id;
}

function abortError(): Error {
  return Object.assign(new Error('encode aborted'), { name: 'AbortError', logTail: '' });
}

let encodeStarted: () => void = () => {};
function hangingEncode(opts: EncodeOptions): Promise<EncodeResult> {
  encodeCalls++;
  encodeStarted();
  return new Promise((_resolve, reject) => {
    if (opts.signal?.aborted) reject(abortError());
    else opts.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
  });
}

function okEncode(opts: EncodeOptions): Promise<EncodeResult> {
  encodeCalls++;
  fs.writeFileSync(opts.output, Buffer.alloc(600, 'y'));
  opts.onProgress?.({
    frame: 1,
    fps: 1,
    outTimeMs: 1000,
    totalSize: 1,
    speed: 1,
    progress: 'end',
  });
  return Promise.resolve({ exitCode: 0, durationMs: 1, logTail: '' });
}

const probe: ProbeResult = {
  codec: 'hevc',
  bitrate: 1,
  durationSeconds: 60,
  width: 1920,
  height: 1080,
  container: 'matroska',
  tags: {},
  color: { space: null, primaries: null, transfer: null, range: null },
  hdr10: { masterDisplay: null, maxCll: null },
};

function wire(
  runEncode: (o: EncodeOptions) => Promise<EncodeResult>,
  extra: Record<string, unknown> = {},
): void {
  const blocklist = {
    matchByFileIdOrPath: (id: number) => blocked.has(id),
  } as unknown as BlocklistRepo;
  __forTests_setDeps({
    runEncode,
    ffprobe: (async () => probe) as never,
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
    blocklistRepo: () => blocklist,
    // Never stalls.
    createStallWatchdog: () => ({ observe: () => {}, stop: () => {} }),
    detectEncoders: (async () =>
      ({ detected: ['libx265'] }) as unknown as DetectionResult) as never,
    events: { emit: vi.fn(), subscribe: vi.fn() } as never,
    logger: { info, warn, error: vi.fn(), debug: vi.fn(), telemetry: vi.fn() } as never,
    now: () => 1_800_000_000,
    ...extra,
  });
}

const jobs = (): JobRowLite[] => db.prepare('SELECT * FROM job ORDER BY id').all() as JobRowLite[];
const jobsOf = (fileId: number) => jobs().filter((j) => j.file_id === fileId);
const job = (id: number) => jobs().find((j) => j.id === id)!;
const claimOrder = (): number[] =>
  (
    db
      .prepare(
        "SELECT file_id FROM job WHERE status='queued' ORDER BY queue_position ASC, created_at ASC, id ASC",
      )
      .all() as { file_id: number }[]
  ).map((r) => r.file_id);
const actions = (spy: ReturnType<typeof vi.fn>, action: string) =>
  spy.mock.calls.filter((c) => (c[0] as { action?: string })?.action === action).map((c) => c[0]);

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(async () => {
  await __forTests_resetOrchestrator();
  __forTests_resetCachePoolCooldowns();
  __forTests_resetStallDetectionCache();
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
  stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-restart-stage-'));
  mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-restart-media-'));
  settingRepo.set('cache_pool_path', stageRoot);
  settingRepo.set('default_crf', '23');
  settingRepo.set('encoder', 'libx265');
  info = vi.fn();
  warn = vi.fn();
  blocked = new Set();
  encodeCalls = 0;
  encodeStarted = () => {};
});

afterEach(async () => {
  await __forTests_resetOrchestrator();
  db.close();
  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.rmSync(mediaRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('hard restart', () => {
  it('puts running jobs back at the front in their old order and leaves waiting jobs alone', async () => {
    const a = seedFile('a.mp4');
    const b = seedFile('b.mp4');
    const c = seedFile('c.mp4');
    const d = seedFile('d.mp4');
    const e = seedFile('e.mp4');
    const ja = runningJob(a.id, 3);
    const jb = runningJob(b.id, 5);
    queuedJob(c.id, 2);
    queuedJob(d.id, 4);
    queuedJob(e.id, 6);
    // Partial output of the interrupted runs.
    for (const id of [ja, jb]) {
      const dir = staging.workDirFor(stageRoot, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'out.mkv'), 'partial');
    }
    const tmp = `${staging.outputPathFor(a.path, '.x265.mkv')}.x265-butler.json.tmp`;
    fs.writeFileSync(tmp, '{}');
    // Keep dispatch out of the picture so the order can be read.
    settingRepo.set('queue_paused', '1');
    wire(hangingEncode);

    startEncoderLoop();

    expect(job(ja)).toMatchObject({ status: 'interrupted', error_msg: 'resumed_after_restart' });
    expect(job(jb)).toMatchObject({ status: 'interrupted', error_msg: 'resumed_after_restart' });
    expect(claimOrder()).toEqual([a.id, b.id, c.id, d.id, e.id]);
    expect(fileRepo.getById(a.id)?.status).toBe('queued');
    expect(fileRepo.getById(b.id)?.status).toBe('queued');

    await waitFor(
      () =>
        !fs.existsSync(staging.workDirFor(stageRoot, ja)) &&
        !fs.existsSync(staging.workDirFor(stageRoot, jb)) &&
        !fs.existsSync(tmp),
    );

    const logs = actions(info, 'job_resumed_after_restart');
    expect(logs).toHaveLength(2);
    const forA = logs.find((l) => l.jobId === ja)!;
    expect(forA).toMatchObject({ fileId: a.id, interruption: 1, maxInterruptions: 3 });
    expect(jobsOf(a.id).map((j) => j.id)).toContain(forA.newJobId);
    for (const l of logs) expect(JSON.stringify(l)).not.toContain(mediaRoot);
    expect(encodeCalls).toBe(0);
  });

  it('works with automatic encoding off and runs the resumed job like any other', async () => {
    settingRepo.set('auto_encode', 'false');
    const a = seedFile('a.mp4');
    const ja = runningJob(a.id, 1);
    wire(okEncode);

    startEncoderLoop();
    await waitFor(() => jobsOf(a.id).some((j) => j.status === 'done'));
    await stopEncoderLoop();

    const all = jobsOf(a.id);
    expect(all).toHaveLength(2);
    expect(job(ja).status).toBe('interrupted');
    expect(all[1].status).toBe('done');
  });

  it('writes the resume line in words to the job log of the resumed job only', async () => {
    const a = seedFile('a.mp4');
    const b = seedFile('b.mp4');
    runningJob(a.id, 1);
    // Interrupted by an older version: no mark, gets no line when retried.
    const old = jobRepo.create({ file_id: b.id, encoder: 'libx265', crf: null })!;
    db.prepare("UPDATE job SET status='interrupted', finished_at=1 WHERE id=?").run(old.id);
    const manual = queuedJob(b.id, 2);
    wire(okEncode);

    startEncoderLoop();
    await waitFor(() => jobs().filter((j) => j.status === 'done').length === 2);
    await stopEncoderLoop();

    const logText = (id: number): string => {
      const f = fs
        .readdirSync(stageRoot, { recursive: true })
        .map(String)
        .find((p) => p.endsWith(`${id}.log`));
      return f ? fs.readFileSync(path.join(stageRoot, f), 'utf8') : '';
    };
    const resumed = jobsOf(a.id)[1].id;
    // Each job log line starts with a hex timestamp.
    expect(
      logText(resumed)
        .split('\n')[0]
        .replace(/^[0-9a-f]+ /, ''),
    ).toBe('Resumed after a container restart, interruption 1 of 3, starting from the beginning');
    expect(logText(manual)).not.toContain('Resumed after a container restart');
  });

  it('leaves waiting jobs untouched when nothing was running', async () => {
    const c = seedFile('c.mp4');
    const d = seedFile('d.mp4');
    queuedJob(c.id, 1);
    queuedJob(d.id, 2);
    settingRepo.set('queue_paused', '1');
    wire(hangingEncode);

    startEncoderLoop();

    expect(jobs().map((j) => j.status)).toEqual(['queued', 'queued']);
    expect(claimOrder()).toEqual([c.id, d.id]);
    expect(actions(info, 'job_resumed_after_restart')).toHaveLength(0);
    expect(actions(info, 'job_resume_skipped')).toHaveLength(0);
  });

  it('never touches interrupted rows from earlier boots', () => {
    const a = seedFile('a.mp4');
    const old = jobRepo.create({ file_id: a.id, encoder: 'libx265', crf: null })!;
    db.prepare("UPDATE job SET status='interrupted', finished_at=1 WHERE id=?").run(old.id);
    settingRepo.set('queue_paused', '1');
    wire(hangingEncode);

    startEncoderLoop();

    expect(jobs()).toHaveLength(1);
    expect(job(old.id)).toMatchObject({ status: 'interrupted', error_msg: null });
  });
});

describe('orderly stop', () => {
  it('ends the running job as interrupted, not cancelled, and queues exactly one new job', async () => {
    const a = seedFile('a.mp4');
    const ja = queuedJob(a.id, 1);
    const started = new Promise<void>((r) => (encodeStarted = r));
    wire(hangingEncode);

    startEncoderLoop();
    await started;
    await stopEncoderLoop();

    expect(job(ja)).toMatchObject({ status: 'interrupted', error_msg: 'resumed_after_restart' });
    const next = jobsOf(a.id).filter((j) => j.id !== ja);
    expect(next).toHaveLength(1);
    expect(next[0].status).toBe('queued');
    expect(fileRepo.getById(a.id)?.status).toBe('queued');
    expect(actions(info, 'shutdown_recover')).toHaveLength(1);

    // The next boot finds nothing to do.
    settingRepo.set('queue_paused', '1');
    wire(hangingEncode);
    startEncoderLoop();
    expect(jobsOf(a.id)).toHaveLength(2);
    expect(actions(info, 'job_resumed_after_restart')).toHaveLength(1);
  });

  it('gives the same result when the stop comes before ffmpeg started', async () => {
    const a = seedFile('a.mp4');
    const ja = queuedJob(a.id, 1);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let probing: () => void = () => {};
    const probeCalled = new Promise<void>((r) => (probing = r));
    wire(hangingEncode, {
      ffprobe: (async () => {
        probing();
        await gate;
        return probe;
      }) as never,
    });

    const run = loopOnce();
    await probeCalled;
    const stopping = stopEncoderLoop();
    release();
    await run;
    await stopping;

    expect(job(ja)).toMatchObject({ status: 'interrupted', error_msg: 'resumed_after_restart' });
    expect(jobsOf(a.id).filter((j) => j.status === 'queued')).toHaveLength(1);
    expect(encodeCalls).toBeLessThanOrEqual(1);
    expect(jobs().some((j) => j.status === 'cancelled')).toBe(false);
  });

  it('a kill in the middle of the stop leaves the rows for the next boot, which queues once', async () => {
    const a = seedFile('a.mp4');
    const ja = queuedJob(a.id, 1);
    const started = new Promise<void>((r) => (encodeStarted = r));
    wire(hangingEncode, {
      // The process dies before the recovery pass commits.
      jobRepo: () => ({
        ...jobRepo,
        runInTransaction: () => {
          throw new Error('killed');
        },
      }),
    });

    startEncoderLoop();
    await started;
    await stopEncoderLoop();
    expect(job(ja).status).toBe('encoding');

    settingRepo.set('queue_paused', '1');
    wire(hangingEncode);
    startEncoderLoop();

    expect(job(ja)).toMatchObject({ status: 'interrupted', error_msg: 'resumed_after_restart' });
    expect(jobsOf(a.id).filter((j) => j.status === 'queued')).toHaveLength(1);
  });
});

describe('crash loop', () => {
  it('fails the job after the third interruption in a row and queues nothing', () => {
    const a = seedFile('a.mp4');
    pastResumedRun(a.id);
    pastResumedRun(a.id);
    const ja = runningJob(a.id, 1);
    settingRepo.set('queue_paused', '1');
    wire(hangingEncode);

    startEncoderLoop();

    expect(job(ja)).toMatchObject({ status: 'failed', error_msg: 'interrupted_repeatedly' });
    expect(fileRepo.getById(a.id)?.status).toBe('failed');
    expect(jobs().filter((j) => j.status === 'queued')).toHaveLength(0);
    expect(actions(warn, 'job_interrupted_repeatedly')).toHaveLength(1);
  });

  it('does not count a stalled job in between', () => {
    const a = seedFile('a.mp4');
    pastResumedRun(a.id);
    const stalled = jobRepo.create({ file_id: a.id, encoder: 'libx265', crf: null })!;
    db.prepare(
      "UPDATE job SET status='failed', finished_at=2, error_msg='encode_stalled' WHERE id=?",
    ).run(stalled.id);
    const ja = runningJob(a.id, 1);
    settingRepo.set('queue_paused', '1');
    wire(hangingEncode);

    startEncoderLoop();

    expect(job(ja).error_msg).toBe('resumed_after_restart');
    expect(actions(info, 'job_resumed_after_restart')[0]).toMatchObject({ interruption: 2 });
  });
});

describe('skip reasons', () => {
  function bootOne(prepare: (f: { id: number; path: string }) => void): number {
    const a = seedFile('a.mp4');
    prepare(a);
    const ja = runningJob(a.id, 1);
    settingRepo.set('queue_paused', '1');
    wire(hangingEncode);
    startEncoderLoop();
    return ja;
  }

  it.each<[string, (f: { id: number; path: string }) => void, string]>([
    ['the source is gone', (f) => fs.rmSync(f.path), 'source_changed'],
    ['the source has another size', (f) => fs.appendFileSync(f.path, 'more'), 'source_changed'],
    [
      'the source has another mtime',
      (f) => fs.utimesSync(f.path, new Date(), new Date(Date.now() + 3_600_000)),
      'source_changed',
    ],
    [
      'the source was replaced by a smaller output that kept its mtime',
      (f) => {
        const st = fs.statSync(f.path);
        fs.writeFileSync(f.path, Buffer.alloc(600, 'y'));
        fs.utimesSync(f.path, st.atime, st.mtime);
      },
      'source_changed',
    ],
    ['the file is blocklisted', (f) => blocked.add(f.id), 'blocklisted'],
  ])('does not queue when %s', (_label, prepare, reason) => {
    const ja = bootOne(prepare);
    expect(job(ja)).toMatchObject({ status: 'interrupted', error_msg: `resume_skipped:${reason}` });
    expect(jobs()).toHaveLength(1);
    expect(actions(info, 'job_resume_skipped')).toEqual([
      expect.objectContaining({ jobId: ja, reason }),
    ]);
  });

  it('does not queue when enqueue is rejected', () => {
    const a = seedFile('a.mp4');
    const ja = runningJob(a.id, 1);
    settingRepo.set('queue_paused', '1');
    wire(hangingEncode, {
      jobRepo: () => ({ ...jobRepo, enqueue: () => null }),
    });

    startEncoderLoop();

    expect(job(ja).error_msg).toBe('resume_skipped:enqueue_rejected');
    expect(jobs()).toHaveLength(1);
  });
});

describe('atomic resume', () => {
  it('rolls everything back when queueing the second row throws, and the next boot queues both once', async () => {
    const a = seedFile('a.mp4');
    const b = seedFile('b.mp4');
    const ja = runningJob(a.id, 1);
    const jb = runningJob(b.id, 2);
    settingRepo.set('queue_paused', '1');
    let calls = 0;
    wire(hangingEncode, {
      jobRepo: () => ({
        ...jobRepo,
        enqueue: (...args: Parameters<JobRepo['enqueue']>) => {
          if (++calls === 2) throw new Error('disk I/O error');
          return jobRepo.enqueue(...args);
        },
      }),
    });

    startEncoderLoop();

    expect(job(ja).status).toBe('encoding');
    expect(job(jb).status).toBe('encoding');
    expect(jobs()).toHaveLength(2);
    expect(actions(warn, 'job_resume_failed')).toHaveLength(1);
    expect(actions(info, 'job_resumed_after_restart')).toHaveLength(0);

    // The process goes down without an orderly stop; the next boot is clean.
    await __forTests_resetOrchestrator();
    wire(hangingEncode);
    startEncoderLoop();

    expect(job(ja).error_msg).toBe('resumed_after_restart');
    expect(job(jb).error_msg).toBe('resumed_after_restart');
    expect(jobsOf(a.id).filter((j) => j.status === 'queued')).toHaveLength(1);
    expect(jobsOf(b.id).filter((j) => j.status === 'queued')).toHaveLength(1);
    expect(jobs().filter((j) => j.status === 'interrupted' && j.error_msg === null)).toHaveLength(
      0,
    );
  });
});

describe('setting off', () => {
  beforeEach(() => settingRepo.set('resume_after_restart', '0'));

  it('hard restart marks the jobs interrupted and queues nothing, like before', () => {
    const a = seedFile('a.mp4');
    const ja = runningJob(a.id, 1);
    wire(hangingEncode);

    startEncoderLoop();

    expect(job(ja)).toMatchObject({ status: 'interrupted', error_msg: null });
    expect(fileRepo.getById(a.id)?.status).toBe('interrupted');
    expect(jobs()).toHaveLength(1);
    expect(actions(info, 'job_resumed_after_restart')).toHaveLength(0);
  });

  it('an orderly stop cancels the running job, like before', async () => {
    const a = seedFile('a.mp4');
    const ja = queuedJob(a.id, 1);
    const started = new Promise<void>((r) => (encodeStarted = r));
    wire(hangingEncode);

    startEncoderLoop();
    await started;
    await stopEncoderLoop();

    expect(job(ja).status).toBe('cancelled');
    expect(jobs()).toHaveLength(1);
    expect(fileRepo.getById(a.id)?.status).toBe('interrupted');
  });

  it('does not restore a stored pause', () => {
    settingRepo.set('queue_paused', '1');
    wire(hangingEncode);
    startEncoderLoop();
    expect(isQueuePaused()).toBe(false);
  });
});
