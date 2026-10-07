/*
 * The CRF helper texts are BOUND to the real argv.
 *
 * Why this test exists at all: the old helper text ("QSV global_quality
 * 0-51") was written before the CQP branch existed and was never wrong loudly —
 * no test tied the sentence to what PROFILE_BUILDERS actually emits, so the
 * claim rotted quietly for a long time. A change whose entire purpose is to fix
 * that drift must not lay the repair down unbound again.
 *
 * NOT self-referential: it compares two INDEPENDENT artefacts — the shipped
 * i18n files against the builder output — and counts no comment pattern the
 * helper rewrite itself introduced. It breaks if either side moves without the
 * other.
 *
 * The binding MOVED, it was not loosened. The CRF-card redesign shows the
 * flag as a badge on every encoder row and drops it from the helper prose (which
 * used to repeat "scale 0-51 … does not transfer" four times). The badge renders
 * resolveCrfParam() from the crf-defaults leaf, so THAT is bound to
 * buildCodecBlock now, for all four encoders, both qsv tiers and the unresolved
 * fallback. The "does not transfer" statement moved to the card description and
 * is pinned there, plus a negative check that no helper repeats it.
 */

import { describe, it, expect } from 'vitest';
import de from '@/messages/de.json';
import en from '@/messages/en.json';
import { buildCodecBlock } from '@/src/lib/encode/profiles';
import {
  QSV_QUALITY_PARAM_BY_TIER,
  QSV_QUALITY_PARAM_FALLBACK,
  resolveCrfParam,
} from '@/src/lib/encode/crf-defaults';
import { getActiveQsvRateControl } from '@/src/lib/encode/detection';

const LOCALES = { de, en } as const;

function argvFor(encoder: 'libx265' | 'nvenc' | 'vaapi' | 'qsv', tier?: 'icq-full' | 'cqp') {
  return buildCodecBlock({
    encoder,
    crf: 23,
    preset: encoder === 'nvenc' ? 'p5' : 'medium',
    devicePath: encoder === 'vaapi' ? '/dev/dri/renderD128' : undefined,
    qsvRateControl: tier,
  });
}

describe('the badge parameter is the parameter the builder really emits', () => {
  // Bound through resolveCrfParam(), the value the CRF-card badge
  // renders, for every encoder AND the unresolved qsv tier.
  it.each([
    ['libx265', undefined, '-crf'],
    ['nvenc', undefined, '-qp'],
    ['vaapi', undefined, '-qp'],
    ['qsv', 'icq-full', '-global_quality'],
    ['qsv', 'cqp', '-q:v'],
    ['qsv', undefined, '-global_quality'],
  ] as const)('%s (tier %s) renders %s, and the builder emits it', (encoder, tier, param) => {
    expect(resolveCrfParam(encoder, tier)).toBe(param);
    expect(argvFor(encoder, tier)).toContain(resolveCrfParam(encoder, tier));
  });

  // qsv, per resolved tier. The helper is ICU-parametrised, so the
  // binding runs through the constant the component substitutes.
  it.each([
    ['icq-full', '-global_quality'],
    ['cqp', '-q:v'],
  ] as const)(
    'qsv tier %s → helper param %s, and that is what the builder emits',
    (tier, param) => {
      expect(QSV_QUALITY_PARAM_BY_TIER[tier]).toBe(param);
      expect(argvFor('qsv', tier)).toContain(param);
    },
  );

  it('the two qsv tiers really are different flags (the premise of the per-tier helper)', () => {
    expect(QSV_QUALITY_PARAM_BY_TIER['icq-full']).not.toBe(QSV_QUALITY_PARAM_BY_TIER.cqp);
  });

  // The shared "does not transfer" statement lives ONCE,
  // in the card description, and no per-encoder helper repeats it.
  it.each(Object.keys(LOCALES) as Array<keyof typeof LOCALES>)(
    '%s: the card description says the value is not transferable, and names the scale',
    (locale) => {
      const description = LOCALES[locale].settings.section.crf.description.toLowerCase();
      expect(description).toMatch(/übertragbar|transfer/);
      expect(description).toMatch(/0 bis 51|0 to 51/);
    },
  );

  it.each(['crf_libx265', 'crf_nvenc', 'crf_qsv', 'crf_vaapi'])(
    '%s helper does NOT repeat the shared sentence (said once, in the description)',
    (key) => {
      for (const messages of Object.values(LOCALES)) {
        const entry = (
          messages.settings.field as unknown as Record<
            string,
            { helper: string; helperUnknown?: string }
          >
        )[key];
        for (const text of [entry.helper, entry.helperUnknown ?? '']) {
          expect(text.toLowerCase()).not.toMatch(/übertragbar|transfer|0 bis 51|0 to 51|0–51/);
        }
      }
    },
  );

  // The false-equivalence sentence kernel is gone from both files.
  it('the old one-scale claim is gone', () => {
    expect(JSON.stringify(de)).not.toContain('Community-Standard für HEVC');
    expect(JSON.stringify(en)).not.toContain('community-default for HEVC');
  });
});

describe('the unknown-tier helper names the REAL fallback', () => {
  it('the UI fallback constant is the value detection resolves on an empty cache', () => {
    // No detection has run in this process → globalThis cache is empty. This is
    // exactly the state the "tier not verified" helper describes, and the encode
    // still deterministically ships this flag.
    const resolved = getActiveQsvRateControl();
    expect(QSV_QUALITY_PARAM_FALLBACK).toBe(QSV_QUALITY_PARAM_BY_TIER[resolved]);
    expect(QSV_QUALITY_PARAM_FALLBACK).toBe('-global_quality');
  });

  it('the builder with an undefined tier emits that same flag', () => {
    expect(argvFor('qsv', undefined)).toContain(QSV_QUALITY_PARAM_FALLBACK);
  });

  it.each(['de', 'en'] as const)(
    '%s helperUnknown states BOTH facts: not verified AND the fallback applies',
    (locale) => {
      const text = LOCALES[locale].settings.field.crf_qsv.helperUnknown;
      // The parameter arrives through the ICU placeholder the component fills
      // with QSV_QUALITY_PARAM_FALLBACK — asserting the placeholder is present
      // is what keeps the text from hardcoding a flag that can drift.
      expect(text).toContain('{param}');
      expect(text.toLowerCase()).toMatch(/fallback/);
      expect(text.toLowerCase()).toMatch(/verifiziert|verified/);
    },
  );
});
