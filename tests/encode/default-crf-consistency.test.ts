/*
 * 49-05 Task 1 — DEFAULT_CRF_BY_ENCODER is the ONE source (AC-6, AC-7).
 *
 * The four crf_* factory defaults used to live as literals in four places
 * (migration seed, settings/page.tsx clampCrf fallback, onboarding/page.tsx ??
 * fallback, quality-step.tsx Number.isFinite fallback) and had already drifted
 * apart from what the encoders actually do. This test binds the constant to the
 * migration seed.
 *
 * NOT self-referential ([[feedback_grep_gates_self_referential]]): it compares
 * two INDEPENDENT artefacts — the parsed SQL seed against the TS constant. It
 * counts no comment pattern that 49-05 itself introduced.
 *
 * The import-graph assertion pins the MH-1 invariant: crf-defaults.ts must stay
 * runtime-dependency-free, because client components take a VALUE import from
 * it. `tsc --noEmit` and vitest cannot see a Node builtin in a client graph —
 * only `npm run build` can — so the cheap static guard lives here.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CRF_BY_ENCODER } from '@/src/lib/encode/crf-defaults';
import { ENCODER_IDS } from '@/src/lib/encode/profiles';

const MIGRATION = path.join(process.cwd(), 'migrations', '0005_encoder_settings.sql');
const LEAF = path.join(process.cwd(), 'src', 'lib', 'encode', 'crf-defaults.ts');

/** Extract every ('crf_<enc>', '<n>') pair from the seed's VALUES list. */
function parseSeed(sql: string): Record<string, number> {
  const out: Record<string, number> = {};
  const re = /\(\s*'(crf_[a-z0-9]+)'\s*,\s*'(\d+)'\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) out[m[1]] = Number(m[2]);
  return out;
}

describe('49-05: DEFAULT_CRF_BY_ENCODER vs. the migration seed', () => {
  const seed = parseSeed(fs.readFileSync(MIGRATION, 'utf8'));

  it('seeds exactly one row per encoder', () => {
    expect(Object.keys(seed).sort()).toEqual(ENCODER_IDS.map((e) => `crf_${e}`).sort());
  });

  it.each(ENCODER_IDS)('crf_%s matches the constant', (enc) => {
    expect(seed[`crf_${enc}`]).toBe(DEFAULT_CRF_BY_ENCODER[enc]);
  });

  // AC-6: the number itself, pinned so a silent revert to 22 is loud.
  it('qsv is 26 (49-05 — new installations only)', () => {
    expect(DEFAULT_CRF_BY_ENCODER.qsv).toBe(26);
    expect(seed.crf_qsv).toBe(26);
  });

  // AC-7: vaapi explicitly did NOT move — no evidence against 22.
  it('vaapi is unchanged at 22', () => {
    expect(DEFAULT_CRF_BY_ENCODER.vaapi).toBe(22);
    expect(seed.crf_vaapi).toBe(22);
  });

  it('libx265 and nvenc are unchanged at 23', () => {
    expect(DEFAULT_CRF_BY_ENCODER.libx265).toBe(23);
    expect(DEFAULT_CRF_BY_ENCODER.nvenc).toBe(23);
    expect(seed.crf_libx265).toBe(23);
    expect(seed.crf_nvenc).toBe(23);
  });

  // MH-1: the leaf must stay client-importable.
  it('crf-defaults.ts has no runtime import (client-graph safe)', () => {
    const src = fs.readFileSync(LEAF, 'utf8');
    const imports = src.match(/^\s*import\s.+$/gm) ?? [];
    expect(imports).toHaveLength(1);
    // The ONLY import allowed is the type-only one — `import type` is erased at
    // compile time, so it cannot pull anything into the client bundle. What must
    // never appear here is a VALUE import (of any module, but node:os and the
    // pino logger in particular).
    expect(imports[0]).toMatch(/^import type \{[^}]*\} from '\.\/profiles';$/);
    expect(src).not.toMatch(/require\(/);
  });
});
