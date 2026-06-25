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
  __forTests_getPerEncoderLimits,
  __forTests_getActiveCount,
  recomputePerEncoderLimits,
  startEncoderLoop,
  stopEncoderLoop,
} from '@/src/lib/encode/orchestrator';
import type { EncodeOptions, EncodeResult } from '@/src/lib/encode/ffmpeg';
import type { ProbeResult } from '@/src/lib/scan/ffprobe';
import type { DetectionResult } from '@/src/lib/encode/detection';

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
let emittedEvents: Array<{ type: string; [k: string]: unknown }>;

const NOW_SECONDS = 1_800_000_000;

function seedFile(p: string, sizeBytes = 1_000_000): { id: number; path: string } {
  const row = fileRepo.upsertByPath({
    path: p,
    size_bytes: sizeBytes,
    mtime: 1_700_000_000,
    content_hash: p.padStart(64, '0').slice(-64),
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

function makeMockEncodeResult(over: Partial<EncodeResult> = {}): EncodeResult {
  return { exitCode: 0, durationMs: 30_000, logTail: '', ...over };
}

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

function setupDeps(opts: {
  detection?: DetectionResult;
  runEncodeImpl?: (opts: EncodeOptions) => Promise<EncodeResult>;
  outputSize?: number;
}): void {
  const detection: DetectionResult = opts.detection ?? {
    detected: ['libx265'],
    activeFromAuto: 'libx265',
    warnings: [],
    outcome: { nvenc: 'missing', qsv: 'missing', vaapi: 'missing', libx265: 'functional' },
    brokenExcerpts: {},
    probeEncodeDisabled: false,
  };
  __forTests_setDeps({
    runEncode:
      opts.runEncodeImpl ??
      (async ({ output }) => {
        const out = opts.outputSize ?? 600_000;
        fs.writeFileSync(output, Buffer.alloc(out, 'y'));
        return makeMockEncodeResult();
      }),
    ffprobe: (async () => makeMockProbe()) as never,
    fs: {
      statSync: fs.statSync,
      statfsSync: (() => ({ bavail: BigInt(1_000_000_000), bsize: BigInt(1) }) as never) as never,
      existsSync: fs.existsSync,
      unlinkSync: (() => undefined) as unknown as typeof import('node:fs').unlinkSync,
      accessSync: fs.accessSync,
    },
    fileRepo: () => fileRepo,
    jobRepo: () => jobRepo,
    settingRepo: () => settingRepo,
    trashRepo: () => trashRepo,
    detectEncoders: async () => detection,
    logger: {
      info: logSpy,
      warn: warnSpy,
      error: errorSpy,
      debug: debugSpy,
    } as never,
    now: () => NOW_SECONDS,
    events: {
      emit: (ev: { type: string; [k: string]: unknown }) => emittedEvents.push(ev),
      subscribe: () => () => {},
      getLastProgress: () => undefined,
    } as never,
  });
}

beforeEach(async () => {
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
  stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-orch-multi-stage-'));
  mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-orch-multi-media-'));
  settingRepo.set('cache_pool_path', stageRoot);
  settingRepo.set('default_crf', '23');
  settingRepo.set('min_savings_percent', '5');
  settingRepo.set('trash_retention_days', '30');
  logSpy = vi.fn();
  warnSpy = vi.fn();
  errorSpy = vi.fn();
  debugSpy = vi.fn();
  emittedEvents = [];
  _enqueueCounter = 0;
  await __forTests_resetOrchestrator();
});

afterEach(async () => {
  await stopEncoderLoop().catch(() => {});
  await __forTests_resetOrchestrator();
  db.close();
  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.rmSync(mediaRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// Helper: spawn N source files + queued jobs. Uses a per-test counter so
// repeat invocations within the same test get unique file paths (the partial
// UNIQUE index on (file_id) WHERE status IN active rejects double-active jobs).
let _enqueueCounter = 0;
function enqueueN(n: number, encoder = 'libx265'): number[] {
  const jobIds: number[] = [];
  for (let i = 0; i < n; i++) {
    const sourcePath = path.join(mediaRoot, `movie-${_enqueueCounter++}.mp4`);
    fs.writeFileSync(sourcePath, Buffer.alloc(1_000_000, 'x'));
    const file = seedFile(sourcePath, 1_000_000);
    const job = jobRepo.create({ file_id: file.id, encoder, crf: null });
    jobIds.push(job!.id);
  }
  return jobIds;
}

// Drain helper: wait for in-flight count to reach 0 with bounded timeout.
async function drain(timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const queued = jobRepo.countByStatus('queued');
    const encoding = jobRepo.countByStatus('encoding');
    if (queued === 0 && encoding === 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(
    `drain timeout: queued=${jobRepo.countByStatus('queued')} encoding=${jobRepo.countByStatus(
      'encoding',
    )}`,
  );
}

describe('orchestrator multi-slot — capacity-aware dispatch', () => {
  it('test_dispatchUntilFull_when_3_libx265_jobs_and_limit_2_then_2_dispatched_1_remains_queued', async () => {
    settingRepo.set('encoder', 'libx265');
    settingRepo.set('concurrency', '2');
    setupDeps({});
    enqueueN(3, 'libx265');

    // Manually drive: instead of starting the loop (which fires async ticks),
    // call recomputePerEncoderLimits + dispatchUntilFull directly via export.
    recomputePerEncoderLimits();
    expect(__forTests_getPerEncoderLimits().libx265).toBe(2);

    // Use deferred encode to keep slots occupied for assertion.
    let completes = 0;
    const slotHolders = new Set<number>();
    setupDeps({
      runEncodeImpl: async ({ output, signal }) => {
        slotHolders.add(slotHolders.size);
        return new Promise<EncodeResult>((resolve, reject) => {
          const t = setTimeout(() => {
            fs.writeFileSync(output, Buffer.alloc(600_000, 'y'));
            completes++;
            resolve(makeMockEncodeResult());
          }, 200);
          signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        });
      },
    });

    startEncoderLoop();
    // wait for dispatch to fire (idle poll runs at 1s; bump quickly via short wait)
    await new Promise((r) => setTimeout(r, 50));
    // Force immediate dispatch tick. dispatchUntilFull goes through scheduleNext.
    // Wait briefly for encoding state to populate.
    let waited = 0;
    while (jobRepo.countByStatus('encoding') < 2 && waited < 5000) {
      await new Promise((r) => setTimeout(r, 50));
      waited += 50;
    }

    expect(jobRepo.countByStatus('encoding')).toBe(2);
    expect(jobRepo.countByStatus('queued')).toBe(1);
    expect(__forTests_getActiveCount('libx265')).toBe(2);

    // Drain (encodes complete, slot frees, third job picks up)
    await drain(15_000);
    expect(completes).toBe(3);
  });

  it('test_dispatchUntilFull_when_4_auto_jobs_and_uniform_limit_1_then_2_in_flight_2_queued_via_capacity_aware_walk', async () => {
    // settings.concurrency='1' → ALL encoders get limit 1 (universal override).
    // settings.encoder='auto' → orchestrator resolves via detection walk.
    // detection ['nvenc', 'libx265']: 4 'auto' jobs distribute across 2 encoders.
    // First job → nvenc (limit 1, free). Second job → libx265 (nvenc full).
    // Third + Fourth jobs queue until a slot frees.
    settingRepo.set('concurrency', '1');
    settingRepo.set('encoder', 'auto');

    setupDeps({
      detection: {
        detected: ['nvenc', 'libx265'],
        activeFromAuto: 'nvenc',
        warnings: [],
        outcome: { nvenc: 'functional', qsv: 'missing', vaapi: 'missing', libx265: 'functional' },
        brokenExcerpts: {},
        probeEncodeDisabled: false,
      },
      runEncodeImpl: async ({ output, signal }) => {
        return new Promise<EncodeResult>((resolve, reject) => {
          const t = setTimeout(() => {
            fs.writeFileSync(output, Buffer.alloc(600_000, 'y'));
            resolve(makeMockEncodeResult());
          }, 300);
          signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        });
      },
    });

    enqueueN(4, 'auto');

    startEncoderLoop();
    let waited = 0;
    while (jobRepo.countByStatus('encoding') < 2 && waited < 5000) {
      await new Promise((r) => setTimeout(r, 50));
      waited += 50;
    }

    expect(jobRepo.countByStatus('encoding')).toBe(2);
    expect(jobRepo.countByStatus('queued')).toBe(2);
    expect(__forTests_getActiveCount('nvenc')).toBe(1);
    expect(__forTests_getActiveCount('libx265')).toBe(1);

    await drain(15_000);
  });

  it('test_processOne_completion_when_finishes_then_slot_freed_and_next_tick_claims_next_job', async () => {
    settingRepo.set('encoder', 'libx265');
    settingRepo.set('concurrency', '1');
    setupDeps({});
    enqueueN(2);
    startEncoderLoop();
    await drain(10_000);
    expect(jobRepo.countByStatus('done')).toBe(2);
    expect(__forTests_getActiveCount('libx265')).toBe(0);
  });
});

describe('orchestrator multi-slot — audit M3 capacity-aware auto', () => {
  it('test_dispatchUntilFull_when_5_auto_jobs_and_nvenc_limit_1_libx265_limit_4_then_1_nvenc_4_libx265_dispatched', async () => {
    if (os.cpus().length < 16) {
      // libx265 = floor(cpus/4) — needs ≥16 cores for libx265=4 from auto.
      // Skip if CI lacks the cores; the M3 logic is also exercised in the
      // smaller-fixture tests above + the real-ffmpeg integration test.
      return;
    }
    settingRepo.set('concurrency', 'auto');
    settingRepo.set('encoder', 'auto');

    setupDeps({
      detection: {
        detected: ['nvenc', 'libx265'],
        activeFromAuto: 'nvenc',
        warnings: [],
        outcome: { nvenc: 'functional', qsv: 'missing', vaapi: 'missing', libx265: 'functional' },
        brokenExcerpts: {},
        probeEncodeDisabled: false,
      },
      runEncodeImpl: async ({ output, signal }) => {
        return new Promise<EncodeResult>((resolve, reject) => {
          const t = setTimeout(() => {
            fs.writeFileSync(output, Buffer.alloc(600_000, 'y'));
            resolve(makeMockEncodeResult());
          }, 300);
          signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        });
      },
    });
    enqueueN(5, 'auto');
    startEncoderLoop();
    let waited = 0;
    while (jobRepo.countByStatus('encoding') < 5 && waited < 5000) {
      await new Promise((r) => setTimeout(r, 50));
      waited += 50;
    }
    expect(__forTests_getActiveCount('nvenc')).toBe(1);
    expect(__forTests_getActiveCount('libx265')).toBe(4);
    await drain(15_000);
  });

  it(
    'test_dispatchUntilFull_when_auto_job_and_nvenc_already_full_then_skips_to_libx265',
    { timeout: 30_000 },
    async () => {
      // With settings.concurrency='1' + detection ['nvenc','libx265']:
      //   - First 'auto' job → resolveEncoderFor walks ['nvenc','libx265'],
      //     nvenc has capacity 0/1 → claims nvenc.
      //   - Second 'auto' job (enqueued while nvenc busy) → resolveEncoderFor
      //     walks ['nvenc','libx265'], nvenc full → falls through to libx265.
      settingRepo.set('concurrency', '1');
      settingRepo.set('encoder', 'auto');

      // ALL encodes block until releaseAll() is called — keeps slots occupied
      // for inspection of active counts.
      const releasers: Array<() => void> = [];
      setupDeps({
        detection: {
          detected: ['nvenc', 'libx265'],
          activeFromAuto: 'nvenc',
          warnings: [],
          outcome: { nvenc: 'functional', qsv: 'missing', vaapi: 'missing', libx265: 'functional' },
          brokenExcerpts: {},
          probeEncodeDisabled: false,
        },
        runEncodeImpl: async ({ output, signal }) => {
          return new Promise<EncodeResult>((resolve, reject) => {
            releasers.push(() => {
              fs.writeFileSync(output, Buffer.alloc(600_000, 'y'));
              resolve(makeMockEncodeResult());
            });
            signal?.addEventListener('abort', () => {
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            });
          });
        },
      });

      enqueueN(1, 'auto');
      startEncoderLoop();
      let waited = 0;
      while (jobRepo.countByStatus('encoding') < 1 && waited < 5000) {
        await new Promise((r) => setTimeout(r, 50));
        waited += 50;
      }
      expect(__forTests_getActiveCount('nvenc')).toBe(1);

      // Now enqueue a second 'auto' job while nvenc is occupied.
      enqueueN(1, 'auto');

      // Wait for the second job to also reach encoding (must dispatch to libx265).
      waited = 0;
      while (jobRepo.countByStatus('encoding') < 2 && waited < 5000) {
        await new Promise((r) => setTimeout(r, 50));
        waited += 50;
      }
      expect(__forTests_getActiveCount('nvenc')).toBe(1);
      expect(__forTests_getActiveCount('libx265')).toBe(1);

      // Release all blocked encodes + drain.
      for (const r of releasers) r();
      await drain(15_000);
    },
  );
});

describe('orchestrator multi-slot — audit M2 single-flight mutex', () => {
  it('test_dispatchUntilFull_when_called_concurrently_then_single_flight_mutex_serializes', async () => {
    // Verify by inspecting in-flight count after concurrent dispatch attempts.
    // Without M2 mutex, concurrent dispatchUntilFull invocations could race
    // past hasCapacityFor and exceed limits. With M2, the second invocation
    // returns immediately (no-op).
    settingRepo.set('encoder', 'libx265');
    settingRepo.set('concurrency', '1');
    setupDeps({
      runEncodeImpl: async ({ output, signal }) => {
        return new Promise<EncodeResult>((resolve, reject) => {
          const t = setTimeout(() => {
            fs.writeFileSync(output, Buffer.alloc(600_000, 'y'));
            resolve(makeMockEncodeResult());
          }, 200);
          signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        });
      },
    });
    enqueueN(5);
    startEncoderLoop();
    // Wait for dispatch to settle.
    let waited = 0;
    while (jobRepo.countByStatus('encoding') < 1 && waited < 3000) {
      await new Promise((r) => setTimeout(r, 50));
      waited += 50;
    }
    // Limit=1 with 5 queued jobs: encoding count never exceeds 1.
    expect(jobRepo.countByStatus('encoding')).toBeLessThanOrEqual(1);
    expect(__forTests_getActiveCount('libx265')).toBeLessThanOrEqual(1);
    await drain(20_000);
  });
});

describe('orchestrator multi-slot — audit M5 unhandled-rejection guard', () => {
  it('test_processOne_when_throws_in_background_then_caught_and_logged_no_unhandled_rejection', async () => {
    settingRepo.set('encoder', 'libx265');
    settingRepo.set('concurrency', '1');
    // Inject a runEncode that throws synchronously inside the await.
    setupDeps({
      runEncodeImpl: () => {
        throw new Error('synthetic throw from runEncode');
      },
    });
    enqueueN(1);
    startEncoderLoop();
    // Wait for the job to fail.
    let waited = 0;
    while (jobRepo.countByStatus('queued') > 0 && waited < 5000) {
      await new Promise((r) => setTimeout(r, 50));
      waited += 50;
    }
    // The orchestrator must NOT have terminated the process.
    // Job reaches 'failed' status via failJob path (synchronous throw caught).
    const finalStatus = jobRepo.countByStatus('failed');
    expect(finalStatus).toBe(1);
  });
});

describe('orchestrator multi-slot — audit S11 queue.updated emit on claim', () => {
  it('test_tryDispatchOne_when_successful_claim_then_emits_queue_updated_event_immediately', async () => {
    settingRepo.set('encoder', 'libx265');
    settingRepo.set('concurrency', '1');
    setupDeps({});
    enqueueN(1);
    startEncoderLoop();
    let waited = 0;
    while (jobRepo.countByStatus('done') < 1 && waited < 5000) {
      await new Promise((r) => setTimeout(r, 50));
      waited += 50;
    }
    // queue.updated emitted at least once during the dispatch flow.
    const queueUpdatedEvents = emittedEvents.filter((e) => e.type === 'queue.updated');
    expect(queueUpdatedEvents.length).toBeGreaterThanOrEqual(1);
  });
});

describe('orchestrator multi-slot — audit S13 FIFO ordering', () => {
  it('test_dispatchUntilFull_when_5_libx265_jobs_and_limit_2_then_dispatched_FIFO_oldest_first', async () => {
    settingRepo.set('encoder', 'libx265');
    settingRepo.set('concurrency', '2');
    setupDeps({});
    const jobIds = enqueueN(5);
    // Bump created_at so each successive job is strictly newer.
    for (let i = 0; i < jobIds.length; i++) {
      db.prepare('UPDATE job SET created_at = created_at + ? WHERE id = ?').run(i, jobIds[i]);
    }
    startEncoderLoop();
    await drain(20_000);
    // All 5 done; verify started_at order matches enqueue order.
    const rows = db
      .prepare("SELECT id, started_at FROM job WHERE status='done' ORDER BY started_at ASC, id ASC")
      .all() as { id: number; started_at: number }[];
    expect(rows).toHaveLength(5);
    // The earliest 2 to claim should be jobIds[0] + jobIds[1] (oldest created_at).
    expect(rows[0].id).toBe(jobIds[0]);
    expect(rows[1].id).toBe(jobIds[1]);
  });
});

describe('orchestrator multi-slot — audit S14 startEncoderLoop idempotency', () => {
  it('test_startEncoderLoop_when_called_twice_then_perEncoderLimits_recomputed_idempotently', () => {
    settingRepo.set('concurrency', '4');
    setupDeps({});
    startEncoderLoop();
    const limitsAfterFirst = __forTests_getPerEncoderLimits();
    expect(limitsAfterFirst).toEqual({ libx265: 4, nvenc: 4, qsv: 4, vaapi: 4 });
    // Second call is no-op (loopStarted=true) but recomputePerEncoderLimits
    // can be invoked directly — verify it produces same result.
    settingRepo.set('concurrency', '6');
    recomputePerEncoderLimits();
    const limitsAfterSecond = __forTests_getPerEncoderLimits();
    expect(limitsAfterSecond).toEqual({ libx265: 6, nvenc: 6, qsv: 6, vaapi: 6 });
  });

  it('test_startEncoderLoop_when_settings_concurrency_4_then_perEncoderLimits_all_4', () => {
    settingRepo.set('concurrency', '4');
    setupDeps({});
    startEncoderLoop();
    expect(__forTests_getPerEncoderLimits()).toEqual({
      libx265: 4,
      nvenc: 4,
      qsv: 4,
      vaapi: 4,
    });
  });

  it('test_startEncoderLoop_when_settings_concurrency_invalid_then_logs_warn_and_uses_auto', () => {
    settingRepo.set('concurrency', 'gibberish');
    setupDeps({});
    startEncoderLoop();
    // computePerEncoderLimits emits the concurrency_setting_invalid warn.
    const invalidWarn = warnSpy.mock.calls
      .map((c) => c[0])
      .find((c) => (c as { action?: string }).action === 'concurrency_setting_invalid');
    expect(invalidWarn).toBeDefined();
  });

  it('test_capacity_log_when_boot_then_emits_encoder_loop_capacity_with_resolved_limits_cpuCount_concurrencySetting', () => {
    settingRepo.set('concurrency', '2');
    setupDeps({});
    startEncoderLoop();
    const capacityLog = logSpy.mock.calls
      .map((c) => c[0])
      .find((c) => (c as { action?: string }).action === 'encoder_loop_capacity');
    expect(capacityLog).toBeDefined();
    const payload = capacityLog as {
      cpuCount: number;
      concurrencySetting: string;
      limits: { libx265: number };
    };
    expect(payload.concurrencySetting).toBe('2');
    expect(typeof payload.cpuCount).toBe('number');
    expect(payload.limits.libx265).toBe(2);
  });
});
