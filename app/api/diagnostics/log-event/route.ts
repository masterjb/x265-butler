// Phase 21 Plan 21-02 — POST /api/diagnostics/log-event.
//
// Client-allowlist gate for audit-trail-relevant events that originate in the
// browser (Copy-Report, Encoder-Replay, Feedback-Link). Emits logger.info with
// `source:'log-event-route'` field so downstream Grafana/jq filters can
// distinguish client-POST records from server-emit records (audit-M3).
//
// audit-M1: auth-mirror gate matches /api/diagnostics + /api/diagnostics-report
// + /api/encoders/refresh — 401 when setting.auth_enabled='true' + no session.
// audit-D4: per-IP rate-limit + idempotency-key deferred; LAN-trust precedent
// inherited from 21-01-AUDIT D1/D2/D3 — no spawn, no hardware resource.

import { withRenewCookie } from '@/src/lib/auth/require-auth';
import { gateAuth } from '@/src/lib/api/auth-gate';
import { jsonResponse } from '@/src/lib/api/json-response';
import {
  clampPayloadValues,
  filterPayloadKeys,
  isClientAllowedEvent,
  isKnownSource,
  isValidTestEncodeOutcome,
  isValidWarningCode,
  noteInvalidOutcomeOnce,
  noteInvalidSourceOnce,
  noteInvalidWarningCodeOnce,
} from '@/src/lib/diagnostics/log-event-allowlist';
import { checkOrigin, checkRateLimit, ipFor } from '@/src/lib/diagnostics/log-event-rate-limit';
import { validateWebVitalPayload } from '@/src/lib/diagnostics/web-vital-validator';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 16 * 1024;

export async function POST(request: Request): Promise<Response> {
  ensureServerInit();

  const { denied, auth } = await gateAuth(request);
  if (denied) return denied;

  // 22-01 IMP-4 audit-M1: per-IP rate-limit + origin gate. Pre-payload-pass
  // closes the unauthenticated ring-buffer-DoS vector that came with the
  // webVitalCaptured client-emit (pages POST before operator-login completes
  // when auth_enabled=false).
  const rateCheck = checkRateLimit(request);
  if (!rateCheck.ok) {
    return new Response(
      JSON.stringify({ error: 'rate_limited', retryAfterSec: rateCheck.retryAfterSec }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Retry-After': String(rateCheck.retryAfterSec),
        },
      },
    );
  }
  const originCheck = checkOrigin(request);
  if (!originCheck.ok) {
    logger.warn(
      {
        action: 'log_event_origin_rejected',
        origin: request.headers.get('origin'),
        ip: ipFor(request),
      },
      'log_event_origin_rejected',
    );
    return jsonResponse({ error: 'origin_forbidden' }, 403);
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return jsonResponse({ error: 'unsupported_media_type' }, 415);
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return jsonResponse({ error: 'body_read_failed' }, 400);
  }

  if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES) {
    return jsonResponse({ error: 'payload_too_large' }, 413);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: 'malformed_json' }, 400);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return jsonResponse({ error: 'malformed_json' }, 400);
  }

  const body = parsed as Record<string, unknown>;
  const eventRaw = body.event;

  if (!isClientAllowedEvent(eventRaw)) {
    return jsonResponse({ error: 'unknown_event' }, 400);
  }

  // 22-01 IMP-4 audit-SR5: webVitalCaptured short-circuit. Validates the FLAT
  // body shape (metric/value/route/atIso at top-level, NOT nested under
  // body.payload) via extracted validator. Emits logger.debug with
  // action='web_vital_captured' (snake_case) so assembleWebVitals scanner
  // filters on msg ===  'web_vital_captured'.
  if (eventRaw === 'webVitalCaptured') {
    const result = validateWebVitalPayload(body);
    if (!result.ok) {
      return jsonResponse({ error: 'invalid_payload', reason: result.reason }, result.status);
    }
    logger.debug(
      {
        action: 'web_vital_captured',
        metric: body.metric,
        value: body.value,
        route: body.route,
        atIso: body.atIso,
      },
      'web_vital_captured',
    );
    const res = new Response(null, {
      status: 204,
      headers: { 'Cache-Control': 'no-store' },
    });
    return withRenewCookie(res, auth);
  }

  const payloadInput =
    typeof body.payload === 'object' && body.payload !== null && !Array.isArray(body.payload)
      ? (body.payload as Record<string, unknown>)
      : (body as Record<string, unknown>);

  const sanitized = filterPayloadKeys(eventRaw, payloadInput);

  // 21-04 audit-M6: code-value format guard for bannerDismissed.
  // Substitute '<invalid_code>' literal when the client-supplied `code` does
  // not match the warning-code regex — preserves audit-trail integrity while
  // blocking file-path / PII leakage from future aggregator code-extensions.
  // logger.info still fires with status 204 so the banner UX never blocks on
  // validator (silent-fail principle).
  if (eventRaw === 'bannerDismissed' && 'code' in sanitized) {
    if (!isValidWarningCode(sanitized.code)) {
      noteInvalidWarningCodeOnce(sanitized.code);
      sanitized.code = '<invalid_code>';
    }
  }

  // 21-05 audit-M1: outcome value-substitution mirroring audit-M6
  // code-substitution pattern. Defense against newline-injection into
  // structured logs via spoofed copyReportUnlocked POST.
  if (eventRaw === 'copyReportUnlocked' && 'outcome' in sanitized) {
    if (!isValidTestEncodeOutcome(sanitized.outcome)) {
      noteInvalidOutcomeOnce(sanitized.outcome);
      sanitized.outcome = '<invalid_outcome>';
    }
  }

  // 21-05 audit-SR6: source value-substitution against KNOWN_SOURCE_VALUES.
  // Applies UNIFORMLY across all events whose payload-schema includes 'source'
  // (errorBoundaryTriggered, bannerDismissed, bannerRestored, copyReportGated,
  // copyReportUnlocked). Spoofed-broker masquerade defense.
  if ('source' in sanitized) {
    if (!isKnownSource(sanitized.source)) {
      noteInvalidSourceOnce(sanitized.source);
      sanitized.source = '<invalid_source>';
    }
  }

  // 21-05 audit-M2: per-value length cap (256 bytes UTF-8). Inner-defense for
  // log-line budget protection — even within the 16 KB envelope cap, a single
  // ~15 KB value would exceed standard ELK / Loki / Grafana per-line budgets.
  const { clamped, truncatedKeys } = clampPayloadValues(sanitized);
  const sidecar = truncatedKeys.length > 0 ? { truncatedKeys } : {};

  logger.info(
    { event: eventRaw, source: 'log-event-route', ...clamped, ...sidecar },
    'diagnostics.log-event',
  );

  const res = new Response(null, {
    status: 204,
    headers: { 'Cache-Control': 'no-store' },
  });
  return withRenewCookie(res, auth);
}
