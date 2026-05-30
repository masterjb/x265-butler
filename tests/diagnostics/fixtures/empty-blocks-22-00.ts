// 22-00 test-helper: empty/null blocks for blocklist + containerImage so
// existing pre-22-00 fixtures keep type-checking under the extended
// DiagnosticsPayload shape.

import type {
  BlocklistEvaluationBlock,
  ContainerImageBlock,
  CpuBlock,
  SlowQueriesBlock,
  SlowRequestsBlock,
  WebVitalsBlock,
} from '@/src/lib/diagnostics/types';

export const EMPTY_BLOCKLIST_BLOCK_22_00: BlocklistEvaluationBlock = {
  totalEntries: 0,
  recentEvaluations: [],
  patternCachedAt: null,
};

// 22-01 IMP-2: empty slowRequests block for fixture-using tests pre-22-01.
export const EMPTY_SLOW_REQUESTS_BLOCK_22_01: SlowRequestsBlock = {
  topN: [],
  tailLimit: 200,
  maxOut: 20,
};

// 22-01 IMP-3: empty slowQueries block for fixture-using tests pre-22-01.
export const EMPTY_SLOW_QUERIES_BLOCK_22_01: SlowQueriesBlock = {
  topN: [],
  tailLimit: 500,
  maxOut: 20,
};

// 22-01 IMP-4: empty webVitals block for fixture-using tests pre-22-01.
export const EMPTY_WEB_VITALS_BLOCK_22_01: WebVitalsBlock = {
  byRoute: {},
  tailLimit: 500,
  sampleCapPerRoute: 50,
};

// 23-05: null-filled cpu block for fixture-using tests pre-23-05.
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

export const NULL_CONTAINER_IMAGE_BLOCK_22_00: ContainerImageBlock = {
  os: { id: null, version: null, prettyName: null },
  glibc: { version: null },
  drivers: {
    intelMediaDriver: { version: null, source: null },
    libva: { version: null },
    libdrm: { version: null },
    // 23-00: additive oneVPL MFX-runtime presence block.
    oneVpl: {
      libmfxGen1: { version: null },
      libvpl: { version: null },
      libigfxcmrt: { version: null },
    },
  },
  ffmpeg: { configurationFlags: null, version: null },
};
