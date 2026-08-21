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

// 50-05: one parse per line, two consumers — the prettified string AND the
// `meta` sidecar the log viewer filters on. Splitting the parse out is what
// makes `meta` possible without the client re-parsing a rendered string:
// `prettifyLine` ends with `.trim()`, so a line WITHOUT a `time` field shifts
// the level token from position 2 to position 1 and any "second word = level"
// client parser is wrong on exactly those lines.
function parseLogLine(rawLine: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(rawLine);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 50-05: per-line sidecar for the container-log viewer's filters. Index-aligned
 * with `lines`; `null` for a line that is not a JSON object (the prettifier
 * passes those through verbatim, so there is nothing to describe).
 *
 * Nothing is guessed: `level` is carried only when it is a number, `action`
 * only when it is a string. A missing or oddly-typed field yields `null`, and
 * the viewer's telemetry filter treats that as "not telemetry" (fail-open).
 *
 * Exposes NO field the caller does not already receive — both values are part
 * of `lines` already (raw NDJSON in `format=json`, the appended rest-JSON in
 * `format=raw`).
 */
export type ContainerLogMeta = { level: number | null; action: string | null } | null;

function metaForLine(parsed: Record<string, unknown> | null): ContainerLogMeta {
  if (parsed === null) return null;
  return {
    level: typeof parsed.level === 'number' ? parsed.level : null,
    action: typeof parsed.action === 'string' ? parsed.action : null,
  };
}

/**
 * Best-effort prettifier for ndjson pino lines. When the line is not valid
 * JSON, return it unchanged. Output format:
 *   <ISO time> <LEVEL> <msg> <kv-rest>
 *
 * 50-05: takes the already-parsed object instead of parsing itself (`null` =
 * not JSON → verbatim passthrough, unchanged behaviour). The produced string is
 * byte-identical to the pre-50-05 output.
 */
function prettifyLine(rawLine: string, parsed: Record<string, unknown> | null): string {
  if (parsed === null) {
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
    // 49-04: the telemetry tier (quiet on stdout, recorded in the ring). The
    // `L${level}` fallback below stays — it exists for UNKNOWN levels, and 25
    // is known from here on.
    25: 'TELE',
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
  // 50-05: parse the RAW ring lines once. Deliberately derived from
  // snapshot.lines and not from `out` — in `format=raw` `out` is already the
  // prettified string, and the structure is no longer recoverable from it.
  // Both formats therefore get the identical `meta`.
  const parsedLines = snapshot.lines.map((l) => parseLogLine(l));
  const meta: ContainerLogMeta[] = parsedLines.map((p) => metaForLine(p));
  const out =
    format === 'json'
      ? snapshot.lines
      : snapshot.lines.map((l, i) => prettifyLine(l, parsedLines[i]));

  log.debug(
    { lines, format, totalLines: snapshot.totalLines, totalBytes: snapshot.totalBytes },
    'container log tail served',
  );

  return withRenewCookie(
    jsonResponse(
      {
        lines: out,
        // 50-05: additive, index-aligned with `lines`. `lines` itself is
        // untouched, so the download link and every existing consumer are
        // unaffected.
        meta,
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
