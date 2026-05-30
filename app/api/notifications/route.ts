// Phase 18 Plan 18-01 Task 4 — GET /api/notifications.
//
// Auth-gate pattern MIRRORS /api/encoders (Plan 05-01 T3 gate). Returns
// the runtime-derived notification list + severity counts.

import crypto from 'node:crypto';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';
import { authGuard, requireAuth } from '@/src/lib/auth/require-auth';
import { notificationStore } from '@/src/lib/notifications/store';

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
  // audit-fix M1: auth-gate parity with /api/encoders.
  const __auth = await requireAuth(request);
  const __denied = authGuard(__auth);
  if (__denied) return __denied;

  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return jsonResponse(
      { notifications: [], count: 0, severityCounts: { info: 0, warn: 0 }, requestId: 'build' },
      200,
    );
  }

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/notifications' });

  try {
    const notifications = await notificationStore().list();
    const severityCounts = notifications.reduce(
      (acc, n) => ({ ...acc, [n.severity]: (acc[n.severity] ?? 0) + 1 }),
      { info: 0, warn: 0 } as Record<'info' | 'warn', number>,
    );
    return jsonResponse(
      {
        notifications,
        count: notifications.length,
        severityCounts,
        requestId,
      },
      200,
    );
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/notifications: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
