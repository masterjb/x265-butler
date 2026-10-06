// Central diagnostics payload assembler.
//
// Consumer-only over every source — never edits encode/scan/skip/detection/share/
// setting modules. Detection-failure → empty encoder block + aggregator-self
// warning so GET /api/diagnostics stays 200 even when sub-systems throw.
//
// Detection-cache-stale note: detectEncoders() caches its result on globalThis
// indefinitely; fresh detection only runs on container restart OR
// /api/encoders/refresh call (the re-detect button). Diagnostics endpoint reflects
// cached detection — by design, NOT a bug.

import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { fileRepo, settingRepo, shareRepo } from '@/src/lib/db';
import { isAutoEncodeEnabled } from '@/src/lib/queue/auto-encode';
import { detectEncoders, ENCODER_IDS, resolveEffectiveCachePathCached } from '@/src/lib/encode';
import { probeCachePoolWritable, CachePoolUnavailableError } from '@/src/lib/encode/staging';
import { getVersionInfo } from '@/src/lib/version';
import { aggregateWarnings } from './warnings-aggregator';
import { getRecentErrors } from './recent-errors';
import { probeMounts } from './mount-probe';
import { probeRenderDevices } from './render-device-probe';
import { assembleBlocklistEvaluation } from './blocklist-evaluation';
import { probeContainerImage } from './container-image-probe';
import { getCpuCapability } from './cpu-capability';
import { getNvidiaGpu } from './nvidia-gpu';
import { assembleSlowRequests } from './slow-requests';
import { assembleSlowQueries } from './slow-queries';
import { assembleCpuAttribution } from './cpu-attribution';
import { assembleWebVitals } from './web-vitals';
import { getAutoScanStatus } from '@/src/lib/watch/service';
import { getScanIntegrity } from '@/src/lib/scan/scan-integrity-store';
import type {
  AggregatedWarning,
  BlocklistEvaluationBlock,
  CacheBlock,
  ContainerImageBlock,
  CpuAttributionBlock,
  CpuBlock,
  DiagnosticsPayload,
  EncoderBlock,
  MountProbeResult,
  NvidiaGpuBlock,
  PollingShareDiagnostic,
  RenderDeviceProbe,
  ScanIntegrityBlock,
  SlowQueriesBlock,
  SlowRequestsBlock,
  WebVitalsBlock,
} from './types';

