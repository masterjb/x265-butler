// @vitest-environment node
// A stalled production encode ends as failed (`encode_stalled`, not cancelled)
// and is retried once at the front of the queue. The watchdog factory is
// injected so the stall fires at once; repositories are the real ones on an
// in-memory database, so a stale file version would really block the retry.

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
  __forTests_markJobAsBenchSample,
  __forTests_resetOrchestrator,
  __forTests_setDeps,
  loopOnce,
} from '@/src/lib/encode/orchestrator';
import { __forTests_resetCachePoolCooldowns } from '@/src/lib/encode/staging';
import {
  __forTests_resetStallDetectionCache,
  createStallWatchdog,
  type StallWatchdogOptions,
} from '@/src/lib/encode/stall-watchdog';
import type { EncodeOptions, EncodeResult } from '@/src/lib/encode/ffmpeg';
import type { ProbeResult } from '@/src/lib/scan/ffprobe';

type Db = InstanceType<typeof Database>;
type JobRowLite = {
  id: number;
  file_id: number;
  status: string;
  error_msg: string | null;
  log_tail: string | null;
  queue_position: number;
  force_container: string | null;
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
let blocked: boolean;
let factoryCalls: StallWatchdogOptions[];
let stopCalls: number;

const origKill = process.env.ENCODE_STALL_DETECTION_DISABLED;

function seedFile(name: string): { id: number; path: string } {
  const p = path.join(mediaRoot, name);
  fs.writeFileSync(p, Buffer.alloc(1000, 'x'));
  const row = fileRepo.upsertByPath({
    path: p,
    size_bytes: 1000,
    mtime: 1_700_000_000,
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

function abortError(logTail: string): Error {
  return Object.assign(new Error('encode aborted'), { name: 'AbortError', logTail });
}

// Stalls on the spot: the watchdog reports in a microtask, the fake encode waits
// for the abort and rejects like runEncode does.
const stallingFactory = (opts: StallWatchdogOptions) => {
  factoryCalls.push(opts);
  queueMicrotask(opts.onStall);
  return { observe: () => {}, stop: () => void stopCalls++ };
};

function hangingEncode(beforeReject?: () => void) {
  return (opts: EncodeOptions): Promise<EncodeResult> =>
    new Promise((_resolve, reject) => {
      const fire = () => {
        beforeReject?.();
        reject(abortError('frame=  1234 fps=0.0 last stderr line'));
      };
      if (opts.signal?.aborted) fire();
      else opts.signal?.addEventListener('abort', fire, { once: true });
    });
}

function okEncode(opts: EncodeOptions): Promise<EncodeResult> {
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

function wire(
  runEncode: (o: EncodeOptions) => Promise<EncodeResult>,
  factory: (o: StallWatchdogOptions) => ReturnType<typeof createStallWatchdog> = stallingFactory,
): void {
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
  const blocklist = { matchByFileIdOrPath: () => blocked } as unknown as BlocklistRepo;
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
    createStallWatchdog: factory,
    logger: { info, warn, error: vi.fn(), debug: vi.fn(), telemetry: vi.fn() } as never,
    now: () => 1_800_000_000,
  });
}

const jobs = (): JobRowLite[] => db.prepare('SELECT * FROM job ORDER BY id').all() as JobRowLite[];
const actions = (spy: ReturnType<typeof vi.fn>, action: string) =>
  spy.mock.calls.filter((c) => (c[0] as { action?: string })?.action === action);
const nextClaim = (): number | undefined =>
  (
    db
      .prepare(
        "SELECT id FROM job WHERE status='queued' ORDER BY queue_position ASC, created_at ASC, id ASC LIMIT 1",
      )
      .get() as { id: number } | undefined
  )?.id;

beforeEach(async () => {
  await __forTests_resetOrchestrator();
  __forTests_resetCachePoolCooldowns();
  __forTests_resetStallDetectionCache();
  delete process.env.ENCODE_STALL_DETECTION_DISABLED;
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
  stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-stall-stage-'));
  mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-stall-media-'));
  settingRepo.set('cache_pool_path', stageRoot);
  settingRepo.set('default_crf', '23');
  settingRepo.set('encoder', 'libx265');
  info = vi.fn();
  warn = vi.fn();
  blocked = false;
  factoryCalls = [];
  stopCalls = 0;
});

afterEach(async () => {
  await __forTests_resetOrchestrator();
  db.close();
  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.rmSync(mediaRoot, { recursive: true, force: true });
  if (origKill === undefined) delete process.env.ENCODE_STALL_DETECTION_DISABLED;
  else process.env.ENCODE_STALL_DETECTION_DISABLED = origKill;
  __forTests_resetStallDetectionCache();
  vi.restoreAllMocks();
});

describe('first stall', () => {
  it('fails the job as encode_stalled and queues one retry ahead of the waiting jobs', async () => {
    const stuck = seedFile('stuck.mp4');
    const waiting = seedFile('waiting.mp4');
    const j1 = jobRepo.create({ file_id: stuck.id, encoder: 'libx265', crf: null })!;
    const j2 = jobRepo.create({ file_id: waiting.id, encoder: 'libx265', crf: null })!;
    wire(hangingEncode());

    await loopOnce();

    const all = jobs();
    const first = all.find((j) => j.id === j1.id)!;
    expect(first.status).toBe('failed');
    expect(first.error_msg).toBe('encode_stalled');
    expect(first.log_tail).toContain('last stderr line');

    const retry = all.filter((j) => j.file_id === stuck.id && j.id !== j1.id);
    expect(retry).toHaveLength(1);
    expect(retry[0].status).toBe('queued');
    expect(nextClaim()).toBe(retry[0].id);
    expect(nextClaim()).not.toBe(j2.id);

    expect(fileRepo.getById(stuck.id)?.status).toBe('queued');
    expect(fs.existsSync(path.join(stageRoot, 'work', String(j1.id)))).toBe(false);

    expect(actions(warn, 'encode_stalled')).toHaveLength(1);
    expect(actions(info, 'encode_stall_retry_queued')).toHaveLength(1);
    expect(stopCalls).toBe(1);
  });

  it('writes the reason in words to the job log', async () => {
    const stuck = seedFile('stuck.mp4');
    const j1 = jobRepo.create({ file_id: stuck.id, encoder: 'libx265', crf: null })!;
    wire(hangingEncode());

    await loopOnce();

    const logFile = fs
      .readdirSync(stageRoot, { recursive: true })
      .map(String)
      .find((f) => f.endsWith(`${j1.id}.log`));
    expect(logFile).toBeDefined();
    const text = fs.readFileSync(path.join(stageRoot, logFile!), 'utf8');
    expect(text).toContain('no encoding progress for 10 minutes, stopping ffmpeg');
  });

  it('retries even when automatic encoding is switched off', async () => {
    settingRepo.set('auto_encode', 'false');
    const stuck = seedFile('stuck.mp4');
    jobRepo.create({ file_id: stuck.id, encoder: 'libx265', crf: null });
    wire(hangingEncode());

    await loopOnce();

    expect(jobs().filter((j) => j.status === 'queued')).toHaveLength(1);
  });

  it('keeps the forced container of the stalled job', async () => {
    const stuck = seedFile('stuck.mp4');
    db.prepare(
      "INSERT INTO job (file_id, status, encoder, created_at, crf, queue_position, force_container) VALUES (?, 'queued', 'libx265', 1, NULL, 1, 'mkv')",
    ).run(stuck.id);
    fileRepo.setStatus(stuck.id, 'queued', fileRepo.getById(stuck.id)!.version);
    wire(hangingEncode());

    await loopOnce();

    const retry = jobs().find((j) => j.status === 'queued');
    expect(retry?.force_container).toBe('mkv');
  });
});

describe('no further retry', () => {
  it('a second stall in a row ends the file as failed without a new job', async () => {
    const stuck = seedFile('stuck.mp4');
    jobRepo.create({ file_id: stuck.id, encoder: 'libx265', crf: null });
    wire(hangingEncode());

    await loopOnce(); // first stall, retry queued
    await loopOnce(); // the retry stalls too

    const all = jobs();
    expect(all).toHaveLength(2);
    expect(all.every((j) => j.status === 'failed' && j.error_msg === 'encode_stalled')).toBe(true);
    expect(fileRepo.getById(stuck.id)?.status).toBe('failed');
    const reasons = actions(info, 'encode_stall_no_retry').map((c) => c[0].reason);
    expect(reasons).toEqual(['previous_attempt_stalled']);
  });

  it('no retry when the file was blocklisted meanwhile', async () => {
    blocked = true;
    const stuck = seedFile('stuck.mp4');
    jobRepo.create({ file_id: stuck.id, encoder: 'libx265', crf: null });
    wire(hangingEncode());

    await loopOnce();

    expect(jobs()).toHaveLength(1);
    expect(actions(info, 'encode_stall_no_retry')[0][0].reason).toBe('blocklisted');
  });

  it('no retry when the job was ended by someone else before it could be marked failed', async () => {
    const stuck = seedFile('stuck.mp4');
    const j1 = jobRepo.create({ file_id: stuck.id, encoder: 'libx265', crf: null })!;
    wire(hangingEncode(() => jobRepo.markCancelled(j1.id)));

    await loopOnce();

    expect(jobs()).toHaveLength(1);
    expect(actions(info, 'encode_stall_no_retry')[0][0].reason).toBe('job_not_encoding');
  });

  it('a rejected enqueue is logged and does not throw', async () => {
    const stuck = seedFile('stuck.mp4');
    jobRepo.create({ file_id: stuck.id, encoder: 'libx265', crf: null });
    const realRepo = jobRepo;
    jobRepo = { ...realRepo, enqueue: () => null };
    wire(hangingEncode());

    await expect(loopOnce()).resolves.toBeUndefined();
    expect(actions(info, 'encode_stall_no_retry')[0][0].reason).toBe('enqueue_rejected');
    jobRepo = realRepo;
  });
});

describe('cancel and normal runs are unchanged', () => {
  it('an operator abort without a stall stays cancelled and is not retried', async () => {
    const f = seedFile('a.mp4');
    jobRepo.create({ file_id: f.id, encoder: 'libx265', crf: null });
    const quiet = (opts: StallWatchdogOptions) => {
      factoryCalls.push(opts);
      return { observe: () => {}, stop: () => void stopCalls++ };
    };
    wire(async () => {
      throw abortError('');
    }, quiet);

    await loopOnce();

    expect(jobs()).toHaveLength(1);
    expect(jobs()[0].status).toBe('cancelled');
    expect(actions(warn, 'encode_stalled')).toHaveLength(0);
    expect(stopCalls).toBe(1);
  });

  it('a finished encode stops its watchdog and feeds it the progress', async () => {
    const f = seedFile('a.mp4');
    jobRepo.create({ file_id: f.id, encoder: 'libx265', crf: null });
    const observed: Array<number | null> = [];
    const watching = (opts: StallWatchdogOptions) => {
      factoryCalls.push(opts);
      return { observe: (v: number | null) => void observed.push(v), stop: () => void stopCalls++ };
    };
    wire(okEncode, watching);

    await loopOnce();

    expect(jobs()[0].status).toBe('done');
    expect(observed).toEqual([1000]);
    expect(stopCalls).toBe(1);
    expect(factoryCalls[0].timeoutMs).toBe(10 * 60_000);
  });
});

describe('when the watchdog is not used', () => {
  it('the kill switch keeps it off regardless of the setting', async () => {
    process.env.ENCODE_STALL_DETECTION_DISABLED = '1';
    const f = seedFile('a.mp4');
    jobRepo.create({ file_id: f.id, encoder: 'libx265', crf: null });
    wire(okEncode);

    await loopOnce();

    expect(factoryCalls).toHaveLength(0);
  });

  it('a setting of 0 turns it off', async () => {
    settingRepo.set('stall_timeout_minutes', '0');
    const f = seedFile('a.mp4');
    jobRepo.create({ file_id: f.id, encoder: 'libx265', crf: null });
    wire(okEncode);

    await loopOnce();

    expect(factoryCalls).toHaveLength(0);
  });

  it('a configured value sets the timeout', async () => {
    settingRepo.set('stall_timeout_minutes', '45');
    const f = seedFile('a.mp4');
    jobRepo.create({ file_id: f.id, encoder: 'libx265', crf: null });
    wire(okEncode, (o) => {
      factoryCalls.push(o);
      return { observe: () => {}, stop: () => {} };
    });

    await loopOnce();

    expect(factoryCalls[0].timeoutMs).toBe(45 * 60_000);
  });

  it('bench samples get no watchdog', async () => {
    const f = seedFile('a.mp4');
    const j = jobRepo.create({ file_id: f.id, encoder: 'libx265', crf: null })!;
    __forTests_markJobAsBenchSample(j.id);
    wire(okEncode);

    await loopOnce();

    expect(factoryCalls).toHaveLength(0);
  });
});
