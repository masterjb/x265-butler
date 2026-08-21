// Phase 21 Plan 21-01 — shared diagnostics types.
//
// Type-only module — zero runtime exports. Imported by aggregator, route
// handlers, markdown template, and tests.

import type { EncoderOutcome } from '@/src/lib/encode';
import type { ScanIntegritySnapshot } from '@/src/lib/scan/scan-integrity-store';

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
  // 49-03: per-encoder forced-IDR (closed-GOP) verdict. Additive NON-OPTIONAL,
  // same house style as `outcome` itself — it forces compile-time enumeration at
  // every fixture site rather than silent drift.
  //   'supported'   = a confirm spawn ran and the runtime accepted the option.
  //   'unsupported' = a confirm spawn ran and the runtime REJECTED it; Butler has
  //                   auto-degraded this encoder to open GOPs.
  //   'not-probed'  = everything else — libx265/vaapi (they emit no such token),
  //                   the probe-encode kill-switch, probe-inconclusive, a confirm
  //                   timeout, closed-GOP disabled, or an unclassifiable stderr.
  // 'not-probed' is where the fail-open design becomes HONEST on the surface: the
  // UI says "not established", while the behaviour says "the pin stays".
  // 49-05: the QSV ratecontrol tier the boot probe resolved (30-01's two-tier
  // detection). Additive NON-OPTIONAL, deliberately the same shape as `forcedIdr`
  // above — an optional field carries no compile-time obligation and drifts
  // silently, which is the failure 23-02, 23-04 and 49-03 each avoided on purpose.
  //   'icq-full' = the probe validated `-global_quality <crf> -low_power 0` (ICQ,
  //                full-encode path).
  //   'cqp'      = the probe validated `-q:v <crf>` (constant-QP, low-power path).
  //   'unresolved' = a qsv row whose det.qsvRateControl is undefined. NOTE this
  //                covers TWO very different facts: "both probe tiers failed"
  //                (tried, detection.ts:594) and "there is no QSV on this host at
  //                all" (outcome 'missing' — never tried). The field stays
  //                four-valued; markdown-template.ts tells them apart at PRINT
  //                time and suppresses the second, so an AMD/NVIDIA report does
  //                not carry an alarming line about hardware it does not have.
  //   'not-applicable' = libx265 / nvenc / vaapi. They have no tier; the value
  //                says so instead of inventing one.
  // The field is named `rateControl`, not `qsvRateControl`: on a vaapi row the
  // qsv prefix would simply be wrong.
  outcome: {
    encoder: string;
    outcome: EncoderOutcome;
    detail?: string;
    forcedIdr: 'supported' | 'unsupported' | 'not-probed';
    rateControl: 'icq-full' | 'cqp' | 'unresolved' | 'not-applicable';
  }[];
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

// 46-02 (D2): NVIDIA GPU model + driver evidence — the analog of the 23-05 cpu
// block, sourced from `nvidia-smi --query-gpu=name,driver_version`. Lets a nvenc
// report be evidence-checked (confirm the exact card/gen) instead of hedged.
// Evidence-only — NO AggregatedWarning emitted (mirrors 23-05 cpu). `source`
// classifies the probe outcome so every empty case renders a distinct fallback.
export interface NvidiaGpu {
  name: string;
  driverVersion: string;
}

export type NvidiaGpuSource = 'present' | 'binary_missing' | 'no_gpu' | 'timeout' | 'error';

