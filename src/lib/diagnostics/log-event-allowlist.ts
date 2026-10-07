// Client-facing allowlist for POST /api/diagnostics/log-event.
//
// CLIENT_ALLOWED_EVENTS excludes server-only events. `diagnosticsPageOpened` is
// emitted server-side from the page Server Component; `testEncodeTriggered`
// is emitted server-side from /api/diagnostics/test-encode.
// Both server-only events MUST NOT be acceptable from client-POST — otherwise
// a misbehaving client (or attacker on the LAN-trust boundary) can spoof
// audit-trail records that an operator/SOC analyst would assume are trusted.

export const CLIENT_ALLOWED_EVENTS = [
  'diagnosticsReportCopied',
  'encoderReplayTriggered',
  'feedbackLinkOpened',
  // Error-boundary mount emits per-boundary; `source`
  // discriminates locale / root / global to preserve audit-trail-integrity.
  'errorBoundaryTriggered',
  // TopbarWarningsBanner per-code dismiss + bulk restore. Both
  // keep `source` discipline (same pattern as above) — payload-key
  // filterPayloadKeys() never strips it.
  'bannerDismissed',
  'bannerRestored',
  // Test-encode-evidence gate at-mount + on-transition emits from
  // DiagnosticsClient. `source` discriminates emitter lineage.
  // copyReportUnlocked.outcome is value-substituted at route boundary
  // against the 3-literal allowlist {success, failed, killed_timeout}.
  'copyReportGated',
  'copyReportUnlocked',
  // Web-vital client emit. Append-only contract.
  // Validated by extracted validateWebVitalPayload().
  'webVitalCaptured',
] as const;

export type ClientAllowedEvent = (typeof CLIENT_ALLOWED_EVENTS)[number];

// `byteLength` (true UTF-8 bytes via TextEncoder, NOT string.length
// which counts UTF-16 code-units).
// encoderReplayTriggered shape is FLAT (no nested `diff` wrapper) —
// downstream Grafana/jq queries see stable field paths.
// errorBoundaryTriggered keeps `source` in the allowlist so
// the filterPayloadKeys() pattern does NOT strip it before logger.info.
// bannerDismissed `code` is validated by isValidWarningCode at
// the route boundary; non-matching values are substituted with '<invalid_code>'
// before logger.info to prevent file-path / PII leakage from future aggregator
// code-extensions.
export const PAYLOAD_SCHEMA_BY_EVENT: Record<ClientAllowedEvent, readonly string[]> = {
  diagnosticsReportCopied: ['byteLength'],
  encoderReplayTriggered: ['added', 'removed', 'activeFromAutoChanged'],
  feedbackLinkOpened: ['type'],
  errorBoundaryTriggered: ['source', 'kind', 'boundary', 'digest', 'versionFingerprint'],
  bannerDismissed: ['source', 'code', 'severity', 'warningSource'],
  bannerRestored: ['source', 'restoredCount'],
  copyReportGated: ['source'],
  copyReportUnlocked: ['source', 'outcome', 'encoderPicked'],
  webVitalCaptured: ['metric', 'value', 'route', 'atIso'],
} as const;

export function isClientAllowedEvent(value: unknown): value is ClientAllowedEvent {
  return typeof value === 'string' && (CLIENT_ALLOWED_EVENTS as readonly string[]).includes(value);
}

// Code-value format guard. Asserts the warning code shape
// `category.subcategory` (lowercase + digits + underscore) so future
// aggregator code-extensions cannot embed file-paths / PII / arbitrary
// content that would leak via logger.info. Route handler substitutes
// '<invalid_code>' on mismatch; trail-integrity preserved, content-leak
// blocked. Module-scoped flag prevents console.warn flood under repeated
// invalid input.
const WARNING_CODE_REGEX = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
let invalidCodeWarnedOnce = false;

export function isValidWarningCode(code: unknown): code is string {
  return typeof code === 'string' && WARNING_CODE_REGEX.test(code);
}

