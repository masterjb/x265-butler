// Barrel — public API consumed by the route handlers.
// Note: runEncode + staging helpers + loopOnce + __forTests_* NOT re-exported
// here. They remain module-internal; orchestrator state-machine is the
// supported integration surface.
export {
  startEncoderLoop,
  stopEncoderLoop,
  cancelJob,
  // Skip + Cancel-All-Queued (replaced the earlier requestStopAll +
  // setPaused/isPaused stop model).
  skipActive,
  cancelAllQueued,
  // In-memory pause-after-current control. setQueuePaused driven
  // by POST /api/queue/pause|resume; isQueuePaused is the single cross-module
  // getter consumed by the watcher emit, GET /api/queue/status, and the SSR page.
  setQueuePaused,
  isQueuePaused,
  // Settings UI hook for operator-confirmed
  // concurrency change. Re-reads settings + os.cpus + recomputes _perEncoderLimits.
  recomputePerEncoderLimits,
  // Settings UI hook for operator-confirmed
  // encoder change. Clears orchestrator's module-local _detectionResult so
  // next processOne falls through to freshly-cached globalThis detection.
  invalidateOrchestratorDetectionCache,
} from './orchestrator';

// Typed engine event emitter for SSE consumers.
// engineEvents.subscribe is consumed by app/api/events/route.ts (server-side)
// AND by the Queue/Trash UI's EventSource client (browser-side via fetch).
export { engineEvents } from './events';
export type { EngineEvent, EngineEvents } from './events';

// Encoder detection + profile registry surface.
// Consumed by app/api/encoders/route.ts AND src/lib/encode/orchestrator.ts AND
// src/lib/encode/ffmpeg.ts. detection.ts is server-only (top-of-file window
// guard); profiles.ts is pure-function and safe anywhere.
export {
  detectEncoders,
  invalidateEncoderCache,
  ENCODER_IDS,
  // Structured detection-warnings surface.
  DETECTION_WARNING_CODES,
  // The forced-IDR verdict accessor. Consumed by the diagnostics
  // test-encode runner so it resolves the SAME value the production buildArgs
  // resolves — otherwise the test encode would validate an argv the
  // production path no longer emits on a degraded host.
  isForcedIdrSupported,
} from './detection';
export type {
  EncoderId,
  DetectionResult,
  DetectionWarning,
  DetectionWarningCode,
  // Per-encoder runtime-probe outcome label (consumed by diagnostics).
  EncoderOutcome,
} from './detection';
export {
  buildCodecBlock,
  buildEncodeArgs,
  PROFILE_BUILDERS,
  // Factory-default preset table — consumed by the diagnostics
  // buildTestEncodeArgs builder (mirrors the detection runtime probe's use).
  DEFAULT_PRESET_BY_ENCODER,
  // Shared HW-safe probe/test-encode frame size. Cross-directory consumer
  // src/lib/diagnostics/test-encode.ts imports it via this barrel (NOT a deep
  // './profiles' path) — same as buildCodecBlock / DEFAULT_PRESET_BY_ENCODER.
  PROBE_FRAME_SIZE,
  // Shared synthetic-probe pixel-format pin + the predicate for the
  // encoders that consume it. Same cross-directory consumer as PROBE_FRAME_SIZE
  // (src/lib/diagnostics/test-encode.ts), imported via this barrel.
  SYNTHETIC_PROBE_PIX_FMT,
  usesSyntheticPixFmtPin,
  // Per-encoder factory CRF defaults. Re-exported through profiles.ts
  // from the dependency-free leaf './crf-defaults'. SERVER consumers only —
  // client components import '@/src/lib/encode/crf-defaults' directly, because
  // this barrel pulls orchestrator + detection.
  DEFAULT_CRF_BY_ENCODER,
} from './profiles';
export type { CodecBlockInput, EncodeProfileInput } from './profiles';
// The shared settings resolvers — ONE source for "which encoder / which
// CRF / which preset would this host actually use", consumed by the production
// dispatch (orchestrator.ts) AND the /diagnostics test encode. SERVER consumers
// only, same caveat as DEFAULT_CRF_BY_ENCODER above: this barrel pulls
// orchestrator + detection, so a client component must never take a VALUE import
// from here.
export {
  resolveCrfForEncoder,
  resolveDefaultCrf,
  resolveForce10bit,
  resolvePresetForEncoder,
  resolveRequestedEncoder,
} from './encode-settings-resolve';
export type { RequestedEncoder, ResolvedPreset } from './encode-settings-resolve';
// qsv ratecontrol variant — consumed by the diagnostics buildTestEncodeArgs
// builder (threads det.qsvRateControl, keeping the pure builder global-read-free).
export type { QsvRateControl } from './profiles';

