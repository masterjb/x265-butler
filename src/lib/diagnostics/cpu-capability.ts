// 23-05 — CPU / iGPU generation capability probe.
//
// Parses the FIRST processor block of `/proc/cpuinfo`, maps the Intel CPUID
// numeric family/model to a graphics generation via an embedded table, and
// classifies HEVC-QSV HARDWARE support ('none' < Skylake gen6, '8bit' at gen6,
// '10bit' at gen7+). Evidence + advisory layer ONLY — never a behavior gate.
//
// Identification uses the NUMERIC CPUID fields (`cpu family` + `model`), NOT the
// marketing `model name` string (which is captured display-only). The numeric
// `model` and the display `model name` lines COLLIDE under a naive regex —
// `/proc/cpuinfo` carries both `model\t\t: 158` and `model name\t: Intel(R)...`
// — so every field is anchored to a full-line exact-key match (M1).
//
// Boot-cached (cpuinfo is immutable at runtime) using the EXACT
// container-image-probe mechanism: module-scope `cachedBlock` + a
// `pendingPromise` concurrency guard so a cold-cache page-card path and the
// standalone /api/diagnostics/cpu-capability route never run readFile twice (S1).
// Never throws upward: a read-failure / no-fields cpuinfo yields a null-filled
// CpuCapability (AC-4).

import { promises as defaultFs } from 'node:fs';
import {
  INTEL_IGPU_HEVC_QSV_10BIT_MIN_GEN,
  INTEL_IGPU_HEVC_QSV_MIN_GEN,
} from './cpu-capability-constants';

const CPUINFO_PATH = '/proc/cpuinfo';

// Re-export the pure gen thresholds (defined in cpu-capability-constants.ts so
// the client advisory can import them without pulling node:fs).
export { INTEL_IGPU_HEVC_QSV_MIN_GEN, INTEL_IGPU_HEVC_QSV_10BIT_MIN_GEN };

export type HevcQsvSupport = 'none' | '8bit' | '10bit' | 'unknown';

export interface CpuCapability {
  isIntel: boolean;
  vendorId: string | null;
  modelName: string | null;
  family: number | null;
  model: number | null;
  microarch: string | null;
  graphicsGen: number | null;
  hevcQsv: HevcQsvSupport;
}

export interface CpuCapabilityDeps {
  readFile?: typeof defaultFs.readFile;
}

// Embedded Intel CPUID-model → graphics-generation table (family 6 assumed;
// family !== 6 → no gen). To add a new Intel generation: add ONE line here AND
// extend the sentinel test (tests/diagnostics/cpu-capability.test.ts, AC-9).
const INTEL_CPUID_MODEL_TABLE: ReadonlyMap<number, { microarch: string; graphicsGen: number }> =
  new Map([
    // Haswell — gen<6 (no HW HEVC-QSV)
    [60, { microarch: 'Haswell', graphicsGen: 5 }], // gen7.5 compute / pre-HEVC iGPU → treat as <6 (none)
    [69, { microarch: 'Haswell', graphicsGen: 5 }],
    [70, { microarch: 'Haswell', graphicsGen: 5 }],
    // Broadwell — gen5-era iGPU, predates HW HEVC-QSV
    [61, { microarch: 'Broadwell', graphicsGen: 5 }],
    [71, { microarch: 'Broadwell', graphicsGen: 5 }],
    [86, { microarch: 'Broadwell', graphicsGen: 5 }],
    // Skylake — gen6, first HW HEVC-QSV (8-bit)
    [78, { microarch: 'Skylake', graphicsGen: 6 }],
    [94, { microarch: 'Skylake', graphicsGen: 6 }],
    // Kaby / Coffee / Comet / Whiskey Lake — gen7-9.5, first 10-bit HEVC-QSV
    [142, { microarch: 'Kaby/Coffee/Comet Lake', graphicsGen: 7 }],
    [158, { microarch: 'Kaby/Coffee/Comet Lake', graphicsGen: 7 }],
    [165, { microarch: 'Comet Lake', graphicsGen: 7 }],
    [166, { microarch: 'Comet Lake', graphicsGen: 7 }],
    // Ice Lake — gen11
    [126, { microarch: 'Ice Lake', graphicsGen: 11 }],
    [125, { microarch: 'Ice Lake', graphicsGen: 11 }],
    // Tiger Lake — gen12
    [140, { microarch: 'Tiger Lake', graphicsGen: 12 }],
    [141, { microarch: 'Tiger Lake', graphicsGen: 12 }],
    // Rocket Lake — gen12 (Xe)
    [167, { microarch: 'Rocket Lake', graphicsGen: 12 }],
    // Alder Lake — gen12 (Xe)
    [151, { microarch: 'Alder Lake', graphicsGen: 12 }],
    [154, { microarch: 'Alder Lake', graphicsGen: 12 }],
    // Raptor Lake — gen13
    [183, { microarch: 'Raptor Lake', graphicsGen: 13 }],
    [186, { microarch: 'Raptor Lake', graphicsGen: 13 }],
    // Meteor / Arrow / Lunar Lake — best-effort (table-edit extensible)
    [170, { microarch: 'Meteor Lake', graphicsGen: 13 }],
    [172, { microarch: 'Lunar Lake', graphicsGen: 13 }],
    [198, { microarch: 'Arrow Lake', graphicsGen: 13 }],
  ]);

