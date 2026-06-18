import { settingRepo, userRepo, shareRepo } from '@/src/lib/db';
import { detectEncoders, resolveEffectiveCachePathCached, type EncoderId } from '@/src/lib/encode';
import type { CachePathCardProps } from '@/components/settings/cache-path-card';
import { isValidPreset } from '@/src/lib/encode/presets';
import { logger } from '@/src/lib/logger';
import { SettingsClient } from './settings-client';
import type {
  ConcurrencyChoice,
  EncoderChoice,
  FormValues,
} from '@/src/lib/api/settings-serialize';
import type { AuthState, AuthSettings } from '@/components/settings/auth-tab';
import type { BenchDefaults } from '@/components/bench/bench-defaults';
import type { AutoScanAdvancedInitial } from '@/components/settings/auto-scan-advanced';

export const dynamic = 'force-dynamic';

function deriveAuthState(
  authEnabled: boolean,
  setupCompleted: boolean,
  userCount: number,
): AuthState {
  if (!authEnabled && userCount === 0) return 'A';
  if (!authEnabled && userCount >= 1) return 'B';
  if (authEnabled && !setupCompleted && userCount === 0) return 'C';
  if (authEnabled && setupCompleted && userCount >= 1) return 'D';
  // E = race state: authEnabled=true && !setupCompleted && userCount>=1
  return 'E';
}

const VALID_ENCODER_CHOICES: EncoderChoice[] = ['auto', 'nvenc', 'qsv', 'vaapi', 'libx265'];
const VALID_CONCURRENCY_CHOICES: ConcurrencyChoice[] = [
  'auto',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
];

function isEncoderChoice(v: unknown): v is EncoderChoice {
  return typeof v === 'string' && (VALID_ENCODER_CHOICES as readonly string[]).includes(v);
}
function isConcurrencyChoice(v: unknown): v is ConcurrencyChoice {
  return typeof v === 'string' && (VALID_CONCURRENCY_CHOICES as readonly string[]).includes(v);
}
function clampCrf(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n < 0 || n > 51) return fallback;
  return n;
}

