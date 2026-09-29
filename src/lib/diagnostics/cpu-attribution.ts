// 40-01: cpu_attribution ring-tail consumer-scanner.
//
// Pattern-mirror src/lib/diagnostics/slow-queries.ts: decodes `cpu_attribution`
// pino events emitted by the headless sampler (cpu-attribution-sampler.ts),
// surfaces the most-recent sample (`latest`) + the N worst by event-loop-lag p99
// (`topByLagP99`). Consumer-only over the ring-buffer; never throws (empty block
// on malformed/absent input) so GET /api/diagnostics stays 200.

import { tail } from '@/src/lib/log/ring-buffer';

const PINO_MSG = 'cpu_attribution';
const DEFAULT_TAIL = 500;
const DEFAULT_MAX_OUT = 20;

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

export interface CpuAttributionDeps {
  tailLimit?: number;
  maxOut?: number;
  ringTail?: typeof tail;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function assembleCpuAttribution(deps: CpuAttributionDeps = {}): CpuAttributionBlock {
  const tailLimit = deps.tailLimit ?? DEFAULT_TAIL;
  const maxOut = deps.maxOut ?? DEFAULT_MAX_OUT;
  const tailFn = deps.ringTail ?? tail;

  const empty: CpuAttributionBlock = {
    latest: null,
    topByLagP99: [],
    sampleCount: 0,
    tailLimit,
    maxOut,
  };

  let buffer: { lines: string[] };
  try {
    buffer = tailFn(tailLimit);
  } catch {
    return empty;
  }

  const samples: CpuAttributionSample[] = [];
  for (const line of buffer.lines) {
    if (typeof line !== 'string' || line.length === 0) continue;
    let parsed: Record<string, unknown> | undefined;
    try {
      const raw = JSON.parse(line);
      if (raw && typeof raw === 'object') parsed = raw as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!parsed) continue;
    if (parsed.msg !== PINO_MSG) continue;

    // The lag p99 is the discriminating key — require it numeric. Other metrics
    // coerce to 0 if a future emit drops one (defensive, never throws).
    const p99 = num(parsed.eventLoopLagP99Ms);
    if (p99 === null) continue;

    const atIso =
      typeof parsed.time === 'number'
        ? new Date(parsed.time).toISOString()
        : new Date().toISOString();

    samples.push({
      eventLoopLagP50Ms: num(parsed.eventLoopLagP50Ms) ?? 0,
      eventLoopLagP99Ms: p99,
      eventLoopLagMaxMs: num(parsed.eventLoopLagMaxMs) ?? 0,
      cpuUserPctCore: num(parsed.cpuUserPctCore) ?? 0,
      cpuSysPctCore: num(parsed.cpuSysPctCore) ?? 0,
      activeEncodes: num(parsed.activeEncodes) ?? 0,
      uptimeSec: num(parsed.uptimeSec) ?? 0,
      atIso,
    });
  }

  if (samples.length === 0) return empty;

  // Ring is chronological → last decoded sample is the most recent.
  const latest = samples[samples.length - 1];
  const topByLagP99 = [...samples]
    .sort((a, b) => b.eventLoopLagP99Ms - a.eventLoopLagP99Ms)
    .slice(0, maxOut);

  return { latest, topByLagP99, sampleCount: samples.length, tailLimit, maxOut };
}
