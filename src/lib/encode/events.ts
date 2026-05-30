// 02-03 Task 2: typed in-memory engine event emitter (single-process).
//
// Inherits 02-02 §S11 single-process assumption: state below is per-Node-process.
// Multi-worker / cluster mode would need a shared store (e.g. Redis pub/sub) —
// out of scope (PROJECT.md mandates single-container deployment for unRAID).
//
// Public API:
//   engineEvents.emit(ev)               — fan out to all subscribers; safeEmit-wrapped
//   engineEvents.subscribe(listener)    — returns an unsubscribe function
//   engineEvents.getLastProgress(jobId) — replay-on-connect for SSE initial frame (S13)
//
// HMR-safe singleton via globalThis (declared in src/lib/global-runtime-state.d.ts).

import { EventEmitter } from 'node:events';
import { logger } from '../logger';

// audit-added S6 (02-03): NO filePath in job.started — PII surface on the
// unauthenticated v1.0 LAN-only SSE wire. UI resolves fileId → path via
// existing /api/library/:id when display is needed. Phase 5 logs viewer
// can re-introduce filePath under auth gate.
export type EngineEvent =
  // 2026-04-27 hotfix: encoder field added so the queue UI's ActiveSlotCard
  // can render the encoder badge during the encoding phase (UAT-discovered
  // gap — ActiveJob.encoder was hardcoded null in the client store because
  // the SSE event never carried it).
  | { type: 'job.started'; jobId: number; fileId: number; encoder: string }
  | {
      type: 'job.progress';
      jobId: number;
      fileId: number;
      frame: number | null;
      fps: number | null;
      outTimeMs: number | null;
      totalSize: number | null;
      progress: 'continue' | 'end';
    }
  | {
      type: 'job.completed';
      jobId: number;
      fileId: number;
      // 05-13 audit M4: outcome union widened from 2 → 3 values. SSE consumers
      // in components/queue/ + components/library/ render via STATUS_VISUALS
      // (Record<FileStatus, ...> exhaustiveness covers the new value at compile
      // time). Switch/map sites that hardcode the 2-value union must add a
      // 'done-not-worth' branch — see verify-grep gate in 05-13 PLAN.md T4.
      outcome: 'done-smaller' | 'done-larger' | 'done-not-worth';
      bytesIn: number;
      bytesOut: number;
      durationMs: number;
    }
  | {
      type: 'job.failed';
      jobId: number;
      fileId: number;
      exitCode: number;
      errorMsg: string;
    }
  | { type: 'job.cancelled'; jobId: number; fileId: number }
  | { type: 'queue.updated'; activeJobs: number; pendingJobs: number; paused: boolean }
  // 11-01: bench events — additive widening only
  | { type: 'bench.queued'; runId: number; mode: string; fileCount: number; comboCount: number }
  | { type: 'bench.started'; runId: number; startedAt: number }
  | {
      type: 'bench.progress';
      runId: number;
      comboId: number;
      fileId: number;
      sampleIdx: number;
      completedCombos: number;
      totalCombos: number;
      currentPhase: string;
    }
  | {
      // 11-02-FIX: per-combo sub-phase progress for live bar motion (UAT-001).
      // Throttled 1Hz leading-edge per-combo in bench orchestrator.
      type: 'bench.combo_progress';
      runId: number;
      comboId: number;
      phase: 'sample-extraction' | 'encode' | 'vmaf' | 'pareto';
      phasePct: number; // 0-100, within current phase
      overallPct: number; // 0-100, anchored per AC-5 (informational only; bar uses phasePct)
    }
  | {
      type: 'bench.combo_complete';
      runId: number;
      comboId: number;
      vmaf: number;
      sizeBytes: number;
      encodeSec: number;
    }
  | {
      type: 'bench.completed';
      runId: number;
      completedAt: number;
      paretoCount: number;
      top3RoleCounts: { quality: number; balanced: number; size: number };
    }
  | { type: 'bench.failed'; runId: number; errorReason: string }
  | { type: 'bench.cancelled'; runId: number; cancelledAt: number }
  // 11-03: Pass-2 full-file verify lifecycle. Single-encode events keyed by
  // (runId, comboId). overallPct contract: encode-phase emits 0..80,
  // vmaf-phase emits 80..100, monotonic non-decreasing per AC-10 / SR4.
  | {
      type: 'bench.pass2_started';
      runId: number;
      comboId: number;
      fileId: number;
      startedAt: number;
    }
  | {
      type: 'bench.pass2_progress';
      runId: number;
      comboId: number;
      overallPct: number;
      currentPhase: 'encode' | 'vmaf';
    }
  | {
      type: 'bench.pass2_complete';
      runId: number;
      comboId: number;
      vmaf: number;
      sizeBytes: number;
      encodeSec: number;
      completedAt: number;
    }
  | { type: 'bench.pass2_failed'; runId: number; comboId: number; errorReason: string };