export async function assembleDiagnostics(): Promise<DiagnosticsPayload> {
  const app = getVersionInfo();

  const runtime = {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    uptimeSec: Math.floor(process.uptime()),
    pid: process.pid,
  };

  const mounts: MountProbeResult[] = await probeMounts();

  const [dri, nvidia] = await Promise.all([listDriDevices(), listNvidiaDevices()]);

  // Render-node permission evidence. Evidence-only — NO
  // AggregatedWarning emitted for a GID mismatch. Double-guard to [] so GET
  // stays 200 even if the probe throws internally (mirror the blocklist and
  // container-image blocks below).
  let renderDevices: RenderDeviceProbe[];
  try {
    renderDevices = await probeRenderDevices();
  } catch {
    renderDevices = [];
  }

  let encoders: EncoderBlock = { detected: [], warnings: [], outcome: [] };
  let detectionFailure: { ok: false; message: string } | { ok: true } = { ok: true };
  try {
    const det = await detectEncoders();
    encoders = {
      detected: [...det.detected],
      warnings: det.warnings.map((w) => ({
        code: w.code,
        message: w.detail,
      })),
      // Key the broken-excerpt BY ENCODER (det.brokenExcerpts),
      // NOT by warning-code — multiple broken encoders share the identical
      // `encoder_runtime_broken` code so code-matching cross-contaminates.
      outcome: ENCODER_IDS.map((enc) => {
        const o = det.outcome[enc];
        // Absent key ⇒ 'not-probed'. That is the honest label for every
        // fail-open path (kill-switch, inconclusive, timeout, unclassifiable
        // stderr, or an encoder that emits no IDR token at all) — NOT 'supported',
        // which would claim a runtime confirmation that never happened.
        const verdict = det.forcedIdrSupported?.[enc];
        const forcedIdr =
          verdict === true ? 'supported' : verdict === false ? 'unsupported' : 'not-probed';
        // Only qsv HAS a ratecontrol tier. Everyone else says
        // 'not-applicable' rather than borrowing a state that does not apply to
        // them; an absent tier on the qsv row is 'unresolved', never a silent
        // default that would pass off the fallback as a measurement.
        const rateControl = enc === 'qsv' ? (det.qsvRateControl ?? 'unresolved') : 'not-applicable';
        return o === 'compiled-in-broken' && det.brokenExcerpts[enc]
          ? { encoder: enc, outcome: o, detail: det.brokenExcerpts[enc], forcedIdr, rateControl }
          : { encoder: enc, outcome: o, forcedIdr, rateControl };
      }),
      // Surface kill-switch state into the diagnostics.
      probeEncodeDisabled: det.probeEncodeDisabled,
    };
  } catch (err) {
    detectionFailure = { ok: false, message: err instanceof Error ? err.message : String(err) };
  }

  let onboardingCompleted = false;
  let hasShare = false;
  try {
    onboardingCompleted = settingRepo().get('onboarding_completed') === 'true';
  } catch {
    // leave false; aggregator will surface onboarding_incomplete
  }
  try {
    hasShare = shareRepo().listAll().length > 0;
  } catch {
    // leave false; aggregator will surface no_share_configured
  }

  // Separate try-blocks so one failed read does not blank the other.
  let autoEncodeEnabled: boolean | null = null;
  let pendingFiles: number | null = null;
  try {
    autoEncodeEnabled = isAutoEncodeEnabled(settingRepo());
  } catch {
    // stays null → rendered as unknown
  }
  try {
    pendingFiles = fileRepo().countByStatus().pending;
  } catch {
    // stays null → rendered as unknown
  }

  const warningsBase = aggregateWarnings({
    encoders: {
      warnings: encoders.warnings.map((w) => ({
        code: w.code as never,
        severity: 'warn' as const,
        detail: w.message,
      })),
    },
    mountProbe: mounts,
    onboardingCompleted,
    hasShare,
  });

  const warnings: AggregatedWarning[] = [...warningsBase];
  if (!detectionFailure.ok) {
    warnings.push({
      severity: 'error',
      source: 'aggregator',
      code: 'aggregator_source_failed',
      message: `encoder: ${detectionFailure.message}`.slice(0, 200),
    });
  }

  // Blocklist-evaluation surface. Decoder-only; never throws.
  let blocklist: BlocklistEvaluationBlock;
  try {
    blocklist = assembleBlocklistEvaluation();
  } catch {
    blocklist = { totalEntries: 0, recentEvaluations: [], patternCachedAt: null };
  }

  // Container-image probe (boot-cached singleton). Race-safe via
  // pendingPromise memoization; per-sub-probe try/catch nulls failed fields.
  let containerImage: ContainerImageBlock;
  try {
    containerImage = await probeContainerImage();
  } catch {
    containerImage = nullContainerImageBlock();
  }

  // slow_request ring-tail scanner. Decoder-only; never throws.
  let slowRequests: SlowRequestsBlock;
  try {
    slowRequests = assembleSlowRequests();
  } catch {
    slowRequests = { topN: [], tailLimit: 200, maxOut: 20 };
  }

  // slow_query ring-tail scanner. Decoder-only; never throws.
  let slowQueries: SlowQueriesBlock;
  try {
    slowQueries = assembleSlowQueries();
  } catch {
    slowQueries = { topN: [], tailLimit: 500, maxOut: 20 };
  }

  // cpu_attribution ring-tail scanner. Decoder-only; never throws. Empty
  // fallback keeps GET 200.
  let cpuAttribution: CpuAttributionBlock;
  try {
    cpuAttribution = assembleCpuAttribution();
  } catch {
    cpuAttribution = { latest: null, topByLagP99: [], sampleCount: 0, tailLimit: 500, maxOut: 20 };
  }

  // web-vital ring-tail scanner. Decoder-only; never throws.
  let webVitals: WebVitalsBlock;
  try {
    webVitals = assembleWebVitals();
  } catch {
    webVitals = { byRoute: {}, tailLimit: 500, sampleCapPerRoute: 50 };
  }

  // CPU/iGPU gen capability (boot-cached singleton). Evidence-only (no
  // AggregatedWarning). getCpuCapability never throws, but double-guard to
  // a null-filled block so GET /api/diagnostics stays 200 (mirror renderDevices).
  let cpu: CpuBlock;
  try {
    cpu = await getCpuCapability();
  } catch {
    cpu = nullCpuBlock();
  }

  // NVIDIA GPU model + driver (boot-cached singleton). Evidence-only
  // (no AggregatedWarning, mirrors cpu). getNvidiaGpu never throws, but
  // double-guard to a null-filled block so GET /api/diagnostics stays 200.
  let nvidiaGpu: NvidiaGpuBlock;
  try {
    nvidiaGpu = await getNvidiaGpu();
  } catch {
    nvidiaGpu = nullNvidiaGpuBlock();
  }

  // DC-B cache-pool resolution surface. Read-surface → Cached
  // resolver variant (≤1 /mnt/cache probe per TTL across banner-polls).
  // `writable` is writable-OR-creatable. Whole-block try/catch →
  // null/false-filled fallback so GET stays 200 even if the probe throws.
  let cache: CacheBlock;
  try {
    let settingValue: string | null = null;
    try {
      settingValue = settingRepo().get('cache_pool_path') ?? null;
    } catch {
      settingValue = null;
    }
    const eff = resolveEffectiveCachePathCached(settingValue ?? undefined);
    cache = {
      effectivePath: eff.effectivePath,
      resolution: eff.resolution,
      settingValue,
      writable: probeEffectiveWritable(eff.effectivePath),
      advisory: eff.resolution === 'config-fallback' ? 'config-fallback-space' : null,
    };
  } catch {
    cache = {
      effectivePath: '',
      resolution: 'config-fallback',
      settingValue: null,
      writable: false,
      advisory: null,
    };
  }

  // Forced-polling stat-rate evidence. Read from the watcher snapshot
  // (getAutoScanStatus → getWatcherSnapshot), populated once per share-start.
  // Decoder-only; double-guard to [] so GET /api/diagnostics stays 200 if the
  // service throws (mirror renderDevices/cpu).
  let pollingShares: PollingShareDiagnostic[];
  try {
    const snap = getAutoScanStatus();
    pollingShares = Object.entries(snap.pollingShares).map(([shareName, d]) => ({
      shareName,
      pollingMode: 'polling-forced' as const,
      watchedFileCount: d.watchedFileCount,
      realPaths: d.realPaths,
      pathMultiplier: d.pathMultiplier,
      effectiveIntervalMs: d.effectiveIntervalMs,
      intervalSource: d.intervalSource,
      computedStatsPerSec: d.computedStatsPerSec,
      // chokidar getWatched()-measured ground truth (null until 'ready').
      actualWatchedPaths: d.actualWatchedPaths,
      actualPathMultiplier: d.actualPathMultiplier,
      actualStatsPerSec: d.actualStatsPerSec,
    }));
  } catch {
    pollingShares = [];
  }

  // Last-scan directory-integrity evidence. Direct getter call, NOT a
  // sub-assembler: getScanIntegrity() is already a pure, ring-buffer-independent
  // source — the pattern here is getAutoScanStatus() above, not
  // assembleCpuAttribution (which only exists because it has to decode pino
  // lines). Double-guard to the empty block so GET stays 200 (mirror
  // renderDevices/pollingShares).
  let scanIntegrity: ScanIntegrityBlock;
  try {
    scanIntegrity = { lastScan: getScanIntegrity() };
  } catch {
    scanIntegrity = { lastScan: null };
  }

  return {
    app,
    runtime,
    mounts,
    cache,
    devices: { dri, nvidia, renderDevices },
    encoders,
    warnings,
    recentErrors: getRecentErrors(25),
    onboarding: {
      completed: onboardingCompleted,
      hasShare,
      autoEncode: { enabled: autoEncodeEnabled, pendingFiles },
    },
    cpu,
    nvidiaGpu,
    blocklist,
    containerImage,
    slowRequests,
    slowQueries,
    cpuAttribution,
    webVitals,
    pollingShares,
    scanIntegrity,
    generatedAt: new Date().toISOString(),
  };
}

