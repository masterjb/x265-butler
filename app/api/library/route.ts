import crypto from 'node:crypto';
import { fileRepo, shareRepo } from '@/src/lib/db';
import { logger } from '@/src/lib/logger';
import { libraryQuerySchema, toListOptions } from '@/src/lib/api/library-query';

import { authGuard, requireAuth } from '@/src/lib/auth/require-auth';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  // 05-01 Plan T3: requireAuth gate.
  const __auth = await requireAuth(request);
  const __denied = authGuard(__auth);
  if (__denied) return __denied;

  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/library' });

  const startedAt = Date.now();
  try {
    const url = new URL(request.url);
    const raw: Record<string, string> = {};
    url.searchParams.forEach((v, k) => {
      if (v !== '') raw[k] = v;
    });
    const parsed = libraryQuerySchema.safeParse(raw);
    if (!parsed.success) {
      log.warn({ issues: parsed.error.issues }, 'invalid query');
      return jsonResponse({ error: 'invalid_query', details: parsed.error.issues, requestId }, 400);
    }
    const query = parsed.data;
    const opts = toListOptions(query);

    // 15-01 audit M4: pathPrefix had raw input but zod regex-rejected it
    // (per-field `.catch(undefined)`). Emit warn-log for operator audit
    // trail before continuing the request (200 OK without filter).
    if (raw.pathPrefix !== undefined && query.pathPrefix === undefined) {
      log.warn(
        { reason: 'control_char', rawLength: raw.pathPrefix.length },
        'library_pathprefix_rejected',
      );
    }

    const repo = fileRepo();
    const { rows, total } = repo.listPaginated(opts);
    const countsByStatus = repo.countByStatus();
    const orphan = repo.countOrphaned();
    const pageCount = total === 0 ? 0 : Math.ceil(total / opts.size);

    // 14-03 audit M1: invalid / non-existent share-id audit-trail (covers
    // AC-16 API slice). Reflect-supplied id semantics — we do NOT 4xx; UI
    // fallback (Share: All) handles operator escape.
    if (typeof query.share === 'number') {
      const sharesAll = shareRepo().listAll();
      if (!sharesAll.some((s) => s.id === query.share)) {
        log.warn(
          {
            requestedShareId: query.share,
            knownShareIds: sharesAll.map((s) => s.id),
          },
          '/api/library: share-id not in shares-table — operator URL hack or out-of-band delete',
        );
      }
    }

    // 15-01 audit M1: additive info-log on success path. Carries pathPrefix
    // presence + scope + duration_ms + rowCount for SOC-2 audit-trail
    // reconstruction. Does NOT replace existing emit shapes — strictly additive.
    log.info(
      {
        hasPathPrefix: query.pathPrefix != null,
        share: query.share,
        status: query.status,
        duration_ms: Date.now() - startedAt,
        rowCount: rows.length,
      },
      'library_query_executed',
    );

    return jsonResponse(
      {
        rows,
        pagination: {
          page: query.page,
          size: query.size,
          total,
          pageCount,
        },
        counts: { ...countsByStatus, orphan },
        effectiveFilters: {
          q: query.q,
          status: query.status,
          sort: query.sort,
          dir: query.dir,
          share: query.share,
          pathPrefix: query.pathPrefix,
        },
        requestId,
      },
      200,
    );
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/library: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
