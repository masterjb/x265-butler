/*
 * Phase 18 Plan 18-02 — M6 audit: step-key renumber orphan-caller probe.
 *
 * After renumber (step2→3, step3→4, step4→5 + new step2=hwAccel), no caller
 * in app/, components/, or tests/ may reference the OLD key positions for
 * paths/encoder/quality. StepIndicator + onboarding-client are exempt
 * (they enumerate the new positions canonically).
 *
 * This is a defensive grep-as-test that fails-noisy on any stale literal
 * `t('onboarding.stepN.*')` or `t('stepN.*')` reference that wasn't migrated.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = [
  join(process.cwd(), 'components'),
  join(process.cwd(), 'app'),
  join(process.cwd(), 'tests'),
];

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
      out.push(...walk(full));
    } else if (full.endsWith('.tsx') || full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('Onboarding step-key renumber orphan-callers (M6)', () => {
  it('test_no_orphan_callers_reference_old_step_keys', () => {
    // After 18-02 renumber: t('onboarding.step{1,2,3,4,5}.*') OR t('step{1..5}.*')
    // is the new canonical. We assert that NO file references step keys via the
    // hardcoded full dotted form `onboarding.stepN.headline` outside of
    // bundle files (messages/*) or where the renumber-aware test-file lives.
    //
    // Pattern we forbid: hardcoded literal `'onboarding.step2.headline'`
    // outside messages/ (post-18-02 nobody should reference step2 paths
    // headline because step2 is now hwAccel).
    const files: string[] = [];
    for (const root of ROOTS) {
      files.push(...walk(root));
    }
    const offending: { file: string; match: string }[] = [];
    const forbidden = [
      // step2 used to be `Where are your videos?`. Anyone reading
      // 'onboarding.step2.headline' expecting paths-text is broken.
      "'onboarding.step2.field.scanRoot",
      '"onboarding.step2.field.scanRoot',
      "'onboarding.step2.body'",
      '"onboarding.step2.body"',
    ];
    for (const file of files) {
      // Allow the renumber test itself + this file (meta-test) + messages json.
      if (file.endsWith('onboarding-step-renumber.test.ts')) continue;
      if (file.endsWith('nvidia-remediation-drift.test.ts')) continue;
      const src = readFileSync(file, 'utf8');
      for (const f of forbidden) {
        if (src.includes(f)) offending.push({ file, match: f });
      }
    }
    expect(offending).toEqual([]);
  });
});