export interface EngineEvents {
  emit(ev: EngineEvent): void;
  subscribe(listener: (ev: EngineEvent) => void): () => void;
  // audit-added S13: cache last job.progress per jobId so SSE initial frame can replay
  getLastProgress(jobId: number): EngineEvent | undefined;
  // 11-03: cache last bench.pass2_progress per comboId (replay-on-connect for Pass-2)
  getLastPass2Progress(comboId: number): EngineEvent | undefined;
}

const CHANNEL = 'engine_event';

function createEngineEvents(): EngineEvents {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0); // SSE allows many concurrent subscribers
  // audit-added S13: progress cache; cleared on terminal event to bound memory
  const lastProgress = new Map<number, EngineEvent>();
  // 11-03: per-combo Pass-2 progress cache (same pattern, comboId-keyed)
  const lastPass2Progress = new Map<number, EngineEvent>();

  return {
    emit(ev) {
      if (ev.type === 'job.progress') lastProgress.set(ev.jobId, ev);
      if (ev.type === 'job.completed' || ev.type === 'job.failed' || ev.type === 'job.cancelled') {
        lastProgress.delete(ev.jobId);
      }
      if (ev.type === 'bench.pass2_progress') lastPass2Progress.set(ev.comboId, ev);
      if (ev.type === 'bench.pass2_complete' || ev.type === 'bench.pass2_failed') {
        lastPass2Progress.delete(ev.comboId);
      }

      // audit-added M1 (02-03): safeEmit — listener throws MUST NOT propagate.
      // Orchestrator emits inside its loopOnce flow; an uncaught throw would be
      // caught by the orchestrator's top-level try/catch and would markFailed an
      // actually-successful job. Iterate listeners explicitly so one bad listener
      // does NOT short-circuit the rest.
      for (const listener of emitter.listeners(CHANNEL) as Array<(e: EngineEvent) => void>) {
        try {
          listener(ev);
        } catch (err) {
          logger.warn(
            {
              action: 'sse_listener_threw',
              err: err instanceof Error ? err.message : String(err),
              evType: ev.type,
            },
            'engineEvents listener threw — continuing to next listener',
          );
        }
      }
    },

    subscribe(listener) {
      emitter.on(CHANNEL, listener);
      return () => emitter.off(CHANNEL, listener);
    },

    getLastProgress(jobId) {
      return lastProgress.get(jobId);
    },

    getLastPass2Progress(comboId) {
      return lastPass2Progress.get(comboId);
    },
  };
}

// HMR-safe singleton — globalThis declared in src/lib/global-runtime-state.d.ts
export const engineEvents: EngineEvents = (globalThis.__x265butler_engine_events ??=
  createEngineEvents());

// Test-only — let tests inject a fresh emitter to avoid cross-test listener leaks.
export function __forTests_resetEngineEvents(): void {
  globalThis.__x265butler_engine_events = createEngineEvents();
}
