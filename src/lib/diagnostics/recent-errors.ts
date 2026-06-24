// Phase 21 Plan 21-01 — consumer-only filter over the Phase-5 pino ring-buffer.
//
// Never throws. Never writes. Drops malformed JSON lines silently. Reads via
// the existing `tail()` API in `src/lib/log/ring-buffer.ts` — DO NOT touch the
// ring-buffer source.

import { tail } from '@/src/lib/log/ring-buffer';
import type { RecentErrorEntry } from './types';

const RING_FULL_SCAN = 1000;
const MSG_HARD_CAP = 500;
const PINO_LEVEL_ERROR = 50;

export function getRecentErrors(limit: number = 25): RecentErrorEntry[] {
  let buffer: { lines: string[] };
  try {
    buffer = tail(RING_FULL_SCAN);
  } catch {
    return [];
  }

  const out: RecentErrorEntry[] = [];
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

    const level = typeof parsed.level === 'number' ? parsed.level : -1;
    if (level < PINO_LEVEL_ERROR) continue;

    const ts = typeof parsed.time === 'number' ? parsed.time : 0;
    const rawMsg = parsed.msg ?? '';
    const msg = String(rawMsg).slice(0, MSG_HARD_CAP);

    const source =
      pickStringField(parsed, 'source') ??
      pickStringField(parsed, 'module') ??
      pickStringField(parsed, 'event') ??
      pickStringField(parsed, 'action');

    const entry: RecentErrorEntry = { ts, level, msg };
    if (source) entry.source = source;
    out.push(entry);
  }

  out.reverse();
  if (limit <= 0) return [];
  return out.slice(0, limit);
}

function pickStringField(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