export default async function SettingsPage() {
  const settings = settingRepo().getAll();

  // 14-04 (Plan 14-04 Task 5): scan_root / extensions / min_size_mb /
  // max_depth removed — multi-share via shareRepo() is the canonical source
  // for those fields. cache_pool_path setting still exists DB-side but no
  // longer surfaces in the legacy form (PathsTabShares does NOT edit it).
  const defaultValues: FormValues = {
    language: settings.language === 'de' ? 'de' : 'en',
    theme_override:
      settings.theme_override === 'light' || settings.theme_override === 'dark'
        ? settings.theme_override
        : 'system',
    auto_enqueue_after_scan: settings.auto_enqueue_after_scan === 'true',
    // 03-03: encoder + concurrency + per-encoder CRF defaults.
    encoder: isEncoderChoice(settings.encoder) ? settings.encoder : 'auto',
    concurrency: isConcurrencyChoice(settings.concurrency) ? settings.concurrency : 'auto',
    crf_libx265: clampCrf(settings.crf_libx265, 23),
    crf_nvenc: clampCrf(settings.crf_nvenc, 23),
    crf_qsv: clampCrf(settings.crf_qsv, 22),
    crf_vaapi: clampCrf(settings.crf_vaapi, 22),
    // 12-03: per-encoder preset defaults. Catalog-valid → DB value;
    // out-of-Catalog (operator-edited DB OR Catalog drift) → migration 0024 seed.
    preset_libx265:
      typeof settings.preset_libx265 === 'string' &&
      isValidPreset('libx265', settings.preset_libx265)
        ? settings.preset_libx265
        : 'medium',
    preset_nvenc:
      typeof settings.preset_nvenc === 'string' && isValidPreset('nvenc', settings.preset_nvenc)
        ? settings.preset_nvenc
        : 'p5',
    preset_qsv:
      typeof settings.preset_qsv === 'string' && isValidPreset('qsv', settings.preset_qsv)
        ? settings.preset_qsv
        : 'slow',
    preset_vaapi:
      typeof settings.preset_vaapi === 'string' && isValidPreset('vaapi', settings.preset_vaapi)
        ? settings.preset_vaapi
        : 'slow',
    // 05-13: 3-bucket verdict threshold (DB seed 5 via 0002:59). Clamp 0..50.
    min_savings_percent: (() => {
      const n = parseInt(settings.min_savings_percent ?? '5', 10);
      if (!Number.isFinite(n) || n < 0 || n > 50) return 5;
      return n;
    })(),
    // 05-bonus: encode-behavior toggles.
    delete_original_after_encode: settings.delete_original_after_encode === 'true',
    output_suffix:
      typeof settings.output_suffix === 'string' && settings.output_suffix.length > 0
        ? settings.output_suffix
        : '.x265.mkv',
    // 05-14: operator-selectable output container — defaults to 'mkv' for
    // back-compat with pre-05-14 installations.
    // 05-15: 'match-source' DWIM directive — coerce to one of three valid
    // literals; everything else (legacy bogus values, future-renamed values)
    // falls back to 'mkv' defensively.
    output_container:
      settings.output_container === 'mp4'
        ? 'mp4'
        : settings.output_container === 'match-source'
          ? 'match-source'
          : 'mkv',
    // 26-02 (F5): output strategy. Default 'suffix' (byte-identical) — any
    // non-'replace' value coerces to 'suffix' defensively. No DB seed.
    output_mode: settings.output_mode === 'replace' ? 'replace' : 'suffix',
    // 26-01 (F3): sidecar location mode + central root. Defaults via code-fallback
    // (no DB seed) — 'beside' = byte-identical to pre-26-01; everything non-enum
    // coerces to 'beside' defensively. Central path default mirrors the orchestrator
    // fallback (/config/x265-butler/sidecars/) so the input is pre-filled.
    sidecar_mode:
      settings.sidecar_mode === 'off'
        ? 'off'
        : settings.sidecar_mode === 'central'
          ? 'central'
          : 'beside',
    sidecar_central_path:
      typeof settings.sidecar_central_path === 'string' && settings.sidecar_central_path.length > 0
        ? settings.sidecar_central_path
        : '/config/x265-butler/sidecars/',
    // 33-02: empty when unset → blank field → placeholder communicates that an
    // empty trash_path tracks the cache pool. Unlike sidecar_central_path, do
    // NOT pre-fill a fake default path (empty = auto is the correct unset state).
    trash_path: typeof settings.trash_path === 'string' ? settings.trash_path : '',
  };

  // 14-04 (Plan 14-04 Task 5): server-side fs.stat existence checks dropped
  // along with the paths-tab fields they fed. Per-share path existence is a
  // follow-up concern (operator-facing diagnostic in a future plan).
  const scanRootExists = false;
  const cachePathExists = false;

  // 14-04: load shares for PathsTabShares mount.
  const initialShares = shareRepo().listAll();

  // 24-03 (F2, AC-5/AC-10): DC-B effective cache resolution for the Paths-tab
  // Cache card. Cached read-surface variant — NOT the pure dispatch variant —
  // so a Settings render does NOT emit a /mnt/cache write-probe each time.
  // `defaultProbeMntCacheWritable` swallows ALL throws → the resolver can never
  // throw, so this render can never 500 on a probe failure (degrades to
  // config-fallback). The sync fs write-probe is acceptable given the TTL memo.
  const cacheEff = resolveEffectiveCachePathCached(settings.cache_pool_path);
  const cachePath: CachePathCardProps = {
    effectivePath: cacheEff.effectivePath,
    resolution: cacheEff.resolution,
    settingValue: settings.cache_pool_path ?? null,
    advisory: cacheEff.resolution === 'config-fallback' ? 'config-fallback-space' : null,
  };

  // 03-03 audit M1: parallel detection probe for first-paint Detected pill row.
  // Mirrors GET /api/encoders shape but skips the HTTP roundtrip — direct
  // call to detectEncoders + same resolution rules. Build-time guard mirrors
  // the route handler S2 pattern (avoid spawning probes during `next build`).
  let detected: EncoderId[] = ['libx265'];
  let activeFromAuto: EncoderId = 'libx265';
  let vaapiDevice: string | undefined;
  if (process.env.NEXT_PHASE !== 'phase-production-build') {
    try {
      const det = await detectEncoders();
      detected = det.detected;
      activeFromAuto = det.activeFromAuto;
      vaapiDevice = det.vaapiDevice;
    } catch {
      // Probe failure → libx265-only fallback (graceful degradation).
    }
  }
  const requestedRaw = settings.encoder;
  const requestedNormalized: EncoderChoice = isEncoderChoice(requestedRaw) ? requestedRaw : 'auto';
  let active: EncoderId;
  let resolution: 'auto' | 'override' | 'fallback';
  let requestedButUnavailable: EncoderId | undefined;
  if (requestedNormalized === 'auto') {
    active = activeFromAuto;
    resolution = 'auto';
  } else if (detected.includes(requestedNormalized)) {
    active = requestedNormalized;
    resolution = 'override';
  } else {
    requestedButUnavailable = requestedNormalized;
    active = 'libx265';
    resolution = 'fallback';
  }

  // 05-02 T2 audit S3: read auth state for the Auth tab + emit
  // auth_state_inconsistency on race state E (authEnabled=true && !setupCompleted && userCount>=1).
  const authEnabled = settings.auth_enabled === 'true';
  const setupCompleted = settings.auth_setup_completed === 'true';
  let userCount = 0;
  try {
    userCount = userRepo().count();
  } catch {
    userCount = 0;
  }
  const authState = deriveAuthState(authEnabled, setupCompleted, userCount);
  if (authState === 'E') {
    logger.warn(
      {
        event: 'auth_state_inconsistency',
        userCount,
        setupCompleted,
        authEnabled,
      },
      'auth state inconsistency detected (race state E)',
    );
  }

  const authSettings: AuthSettings = {
    auth_enabled: authEnabled ? 'true' : 'false',
    session_ttl_seconds: settings.session_ttl_seconds ?? '604800',
    auth_trust_proxy_xff: settings.auth_trust_proxy_xff === 'true' ? 'true' : 'false',
    bcrypt_cost: settings.bcrypt_cost ?? '12',
  };

  // 16-02 T2/T4: server-rendered initial values for AutoScanAdvanced.
  // Hydration-lock per /ui-ux-pro-max T3§h — Client component receives values
  // as a prop, no SWR-fetch on mount → zero hydration mismatch.
  const autoScanAdvancedInitial: AutoScanAdvancedInitial = {
    bootScanOnStart: settings['autoScan.bootScanOnStart'] === 'false' ? 'false' : 'true',
    stabilityThreshold: settings['autoScan.stabilityThreshold'] ?? '10000',
    batchWindow: settings['autoScan.batchWindow'] ?? '5000',
    reconcileIntervalH: settings['autoScan.reconcileIntervalH'] ?? '6',
  };

  // 11-06: 8 von 8 non-file Bench-Settings exposed.
  const benchDefaults: BenchDefaults = {
    mode: settings.bench_default_mode === 'vmaf-anchored' ? 'vmaf-anchored' : 'native-sweep',
    encoders: (settings.bench_default_encoders ?? 'libx265').split(','),
    presets: (settings.bench_default_presets ?? 'veryfast,medium,slow').split(','),
    nativeValues: settings.bench_default_native_values ?? '23,28',
    sampleCount: parseInt(settings.bench_sample_count ?? '3', 10),
    sampleDurationSec: parseInt(settings.bench_sample_duration_seconds ?? '20', 10),
    vmafModel: settings.bench_vmaf_model ?? 'vmaf_v0.6.1',
    vmafBuckets: settings.bench_vmaf_buckets ?? '95,92,88',
  };

  return (
    <SettingsClient
      defaultValues={defaultValues}
      initialShares={initialShares}
      cachePath={cachePath}
      scanRootExists={scanRootExists}
      cachePathExists={cachePathExists}
      detectedEncoders={detected}
      activeEncoder={active}
      encoderResolution={resolution}
      requestedButUnavailable={requestedButUnavailable}
      vaapiDevice={vaapiDevice}
      authState={authState}
      authSettings={authSettings}
      userExists={userCount >= 1}
      benchDefaults={benchDefaults}
      autoScanAdvancedInitial={autoScanAdvancedInitial}
    />
  );
}
