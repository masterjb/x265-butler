// 22-01 IMP-4 audit-SR5: extracted web-vital payload validator.
//
// Discriminated-union result `{ ok: true } | { ok: false, reason, status }`.
// Used by /api/diagnostics/log-event route handler to delegate per-event
// validation — keeps inline route logic clean + enables targeted unit tests.

export type ValidationResult = { ok: true } | { ok: false; reason: string; status: 400 };

const VALID_METRICS = new Set(['ttfb', 'lcp', 'inp']);

export function validateWebVitalPayload(body: unknown): ValidationResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, reason: 'body_not_object', status: 400 };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.metric !== 'string' || !VALID_METRICS.has(b.metric)) {
    return { ok: false, reason: 'metric_invalid', status: 400 };
  }
  if (typeof b.value !== 'number' || !Number.isFinite(b.value) || b.value < 0) {
    return { ok: false, reason: 'value_invalid', status: 400 };
  }
  if (typeof b.route !== 'string' || b.route.length > 256) {
    return { ok: false, reason: 'route_invalid', status: 400 };
  }
  if (typeof b.atIso !== 'string' || b.atIso.length > 64) {
    return { ok: false, reason: 'atIso_invalid', status: 400 };
  }
  return { ok: true };
}
