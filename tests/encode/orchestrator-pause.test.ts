// 32-02: in-memory pause-after-current. Asserts the dispatch gate (paused stops
// NEXT-dispatch, running is NOT aborted, resume restarts immediately), the
// emitQueueUpdated paused payload, setQueuePaused idempotency, and the cross-module
// barrel singleton (isQueuePaused via the encode barrel reflects setQueuePaused).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  __forTests_resetOrchestrator,
  __forTests_setDeps,
  __forTests_dispatchUntilFull,
  __forTests_registerActiveController,
  setQueuePaused,
  isQueuePaused,
} from '@/src/lib/encode/orchestrator';
// SR-3: import the getter via the BARREL the watcher/status/page consume — proves
// they observe the SAME module-level _paused instance (no divergent copies).
import { isQueuePaused as isQueuePausedViaBarrel } from '@/src/lib/encode';
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
  it('AC-6 default state is unpaused after reset', () => {
    expect(isQueuePaused()).toBe(false);
  });

  it('AC-1 emits queue.updated with paused:true on pause', () => {
    setQueuePaused(true);
    expect(isQueuePaused()).toBe(true);
    const last = emitsForQueueUpdated().at(-1)![0] as { paused: boolean };
    expect(last.paused).toBe(true);
  });

  it('AC-2 emits queue.updated with paused:false on resume', () => {
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

  it('SR-3 barrel getter reflects the same _paused instance', () => {
    setQueuePaused(true);
    expect(isQueuePausedViaBarrel()).toBe(true);
    setQueuePaused(false);
    expect(isQueuePausedViaBarrel()).toBe(false);
  });
});

describe('dispatch gate (pause-after-current)', () => {
  it('AC-1 paused-from-idle: tryDispatchOne is not reached (peekQueued never called)', async () => {
    setQueuePaused(true);
    peekQueued.mockClear();
    await __forTests_dispatchUntilFull();
    // The `while (!_stopping && !_paused)` guard short-circuits before the body,
    // so tryDispatchOne — and thus peekQueued/claimById — is never invoked.
    expect(peekQueued).not.toHaveBeenCalled();
    expect(claimById).not.toHaveBeenCalled();
  });

  it('AC-1 pause does NOT abort an in-flight encode (pause-after-current)', () => {
    const ctrl = new AbortController();
    __forTests_registerActiveController(QUEUED_JOB.id, ctrl);
    setQueuePaused(true);
    expect(ctrl.signal.aborted).toBe(false);
  });

  it('AC-2 resume restarts dispatch immediately (claim attempted without idle wait)', async () => {
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

  it('AC-1 while paused, a resume-then-repause leaves dispatch gated', async () => {
    setQueuePaused(false); // no-op (already false) — sanity
    setQueuePaused(true);
    peekQueued.mockClear();
    await __forTests_dispatchUntilFull();
    expect(peekQueued).not.toHaveBeenCalled();
  });
});
