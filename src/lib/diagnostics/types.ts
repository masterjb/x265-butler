// Phase 21 Plan 21-01 — shared diagnostics types.
//
// Type-only module — zero runtime exports. Imported by aggregator, route
// handlers, markdown template, and tests.

import type { EncoderOutcome } from '@/src/lib/encode';

export type WarningSource = 'encoder' | 'mount' | 'onboarding' | 'aggregator';

export interface MountProbeResult {
  path: string;
  readable: boolean;
  writable: boolean;
  error?: string;
}

export interface AggregatedWarning {
  severity: 'warn' | 'error';
  source: WarningSource;
  code: string;
  message: string;
}

export interface RecentErrorEntry {
  ts: number;
  level: number;
  msg: string;
  source?: string;
}

export interface AppVersionBlock {
  version: string;
  gitHash: string;
  committedAt: number | null;
  committedAtCET: string | null;
}

export interface RuntimeBlock {
  nodeVersion: string;
  platform: string;
  arch: string;
  uptimeSec: number;
  pid: number;
}

// 23-02: per render-node permission evidence — surfaces the render-group GID
// mismatch behind cryptic `MFX session: -9`. Pairs with the 23-01 stderr hint:
// 23-01 names the failure class, 23-02 names the exact mismatch (`--group-add
// <gid>` / `PGID=<gid>`). Evidence-only — NO AggregatedWarning emitted (D2=A).
export interface RenderDeviceProbe {
  path: string;
  exists: boolean;
  gid: number | null;
  groupName: string | null;
  processGroups: number[];
  processGid: number | null; // audit M1 — primary/effective gid (PGID fix-path)
  inRenderGroup: boolean; // gid ∈ processGroups OR gid === processGid
  readable: boolean;
  writable: boolean;
  error?: string;
}

export interface DeviceBlock {
  dri: string[];
  nvidia: string[];
  // 23-02: additive NON-OPTIONAL — aggregator always populates ([] on failure).
  // Deliberately non-optional (mirrors 23-01 mappedError): forces compile-time
  // enumeration of every fixture site rather than silent drift.
  renderDevices: RenderDeviceProbe[];
}

export interface EncoderBlock {
  detected: string[];
  warnings: Array<{ code: string; message?: string }>;
  // 23-04: per-encoder runtime-probe outcome. Additive NON-OPTIONAL (mirrors the
  // 23-02 DeviceBlock.renderDevices precedent) — aggregator ALWAYS populates;
  // forces compile-time enumeration at every fixture site rather than silent
  // drift. `detail` carries the bounded stderr excerpt for compiled-in-broken.
  outcome: { encoder: string; outcome: EncoderOutcome; detail?: string }[];
  // 23-04 (audit SR2/AC-12): probe-encode kill-switch state. Optional — absent or
  // false ⇒ gate active; true ⇒ outcomes are feature-parse-only, NOT verified.
  probeEncodeDisabled?: boolean;
}

export interface OnboardingBlock {
  completed: boolean;
  hasShare: boolean;
}

// 23-05: CPU / iGPU generation capability evidence — surfaces the human-readable
// WHY behind "qsv unavailable" (e.g. "Intel Broadwell gen5 predates HEVC-QSV
// hardware — use libx265"). Mirrors the CpuCapability classifier output.
// `hevcQsv` reflects HARDWARE capability by the embedded gen-table; runtime
// QSV-functionality is verified separately by the probe-encode (23-04).
// Evidence-only — NO AggregatedWarning emitted (mirrors 23-02 D2=A).
export interface CpuBlock {
  isIntel: boolean;
  vendorId: string | null;
  modelName: string | null;
  family: number | null;
  model: number | null;
  microarch: string | null;
  graphicsGen: number | null;
  hevcQsv: 'none' | '8bit' | '10bit' | 'unknown';
}

// 22-00 IMP-8: blocklist-evaluation block — surfaces blocklist count +
// recent in-pipeline evaluations decoded from pino ring-buffer.
export interface BlocklistMatchedEntryRef {
  id: number;
  kind: 'file_id' | 'path_pattern';
  pattern?: string;
}