export function noteInvalidWarningCodeOnce(code: unknown): void {
  if (invalidCodeWarnedOnce) return;
  invalidCodeWarnedOnce = true;
  console.warn('[log-event-allowlist] invalid warning code substituted with <invalid_code>', code);
}

// Test-only escape hatch — resets the once-per-process flag so a vitest run
// can exercise the first-emit path in successive test cases.
export function __resetInvalidWarningCodeWarnedForTests(): void {
  invalidCodeWarnedOnce = false;
}

// Outcome value-allowlist for copyReportUnlocked.outcome.
// Mirrors isValidWarningCode shape — strict equality against 3-literal set.
// Route handler substitutes '<invalid_outcome>' on mismatch (audit-trail
// integrity preserved, log-line injection blocked).
const VALID_TEST_ENCODE_OUTCOMES = new Set<string>(['success', 'failed', 'killed_timeout']);
let invalidOutcomeWarnedOnce = false;

export function isValidTestEncodeOutcome(
  value: unknown,
): value is 'success' | 'failed' | 'killed_timeout' {
  return typeof value === 'string' && VALID_TEST_ENCODE_OUTCOMES.has(value);
}

export function noteInvalidOutcomeOnce(value: unknown): void {
  if (invalidOutcomeWarnedOnce) return;
  invalidOutcomeWarnedOnce = true;
  console.warn(
    '[log-event-allowlist] invalid test-encode outcome substituted with <invalid_outcome>',
    value,
  );
}

export function __resetInvalidOutcomeWarnedForTests(): void {
  invalidOutcomeWarnedOnce = false;
}

// Source value-allowlist applied uniformly across all
// events whose payload-schema includes 'source'. Spoofed-broker masquerade
// defense — route handler substitutes '<invalid_source>' on mismatch.
export const KNOWN_SOURCE_VALUES: ReadonlySet<string> = new Set<string>([
  'diagnostics-client',
  'copy-report-button',
  'feedback-links',
  'app-shell-banner',
  'app-shell-banner-bulk-restore',
  'error-boundary-locale',
  'error-boundary-root',
  'error-boundary-global',
  // Banner emits with source='topbar-banner'.
  'topbar-banner',
]);
let invalidSourceWarnedOnce = false;

export function isKnownSource(value: unknown): value is string {
  return typeof value === 'string' && KNOWN_SOURCE_VALUES.has(value);
}

export function noteInvalidSourceOnce(value: unknown): void {
  if (invalidSourceWarnedOnce) return;
  invalidSourceWarnedOnce = true;
  console.warn('[log-event-allowlist] invalid source substituted with <invalid_source>', value);
}

export function __resetInvalidSourceWarnedForTests(): void {
  invalidSourceWarnedOnce = false;
}

// Per-value length cap. UTF-8 bytes via TextEncoder
// matches the existing MAX_BODY_BYTES envelope check. Substitutes
// '<truncated>' for over-length string values; passes number / boolean / null
// through unchanged. Sidecar `truncatedKeys` lets logger.info emit a single
// line listing which keys were affected — auditable without per-key warn.
export const MAX_PAYLOAD_VALUE_BYTES = 256;

export function clampPayloadValues(payload: Record<string, unknown>): {
  clamped: Record<string, unknown>;
  truncatedKeys: string[];
} {
  const clamped: Record<string, unknown> = {};
  const truncatedKeys: string[] = [];
  const encoder = new TextEncoder();
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string' && encoder.encode(value).length > MAX_PAYLOAD_VALUE_BYTES) {
      clamped[key] = '<truncated>';
      truncatedKeys.push(key);
    } else {
      clamped[key] = value;
    }
  }
  return { clamped, truncatedKeys };
}

export function filterPayloadKeys(
  event: ClientAllowedEvent,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = PAYLOAD_SCHEMA_BY_EVENT[event];
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in payload) {
      out[key] = payload[key];
    }
  }
  return out;
}
