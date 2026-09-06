// 24-05 F7: DELETE /api/logs — operator "Clear log" action.
// Phase 24 Plan 24-05 — AC-2 + AC-3 + AC-4.
//
// Empties the in-memory pino ring buffer (the SAME ring read by
// /api/logs/container's tail() AND by the diagnostics consumers
// recent-errors / slow-requests / slow-queries — all `import { tail }`).
// The GET tail route at …/container/route.ts is intentionally untouched.
//
// Order matters: clear() FIRST, then emit the logs_cleared audit line, so the
// audit record survives the wipe (and the counts reflect the pre-clear state).

import crypto from 'node:crypto';
import { gateAuth } from '@/src/lib/api/auth-gate';
import { jsonResponse } from '@/src/lib/api/json-response';
import { tail, clear } from '@/src/lib/log/ring-buffer';
import { logger } from '@/src/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(request: Request): Promise<Response> {
  const { denied } = await gateAuth(request);
  if (denied) return denied; // authGuard's own 401 Response — ring untouched (AC-4)

  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/logs', method: 'DELETE' });

  try {
    // Capture true counts BEFORE clearing. tail() returns the real
    // totalLines/totalBytes regardless of the n arg (verified ring-buffer.ts).
    const before = tail(1000);
    const clearedLines = before.totalLines;
    const clearedBytes = before.totalBytes;

    clear(); // wipe FIRST (AC-3)

    log.info({ clearedLines, clearedBytes }, 'logs_cleared'); // audit AFTER wipe

    return jsonResponse({ cleared: clearedLines, bytesCleared: clearedBytes, requestId }, 200);
  } catch (err) {
    // audit-SR2: no silent failure — forensic record with requestId.
    log.error({ err: err instanceof Error ? err.stack : String(err) }, 'logs clear failed');
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