// Per-encoder concurrency limits + Settings UI hook.
// computePerEncoderLimits is pure function (no fs/db/state); recompute hook
// lives in orchestrator and is exported via this barrel for the
// Settings UI consumer (operator-confirmed concurrency change path).
export { computePerEncoderLimits } from './concurrency';
export type { PerEncoderLimits, LimitsInput } from './concurrency';

// ffmpeg version probe at server-init time.
// probeFfmpegVersionAtBoot is fire-and-forget; getFfmpegVersionCached returns
// the cached value (string OR null OR undefined→null). Consumed by
// server-init.ts (boot trigger) + /api/stats route + Dashboard Server Component.
export {
  probeFfmpegVersionAtBoot,
  getFfmpegVersionCached,
  getFfmpegNvencVersionCached,
} from './ffmpeg-version';

// Preset catalog — encoder preset lists consumed by the bench and the
// encoder profile editor. Pure data, no server deps.
export { PRESETS_BY_ENCODER, isValidPreset } from './presets';
export type { PresetByEncoder } from './presets';

// Sidecar JSON helpers — atomic write at orchestrator commit
// step (writeSidecar) + skip-pipeline read path (readSidecar) + boot-time tmp
// orphan sweep (sweepSidecarTmpFiles). SidecarV1 type re-exported
// for the skip module + the retry/self-heal contract.
//
// selfHealSidecar — scan-time idempotent helper invoked from
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

// Cache-pool resolver. Diagnostics aggregator +
// Settings page import the *Cached* read-surface variant; orchestrator dispatch
// imports the PURE variant directly (deep path) to keep the late-mount-at-
// dispatch contract. Dependency-light (only ./staging) so server pages +
// diagnostics import it WITHOUT pulling the heavy orchestrator graph.
export {
  resolveEffectiveCachePath,
  resolveEffectiveCachePathCached,
  defaultProbeMntCacheWritable,
  __resetCachePathMemo,
  CACHE_MOUNT_ROOT,
  MNT_CACHE_DEFAULT,
  CONFIG_CACHE_FALLBACK,
  MNT_CACHE_PROBE_ROOT,
  READ_SURFACE_TTL_MS,
} from './cache-path';
export type { CacheResolution, EffectiveCachePath } from './cache-path';

// The cover-art attach surface. attached-pic.ts is the PURE half
// (zero fs / logger / spawn — safe anywhere); cover-extract.ts is the spawn leaf
// (server-only, same class as cropdetect.ts, which the orchestrator already
// pulls into this barrel). The `__forTests_*` seams are deliberately NOT
// re-exported — tests import them from the deep path.
export {
  isAttachedPictureStream,
  analyzeAttachedPictures,
  describeAttachedPictures,
  countAttachmentStreams,
  sanitizeAttachmentFilename,
  COVER_MEDIA_BY_CODEC,
} from './attached-pic';
export type { AttachedPicAnalysis, CoverStream, CoverMedia } from './attached-pic';
export {
  extractCovers,
  buildCoverExtractArgs,
  coverAttachEnabled,
  resolveCoverAttachEnabled,
  COVER_ATTACH_MAX,
  COVER_EXTRACT_TIMEOUT_MS,
} from './cover-extract';
export type { CoverAttachment } from './cover-extract';
