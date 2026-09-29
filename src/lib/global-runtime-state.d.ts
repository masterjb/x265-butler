// audit-added S5 (02-03): consolidated declarations for HMR-safe runtime singletons.
// Both server-init.ts (encoder loop bootstrap state) and encode/events.ts (engineEvents
// EventEmitter) use globalThis-backed singletons so Next.js dev hot-reload of their
// implementation modules does not leak listeners or restart the encoder loop.
//
// Keeping these declarations in ONE ambient .d.ts file (instead of `declare global`
// blocks scattered across implementation modules) makes the runtime-global surface
// auditable in a single place — important context for any future Phase 5 cluster /
// multi-process discussion (this file is the COMPLETE list of process-wide state).
//
// `var` is required for `declare global` augmentation — TypeScript treats `let`/`const`
// declarations differently in ambient global scope; `var` is the canonical pattern.
// ESLint's no-var rule does NOT fire inside `declare global` (verified locally), so the
// previously-included `// eslint-disable-next-line no-var` directives were unused and
// produced "Unused eslint-disable directive" warnings on CI lint.

import type { IntervalHistogram } from 'node:perf_hooks';
import type { EngineEvents } from './encode/events';
import type { DetectionResult } from './encode/detection';

declare global {
  var __x265butler_init: { started: boolean; sweepTimer: NodeJS.Timeout | null } | undefined;

  // 40-01: HMR-safe handle for the headless cpu_attribution sampler (timer +
  // event-loop-delay histogram). A module-level handle would leak the
  // setInterval + double-emit on a Next.js HMR module re-import; keeping it on
  // globalThis lets startCpuAttributionSampler's idempotent guard see the live
  // timer. See diagnostics/cpu-attribution-sampler.ts.
  var __x265butler_cpu_attribution_sampler:
    | { timer: NodeJS.Timeout | null; histogram: IntervalHistogram | null }
    | undefined;

  var __x265butler_engine_events: EngineEvents | undefined;

  // 03-01 audit-added S12: cached encoder detection result (HMR-safe).
  // Cleared via invalidateEncoderCache() (S4) for the future Settings UI
  // operator GPU-swap path.
  var __x265butler_encoder_cache: DetectionResult | undefined;

  // 39-01: boot-race single-flight guard. At fresh-install boot, startEncoderLoop
  // fires detectEncoders() (orchestrator.ts:3095) AND dispatchUntilFull's
  // await detectEncoders() (orchestrator.ts:2906) concurrently against an empty
  // cache → two runDetection() → two concurrent VAAPI probe-encodes self-contend
  // for the AMD card's single encode session → one exits non-zero →
  // compiled-in-broken → card cached-out for the process lifetime. This shared
  // in-flight Promise makes concurrent bare callers join ONE runDetection.
  // force:true bypasses it (always fresh, never the shared join target). Cleared
  // by the .finally identity-guard on resolve OR reject (failed detection is
  // never cached → no permanent poison).
  var __x265butler_encoder_detect_inflight: Promise<DetectionResult> | undefined;

  // 03-04 audit M3: ffmpeg version probed once per process at server-init.
  // null = probe failed (binary missing or non-zero exit); string = probed
  // version (e.g. "6.0.1"); undefined = not yet probed (cold-cold first call).
  // Populated by probeFfmpegVersionAtBoot (fire-and-forget from ensureServerInit).
  // Read by /api/stats route handler + /[locale]/dashboard Server Component
  // via getFfmpegVersionCached().
  var __x265butler_ffmpeg_version: string | null | undefined;

  // 2026-04-27 hotfix: HMR-safe single-shot guard for SIGTERM/SIGINT db.close
  // listener registration. See src/lib/db/index.ts:registerShutdownHandlers
  // for context — module-local flag accumulated listeners on every Next.js
  // dev hot-reload, triggering MaxListenersExceededWarning at the 11th cycle.
  var __x265butler_shutdown_registered: boolean | undefined;
}

export {};