// Writable-OR-creatable probe of the effective cache path.
// probeCachePoolWritable NEVER mkdirs and throws ENOENT on the effective subdir,
// which does not exist until first dispatch (assertCachePoolWritable mkdirs it).
// A raw probe would therefore report writable:false on a fully writable host on
// every fresh install — a self-contradictory `resolution: mnt-cache,
// writable: false` that manufactures false bug reports. On ENOENT we fall back
// to the nearest existing ancestor: /mnt/cache/x265-butler → /mnt/cache (exists
// + writable) → true; /config/cache → /config (appdata, always writable) → true.
// EACCES/EROFS/shape-error → not writable. Read-only: NEVER mkdirs.
function probeEffectiveWritable(p: string): boolean {
  if (!p) return false;
  try {
    probeCachePoolWritable(p); // dir exists + writable
    return true;
  } catch (err) {
    const enoent = err instanceof CachePoolUnavailableError && err.code === 'ENOENT';
    if (!enoent) return false; // EACCES / EROFS / shape → not writable
    try {
      probeCachePoolWritable(path.dirname(p)); // creatable: parent writable
      return true;
    } catch {
      return false;
    }
  }
}

function nullCpuBlock(): CpuBlock {
  return {
    isIntel: false,
    vendorId: null,
    modelName: null,
    family: null,
    model: null,
    microarch: null,
    graphicsGen: null,
    hevcQsv: 'unknown',
  };
}

function nullNvidiaGpuBlock(): NvidiaGpuBlock {
  return { source: 'error', gpus: [] };
}

function nullContainerImageBlock(): ContainerImageBlock {
  return {
    os: { id: null, version: null, prettyName: null },
    glibc: { version: null },
    drivers: {
      intelMediaDriver: { version: null, source: null },
      libva: { version: null },
      libdrm: { version: null },
      oneVpl: {
        libmfxGen1: { version: null },
        libvpl: { version: null },
        libigfxcmrt: { version: null },
      },
    },
    ffmpeg: { configurationFlags: null, version: null },
    ffmpegNvenc: { version: null },
  };
}

async function listDriDevices(): Promise<string[]> {
  try {
    const entries = await readdir('/dev/dri');
    return entries
      .filter((e) => e.startsWith('renderD') || e.startsWith('card'))
      .map((e) => `/dev/dri/${e}`)
      .sort();
  } catch {
    return [];
  }
}

async function listNvidiaDevices(): Promise<string[]> {
  try {
    const entries = await readdir('/dev');
    return entries
      .filter((e) => e === 'nvidiactl' || /^nvidia\d+$/.test(e))
      .map((e) => `/dev/${e}`)
      .sort();
  } catch {
    return [];
  }
}
