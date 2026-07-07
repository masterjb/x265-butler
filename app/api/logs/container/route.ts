// 05-03 T1.I: GET /api/logs/container — pino ring-buffer tail.
// Phase 5 Plan 05-03 (Logs Viewer) — AC-5 + audit S1 + S5.
//
// Reads from the in-memory pino ring buffer (1000 lines / 5 MB cap; FIFO
// eviction; populated by pino multistream wrap in src/lib/logger.ts).
//
// Query params:
//   ?lines=N         clamp [1..1000]; default 100
//   ?format=raw|json default 'raw' (pretty-prefixed); 'json' returns raw NDJSON

import crypto from 'node:crypto';
import { withRenewCookie } from '@/src/lib/auth/require-auth';
import { gateAuth } from '@/src/lib/api/auth-gate';
import { jsonResponse } from '@/src/lib/api/json-response';
import { tail } from '@/src/lib/log/ring-buffer';
import { logger } from '@/src/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_LINES = 100;
const MAX_LINES = 1000;

/**
 * Best-effort prettifier for ndjson pino lines. When the line is not valid
 * JSON, return it unchanged. Output format:
 *   <ISO time> <LEVEL> <msg> <kv-rest>
 */
function prettifyLine(rawLine: string): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawLine) as Record<string, unknown>;
  } catch {
    return rawLine;
  }
  const time =
    typeof parsed.time === 'number'
      ? new Date(parsed.time).toISOString()
      : typeof parsed.time === 'string'
        ? parsed.time
        : '';
  const levelMap: Record<number, string> = {
    10: 'TRACE',
    20: 'DEBUG',
    30: 'INFO',
    40: 'WARN',
    50: 'ERROR',
    60: 'FATAL',
  };
  const level =
    typeof parsed.level === 'number' ? (levelMap[parsed.level] ?? `L${parsed.level}`) : 'INFO';
  const msg = typeof parsed.msg === 'string' ? parsed.msg : '';
  // Strip well-known fields; serialize the rest as compact JSON when present.
  const known = new Set(['time', 'level', 'msg', 'pid', 'hostname', 'v']);
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (!known.has(k)) rest[k] = v;
  }
  const restStr = Object.keys(rest).length > 0 ? ' ' + JSON.stringify(rest) : '';
  return `${time} ${level} ${msg}${restStr}`.trim();
}

export async function GET(request: Request): Promise<Response> {
  const { denied, auth } = await gateAuth(request);
  if (denied) return denied;

  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/logs/container' });

  const url = new URL(request.url);
  const linesParam = url.searchParams.get('lines');
  const formatParam = url.searchParams.get('format') ?? 'raw';

  let lines = DEFAULT_LINES;
  if (linesParam !== null) {
    const parsed = Number.parseInt(linesParam, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return jsonResponse({ error_code: 'invalid_lines', requestId }, 400);
    }
    lines = Math.min(parsed, MAX_LINES);
  }

  const format: 'raw' | 'json' = formatParam === 'json' ? 'json' : 'raw';

  const snapshot = tail(lines);
  const out = format === 'json' ? snapshot.lines : snapshot.lines.map((l) => prettifyLine(l));

  log.debug(
    { lines, format, totalLines: snapshot.totalLines, totalBytes: snapshot.totalBytes },
    'container log tail served',
  );

  return withRenewCookie(
    jsonResponse(
      {
        lines: out,
        totalLines: snapshot.totalLines,
        totalBytes: snapshot.totalBytes,
        format,
        requestId,
      },
      200,
    ),
    auth,
  );
}
