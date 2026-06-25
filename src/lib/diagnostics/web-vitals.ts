// 22-01 IMP-4: web-vital ring-tail consumer-scanner.
//
// Aggregates per-route p75 of last-N samples for TTFB / LCP / INP. Sample
// retention is MOST-RECENT-N per route (audit-M5: reverse-iteration so the
// per-route bucket retains newest samples when ring-buffer history exceeds
// sampleCapPerRoute). p75 percentile uses ceil-based formula (audit-M3).
//
// Threshold-coloring deferred to consumer-plan per T0-decision D5=A
// (instrumentation-only-vorschalt scope).

import { tail } from '@/src/lib/log/ring-buffer';

const PINO_MSG = 'web_vital_captured';
const DEFAULT_TAIL = 500;
const DEFAULT_SAMPLE_CAP = 50;

export type WebVitalMetric = 'ttfb' | 'lcp' | 'inp';

export interface RouteMetric {
  p75: number;
  sampleSize: number;
}

export interface RouteVitals {
  ttfb?: RouteMetric;
  lcp?: RouteMetric;
  inp?: RouteMetric;
}

export interface WebVitalsBlock {
  byRoute: Record<string, RouteVitals>;
  tailLimit: number;
  sampleCapPerRoute: number;
}

export interface WebVitalsDeps {
  tailLimit?: number;
  sampleCapPerRoute?: number;
  ringTail?: typeof tail;
}

// audit-M3: ceil-based percentile.
// AC-8 pins n=20 sequence [100..2000] → p75 === 1500 (NOT 1600).
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const n = sorted.length;
  const idx = Math.min(n - 1, Math.ceil((p / 100) * n) - 1);
  return sorted[Math.max(0, idx)];
}

export function assembleWebVitals(deps: WebVitalsDeps = {}): WebVitalsBlock {
  const tailLimit = deps.tailLimit ?? DEFAULT_TAIL;
  const sampleCapPerRoute = deps.sampleCapPerRoute ?? DEFAULT_SAMPLE_CAP;
  const tailFn = deps.ringTail ?? tail;

  let buffer: { lines: string[] };
  try {
    buffer = tailFn(tailLimit);
  } catch {
    return { byRoute: {}, tailLimit, sampleCapPerRoute };
  }

  const samples: Record<string, { ttfb: number[]; lcp: number[]; inp: number[] }> = {};

  // audit-M5: reverse iteration so per-route bucket retains MOST-RECENT N samples
  // when ring-buffer accumulation exceeds sampleCapPerRoute.
  for (let i = buffer.lines.length - 1; i >= 0; i--) {
    const line = buffer.lines[i];
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
    if (typeof parsed.route !== 'string') continue;
    const metric = parsed.metric;
    if (metric !== 'ttfb' && metric !== 'lcp' && metric !== 'inp') continue;
    if (typeof parsed.value !== 'number' || !Number.isFinite(parsed.value)) continue;
    if (!samples[parsed.route]) {
      samples[parsed.route] = { ttfb: [], lcp: [], inp: [] };
    }
    const bucket = samples[parsed.route][metric];
    if (bucket.length < sampleCapPerRoute) bucket.push(parsed.value);
  }

  const byRoute: Record<string, RouteVitals> = {};
  for (const [route, m] of Object.entries(samples)) {
    const rv: RouteVitals = {};
    for (const k of ['ttfb', 'lcp', 'inp'] as const) {
      if (m[k].length > 0) {
        const sorted = [...m[k]].sort((a, b) => a - b);
        rv[k] = { p75: percentile(sorted, 75), sampleSize: m[k].length };
      }
    }
    byRoute[route] = rv;
  }
  return { byRoute, tailLimit, sampleCapPerRoute };
}
