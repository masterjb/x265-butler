/*
 * Phase 18 Plan 18-02 — AC-16: NVIDIA-remediation copy drift-test.
 *
 * Asserts byte-for-byte equality between the new
 *   onboarding.hwAccel.branch.nvidia.steps.{1,2,3,4}
 * keys and the existing 18-01 source:
 *   notification.detection.nvenc_no_runtime.remediation.steps[0..3]
 *
 * Plan AC-16 named `settings.encoder.warningsBadge.remediation.nvidia.*` but
 * the actual 18-01 location was `notification.detection.nvenc_no_runtime.
 * remediation.*`. Drift-test points at the real source-of-truth (DEVIATION-1
 * logged for review).
 *
 * DRY-via-t.rich rejected per SR3 (bidirectional refactor-break risk).
 * Explicit duplication + this drift-test = safer maintenance posture.
 */

import { describe, it, expect } from 'vitest';

import en from '@/messages/en.json';
import de from '@/messages/de.json';

type Bundle = Record<string, unknown>;

function getKey(bundle: Bundle, dotted: string): unknown {
  const parts = dotted.split('.');
  let cur: unknown = bundle;
  for (const p of parts) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[p];
    if (cur === undefined) return undefined;
  }
  return cur;
}

function getNvidiaSteps(bundle: Bundle): string[] {
  const raw = getKey(bundle, 'notification.detection.nvenc_no_runtime.remediation.steps');
  return Array.isArray(raw) ? (raw as string[]) : [];
}

function getOnboardingNvidiaSteps(bundle: Bundle): string[] {
  const out: string[] = [];
  for (const n of [1, 2, 3, 4]) {
    const v = getKey(bundle, `onboarding.hwAccel.branch.nvidia.steps.${n}`);
    out.push(typeof v === 'string' ? v : '');
  }
  return out;
}

describe('NVIDIA remediation copy drift-test (AC-16)', () => {
  it('test_nvidia_remediation_copy_no_drift_between_settings_and_onboarding_namespaces_EN', () => {
    const source = getNvidiaSteps(en as Bundle);
    const dup = getOnboardingNvidiaSteps(en as Bundle);
    expect(source).toHaveLength(4);
    expect(dup).toHaveLength(4);
    for (let i = 0; i < 4; i += 1) {
      expect(dup[i]).toBe(source[i]);
    }
  });

  it('test_nvidia_remediation_copy_no_drift_between_settings_and_onboarding_namespaces_DE', () => {
    const source = getNvidiaSteps(de as Bundle);
    const dup = getOnboardingNvidiaSteps(de as Bundle);
    expect(source).toHaveLength(4);
    expect(dup).toHaveLength(4);
    for (let i = 0; i < 4; i += 1) {
      expect(dup[i]).toBe(source[i]);
    }
  });
});

describe('onboarding.hwAccel namespace EN/DE parity (AC-7)', () => {
  function collectLeafKeys(bundle: Bundle, prefix: string): string[] {
    const out: string[] = [];
    for (const [k, v] of Object.entries(bundle)) {
      const path = `${prefix}.${k}`;
      if (typeof v === 'object' && v !== null) {
        out.push(...collectLeafKeys(v as Bundle, path));
      } else {
        out.push(path);
      }
    }
    return out;
  }

  it('test_onboarding_hwAccel_namespace_has_parity_between_en_and_de', () => {
    const enTree = getKey(en as Bundle, 'onboarding.hwAccel');
    const deTree = getKey(de as Bundle, 'onboarding.hwAccel');
    expect(enTree).toBeTruthy();
    expect(deTree).toBeTruthy();
    const enKeys = collectLeafKeys(enTree as Bundle, 'onboarding.hwAccel').sort();
    const deKeys = collectLeafKeys(deTree as Bundle, 'onboarding.hwAccel').sort();
    expect(enKeys).toEqual(deKeys);
  });

  it('test_onboarding_step_keys_renumbered_step5_exists', () => {
    const step5 = getKey(en as Bundle, 'onboarding.step5.headline');
    expect(typeof step5).toBe('string');
    expect(step5).toBe('Quality defaults');
  });
});
