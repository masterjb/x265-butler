// Phase 50 Plan 50-06 — the shared settings resolvers.
//
// These tests exist for TWO reasons, and the second one is the important one:
//  1. the resolvers behave as specified, and
//  2. they behave EXACTLY as the pre-50-06 orchestrator code did (AC-6/AC-14),
//     INCLUDING the NaN pass-through that is a real defect. A "helpful" cleanup
//     here would silently change every production encode's CRF.

import { describe, it, expect } from 'vitest';
import {
  resolveCrfForEncoder,
  resolveDefaultCrf,
  resolveForce10bit,
  resolvePresetForEncoder,
  resolveRequestedEncoder,
} from '@/src/lib/encode/encode-settings-resolve';
import { DEFAULT_PRESET_BY_ENCODER, type EncoderId } from '@/src/lib/encode/profiles';

const ALL: EncoderId[] = ['libx265', 'nvenc', 'qsv', 'vaapi'];

describe('resolveRequestedEncoder (AC-10/AC-11/AC-12)', () => {
  it('undefined and the literal "auto" both mean auto', () => {
    expect(resolveRequestedEncoder(undefined)).toBe('auto');
    expect(resolveRequestedEncoder('auto')).toBe('auto');
  });

  it('every EncoderId round-trips', () => {
    for (const enc of ALL) expect(resolveRequestedEncoder(enc)).toBe(enc);
  });

  it('anything else is "invalid" — NOT silently coerced to auto', () => {
    // The caller decides the fallback AND the warn; conflating the two here is
    // what would lose the `encoder_setting_invalid` audit line (AC-15).
    for (const junk of ['hevc_magic', 'LIBX265', '', ' qsv', 'x265']) {
      expect(resolveRequestedEncoder(junk)).toBe('invalid');
    }
  });
});

describe('resolveDefaultCrf', () => {
  it('absent default_crf → 23', () => {
    expect(resolveDefaultCrf({})).toBe(23);
  });

  it('a stored value wins', () => {
    expect(resolveDefaultCrf({ default_crf: '19' })).toBe(19);
  });

  it('AC-6: a STORED empty string is NaN, not 23 — `??` does not catch it', () => {
    // This is the production behaviour being frozen. `||` would return 23 here
    // and would change what every host encodes at.
    expect(Number.isNaN(resolveDefaultCrf({ default_crf: '' }))).toBe(true);
  });
});

describe('resolveCrfForEncoder (AC-5/AC-6)', () => {
  it('AC-5: the per-encoder value wins', () => {
    const s = { crf_qsv: '26', crf_libx265: '19', default_crf: '23' };
    expect(resolveCrfForEncoder('qsv', s)).toBe(26);
    expect(resolveCrfForEncoder('libx265', s)).toBe(19);
  });

  it('absent per-encoder value falls back to default_crf', () => {
    expect(resolveCrfForEncoder('vaapi', { default_crf: '20' })).toBe(20);
  });

  it('empty per-encoder value is falsy → default_crf (mirrors the `? :` in prod)', () => {
    expect(resolveCrfForEncoder('vaapi', { crf_vaapi: '', default_crf: '20' })).toBe(20);
  });

  it('unparsable per-encoder value → default_crf via the finite check', () => {
    expect(resolveCrfForEncoder('nvenc', { crf_nvenc: 'abc', default_crf: '21' })).toBe(21);
  });

  it('parseInt prefix semantics are preserved ("26abc" → 26)', () => {
    expect(resolveCrfForEncoder('qsv', { crf_qsv: '26abc' })).toBe(26);
  });

  it('AC-6/AC-26: BOTH values unparsable → NaN passes through, it is NOT repaired', () => {
    const crf = resolveCrfForEncoder('qsv', { crf_qsv: 'abc', default_crf: 'xyz' });
    expect(Number.isNaN(crf)).toBe(true);
  });

  it('an explicit fallbackCrf overrides the settings-derived one (the orchestrator seam)', () => {
    // This is how the production dispatch hands in readSettings().crf so the
    // delegation cannot diverge from the pre-50-06 code.
    expect(resolveCrfForEncoder('qsv', { default_crf: '30' }, 17)).toBe(17);
    expect(resolveCrfForEncoder('qsv', { crf_qsv: 'junk', default_crf: '30' }, 17)).toBe(17);
  });
});

describe('resolvePresetForEncoder (AC-7)', () => {
  it('AC-7: a valid stored preset is used and reported as source "settings"', () => {
    const r = resolvePresetForEncoder('libx265', { preset_libx265: 'veryslow' });
    expect(r).toEqual({ preset: 'veryslow', source: 'settings', raw: 'veryslow' });
  });

  it('AC-7: an out-of-catalog preset falls back to the per-encoder default', () => {
    const r = resolvePresetForEncoder('libx265', { preset_libx265: 'schnell-bitte' });
    expect(r.preset).toBe(DEFAULT_PRESET_BY_ENCODER.libx265);
    expect(r.source).toBe('fallback');
    // raw is retained so the caller can still tell "garbage stored" from "absent"
    expect(r.raw).toBe('schnell-bitte');
  });

  it('absent preset falls back AND reports raw undefined (absent ≠ garbage, AC-15)', () => {
    for (const enc of ALL) {
      const r = resolvePresetForEncoder(enc, {});
      expect(r.preset).toBe(DEFAULT_PRESET_BY_ENCODER[enc]);
      expect(r.source).toBe('fallback');
      expect(r.raw).toBeUndefined();
    }
  });

  it('a preset valid for another encoder is still invalid here', () => {
    // 'p5' is an nvenc preset; libx265 must reject it.
    const r = resolvePresetForEncoder('libx265', { preset_libx265: 'p5' });
    expect(r.source).toBe('fallback');
  });
});

