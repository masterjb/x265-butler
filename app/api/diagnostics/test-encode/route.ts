// POST /api/diagnostics/test-encode.
//
// Body ignored (LAN-only diagnostic). Spawn parameters are NOT operator-
// controllable; synthetic input is hardcoded. Hard-mutex (one slot per
// process) returns 503 + Retry-After: 5 on concurrent request.

import { withRenewCookie } from '@/src/lib/auth/require-auth';
import { gateAuth } from '@/src/lib/api/auth-gate';
import { releaseMutex, runTestEncode, tryAcquireMutex } from '@/src/lib/diagnostics/test-encode';
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
    // No pre-resolved binary — runTestEncode's internal selector picks by the
    // detected encoder (nvenc → jellyfin ffmpeg-nvenc, else BtbN).
    const { body, auditOutcome } = await runTestEncode({});
    logger.info(
      {
        encoder: body.encoderPicked,
        // The requested encoder rides on the EXISTING line — no second log
        // call for the same event. Without it a post-incident reader
        // cannot tell "nvenc was tested" from "nvenc was asked for and libx265
        // answered", which is precisely the case a green result would hide.
        encoderRequested: body.encoderRequested,
        durationMs: body.durationMs,
        outcome: auditOutcome,
        exitCode: body.exitCode,
      },
      'testEncodeTriggered',
    );
    // Server-emit only — derived from server-captured stderr; NOT a
    // CLIENT_ALLOWED_EVENTS entry (mirrors testEncodeTriggered, so a client
    // cannot spoof it through /api/diagnostics/log-event). Flat
    // { encoder, code, severity, exitCode } shape for stable downstream log
    // queries; all values are closed-set.
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