export interface NvidiaGpuBlock {
  gpus: NvidiaGpu[];
  source: NvidiaGpuSource;
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
// 42-03: actual* pair = chokidar getWatched()-measured ground truth (null until
// 'ready'); the realPaths/computedStatsPerSec fields above are the PATHS_PER_FILE=10
// estimate, kept for direct heuristic-vs-measured comparison.
export interface PollingShareDiagnostic {
  shareName: string;
  pollingMode: 'polling-forced';
  watchedFileCount: number;
  realPaths: number;
  pathMultiplier: number;
  effectiveIntervalMs: number;
  intervalSource: 'env' | 'setting' | 'scaled' | 'default';
  computedStatsPerSec: number;
  // 42-03: chokidar getWatched()-measured ground truth, captured at 'ready'.
  // null until ready (or when the watch factory has no getWatched). Exposes the
  // real stat-rate so the estimate above is auditable (heuristic under-reported
  // ~3× on the operator's tree); estimate fields preserved for comparison.
  actualWatchedPaths: number | null;
  actualPathMultiplier: number | null; // actualWatchedPaths / watchedFileCount, 1 decimal
  actualStatsPerSec: number | null;
}

// 48-01: directory-integrity evidence of the LAST completed (or failed) scan.
// The nested `lastScan: null` is load-bearing: it separates "never scanned in
// this process" from "scanned, zero skips" — and that distinction IS the whole
// point of the block. A flat null-filled shape would collapse the two.
export interface ScanIntegrityBlock {
  lastScan: ScanIntegritySnapshot | null;
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
  // 46-02 (D2): NVIDIA GPU model + driver. Additive NON-OPTIONAL (mirrors 23-05
  // cpu) — aggregator ALWAYS populates ({ source:'error', gpus:[] } on throw);
  // forces compile-time fixture enumeration rather than silent drift.
  nvidiaGpu: NvidiaGpuBlock;
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
  // 48-01: additive NON-OPTIONAL (mirrors pollingShares/cpuAttribution) —
  // aggregator ALWAYS populates ({ lastScan: null } before the first scan or on
  // throw). Forces compile-time fixture enumeration rather than silent drift.
  scanIntegrity: ScanIntegrityBlock;
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
  // ─── 50-06: what the test encode ACTUALLY ran with ──────────────────────────
  // Purely additive; every field above keeps its name, type and meaning.
  // Without these, "the test encode fares your configuration" is an unverifiable
  // claim, and a report saying only "test-encode failed" is not actionable.
  //
  /** The raw `settings.encoder` value, or 'auto'. Compare against encoderPicked. */
  encoderRequested: string;
  /**
   * True when a PINNED encoder was not in `detected[]` and the run fell back to
   * libx265 — production takes the same fallback and logs `encoder_unavailable`.
   *
   * Computed SERVER-SIDE on purpose. The client cannot derive it: `encoderPicked`
   * is an ffmpeg codec string (`hevc_nvenc`) while `encoderRequested` is a
   * setting value (`nvenc`), and the only mapper lives in a module that imports
   * `node:child_process` — pulling it into a client bundle is the 49-05 MH-1 trap.
   * A UI that re-derives a fact the server already knows is also how a green
   * result comes to read as "my nvenc works" when libx265 did the work.
   */
  encoderFallback: boolean;
  /**
   * The resolved per-encoder CRF.
   *
   * `'unresolved'` — NOT `null` — when the stored settings do not parse to a
   * finite number (both `crf_<enc>` and `default_crf` unparsable, e.g. a hand-
   * edited DB). The production resolver passes that NaN straight through to
   * ffmpeg, so it is a real state the operator must be able to SEE. Typing this
   * as a bare `number` would be a lie on the wire: `JSON.stringify({crf: NaN})`
   * yields `{"crf":null}`, i.e. the report would silently hide the very value
   * that kills the encode. Repairing the underlying NaN pass-through is a
   * separate plan — it would change production CRF resolution.
   */
  crf: number | 'unresolved';
  /** The resolved per-encoder preset (Catalog-guarded). */
  preset: string;
  /** `force_10bit` as it was applied to this run. */
  force10bit: boolean;
  /** Forced-keyframe interval in seconds; 0 = no `-force_key_frames` token. */
  keyframeIntervalSec: number;
  /**
   * `[binary, ...args]` — the binary is INCLUDED on purpose (45-01 ships two
   * ffmpeg binaries and the choice between them is itself a diagnosis). Safe to
   * share: synthetic input, `/dev/null` output, no library path anywhere.
   */
  commandLine: string[];
  /**
   * `'unavailable'` means the settings read FAILED and every value above is a
   * factory default, not the operator's configuration. The surfaces must say so
   * rather than presenting defaults as if they were configured.
   */
  settingsSource: 'settings' | 'unavailable';
}
