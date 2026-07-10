// Phase 18 Plan 18-01 Task 7 — pure derivation tests for
// notificationsFromDetection(). No mocking required; the function is a pure
// map over DetectionResult.warnings.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { notificationsFromDetection } from '@/src/lib/notifications/from-detection';
import type { DetectionResult } from '@/src/lib/encode/detection';

const FROZEN_NOW = 1779000000000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FROZEN_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function makeDetection(warnings: DetectionResult['warnings'] = []): DetectionResult {
  return {
    detected: ['libx265'],
    activeFromAuto: 'libx265',
    warnings,
    outcome: { nvenc: 'missing', qsv: 'missing', vaapi: 'missing', libx265: 'functional' },
    brokenExcerpts: {},
    probeEncodeDisabled: false,
  };
}

describe('notificationsFromDetection — derivation', () => {
  it('test_when_no_warnings_then_empty_array', () => {
    expect(notificationsFromDetection(makeDetection())).toEqual([]);
  });

  it('test_when_one_warning_then_id_is_notif_prefix_plus_code', () => {
    const result = notificationsFromDetection(
      makeDetection([{ code: 'nvenc_no_runtime', severity: 'warn' }]),
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('notif_nvenc_no_runtime');
  });

  it('test_when_warning_then_source_is_detection_literal', () => {
    const result = notificationsFromDetection(
      makeDetection([{ code: 'vainfo_binary_missing', severity: 'warn' }]),
    );
    expect(result[0].source).toBe('detection');
  });

  it('test_when_warning_then_title_is_i18n_key_pattern', () => {
    const result = notificationsFromDetection(
      makeDetection([{ code: 'qsv_only_legacy_intel', severity: 'info' }]),
    );
    expect(result[0].title).toBe('notification.detection.qsv_only_legacy_intel.title');
  });

  it('test_when_warning_then_deeplink_is_settings_encoder_anchor', () => {
    const result = notificationsFromDetection(
      makeDetection([{ code: 'dri_present_no_driver', severity: 'warn' }]),
    );
    expect(result[0].deeplink).toBe('/settings#encoder-config');
  });

  it('test_when_warning_then_createdAt_is_Date_now', () => {
    const result = notificationsFromDetection(
      makeDetection([{ code: 'nvenc_no_runtime', severity: 'warn' }]),
    );
    expect(result[0].createdAt).toBe(FROZEN_NOW);
  });

  it('test_when_warning_severity_is_info_then_notification_severity_is_info', () => {
    const result = notificationsFromDetection(
      makeDetection([{ code: 'qsv_only_legacy_intel', severity: 'info' }]),
    );
    expect(result[0].severity).toBe('info');
  });

  it('test_when_warning_severity_is_warn_then_notification_severity_is_warn', () => {
    const result = notificationsFromDetection(
      makeDetection([{ code: 'nvenc_no_runtime', severity: 'warn' }]),
    );
    expect(result[0].severity).toBe('warn');
  });

  it('test_when_warning_has_detail_then_detail_is_preserved', () => {
    const result = notificationsFromDetection(
      makeDetection([
        { code: 'vainfo_binary_missing', severity: 'warn', detail: 'binary missing' },
      ]),
    );
    expect(result[0].detail).toBe('binary missing');
  });

  // 45-02 (audit-S2): prove the end-to-end wiring for the new code — the title is
  // the derived i18n key path, the detail is the RUNTIME string (not an i18n key).
  it('test_when_nvenc_api_too_new_then_title_is_derived_key_and_detail_is_runtime_string', () => {
    const result = notificationsFromDetection(
      makeDetection([
        {
          code: 'nvenc_api_too_new',
          severity: 'warn',
          detail: 'nvenc: Required: 13.1 Found: 13.0',
        },
      ]),
    );
    expect(result[0].title).toBe('notification.detection.nvenc_api_too_new.title');
    expect(result[0].detail).toBe('nvenc: Required: 13.1 Found: 13.0');
  });

  it('test_when_multiple_warnings_then_one_notification_per_warning_in_order', () => {
    const result = notificationsFromDetection(
      makeDetection([
        { code: 'nvenc_no_runtime', severity: 'warn' },
        { code: 'qsv_only_legacy_intel', severity: 'info' },
      ]),
    );
    expect(result).toHaveLength(2);
    expect(result.map((n) => n.code)).toEqual(['nvenc_no_runtime', 'qsv_only_legacy_intel']);
  });
});
