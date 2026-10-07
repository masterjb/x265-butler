// In-memory pause-after-current. Asserts the dispatch gate (paused stops
// NEXT-dispatch, running is NOT aborted, resume restarts immediately), the
// emitQueueUpdated paused payload, setQueuePaused idempotency, and the cross-module
// barrel singleton (isQueuePaused via the encode barrel reflects setQueuePaused).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@/src/lib/db/migrate';
import { makeFileRepo } from '@/src/lib/db/repos/file';
import { makeJobRepo } from '@/src/lib/db/repos/job';
import { makeSettingRepo, type SettingRepo } from '@/src/lib/db/repos/setting';
import {
  __forTests_resetOrchestrator,
  __forTests_setDeps,
  __forTests_dispatchUntilFull,
  __forTests_registerActiveController,
  setQueuePaused,
  isQueuePaused,
  startEncoderLoop,
  stopEncoderLoop,
} from '@/src/lib/encode/orchestrator';
// import the getter via the BARREL the watcher/status/page consume — proves
// they observe the SAME module-level _paused instance (no divergent copies).
import { isQueuePaused as isQueuePausedViaBarrel } from '@/src/lib/encode';
import { __resetPausedFlag } from '@/src/lib/encode/pause-state';
import type { JobRow } from '@/src/lib/db/schema';
import type { DetectionResult } from '@/src/lib/encode/detection';

let emit: ReturnType<typeof vi.fn>;
let peekQueued: ReturnType<typeof vi.fn>;
let claimById: ReturnType<typeof vi.fn>;

const QUEUED_JOB = { id: 1, file_id: 1, encoder: 'libx265', crf: null, status: 'queued' } as JobRow;

function emitsForQueueUpdated() {
  return emit.mock.calls.filter((c) => (c[0] as { type?: string })?.type === 'queue.updated');
}

beforeEach(async () => {
  await __forTests_resetOrchestrator();
  emit = vi.fn();
  peekQueued = vi.fn(() => [QUEUED_JOB]);
  // Default: claim races lost → tryDispatchOne rolls back + returns false, so the
  // dispatch loop terminates WITHOUT launching processOne (no ffmpeg spawn).
  claimById = vi.fn(() => undefined);
  __forTests_setDeps({
    jobRepo: () =>
      ({
        peekQueued,
        claimById,
        listActive: () => [],
        countByStatus: () => 0,
      }) as never,
    settingRepo: () => ({ getAll: () => ({ encoder: 'libx265' }), get: () => undefined }) as never,
    detectEncoders: (async () =>
      ({ detected: ['libx265'] }) as unknown as DetectionResult) as never,
    events: { emit, subscribe: vi.fn() } as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  });
});

afterEach(async () => {
  await __forTests_resetOrchestrator();
});

describe('setQueuePaused / isQueuePaused', () => {
  it('default state is unpaused after reset', () => {
    expect(isQueuePaused()).toBe(false);
  });

  it('emits queue.updated with paused:true on pause', () => {
    setQueuePaused(true);
    expect(isQueuePaused()).toBe(true);
    const last = emitsForQueueUpdated().at(-1)![0] as { paused: boolean };
    expect(last.paused).toBe(true);
  });

  it('emits queue.updated with paused:false on resume', () => {
    setQueuePaused(true);
    emit.mockClear();
    setQueuePaused(false);
    expect(isQueuePaused()).toBe(false);
    const last = emitsForQueueUpdated().at(-1)![0] as { paused: boolean };
    expect(last.paused).toBe(false);
  });

  it('(e) idempotent — repeated same-value set does NOT re-emit', () => {
    setQueuePaused(true);
    const after = emitsForQueueUpdated().length;
    setQueuePaused(true);
    setQueuePaused(true);
    expect(emitsForQueueUpdated().length).toBe(after);
  });

  it('barrel getter reflects the same _paused instance', () => {
    setQueuePaused(true);
    expect(isQueuePausedViaBarrel()).toBe(true);
    setQueuePaused(false);
    expect(isQueuePausedViaBarrel()).toBe(false);
  });
});

