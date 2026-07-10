// 14-04 Task 3: /api/shares — GET list + POST create.
//
// audit-fix M1 (audit): assertNonNested + create wrapped in
// db.transaction() so the SQLite default isolation serializes the TOCTOU
// window between concurrent POSTs. See AC-21.
// audit-fix SR4: every mutation logs full enriched fields (action / shareId /
// name / path / filter-quartet / actor / requestId).
// audit-fix SR3 actor field: session userId when AUTH_ENABLED=true, literal
// 'anonymous' otherwise (per AC-26 last clause).
//
// Pattern mirrors app/api/library/route.ts:
//   - requireAuth → authGuard short-circuit (AC-9)
//   - pino child logger carrying requestId (SR3 audit-trail correlation)
//   - jsonResponse helper (Content-Type + no-store)
//   - Node runtime, force-dynamic (Auth + DB writes).
//
// Concurrency model: better-sqlite3 is synchronous → Promise.all() over POSTs
// will serialize within the event loop, but the assertNonNested+create TX
// wrap is still load-bearing for any external write-source (CLI tool, future
// admin script) AND documents the invariant in the route surface.

import crypto from 'node:crypto';
import { getDb, shareRepo } from '@/src/lib/db';
import { logger } from '@/src/lib/logger';
import { gateAuth } from '@/src/lib/api/auth-gate';
import { jsonResponse } from '@/src/lib/api/json-response';
import {
  shareCreateSchema,
  fieldErrorsFromZod,
  mapShareRepoErrorToHttp,
} from '@/src/lib/api/shares-zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function actorFromAuth(auth: {
  ok: true;
  mode: 'disabled' | 'authenticated';
  username: string | null;
}): string {
  return auth.mode === 'authenticated' && auth.username ? auth.username : 'anonymous';
}

export async function GET(request: Request): Promise<Response> {
  const { denied, auth } = await gateAuth(request);
  if (denied) return denied;

  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/shares' });
  const actor = actorFromAuth(auth);

  try {
    const shares = shareRepo().listAll();
    log.info({ action: 'shares_listed', count: shares.length, actor }, 'shares listed');
    return jsonResponse({ shares, count: shares.length, requestId }, 200);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/shares GET: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}

export async function POST(request: Request): Promise<Response> {
  const { denied, auth } = await gateAuth(request);
  if (denied) return denied;

  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/shares' });
  const actor = actorFromAuth(auth);

  // Content-Type guard mirrors /api/library/export.csv pattern.
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return jsonResponse({ error: 'unsupported_media_type', requestId }, 415);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid_json', requestId }, 400);
  }

  const parsed = shareCreateSchema.safeParse(body);
  if (!parsed.success) {
    const fieldErrors = fieldErrorsFromZod(parsed.error);
    log.warn({ action: 'share_create_rejected_validation', fieldErrors, actor }, 'zod rejected');
    return jsonResponse(
      {
        error: 'validation_failed',
        fieldErrors,
        requestId,
      },
      400,
    );
  }

  const input = parsed.data;

  try {
    // audit-fix M1: TX wraps assertNonNested + create. shareRepo.create also
    // calls assertNonNested internally — the outer assertNonNested is the
    // documented serialization point per AC-21; the inner re-check is
    // defense-in-depth + already part of the repo contract.
    const created = getDb().transaction(() => {
      shareRepo().assertNonNested({ path: input.path });
      return shareRepo().create(input);
    })();

    log.info(
      {
        action: 'share_created',
        shareId: created.id,
        name: created.name,
        path: created.path,
        min_size_mb: created.min_size_mb,
        extensions_csv: created.extensions_csv,
        max_depth: created.max_depth,
        actor,
      },
      'share created',
    );

    return jsonResponse({ share: created, requestId }, 201);
  } catch (err) {
    const mapped = mapShareRepoErrorToHttp(err);
    if (mapped) {
      log.warn(
        { action: 'share_create_rejected', error: mapped.body.error, path: input.path, actor },
        'share create rejected',
      );
      return jsonResponse({ ...mapped.body, requestId }, mapped.status);
    }
    log.error(
      { err: err instanceof Error ? err.stack : String(err), actor },
      '/api/shares POST: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
