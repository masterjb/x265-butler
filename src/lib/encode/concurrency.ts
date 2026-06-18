// Phase 3 Plan 03-02 Task 1 — per-encoder concurrency limits computer.
//
// Pure function. Maps `settings.concurrency` + host `os.cpus().length` to a
// `PerEncoderLimits` map consumed by the orchestrator's dispatch loop.
//
// Algorithm (binding from Discovery):
//   - settings.concurrency = '<N>' (positive integer string) →
//     ALL encoders get limit N (operator override is universal)
//   - settings.concurrency = 'auto' OR undefined →
//     libx265 = clamp(floor(cpuCount / 4), 1, 8)
//     nvenc / qsv / vaapi = 1 (Discovery default — safe across consumer hardware)
//   - settings.concurrency = invalid (gibberish / '0' / negative) →
//     pino-warn + return the 'auto' result for the same effectiveCpuCount
//
// Audit notes:
//   S4 — defensive cpuCount clamp `Math.max(1, Math.floor(cpuCount))` handles
//        constrained environments returning os.cpus().length === 0; without
//        this, libx265 limit would collapse to 0 and the orchestrator silently
//        never dispatches.

import type { EncoderId } from './profiles';

export interface PerEncoderLimits {
  libx265: number;
  nvenc: number;
  qsv: number;
  vaapi: number;
}

export interface LimitsInput {
  concurrency: string | undefined;
  cpuCount: number;
  logger?: { warn: (obj: unknown, msg?: string) => void };
}

const HW_DEFAULT_LIMIT = 1; // Discovery: safe across all consumer NVENC/QSV/VAAPI cards.
const SW_LIMIT_CEILING = 8; // libx265 8-slot ceiling per Discovery.
const SW_LIMIT_FLOOR = 1; // libx265 always-≥1 floor.
const SW_CPU_DIVISOR = 4; // libx265 cores/4 heuristic per Discovery.

function autoLimits(effectiveCpuCount: number): PerEncoderLimits {
  const libx265 = Math.min(
    Math.max(SW_LIMIT_FLOOR, Math.floor(effectiveCpuCount / SW_CPU_DIVISOR)),
    SW_LIMIT_CEILING,
  );
  return {
    libx265,
    nvenc: HW_DEFAULT_LIMIT,
    qsv: HW_DEFAULT_LIMIT,
    vaapi: HW_DEFAULT_LIMIT,
  };
}

function uniformLimits(n: number): PerEncoderLimits {
  return { libx265: n, nvenc: n, qsv: n, vaapi: n };
}

export function computePerEncoderLimits(input: LimitsInput): PerEncoderLimits {
  // audit-added S4: defensive cpuCount clamp.
  const effectiveCpuCount = Math.max(
    1,
    Math.floor(Number.isFinite(input.cpuCount) ? input.cpuCount : 1),
  );

  const raw = input.concurrency;
  if (raw === undefined || raw === 'auto') {
    return autoLimits(effectiveCpuCount);
  }

  // Strict positive-integer-string match. `parseInt` accepts trailing junk
  // ('4abc' → 4), so use a regex to reject anything but pure digits.
  if (/^\d+$/.test(raw)) {
    const n = parseInt(raw, 10);
    if (n > 0) {
      return uniformLimits(n);
    }
  }

  // Invalid value path: '0', negative, gibberish, decimal, etc.
  input.logger?.warn(
    { action: 'concurrency_setting_invalid', value: raw, fallback: 'auto' },
    'invalid settings.concurrency — defaulting to auto',
  );
  return autoLimits(effectiveCpuCount);
}

// Re-export EncoderId for callers that consume PerEncoderLimits + EncoderId together.
export type { EncoderId };
