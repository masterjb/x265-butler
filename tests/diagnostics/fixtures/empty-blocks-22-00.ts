// Test helper: empty/null blocks for the additive diagnostics blocks so
// existing fixtures that predate them keep type-checking under the extended
// DiagnosticsPayload shape.

import type {
  BlocklistEvaluationBlock,
  CacheBlock,
  ContainerImageBlock,
  CpuAttributionBlock,
  CpuBlock,
  NvidiaGpuBlock,
  PollingShareDiagnostic,
  ScanIntegrityBlock,
  SlowQueriesBlock,
  SlowRequestsBlock,
  WebVitalsBlock,
} from '@/src/lib/diagnostics/types';

// Empty pollingShares list (inotify host).
export const EMPTY_POLLING_SHARES_42_01: PollingShareDiagnostic[] = [];

// Empty scanIntegrity block (no scan has completed in the process yet).
export const EMPTY_SCAN_INTEGRITY_48_01: ScanIntegrityBlock = { lastScan: null };

// Default cache block. Mirrors a healthy unRAID array host: unset setting →
// auto-resolved to /mnt/cache.
export const DEFAULT_CACHE_BLOCK_24_03: CacheBlock = {
  effectivePath: '/mnt/cache/x265-butler',
  resolution: 'mnt-cache',
  settingValue: null,
  writable: true,
  advisory: null,
};

export const EMPTY_BLOCKLIST_BLOCK_22_00: BlocklistEvaluationBlock = {
  totalEntries: 0,
  recentEvaluations: [],
  patternCachedAt: null,
};

// Empty slowRequests block.
export const EMPTY_SLOW_REQUESTS_BLOCK_22_01: SlowRequestsBlock = {
  topN: [],
  tailLimit: 200,
  maxOut: 20,
};

// Empty slowQueries block.
export const EMPTY_SLOW_QUERIES_BLOCK_22_01: SlowQueriesBlock = {
  topN: [],
  tailLimit: 500,
  maxOut: 20,
};

// Empty cpuAttribution block.
export const EMPTY_CPU_ATTRIBUTION_BLOCK_40_01: CpuAttributionBlock = {
  latest: null,
  topByLagP99: [],
  sampleCount: 0,
  tailLimit: 500,
  maxOut: 20,
};

// Empty webVitals block.
export const EMPTY_WEB_VITALS_BLOCK_22_01: WebVitalsBlock = {
  byRoute: {},
  tailLimit: 500,
  sampleCapPerRoute: 50,
};

// Null-filled cpu block.
export const NULL_CPU_BLOCK_23_05: CpuBlock = {
  isIntel: false,
  vendorId: null,
  modelName: null,
  family: null,
  model: null,
  microarch: null,
  graphicsGen: null,
  hevcQsv: 'unknown',
};

// Empty nvidiaGpu block (the common no-toolkit host — nvidia-smi absent → binary_missing).
export const EMPTY_NVIDIA_GPU_BLOCK_46_02: NvidiaGpuBlock = {
  source: 'binary_missing',
  gpus: [],
};

export const NULL_CONTAINER_IMAGE_BLOCK_22_00: ContainerImageBlock = {
  os: { id: null, version: null, prettyName: null },
  glibc: { version: null },
  drivers: {
    intelMediaDriver: { version: null, source: null },
    libva: { version: null },
    libdrm: { version: null },
    // Additive oneVPL MFX-runtime presence block.
    oneVpl: {
      libmfxGen1: { version: null },
      libvpl: { version: null },
      libigfxcmrt: { version: null },
    },
  },
  ffmpeg: { configurationFlags: null, version: null },
  // Second binary (jellyfin, NVENC only).
  ffmpegNvenc: { version: null },
};
