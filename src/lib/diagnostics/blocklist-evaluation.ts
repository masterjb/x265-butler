// 22-00 IMP-8: blocklist-evaluation surface for /api/diagnostics.
//
// Decodes blocklist_evaluation pino events from the in-memory ring-buffer,
// surfaces BlocklistRepo.count() + patternCachedAt timestamp. ZERO new
// persistence (IMP-15 SQLite diagnostic_event stays M3-deferred).

import { tail } from '@/src/lib/log/ring-buffer';
import { blocklistRepo as defaultBlocklistRepo } from '@/src/lib/db';
import { getPatternsCacheTimestamp } from '@/src/lib/skip/pipeline';
import type { BlocklistRepo } from '@/src/lib/db/repos/blocklist';

const PINO_MSG = 'blocklist_evaluation';
const RING_FULL_SCAN = 1000;
const RECENT_CAP = 50;

export interface BlocklistMatchedEntry {
  id: number;
  kind: 'file_id' | 'path_pattern';
  pattern?: string;
}

export interface BlocklistRecentEvaluation {
  path: string;
  matchedEntry: BlocklistMatchedEntry | null;
  matchedAt: string;
}

export interface BlocklistEvaluationBlock {
  totalEntries: number;
  recentEvaluations: BlocklistRecentEvaluation[];
  patternCachedAt: string | null;
}

export interface BlocklistEvaluationDeps {
  blocklistRepo?: () => BlocklistRepo;
  ringTail?: typeof tail;
  patternsCacheTimestampGetter?: () => string | null;
}

export function assembleBlocklistEvaluation(
  deps: BlocklistEvaluationDeps = {},
): BlocklistEvaluationBlock {
  const repoFactory = deps.blocklistRepo ?? defaultBlocklistRepo;
  const tailFn = deps.ringTail ?? tail;
  const getTs = deps.patternsCacheTimestampGetter ?? getPatternsCacheTimestamp;

  let totalEntries = 0;
  try {
    totalEntries = repoFactory().count();
  } catch {
    totalEntries = 0;
  }

  let buffer: { lines: string[] };
  try {
    buffer = tailFn(RING_FULL_SCAN);
  } catch {
    return { totalEntries, recentEvaluations: [], patternCachedAt: getTs() };
  }

  const evaluations: BlocklistRecentEvaluation[] = [];
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

    const path = typeof parsed.path === 'string' ? parsed.path : null;
    if (!path) continue;

    const rawMatched = parsed.matchedEntry;
    let matchedEntry: BlocklistMatchedEntry | null = null;
    if (rawMatched && typeof rawMatched === 'object') {
      const m = rawMatched as Record<string, unknown>;
      const id = typeof m.id === 'number' ? m.id : null;
      const kind = m.kind === 'file_id' || m.kind === 'path_pattern' ? m.kind : null;
      if (id !== null && kind !== null) {
        matchedEntry = { id, kind };
        if (typeof m.pattern === 'string') matchedEntry.pattern = m.pattern;
      }
    }

    const tsCandidate = typeof parsed.time === 'number' ? parsed.time : 0;
    const matchedAt = new Date(tsCandidate).toISOString();

    evaluations.push({ path, matchedEntry, matchedAt });
  }

  // Newest-first: ring-buffer is FIFO append, so reverse + slice.
  evaluations.reverse();
  const recentEvaluations = evaluations.slice(0, RECENT_CAP);

  return {
    totalEntries,
    recentEvaluations,
    patternCachedAt: getTs(),
  };
}
