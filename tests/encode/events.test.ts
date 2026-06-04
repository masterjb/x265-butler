import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  engineEvents,
  __forTests_resetEngineEvents,
  type EngineEvent,
} from '@/src/lib/encode/events';

describe('engineEvents (02-03 Task 2)', () => {
  beforeEach(() => {
    __forTests_resetEngineEvents();
  });

  it('test_subscribe_then_emit_then_listener_called_synchronously', () => {
    const events = globalThis.__x265butler_engine_events!;
    const listener = vi.fn();
    events.subscribe(listener);
    const ev: EngineEvent = {
      type: 'queue.updated',
      activeJobs: 1,
      pendingJobs: 0,
      paused: false,
    };
    events.emit(ev);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(ev);
  });

  it('test_unsubscribe_removes_listener', () => {
    const events = globalThis.__x265butler_engine_events!;
    const listener = vi.fn();
    const unsubscribe = events.subscribe(listener);
    unsubscribe();
    events.emit({ type: 'queue.updated', activeJobs: 0, pendingJobs: 0, paused: false });
    expect(listener).not.toHaveBeenCalled();
  });

  it('test_100_subscribers_no_MaxListenersExceededWarning', () => {
    const events = globalThis.__x265butler_engine_events!;
    const warnings: string[] = [];
    const orig = process.emitWarning.bind(process);
    process.emitWarning = ((warning: string | Error) => {
      warnings.push(typeof warning === 'string' ? warning : warning.message);
    }) as typeof process.emitWarning;
    try {
      const unsubs: Array<() => void> = [];
      for (let i = 0; i < 100; i++) {
        unsubs.push(events.subscribe(() => {}));
      }
      // setMaxListeners(0) means no warning ever; tear down so we don't leak
      unsubs.forEach((u) => u());
    } finally {
      process.emitWarning = orig;
    }
    expect(warnings.filter((w) => w.includes('MaxListenersExceeded'))).toHaveLength(0);
  });

  it('test_emit_with_typed_event_preserves_shape', () => {
    const events = globalThis.__x265butler_engine_events!;
    const captured: EngineEvent[] = [];
    events.subscribe((ev) => captured.push(ev));
    events.emit({ type: 'job.started', jobId: 7, fileId: 42, encoder: 'libx265' });
    events.emit({
      type: 'job.completed',
      jobId: 7,
      fileId: 42,
      outcome: 'done-smaller',
      bytesIn: 100,
      bytesOut: 50,
      durationMs: 1234,
    });
    expect(captured).toHaveLength(2);
    expect(captured[0]).toMatchObject({ type: 'job.started', jobId: 7, fileId: 42 });
    expect(captured[1]).toMatchObject({ type: 'job.completed', outcome: 'done-smaller' });
  });

  // audit-added M1: safeEmit isolation
  it('test_safeEmit_when_listener_throws_then_other_listeners_still_fire', () => {
    const events = globalThis.__x265butler_engine_events!;
    const ok1 = vi.fn();
    const bad = vi.fn().mockImplementation(() => {
      throw new Error('listener crashed');
    });
    const ok2 = vi.fn();
    events.subscribe(ok1);
    events.subscribe(bad);
    events.subscribe(ok2);
    const ev: EngineEvent = {
      type: 'queue.updated',
      activeJobs: 0,
      pendingJobs: 0,
      paused: false,
    };
    expect(() => events.emit(ev)).not.toThrow();
    expect(ok1).toHaveBeenCalledWith(ev);
    expect(bad).toHaveBeenCalledWith(ev);
    expect(ok2).toHaveBeenCalledWith(ev);
  });

  it('test_safeEmit_when_listener_throws_then_emit_returns_normally_no_propagation', () => {
    // Critical M1 invariant: orchestrator's loopOnce calls events.emit and
    // expects it NEVER to throw — otherwise the encode is markFailed.
    const events = globalThis.__x265butler_engine_events!;
    events.subscribe(() => {
      throw new Error('boom');
    });
    expect(() => events.emit({ type: 'job.cancelled', jobId: 1, fileId: 1 })).not.toThrow();
  });

  // audit-added S13: getLastProgress
  it('test_getLastProgress_returns_undefined_when_no_progress', () => {
    const events = globalThis.__x265butler_engine_events!;
    expect(events.getLastProgress(99)).toBeUndefined();
  });

  it('test_getLastProgress_caches_most_recent_per_jobId', () => {
    const events = globalThis.__x265butler_engine_events!;
    events.emit({
      type: 'job.progress',
      jobId: 1,
      fileId: 1,
      frame: 100,
      fps: 30,
      outTimeMs: 3300000,
      totalSize: 12345,
      progress: 'continue',
    });
    events.emit({
      type: 'job.progress',
      jobId: 1,
      fileId: 1,
      frame: 200,
      fps: 30,
      outTimeMs: 6600000,
      totalSize: 24690,
      progress: 'continue',
    });
    const cached = events.getLastProgress(1);
    expect(cached).toMatchObject({ frame: 200, totalSize: 24690 });
  });

  it('test_getLastProgress_clears_on_terminal_event', () => {
    const events = globalThis.__x265butler_engine_events!;
    events.emit({
      type: 'job.progress',
      jobId: 1,
      fileId: 1,
      frame: 100,
      fps: 30,
      outTimeMs: 3300000,
      totalSize: 12345,
      progress: 'continue',
    });
    expect(events.getLastProgress(1)).toBeDefined();

    events.emit({
      type: 'job.completed',
      jobId: 1,
      fileId: 1,
      outcome: 'done-smaller',
      bytesIn: 100,
      bytesOut: 50,
      durationMs: 1234,
    });
    expect(events.getLastProgress(1)).toBeUndefined();
  });

  it('test_getLastProgress_clears_on_failed_and_cancelled', () => {
    const events = globalThis.__x265butler_engine_events!;
    events.emit({
      type: 'job.progress',
      jobId: 1,
      fileId: 1,
      frame: 1,
      fps: 1,
      outTimeMs: 1,
      totalSize: 1,
      progress: 'continue',
    });
    events.emit({
      type: 'job.failed',
      jobId: 1,
      fileId: 1,
      exitCode: 1,
      errorMsg: 'boom',
    });
    expect(events.getLastProgress(1)).toBeUndefined();

    events.emit({
      type: 'job.progress',
      jobId: 2,
      fileId: 2,
      frame: 1,
      fps: 1,
      outTimeMs: 1,
      totalSize: 1,
      progress: 'continue',
    });
    events.emit({ type: 'job.cancelled', jobId: 2, fileId: 2 });
    expect(events.getLastProgress(2)).toBeUndefined();
  });

  it('test___forTests_resetEngineEvents_creates_fresh_instance_no_leaked_listeners', () => {
    const before = globalThis.__x265butler_engine_events;
    const stale = vi.fn();
    before!.subscribe(stale);

    __forTests_resetEngineEvents();

    const after = globalThis.__x265butler_engine_events;
    expect(after).not.toBe(before);

    // Emit on the new singleton — stale listener from old singleton must NOT fire
    after!.emit({ type: 'queue.updated', activeJobs: 0, pendingJobs: 0, paused: false });
    expect(stale).not.toHaveBeenCalled();
  });

  it('test_engineEvents_singleton_uses_globalThis_for_HMR_safety', () => {
    // After reset, globalThis is repopulated; subsequent module-level access to
    // engineEvents (via the imported binding) STILL points at the OLD instance
    // because Task 2's events.ts captures globalThis at module load. Verify by
    // checking the GLOBAL ref is updated (HMR will read this on re-import).
    __forTests_resetEngineEvents();
    expect(globalThis.__x265butler_engine_events).toBeDefined();
  });

  // engineEvents binding is the live singleton at module-load time. After
  // __forTests_resetEngineEvents, NEW code paths reading globalThis get the
  // fresh instance, but cached `engineEvents` from this test file still points
  // at the original. That's the intended HMR semantic (production never reset).
  it('test_engineEvents_imported_binding_is_stable_for_consumers', () => {
    expect(engineEvents).toBeDefined();
    expect(typeof engineEvents.emit).toBe('function');
    expect(typeof engineEvents.subscribe).toBe('function');
    expect(typeof engineEvents.getLastProgress).toBe('function');
    expect(typeof engineEvents.getLastPass2Progress).toBe('function');
  });

  // 11-03 AC-10: 4 new bench.pass2_* events compile + round-trip through emit
  it('test_bench_pass2_started_progress_complete_failed_round_trip', () => {
    const events = globalThis.__x265butler_engine_events!;
    const captured: EngineEvent[] = [];
    events.subscribe((ev) => captured.push(ev));
    events.emit({
      type: 'bench.pass2_started',
      runId: 1,
      comboId: 42,
      fileId: 10,
      startedAt: 1000,
    });
    events.emit({
      type: 'bench.pass2_progress',
      runId: 1,
      comboId: 42,
      overallPct: 50,
      currentPhase: 'encode',
    });
    events.emit({
      type: 'bench.pass2_complete',
      runId: 1,
      comboId: 42,
      vmaf: 95,
      sizeBytes: 4_000_000_000,
      encodeSec: 600,
      completedAt: 2000,
    });
    events.emit({
      type: 'bench.pass2_failed',
      runId: 1,
      comboId: 42,
      errorReason: 'cancelled',
    });
    expect(captured.map((e) => e.type)).toEqual([
      'bench.pass2_started',
      'bench.pass2_progress',
      'bench.pass2_complete',
      'bench.pass2_failed',
    ]);
  });

  // 11-03: getLastPass2Progress caches per comboId + clears on terminal event
  it('test_getLastPass2Progress_caches_per_comboId_and_clears_on_complete', () => {
    const events = globalThis.__x265butler_engine_events!;
    expect(events.getLastPass2Progress(42)).toBeUndefined();

    events.emit({
      type: 'bench.pass2_progress',
      runId: 1,
      comboId: 42,
      overallPct: 30,
      currentPhase: 'encode',
    });
    events.emit({
      type: 'bench.pass2_progress',
      runId: 1,
      comboId: 42,
      overallPct: 85,
      currentPhase: 'vmaf',
    });
    expect(events.getLastPass2Progress(42)).toMatchObject({
      overallPct: 85,
      currentPhase: 'vmaf',
    });
    expect(events.getLastPass2Progress(99)).toBeUndefined();

    events.emit({
      type: 'bench.pass2_complete',
      runId: 1,
      comboId: 42,
      vmaf: 95,
      sizeBytes: 1,
      encodeSec: 1,
      completedAt: 1,
    });
    expect(events.getLastPass2Progress(42)).toBeUndefined();
  });

  it('test_getLastPass2Progress_clears_on_pass2_failed', () => {
    const events = globalThis.__x265butler_engine_events!;
    events.emit({
      type: 'bench.pass2_progress',
      runId: 1,
      comboId: 7,
      overallPct: 40,
      currentPhase: 'encode',
    });
    events.emit({
      type: 'bench.pass2_failed',
      runId: 1,
      comboId: 7,
      errorReason: 'boom',
    });
    expect(events.getLastPass2Progress(7)).toBeUndefined();
  });
});