describe('dispatch gate (pause-after-current)', () => {
  it('paused-from-idle: tryDispatchOne is not reached (peekQueued never called)', async () => {
    setQueuePaused(true);
    peekQueued.mockClear();
    await __forTests_dispatchUntilFull();
    // The `while (!_stopping && !_paused)` guard short-circuits before the body,
    // so tryDispatchOne — and thus peekQueued/claimById — is never invoked.
    expect(peekQueued).not.toHaveBeenCalled();
    expect(claimById).not.toHaveBeenCalled();
  });

  it('pause does NOT abort an in-flight encode (pause-after-current)', () => {
    const ctrl = new AbortController();
    __forTests_registerActiveController(QUEUED_JOB.id, ctrl);
    setQueuePaused(true);
    expect(ctrl.signal.aborted).toBe(false);
  });

  it('resume restarts dispatch immediately (claim attempted without idle wait)', async () => {
    setQueuePaused(true);
    peekQueued.mockClear();
    claimById.mockClear();
    // Resume kicks dispatch (fire-and-forget) — flush microtasks + the awaited
    // detectEncoders before asserting the claim attempt landed.
    setQueuePaused(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(peekQueued).toHaveBeenCalled();
    expect(claimById).toHaveBeenCalledWith(QUEUED_JOB.id);
  });

  it('while paused, a resume-then-repause leaves dispatch gated', async () => {
    setQueuePaused(false); // no-op (already false) — sanity
    setQueuePaused(true);
    peekQueued.mockClear();
    await __forTests_dispatchUntilFull();
    expect(peekQueued).not.toHaveBeenCalled();
  });
});

describe('pause across a restart', () => {
  let db: InstanceType<typeof Database>;
  let settings: SettingRepo;
  let info: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    const fileRepo = makeFileRepo(db);
    const jobRepo = makeJobRepo(db, {
      setFileStatus: (id, status, v) => fileRepo.setStatus(id, status, v),
      bulkSetFileStatusToPending: (ids, st) => fileRepo.bulkSetStatusToPendingByIds(ids, st),
    });
    settings = makeSettingRepo(db);
    info = vi.fn();
    __forTests_setDeps({
      fileRepo: () => fileRepo,
      jobRepo: () => ({ ...jobRepo, peekQueued, claimById }) as never,
      settingRepo: () => settings,
      logger: { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      now: () => 1_800_000_000,
    });
  });

  afterEach(() => db.close());

  async function restart(): Promise<void> {
    await stopEncoderLoop();
    // A new process starts with the in-memory flag cleared.
    __resetPausedFlag();
    peekQueued.mockClear();
    startEncoderLoop();
    await new Promise((r) => setTimeout(r, 0));
  }

  it('stores the pause and restores it before the first dispatch', async () => {
    setQueuePaused(true);
    expect(settings.get('queue_paused')).toBe('1');

    await restart();

    expect(isQueuePaused()).toBe(true);
    expect(peekQueued).not.toHaveBeenCalled();
    expect(
      info.mock.calls.filter(
        (c) => (c[0] as { action?: string })?.action === 'queue_pause_restored',
      ),
    ).toHaveLength(1);
  });

  it('resuming stores the lifted pause', async () => {
    setQueuePaused(true);
    setQueuePaused(false);
    expect(settings.get('queue_paused')).toBe('0');

    await restart();

    expect(isQueuePaused()).toBe(false);
  });

  it('with the setting off a restart starts unpaused, but the state is still stored', async () => {
    settings.set('resume_after_restart', '0');
    setQueuePaused(true);
    expect(settings.get('queue_paused')).toBe('1');

    await restart();

    expect(isQueuePaused()).toBe(false);
  });

  it('switching the setting on after a resume does not bring back an old pause', async () => {
    settings.set('resume_after_restart', '0');
    setQueuePaused(true);
    await restart();
    // Unpaused after the restart; the operator presses resume anyway.
    setQueuePaused(false);
    expect(settings.get('queue_paused')).toBe('0');

    settings.set('resume_after_restart', '1');
    await restart();

    expect(isQueuePaused()).toBe(false);
  });
});
