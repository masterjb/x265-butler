/*
 * 49-05 AC-2b + AC-3b — the CRF helper texts are BOUND to the real argv.
 *
 * Why this test exists at all: the helper 49-05 replaces ("QSV global_quality
 * 0-51") was written before the CQP branch existed and was never wrong loudly —
 * no test tied the sentence to what PROFILE_BUILDERS actually emits, so the
 * claim rotted quietly for a whole phase. A plan whose entire purpose is to fix
 * that drift must not lay the repair down unbound again.
 *
 * NOT self-referential ([[feedback_grep_gates_self_referential]]): it compares
 * two INDEPENDENT artefacts — the shipped i18n files against the builder output
 * — and counts no comment pattern 49-05 itself introduced. It breaks if either
 * side moves without the other.
 */

import { describe, it, expect } from 'vitest';
import de from '@/messages/de.json';
import en from '@/messages/en.json';
import { buildCodecBlock } from '@/src/lib/encode/profiles';
import {
  QSV_QUALITY_PARAM_BY_TIER,
  QSV_QUALITY_PARAM_FALLBACK,
} from '@/src/lib/encode/crf-defaults';
import { getActiveQsvRateControl } from '@/src/lib/encode/detection';

const LOCALES = { de, en } as const;

/** The parameter each non-qsv helper NAMES, read out of the shipped strings. */
const NAMED_PARAM = {
  crf_libx265: '-crf',
  crf_nvenc: '-qp',
  crf_vaapi: '-qp',
} as const;

function argvFor(encoder: 'libx265' | 'nvenc' | 'vaapi' | 'qsv', tier?: 'icq-full' | 'cqp') {
  return buildCodecBlock({
    encoder,
    crf: 23,
    preset: encoder === 'nvenc' ? 'p5' : 'medium',
    devicePath: encoder === 'vaapi' ? '/dev/dri/renderD128' : undefined,
    qsvRateControl: tier,
  });
}

describe('49-05: helper texts name the parameter the builder really emits', () => {
  // AC-2b — three static encoders.
  for (const [locale, messages] of Object.entries(LOCALES)) {
    for (const [key, param] of Object.entries(NAMED_PARAM)) {
      it(`${locale}/${key}: names ${param} and the builder emits it`, () => {
        const helper = (messages.settings.field as unknown as Record<string, { helper: string }>)[
          key
        ].helper;
        expect(helper).toContain(param);
        const encoder = key.replace('crf_', '') as 'libx265' | 'nvenc' | 'vaapi';
        expect(argvFor(encoder)).toContain(param);
      });
    }
  }

  // AC-2b — qsv, per resolved tier. The helper is ICU-parametrised, so the
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

  it('the two qsv tiers really are different flags (the whole 49-05 premise)', () => {
    expect(QSV_QUALITY_PARAM_BY_TIER['icq-full']).not.toBe(QSV_QUALITY_PARAM_BY_TIER.cqp);
  });

  // AC-2 — every helper states the values do not transfer across encoders.
  it.each(['crf_libx265', 'crf_nvenc', 'crf_qsv', 'crf_vaapi'])(
    '%s says the value is not transferable, in both locales',
    (key) => {
      for (const messages of Object.values(LOCALES)) {
        const helper = (messages.settings.field as unknown as Record<string, { helper: string }>)[
          key
        ].helper;
        expect(helper.toLowerCase()).toMatch(/übertragbar|transfer/);
      }
    },
  );

  // AC-1 — the false-equivalence sentence kernel is gone from both files.
  it('the pre-49-05 one-scale claim is gone', () => {
    expect(JSON.stringify(de)).not.toContain('Community-Standard für HEVC');
    expect(JSON.stringify(en)).not.toContain('community-default for HEVC');
  });
});

describe('49-05 AC-3b: the unknown-tier helper names the REAL fallback', () => {
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
