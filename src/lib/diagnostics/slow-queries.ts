// 22-01 IMP-3: slow_query ring-tail consumer-scanner.
//
// Pattern-mirror src/lib/diagnostics/slow-requests.ts: decodes `slow_query`
// pino events, sorts topN by durationMs desc, consumer-only over ring-buffer.

import { tail } from '@/src/lib/log/ring-buffer';

const PINO_MSG = 'slow_query';
const DEFAULT_TAIL = 500;
const DEFAULT_MAX_OUT = 20;

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

export interface SlowQueriesDeps {
  tailLimit?: number;
  maxOut?: number;
  ringTail?: typeof tail;
}

export function assembleSlowQueries(deps: SlowQueriesDeps = {}): SlowQueriesBlock {
  const tailLimit = deps.tailLimit ?? DEFAULT_TAIL;
  const maxOut = deps.maxOut ?? DEFAULT_MAX_OUT;
  const tailFn = deps.ringTail ?? tail;

  let buffer: { lines: string[] };
  try {
    buffer = tailFn(tailLimit);
  } catch {
    return { topN: [], tailLimit, maxOut };
  }

  const slow: SlowQueryEntry[] = [];
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
    if (typeof parsed.queryName !== 'string') continue;
    if (typeof parsed.durationMs !== 'number' || !Number.isFinite(parsed.durationMs)) continue;
    const atIso =
      typeof parsed.time === 'number'
        ? new Date(parsed.time).toISOString()
        : new Date().toISOString();
    slow.push({
      queryName: parsed.queryName,
      durationMs: parsed.durationMs,
      atIso,
    });
  }

  slow.sort((a, b) => b.durationMs - a.durationMs);
  return { topN: slow.slice(0, maxOut), tailLimit, maxOut };
}
