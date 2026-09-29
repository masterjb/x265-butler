// 22-01 IMP-2: slow_request ring-tail consumer-scanner.
//
// Decodes `slow_request` pino events from the in-memory ring-buffer, sorts
// topN by durationMs desc. Pattern-mirror src/lib/diagnostics/blocklist-evaluation.ts:
// consumer-only (never edits page/middleware), JSON-parse tolerant of malformed
// lines, decoder-only on failure.

import { tail } from '@/src/lib/log/ring-buffer';

const PINO_MSG = 'slow_request';
const DEFAULT_TAIL = 200;
const DEFAULT_MAX_OUT = 20;

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

export interface SlowRequestsDeps {
  tailLimit?: number;
  maxOut?: number;
  ringTail?: typeof tail;
}

export function assembleSlowRequests(deps: SlowRequestsDeps = {}): SlowRequestsBlock {
  const tailLimit = deps.tailLimit ?? DEFAULT_TAIL;
  const maxOut = deps.maxOut ?? DEFAULT_MAX_OUT;
  const tailFn = deps.ringTail ?? tail;

  let buffer: { lines: string[] };
  try {
    buffer = tailFn(tailLimit);
  } catch {
    return { topN: [], tailLimit, maxOut };
  }

  const slow: SlowRequestEntry[] = [];
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
    if (typeof parsed.route !== 'string') continue;
    if (typeof parsed.durationMs !== 'number' || !Number.isFinite(parsed.durationMs)) continue;
    const atIso =
      typeof parsed.time === 'number'
        ? new Date(parsed.time).toISOString()
        : new Date().toISOString();
    const breakdown =
      parsed.breakdown && typeof parsed.breakdown === 'object' && !Array.isArray(parsed.breakdown)
        ? (parsed.breakdown as Record<string, number>)
        : undefined;
    slow.push({
      route: parsed.route,
      durationMs: parsed.durationMs,
      atIso,
      breakdown,
    });
  }

  slow.sort((a, b) => b.durationMs - a.durationMs);
  return { topN: slow.slice(0, maxOut), tailLimit, maxOut };
}
