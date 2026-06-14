// Phase 18 Plan 18-01: pure derivation from DetectionResult.warnings →
// Notification[]. Tested in tests/lib/notifications-from-detection.test.ts.

import type { DetectionResult } from '../encode/detection';
import type { Notification } from './types';

export function notificationsFromDetection(result: DetectionResult): Notification[] {
  const now = Date.now();
  return result.warnings.map((w) => ({
    id: `notif_${w.code}`,
    source: 'detection' as const,
    severity: w.severity,
    code: w.code,
    title: `notification.detection.${w.code}.title`,
    detail: w.detail,
    deeplink: '/settings#encoder-config',
    createdAt: now,
  }));
}