const NULL_CAPABILITY: CpuCapability = {
  isIntel: false,
  vendorId: null,
  modelName: null,
  family: null,
  model: null,
  microarch: null,
  graphicsGen: null,
  hevcQsv: 'unknown',
};

// Module-scope boot-cache (S1 — concurrency-safe via pendingPromise).
let cachedCapability: CpuCapability | null = null;
let pendingPromise: Promise<CpuCapability> | null = null;

// Fresh, uncached probe. Never throws upward (AC-4).
export async function probeCpuCapability(deps: CpuCapabilityDeps = {}): Promise<CpuCapability> {
  const readFile = deps.readFile ?? defaultFs.readFile;
  let raw: string;
  try {
    raw = String(await readFile(CPUINFO_PATH, 'utf8'));
  } catch {
    return { ...NULL_CAPABILITY };
  }
  return classify(raw);
}

// Boot-cached probe (S1 — single readFile under concurrent cold-cache callers).
export async function getCpuCapability(deps: CpuCapabilityDeps = {}): Promise<CpuCapability> {
  if (cachedCapability) return cachedCapability;
  if (pendingPromise) return pendingPromise;
  pendingPromise = probeCpuCapability(deps)
    .then((cap) => {
      cachedCapability = cap;
      pendingPromise = null;
      return cap;
    })
    .catch((err) => {
      // probeCpuCapability never throws, but keep the cache consistent if it did.
      pendingPromise = null;
      throw err;
    });
  return pendingPromise;
}

// Public cache invalidate — mirrors container-image-probe's clearContainerImageCache;
// wired into the GET /api/diagnostics?refresh=1 path.
export function clearCpuCapabilityCache(): void {
  cachedCapability = null;
  pendingPromise = null;
}

// Test-only cache reset alias. NOT barrelled.
export function __forTests_resetCpuCapabilityCache(): void {
  clearCpuCapabilityCache();
}

function classify(raw: string): CpuCapability {
  const vendorId = firstField(raw, 'vendor_id');
  const modelName = firstField(raw, 'model name');
  const family = firstNumericField(raw, 'cpu family');
  const model = firstNumericField(raw, 'model');

  // No recognizable fields at all → null-filled (AC-4).
  if (vendorId === null && family === null && model === null && modelName === null) {
    return { ...NULL_CAPABILITY };
  }

  const isIntel = vendorId === 'GenuineIntel';

  // Non-Intel (AMD / ARM / unknown vendor) is inert (AC-3).
  if (!isIntel) {
    return {
      isIntel: false,
      vendorId,
      modelName,
      family,
      model,
      microarch: null,
      graphicsGen: null,
      hevcQsv: 'unknown',
    };
  }

  // Intel: gen-table lookup gated on family === 6.
  const entry = family === 6 && model !== null ? INTEL_CPUID_MODEL_TABLE.get(model) : undefined;
  const microarch = entry?.microarch ?? null;
  const graphicsGen = entry?.graphicsGen ?? null;
  const hevcQsv = classifyHevcQsv(graphicsGen);

  return {
    isIntel: true,
    vendorId,
    modelName,
    family,
    model,
    microarch,
    graphicsGen,
    hevcQsv,
  };
}

function classifyHevcQsv(graphicsGen: number | null): HevcQsvSupport {
  if (graphicsGen === null) return 'unknown'; // Intel but unknown model
  if (graphicsGen >= INTEL_IGPU_HEVC_QSV_10BIT_MIN_GEN) return '10bit';
  if (graphicsGen >= INTEL_IGPU_HEVC_QSV_MIN_GEN) return '8bit';
  return 'none';
}

// Full-line exact-key field extraction from the FIRST processor block (M1).
// `/proc/cpuinfo` lines are `key\t...: value`; a blank line separates processor
// blocks. We stop at the first blank line so only processor 0 is read.
function firstField(raw: string, key: string): string | null {
  for (const line of raw.split('\n')) {
    if (line.trim() === '') break; // end of first processor block
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const lineKey = line.slice(0, colon).trim();
    if (lineKey === key) {
      const value = line.slice(colon + 1).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

function firstNumericField(raw: string, key: string): number | null {
  const value = firstField(raw, key);
  if (value === null) return null;
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) ? n : null;
}
