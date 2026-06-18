// Phase 18 Plan 18-01 Task 7 (audit-fix M8): regex-walks t()-calls in
// NotificationBell + EncoderWarningsBadge + VendorRemediation; asserts every
// referenced i18n key exists in EN + DE messages.
//
// Carry-forward pattern from auto-scan-key-coverage + onboarding-key-coverage.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import enJson from '../../messages/en.json';
import deJson from '../../messages/de.json';

type Bundle = Record<string, unknown>;

function getByPath(bundle: Bundle, key: string): unknown {
  return key.split('.').reduce<unknown>((acc, seg) => {
    if (acc && typeof acc === 'object' && seg in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[seg];
    }
    return undefined;
  }, bundle);
}

const COMPONENT_FILES = [
  'components/app-shell/notification-bell.tsx',
  'components/settings/encoder-warnings-badge.tsx',
];

const KEY_PATTERNS = [
  /\bt\(['"]([\w.]+)['"]/g, // t('foo.bar')
  /\bt\.raw\(['"]([\w.]+)['"]/g, // t.raw('foo.bar')
];

// Hard-coded keys from settings-form.tsx Encoder-tab anchor mount (per plan).
const STATIC_USES = ['settings.encoder.warningsBadge.label', 'settings.encoder.warningsBadge.aria'];

function extractKeys(filePath: string): string[] {
  const abs = resolve(__dirname, '..', '..', filePath);
  const src = readFileSync(abs, 'utf8');
  const keys = new Set<string>();
  for (const re of KEY_PATTERNS) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      keys.add(m[1]);
    }
  }
  return [...keys];
}

describe('i18n notification-key coverage (Plan 18-01 audit M8)', () => {
  const allKeys = new Set<string>([...COMPONENT_FILES.flatMap(extractKeys), ...STATIC_USES]);

  for (const key of allKeys) {
    it(`test_i18n_en_has_key_${key.replace(/\./g, '_')}`, () => {
      expect(getByPath(enJson as Bundle, key)).toBeDefined();
    });
    it(`test_i18n_de_has_key_${key.replace(/\./g, '_')}`, () => {
      expect(getByPath(deJson as Bundle, key)).toBeDefined();
    });
  }
});
