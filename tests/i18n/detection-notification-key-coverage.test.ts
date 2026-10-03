// @vitest-environment node
//
// 45-02 (audit-M1): the notification-side analogue of the test-encode hint-key
// coverage guard (tests/diagnostics/test-encode-error-map.test.ts). from-detection.ts
// builds notification.title = `notification.detection.<code>.title` and
// notification-bell.tsx renders t(n.title) — a MISSING key ships a raw dotted path
// into the bell + logs MISSING_MESSAGE (a broken diagnostic surface). The
// notification.detection.* subtree had NO parity/coverage guard before this file.
//
// Asserts, for EVERY DetectionWarningCode, that notification.detection.<code>.title is
// a non-empty string in BOTH en.json AND de.json. `.title` ONLY — from-detection does
// NOT render `.detail`/`.remediation`, so those are out of scope here.

import { describe, it, expect } from 'vitest';
import { DETECTION_WARNING_CODES } from '@/src/lib/encode/detection';
import en from '@/messages/en.json';
import de from '@/messages/de.json';

type DetectionMessages = {
  notification: { detection: Record<string, { title?: unknown }> };
};

const enDet = (en as DetectionMessages).notification.detection;
const deDet = (de as DetectionMessages).notification.detection;

describe('45-02 notification.detection.<code>.title coverage (render surface guard)', () => {
  it('every DetectionWarningCode has a non-empty EN + DE title', () => {
    for (const code of DETECTION_WARNING_CODES) {
      expect(enDet[code]?.title, `missing en title for ${code}`).toBeTypeOf('string');
      expect((enDet[code]?.title as string)?.length, `empty en title for ${code}`).toBeGreaterThan(
        0,
      );
      expect(deDet[code]?.title, `missing de title for ${code}`).toBeTypeOf('string');
      expect((deDet[code]?.title as string)?.length, `empty de title for ${code}`).toBeGreaterThan(
        0,
      );
    }
  });

  it('includes the new nvenc_api_too_new code and the backfilled gpu_device_not_found', () => {
    expect(DETECTION_WARNING_CODES).toContain('nvenc_api_too_new');
    expect(DETECTION_WARNING_CODES).toContain('gpu_device_not_found');
    expect(enDet.nvenc_api_too_new?.title).toBeTypeOf('string');
    expect(deDet.nvenc_api_too_new?.title).toBeTypeOf('string');
    expect(enDet.gpu_device_not_found?.title).toBeTypeOf('string');
    expect(deDet.gpu_device_not_found?.title).toBeTypeOf('string');
  });
});