export interface BlocklistRecentEvaluationEntry {
  path: string;
  matchedEntry: BlocklistMatchedEntryRef | null;
  matchedAt: string;
}

export interface BlocklistEvaluationBlock {
  totalEntries: number;
  recentEvaluations: BlocklistRecentEvaluationEntry[];
  patternCachedAt: string | null;
}

// 22-00 IMP-11: container-image block — OS / glibc / driver / ffmpeg surface.
// Boot-cached singleton; refresh via `GET /api/diagnostics?refresh=1`.
// 22-01 IMP-2: slow_request block — surfaces top-N slow Server-Component reads
// decoded from pino ring-buffer (consumer-only).
export interface SlowRequestEntry {
  route: string;
  durationMs: number;
  atIso: string;
  breakdown?: Record<string, number>;
}

export interface SlowRequestsBlock {
  topN: SlowRequestEntry[];
  tailLimit: number;
  maxOut: number;
}

// 22-01 IMP-3: slow_query block — surfaces top-N slow SQLite repo-method calls
// decoded from pino ring-buffer.
export interface SlowQueryEntry {
  queryName: string;
  durationMs: number;
  atIso: string;
}

export interface SlowQueriesBlock {
  topN: SlowQueryEntry[];
  tailLimit: number;
  maxOut: number;
}

// 40-01: cpu_attribution sample — one headless sampler tick. Event-loop-lag
// (BLOCKING signal) + per-core CPU% (process-aggregate, off-loop signal) +
// active-encode count. See cpu-attribution-sampler.ts / cpu-attribution.ts.
export interface CpuAttributionSample {
  eventLoopLagP50Ms: number;
  eventLoopLagP99Ms: number;
  eventLoopLagMaxMs: number;
  cpuUserPctCore: number;
  cpuSysPctCore: number;
  activeEncodes: number;
  uptimeSec: number;
  atIso: string;
}

export interface CpuAttributionBlock {
  latest: CpuAttributionSample | null;
  topByLagP99: CpuAttributionSample[];
  sampleCount: number;
  tailLimit: number;
  maxOut: number;
}

// 22-01 IMP-4: web-vital per-route p75 block.
export interface WebVitalRouteMetric {
  p75: number;
  sampleSize: number;
}

export interface WebVitalRouteVitals {
  ttfb?: WebVitalRouteMetric;
  lcp?: WebVitalRouteMetric;
  inp?: WebVitalRouteMetric;
}

export interface WebVitalsBlock {
  byRoute: Record<string, WebVitalRouteVitals>;
  tailLimit: number;
  sampleCapPerRoute: number;
}

export interface ContainerImageBlock {
  os: {
    id: string | null;
    version: string | null;
    prettyName: string | null;
  };
  glibc: {
    version: string | null;
  };
  drivers: {
    intelMediaDriver: {
      version: string | null;
      source: 'vainfo' | 'so-symlink' | null;
    };
    libva: { version: string | null };
    libdrm: { version: string | null };
    // 23-00: oneVPL MFX GPU-runtime presence (root-cause surface for `MFX -9`).
    // Reports installed-package PRESENCE only — verified QSV-functionality is
    // the probe-encode's job (23-04), NOT a non-null version here.
    oneVpl: {
      libmfxGen1: { version: string | null }; // libmfx-gen1.2
      libvpl: { version: string | null }; // libvpl2
      libigfxcmrt: { version: string | null }; // libigfxcmrt7
    };
  };
  ffmpeg: {
    configurationFlags: string[] | null;
    version: string | null;
  };
}

// 24-03 (F2): DC-B cache-pool resolution evidence — surfaces the EFFECTIVE
// resolved cache path + HOW it resolved (mnt-cache / config-fallback /
// user-override) so the operator can audit the auto-resolution ("no silent
// magic" visibility invariant). `writable` is writable-OR-creatable (AC-9): the
// effective subdir does not exist until first dispatch mkdirs it, so a raw probe
// would false-negative on a healthy fresh install; we fall back to the nearest
// existing ancestor. Evidence-only — NO AggregatedWarning (mirrors 23-02 D2=A);
// the operator-facing nudge is the amber advisory in the Settings card.
export interface CacheBlock {
  effectivePath: string;
  resolution: 'user-override' | 'mnt-cache' | 'config-fallback';
  settingValue: string | null; // raw cache_pool_path setting, null when unset
  writable: boolean; // writable-OR-creatable probe of the EFFECTIVE path (AC-9)
  advisory: 'config-fallback-space' | null; // set iff resolution === 'config-fallback'
}

