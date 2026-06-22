/*
 * Translation key naming convention (audit-added S12)
 * --------------------------------------------------
 * `<page-or-component>.<section>.<element>` for nouns
 *   e.g. `library.column.path`, `settings.field.scanRoot.label`
 * `<page-or-component>.action.<verb>` for buttons
 *   e.g. `library.action.scan`, `settings.action.save`
 * Empty/error states: `<page>.<context>.headline / .helper / .cta`
 *
 * The regex below enforces: lowercase-letter first segment, alphanumeric
 * camelCase segments separated by dots, no spaces, no hyphens, no underscores.
 */

import { describe, it, expect } from 'vitest';
import en from '@/messages/en.json';
import de from '@/messages/de.json';

// 03-03 audit S12 update: segments past the first allow digits + underscores.
// Encoder names contain digits ('libx265') and DB column names use snake_case
// for the per-encoder CRF settings (crf_libx265, crf_nvenc, crf_qsv, crf_vaapi).
// First segment still locked to lowercase-alpha to keep the root namespace clean.
const KEY_NAMING_REGEX = /^[a-z]+(\.[a-zA-Z0-9_]+)+$/;

function gatherLeafPaths(obj: unknown, prefix = ''): string[] {
  if (typeof obj !== 'object' || obj === null) {
    return [prefix];
  }
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    out.push(...gatherLeafPaths(v, path));
  }
  return out;
}

function symmetricDifference<T>(a: T[], b: T[]): { onlyInA: T[]; onlyInB: T[] } {
  const setA = new Set(a);
  const setB = new Set(b);
  const onlyInA = a.filter((x) => !setB.has(x));
  const onlyInB = b.filter((x) => !setA.has(x));
  return { onlyInA, onlyInB };
}

describe('i18n completeness', () => {
  // audit-added M4: structural-equality assertion. Recursively gather all
  // leaf paths from both files, sort, expect equal. On failure, surface the
  // symmetric difference so missing keys are pinpointed.
  it('test_messages_when_diffed_then_keysets_are_identical', () => {
    const enLeaves = gatherLeafPaths(en).sort();
    const deLeaves = gatherLeafPaths(de).sort();
    const { onlyInA: onlyInEn, onlyInB: onlyInDe } = symmetricDifference(enLeaves, deLeaves);
    if (onlyInEn.length > 0 || onlyInDe.length > 0) {
      console.error('Missing in DE:', onlyInEn);
      console.error('Missing in EN:', onlyInDe);
    }
    expect(enLeaves).toEqual(deLeaves);
  });

  // audit-added S12: key-naming convention enforced as a regex.
  it('test_messages_when_inspected_then_all_keys_match_naming_convention', () => {
    const enLeaves = gatherLeafPaths(en);
    const violations = enLeaves.filter((p) => !KEY_NAMING_REGEX.test(p));
    if (violations.length > 0) {
      console.error('S12 naming violations:', violations);
    }
    expect(violations).toEqual([]);
  });

  // 11-03 UAT regression: TwoPassStepper calls tPass2('verifyTooltipReady')
  // (namespace bench.pass2) AND Top3Cards calls t('verifyTooltipReady') (namespace
  // bench.top3). Both consumer paths must resolve in prod messages — fixture-only
  // coverage previously masked the missing prod key.
  it('test_messages_consumer_paths_for_11-03_verifyTooltipReady', () => {
    const enLeaves = new Set(gatherLeafPaths(en));
    expect(enLeaves.has('bench.pass2.verifyTooltipReady')).toBe(true);
    expect(enLeaves.has('bench.top3.verifyTooltipReady')).toBe(true);
  });
});
