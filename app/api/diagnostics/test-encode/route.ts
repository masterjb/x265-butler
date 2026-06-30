// Phase 21 Plan 21-01 — POST /api/diagnostics/test-encode.
//
// Body ignored (LAN-only diagnostic). Spawn parameters are NOT operator-
// controllable; synthetic input is hardcoded. Hard-mutex (one slot per
// process) returns 503 + Retry-After: 5 on concurrent request.

import { withRenewCookie } from '@/src/lib/auth/require-auth';
import { gateAuth } from '@/src/lib/api/auth-gate';
import { releaseMutex, runTestEncode, tryAcquireMutex } from '@/src/lib/diagnostics/test-encode';
import { ffmpegBinary } from '@/src/lib/encode/ffmpeg-binary';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  ensureServerInit();
  const { denied, auth } = await gateAuth(request);
  if (denied) return denied;

  if (!tryAcquireMutex()) {
    logger.info(
      { encoder: null, durationMs: 0, outcome: 'mutex_held', exitCode: null },
      'testEncodeTriggered',
    );
    return new Response(
      JSON.stringify({ error_code: 'test_encode_in_flight', retryAfterSeconds: 5 }),
      {
        status: 503,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Retry-After': '5',
          'Cache-Control': 'no-store',
        },
      },
    );
  }

  try {
    const { body, auditOutcome } = await runTestEncode({ ffmpegPath: ffmpegBinary() });
    logger.info(
      {
        encoder: body.encoderPicked,
        durationMs: body.durationMs,
        outcome: auditOutcome,
        exitCode: body.exitCode,
      },
      'testEncodeTriggered',
    );
    // 23-01: server-emit only — derived from server-captured stderr; NOT a
    // CLIENT_ALLOWED_EVENTS entry (mirrors testEncodeTriggered, 21-02 audit-M3
    // spoof-defense). Flat { encoder, code, severity, exitCode } shape for
    // stable downstream log queries (audit-SR3); all values are closed-set.
    if (body.mappedError) {
      logger.info(
        {
          encoder: body.encoderPicked,
          code: body.mappedError.code,
          severity: body.mappedError.severity,
          exitCode: body.exitCode,
        },
        'testEncodeErrorMapped',
      );
    }
    const res = new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
    return withRenewCookie(res, auth);
  } catch (err) {
    logger.error(
      {
        err: err instanceof Error ? err.stack : String(err),
        route: '/api/diagnostics/test-encode',
      },
      'test_encode_unexpected_failure',
    );
    return new Response(JSON.stringify({ error_code: 'test_encode_failed' }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  } finally {
    releaseMutex();
  }
}