// 42-01: per-forced-polling-share stat-rate evidence. Surfaces the FUSE/shfs
// polling stat-storm (root-cause of the v2.36.0 UI-sluggishness report) WITHOUT
// shell access: a high computedStatsPerSec at a short effectiveIntervalMs over a
// large realPaths count IS the storm. realPaths = watchedFileCount ×
// pathMultiplier (chokidar depth:99 stats dirs too, ≈10× files per strace).
// intervalSource shows which precedence arm won (env / setting / scaled / default).
export interface PollingShareDiagnostic {
  shareName: string;
  pollingMode: 'polling-forced';
  watchedFileCount: number;
  realPaths: number;
  pathMultiplier: number;
  effectiveIntervalMs: number;
  intervalSource: 'env' | 'setting' | 'scaled' | 'default';
  computedStatsPerSec: number;
}

export interface DiagnosticsPayload {
  app: AppVersionBlock;
  runtime: RuntimeBlock;
  mounts: MountProbeResult[];
  // 24-03 (F2): additive NON-OPTIONAL (mirrors cpu/renderDevices precedent) —
  // aggregator ALWAYS populates (null/false-filled on throw, 200 preserved).
  cache: CacheBlock;
  devices: DeviceBlock;
  encoders: EncoderBlock;
  warnings: AggregatedWarning[];
  recentErrors: RecentErrorEntry[];
  onboarding: OnboardingBlock;
  // 23-05: CPU/iGPU gen capability. Additive NON-OPTIONAL (mirrors 23-02
  // renderDevices / 23-04 outcome) — aggregator ALWAYS populates (null-filled on
  // throw); forces compile-time fixture enumeration rather than silent drift.
  cpu: CpuBlock;
  // 22-00 IMP-8 + IMP-11: additive evidence-surfaces. NEVER null at payload
  // boundary (aggregator falls back to empty/null-filled blocks on failure).
  blocklist: BlocklistEvaluationBlock;
  containerImage: ContainerImageBlock;
  // 22-01 IMP-2: additive — never null at boundary; empty topN on failure.
  slowRequests: SlowRequestsBlock;
  // 22-01 IMP-3: additive — never null at boundary; empty topN on failure.
  slowQueries: SlowQueriesBlock;
  // 40-01: additive NON-OPTIONAL (mirrors slowQueries/cpu precedent) — aggregator
  // ALWAYS populates (empty-filled on throw, 200 preserved). Forces compile-time
  // fixture enumeration rather than silent drift.
  cpuAttribution: CpuAttributionBlock;
  // 22-01 IMP-4: additive — never null at boundary; empty byRoute on failure.
  webVitals: WebVitalsBlock;
  // 42-01: additive NON-OPTIONAL (mirrors cpuAttribution/cpu precedent) —
  // aggregator ALWAYS populates ([] on throw or no forced-polling share). Forces
  // compile-time fixture enumeration rather than silent drift.
  pollingShares: PollingShareDiagnostic[];
  generatedAt: string;
}

// 23-01: server-derived diagnosis of a failed HW-encoder test-encode. `code` is
// a closed-set dictionary key (see test-encode-error-map.ts); `severity` drives
// the failed-result callout colour (error=red, warning=amber). Null when the
// encode succeeded or no pattern applies.
export interface MappedTestEncodeError {
  code: string;
  severity: 'error' | 'warning';
}

export interface TestEncodeOutcome {
  success: boolean;
  encoderPicked: string;
  durationMs: number;
  ffmpegStdout: string;
  ffmpegStderr: string;
  exitCode: number | null;
  // 23-01: additive — populated server-side from the stderr→diagnosis dictionary
  // when the test-encode failed and a pattern matched; null otherwise.
  mappedError: MappedTestEncodeError | null;
}