describe('resolveForce10bit (AC-8)', () => {
  it('only the exact string "true" is ON', () => {
    expect(resolveForce10bit({ force_10bit: 'true' })).toBe(true);
  });

  it('unset / "false" / junk are OFF (byte-identical to pre-43)', () => {
    expect(resolveForce10bit({})).toBe(false);
    expect(resolveForce10bit({ force_10bit: 'false' })).toBe(false);
    expect(resolveForce10bit({ force_10bit: 'TRUE' })).toBe(false);
    expect(resolveForce10bit({ force_10bit: '1' })).toBe(false);
  });
});

describe('AC-22: the leaf is pure — no env, no logger, no DB', () => {
  it('its CODE contains no process.env read and no ambient-state import', async () => {
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync('src/lib/encode/encode-settings-resolve.ts', 'utf8');
    // Strip comments FIRST. The module header documents the purity rule in prose
    // and therefore contains the very token this gate looks for — a gate that
    // matches its own documentation proves nothing about the implementation.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toContain('process.env');
    expect(code).not.toMatch(/from '\.\.\/logger'/);
    expect(code).not.toMatch(/from '\.\.\/db'/);
    expect(code).not.toMatch(/from 'node:/);
    // Sanity: the stripping did not eat the implementation it is guarding.
    expect(code).toContain('export function resolveCrfForEncoder');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 50-06 review (R-1) — structural invariants that AC-16, AC-17 and AC-22 state in
// words but that the APPLY pass only verified by hand. A rule nobody executes is
// a comment, and these three are exactly the ones a future refactor breaks
// silently.
// ─────────────────────────────────────────────────────────────────────────────
describe('50-06 structural invariants', () => {
  const read = (p: string): string => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    return readFileSync(p, 'utf8');
  };
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('AC-16: profiles.ts and bench/vmaf.ts do NOT import the settings leaf', () => {
    // The 49-02 invariant, one level further: `encodeForBench` calls
    // buildCodecBlock DIRECTLY, so operator settings reaching profiles.ts would
    // push them into every bench Pass-1 argv and break apples-to-apples VMAF.
    for (const f of ['src/lib/encode/profiles.ts', 'src/lib/bench/vmaf.ts']) {
      const code = stripComments(read(f));
      expect(code, `${f} must not import the settings resolvers`).not.toContain(
        'encode-settings-resolve',
      );
      expect(code).not.toContain('resolveCrfForEncoder');
      expect(code).not.toContain('resolvePresetForEncoder');
    }
  });

  it('AC-17: forceKeyFrameArgs exists EXACTLY once, and it lives in keyframe.ts', () => {
    // It was PULLED out of ffmpeg.ts, not copied. A second definition is the
    // drift this move exists to prevent, so count it rather than trust it.
    const files = [
      'src/lib/encode/keyframe.ts',
      'src/lib/encode/ffmpeg.ts',
      'src/lib/diagnostics/test-encode.ts',
      'src/lib/encode/profiles.ts',
    ];
    const definers = files.filter((f) =>
      /function\s+forceKeyFrameArgs/.test(stripComments(read(f))),
    );
    expect(definers).toEqual(['src/lib/encode/keyframe.ts']);
    // ...and the two legitimate callers reach it by import, not by redeclaring it.
    for (const caller of ['src/lib/encode/ffmpeg.ts', 'src/lib/diagnostics/test-encode.ts']) {
      const code = stripComments(read(caller));
      expect(code).toContain('forceKeyFrameArgs');
      expect(code).toMatch(/from '(\.\/keyframe|@\/src\/lib\/encode\/keyframe)'/);
    }
  });

  it('AC-22: test-encode.ts reads NO env var of its own', () => {
    // The keyframe / closed-GOP levers are read through the keyframe leaf's
    // memoised accessors. A direct process.env read here would be a new,
    // undocumented operator lever — this plan ships none (D6).
    const code = stripComments(read('src/lib/diagnostics/test-encode.ts'));
    expect(code).not.toContain('process.env.ENCODE_');
    expect(code).not.toContain('process.env.FFMPEG_');
    expect(code).not.toContain('process.env.X265_');
    // the ONE permitted process.env touch is the pre-existing test-seam guard
    const envReads = code.match(/process\.env\.\w+/g) ?? [];
    expect(envReads.sort()).toEqual(['process.env.NODE_ENV', 'process.env.VITEST']);
  });
});
