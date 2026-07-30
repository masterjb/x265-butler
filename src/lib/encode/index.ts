// 02-02 barrel — public API consumed by Plan 02-03 Route Handlers.
// Note: runEncode + staging helpers + loopOnce + __forTests_* NOT re-exported
// here. They remain module-internal; orchestrator state-machine is the
// supported integration surface.
export {
  startEncoderLoop,
  stopEncoderLoop,
  cancelJob,
  // 05-09 additive: Skip + Cancel-All-Queued (replaces 05-08 B1 requestStopAll
  // + setPaused/isPaused; Pause concept retired entirely — see Skip + Cancel-
  // All-Queued for the replacement model).
  skipActive,
  cancelAllQueued,
  // 32-02 additive: in-memory pause-after-current control. setQueuePaused driven
  // by POST /api/queue/pause|resume; isQueuePaused is the single cross-module
  // getter consumed by the watcher emit, GET /api/queue/status, and the SSR page.
  setQueuePaused,
  isQueuePaused,
  // 03-02 audit-added S3: 03-03 Settings UI hook for operator-confirmed
  // concurrency change. Re-reads settings + os.cpus + recomputes _perEncoderLimits.
  recomputePerEncoderLimits,
  // 03-03 audit-added M3: 03-03 Settings UI hook for operator-confirmed
  // encoder change. Clears orchestrator's module-local _detectionResult so
  // next processOne falls through to freshly-cached globalThis detection.
  invalidateOrchestratorDetectionCache,
} from './orchestrator';

// 02-03 additive: typed engine event emitter for SSE consumers.
// engineEvents.subscribe is consumed by app/api/events/route.ts (server-side)
// AND by 02-04 Queue/Trash UI's EventSource client (browser-side via fetch).
export { engineEvents } from './events';
export type { EngineEvent, EngineEvents } from './events';

// 03-01 additive: encoder detection + profile registry surface (audit S12).
// Consumed by app/api/encoders/route.ts AND src/lib/encode/orchestrator.ts AND
// src/lib/encode/ffmpeg.ts. detection.ts is server-only (top-of-file window
// guard per audit S8); profiles.ts is pure-function and safe anywhere.
export {
  detectEncoders,
  invalidateEncoderCache,
  ENCODER_IDS,
  // Phase 18 additive: structured detection-warnings surface.
  DETECTION_WARNING_CODES,
} from './detection';
export type {
  EncoderId,
  DetectionResult,
  DetectionWarning,
  DetectionWarningCode,
  // 23-04: per-encoder runtime-probe outcome label (consumed by diagnostics).
  EncoderOutcome,
} from './detection';
export {
  buildCodecBlock,
  buildEncodeArgs,
  PROFILE_BUILDERS,
  // 24-02: factory-default preset table — consumed by the diagnostics
  // buildTestEncodeArgs builder (mirrors the 23-04 probe's use).
  DEFAULT_PRESET_BY_ENCODER,
  // 29-01: shared HW-safe probe/test-encode frame size. Cross-directory consumer
  // src/lib/diagnostics/test-encode.ts imports it via this barrel (NOT a deep
  // './profiles' path) — same as buildCodecBlock / DEFAULT_PRESET_BY_ENCODER.
  PROBE_FRAME_SIZE,
} from './profiles';
export type { CodecBlockInput, EncodeProfileInput } from './profiles';
// 30-01: qsv ratecontrol variant — consumed by the diagnostics buildTestEncodeArgs
// builder (threads det.qsvRateControl, keeping the pure builder global-read-free).
export type { QsvRateControl } from './profiles';

// 03-02 additive: per-encoder concurrency limits + future Settings UI hook.
// computePerEncoderLimits is pure function (no fs/db/state); recompute hook
// lives in orchestrator (Task 2) and is exported via this barrel for the
// 03-03 Settings UI consumer (operator-confirmed concurrency change path).
export { computePerEncoderLimits } from './concurrency';
export type { PerEncoderLimits, LimitsInput } from './concurrency';

// 03-04 audit M3 additive: ffmpeg version probe at server-init time.
// probeFfmpegVersionAtBoot is fire-and-forget; getFfmpegVersionCached returns
// the cached value (string OR null OR undefined→null). Consumed by
// server-init.ts (boot trigger) + /api/stats route + Dashboard Server Component.
export { probeFfmpegVersionAtBoot, getFfmpegVersionCached } from './ffmpeg-version';

// 10-03 additive: W9 Preset-Catalog — encoder preset lists consumed by
// P11-Bench + P12-Encoder-Profile-Editor. Pure data, no server deps.
export { PRESETS_BY_ENCODER, isValidPreset } from './presets';
export type { PresetByEncoder } from './presets';

// 04-01 additive: sidecar JSON helpers — atomic write at orchestrator commit
// step (writeSidecar) + skip-pipeline read path (readSidecar) + boot-time tmp
// orphan sweep (sweepSidecarTmpFiles per audit M5). SidecarV1 type re-exported
// for the Plan 04-02 skip module + 04-03 retry/self-heal contract.
//
// 04-03 additive: selfHealSidecar — scan-time idempotent helper invoked from
// scan/orchestrator on db-hash skip-pipeline source (sidecar absent but DB row
// matches disk content hash; sidecar gets written without touching MKV body).
export {
  writeSidecar,
  readSidecar,
  selfHealSidecar,
  sweepSidecarTmpFiles,
  sidecarPathFor,
  type SidecarV1,
} from './sidecar';

// 24-03 (F2) additive: DC-B cache-pool resolver. Diagnostics aggregator +
// Settings page import the *Cached* read-surface variant; orchestrator dispatch
// imports the PURE variant directly (deep path) to keep the late-mount-at-
// dispatch contract. Dependency-light (only ./staging) so server pages +
// diagnostics import it WITHOUT pulling the heavy orchestrator graph.
export {
  resolveEffectiveCachePath,
  resolveEffectiveCachePathCached,
  defaultProbeMntCacheWritable,
  __resetCachePathMemo,
  MNT_CACHE_DEFAULT,
  CONFIG_CACHE_FALLBACK,
  MNT_CACHE_PROBE_ROOT,
  READ_SURFACE_TTL_MS,
} from './cache-path';
export type { CacheResolution, EffectiveCachePath } from './cache-path';
