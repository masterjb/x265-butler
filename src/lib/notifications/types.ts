// Phase 18 Plan 18-01: notification types.
//
// 18-01 is intentionally a thin pull-through wrapper over `detectEncoders()`.
// Phase 19 may extend this surface with a real store + SSE if multi-source
// warnings need eventual-consistency semantics.

export type NotificationSeverity = 'info' | 'warn';

export interface Notification {
  // Stable: `notif_${code}` for detection-derived. Future sources may use
  // other prefixes (`notif_scan_*`, `notif_release_*`, …).
  id: string;
  // 'detection' is the only source in 18-01; widen as future sources land.
  source: 'detection';
  severity: NotificationSeverity;
  // Mirrors DetectionWarningCode for detection-source.
  code: string;
  // i18n-key reference (UI resolves via next-intl).
  title: string;
  detail?: string;
  // Locale-prefixed app-path, e.g. '/settings#encoder-config'.
  deeplink?: string;
  // Date.now() at derivation time.
  createdAt: number;
}
