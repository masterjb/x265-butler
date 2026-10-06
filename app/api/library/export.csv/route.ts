// GET /api/library/export.csv — streaming CSV export.
//
// Order of operations:
//   1. requireAuth() + authGuard()
//   2. parse libraryQuerySchema (zod)
//   3. countByQuery() → projectedRowCount
//   4. emit log_csv_export_attempt BEFORE body
//   5. construct ReadableStream (pull-based)
//   6. respond with RFC 5987 dual Content-Disposition
//
// Invariants:
//   - iter.return?.() called BEFORE controller.error(err)
//   - log_csv_export_complete fires on success/error/cancel paths
//   - attempt event fires even when auth_enabled='false'
//   - pull-based stream — exactly one row enqueued per consumer pull
//   - request.signal abort path triggers cleanup

import crypto from 'node:crypto';

import { withRenewCookie } from '@/src/lib/auth/require-auth';
import { gateAuth } from '@/src/lib/api/auth-gate';
import { jsonResponse } from '@/src/lib/api/json-response';
import { extractIp, hashIp } from '@/src/lib/auth/rate-limit';
import { getCachedAuthSetting } from '@/src/lib/auth/settings-cache';
import { fileRepo, shareRepo } from '@/src/lib/db';
import type { FileRow } from '@/src/lib/db/schema';
import { libraryQuerySchema, toListOptions } from '@/src/lib/api/library-query';
import {
  BOM_BYTES,
  CRLF,
  CSV_HEADERS,
  buildExportFilename,
  contentDisposition,
  rowToCsvLine,
  type ExportScope,
} from '@/src/lib/api/library-csv';
import { logger } from '@/src/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const { denied, auth } = await gateAuth(request);
  if (denied) return denied;

  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/library/export.csv' });

  const url = new URL(request.url);
  const raw: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    if (v !== '') raw[k] = v;
  });
  const parsed = libraryQuerySchema.safeParse(raw);
  if (!parsed.success) {
    return jsonResponse({ error: 'invalid_query', details: parsed.error.issues, requestId }, 400);
  }
  const query = parsed.data;
  const opts = toListOptions(query);

  const repo = fileRepo();
  const projectedRowCount = repo.countByQuery(opts);

  // Resolve share-scope for filename + audit-trail. Single
  // shareRepo().getById() lookup happens BEFORE the response stream so the
  // filename can be sealed into Content-Disposition.
  let scope: ExportScope = { type: 'all' };
  if (query.share === 'orphan') {
    scope = { type: 'orphan' };
  } else if (typeof query.share === 'number') {
    const sRow = shareRepo().getById(query.share);
    if (!sRow) {
      // Symmetry with /api/library — emit warn-log so SOC 2 reconstruction
      // can correlate library-view + CSV-export per requestId.
      log.warn(
        {
          requestedShareId: query.share,
          knownShareIds: shareRepo()
            .listAll()
            .map((s) => s.id),
        },
        '/api/library/export.csv: share-id not in shares-table',
      );
    }
    // Fallback `unknown` baked into slugifyShareName when name missing.
    scope = { type: 'share', id: query.share, name: sRow?.name ?? 'unknown' };
  }

  const trustXff = getCachedAuthSetting('auth_trust_proxy_xff') === 'true';
  const ipHash = hashIp(extractIp(request, trustXff));

  // Attempt event fires regardless of auth mode. SOC 2
  // reconstruction must work in auth_enabled='false' mode too.
  log.info(
    {
      event: 'log_csv_export_attempt',
      requestId,
      username: auth.ok ? auth.username : null,
      ip_hash: ipHash,
      query: {
        q: opts.q ?? null,
        status: opts.status ?? null,
        sort: opts.sort,
        dir: opts.dir,
        includeVanished: !!opts.includeVanished,
        // Share-scope in audit-trail for SOC 2 symmetry.
        share: query.share ?? null,
      },
      projectedRowCount,
    },
    'csv export started',
  );

  const now = new Date();
  const filename = buildExportFilename(now, scope);

  // Pull-based stream. start() pushing all rows would unbound the
  // internal queue and break memory bounds at scale. pull() honors backpressure —
  // exactly one row is enqueued per consumer pull.
  let iter: IterableIterator<FileRow> | null = null;
  let rowsEmitted = 0;
  type Phase = 'bom' | 'header' | 'rows' | 'done';
  let phase: Phase = 'bom';
  let completed = false;

  function releaseIter(): void {
    if (!iter) return;
    try {
      iter.return?.();
    } catch {
      // swallow — releasing a finished iterator should not error the response
    }
    iter = null;
  }

  const onAbort = (): void => {
    // Client TCP disconnect propagated by Next.js.
    if (completed) return;
    completed = true;
    releaseIter();
    log.info(
      {
        event: 'log_csv_export_complete',
        requestId,
        rowsEmitted,
        ok: false,
        errorReason: 'client_cancelled',
      },
      'csv export finished (signal abort)',
    );
  };

  const webStream = new ReadableStream<Uint8Array>({
    start() {
      iter = repo.iterateAll(opts);
      request.signal.addEventListener('abort', onAbort);
    },
    pull(controller) {
      try {
        if (phase === 'bom') {
          controller.enqueue(BOM_BYTES);
          phase = 'header';
          return;
        }
        if (phase === 'header') {
          controller.enqueue(Buffer.from(CSV_HEADERS.join(',') + CRLF, 'utf8'));
          phase = 'rows';
          return;
        }
        if (phase === 'rows') {
          const next = iter!.next();
          if (next.done) {
            phase = 'done';
            request.signal.removeEventListener('abort', onAbort);
            if (!completed) {
              completed = true;
              // Success path
              log.info(
                {
                  event: 'log_csv_export_complete',
                  requestId,
                  rowsEmitted,
                  ok: true,
                  errorReason: undefined,
                },
                'csv export finished',
              );
            }
            controller.close();
            return;
          }
          controller.enqueue(Buffer.from(rowToCsvLine(next.value) + CRLF, 'utf8'));
          rowsEmitted++;
          return;
        }
      } catch (err) {
        // Release the iterator BEFORE erroring the controller so
        // the underlying SQLite statement is freed even on mid-stream throw.
        releaseIter();
        request.signal.removeEventListener('abort', onAbort);
        const errorReason = err instanceof Error ? err.message : String(err);
        if (!completed) {
          completed = true;
          // Error path
          log.info(
            {
              event: 'log_csv_export_complete',
              requestId,
              rowsEmitted,
              ok: false,
              errorReason,
            },
            'csv export finished (error)',
          );
        }
        try {
          controller.error(err);
        } catch {
          // already errored
        }
      }
    },
    cancel() {
      // Reader cancelled (consumer abort, browser tab close after fetch
      // started, fetch AbortController.abort).
      releaseIter();
      request.signal.removeEventListener('abort', onAbort);
      if (!completed) {
        completed = true;
        // Cancel path
        log.info(
          {
            event: 'log_csv_export_complete',
            requestId,
            rowsEmitted,
            ok: false,
            errorReason: 'client_cancelled',
          },
          'csv export finished (cancel)',
        );
      }
    },
  });

  const response = new Response(webStream, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': contentDisposition(filename),
      'Cache-Control': 'no-store',
      'X-Request-Id': requestId,
    },
  });
  return withRenewCookie(response, auth);
}
